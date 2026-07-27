/**
 * Blueprint Watchdog & Safe-State Fallback — Unit Tests (#459)
 *
 * Exercises the pure trip logic against in-memory fakes for the runtime, the
 * canonical anchor backend, and the audit sink:
 *
 *  - in-budget ticks reset the consecutive-miss counter
 *  - N consecutive over-budget ticks trip the watchdog
 *  - a tripped watchdog halts the blueprint and applies the declared safe state
 *  - a CRITICAL `SafeStateEntered` event is anchored
 *  - every entry / exit is audited
 *  - resume requires an operator and anchors a `SafeStateExited` event
 *  - the documented verification scenario: an artificial pause -> trip -> badge data
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SafeStateController,
  computeAnchorHash,
  describeSafeState,
  type AnchorBackend,
  type AnchorEvent,
  type AnchorReceipt,
  type SafeStateActuator,
  type SafeStateAuditEntry,
  type SafeStateAuditSink,
} from "../blueprint/safe-state";
import { Watchdog } from "../blueprint/watchdog";
import { WatchdogRegistry } from "../blueprint/registry";
import type { SafeStateConfig, SafeStateAction } from "@shared/schema";

// ─── In-memory fakes ─────────────────────────────────────────────────────────

class FakeRuntime implements SafeStateActuator {
  readonly blueprintId: string;
  readonly siteId?: string;
  halted = false;
  resumed = false;
  heldLast = false;
  forcedZero = false;
  appliedRecipe: string | null = null;
  resumeCalls = 0;
  failResume = false;
  failHalt = false;
  failSafeAction = false;
  safeActionCalls = 0;
  /** Actions this fake refuses to arm, exercising the fail-closed path. */
  unsupported = new Set<string>();

  constructor(blueprintId = "bp-test", siteId = "site-1") {
    this.blueprintId = blueprintId;
    this.siteId = siteId;
  }

  assertCanApply(action: SafeStateAction): void {
    const key = typeof action === "string" ? action : `recipe:${action.recipe}`;
    if (this.unsupported.has(key)) {
      throw new Error(`cannot actuate ${key}`);
    }
  }

  halt(): void {
    if (this.failHalt) {
      throw new Error("runtime halt failed");
    }
    this.halted = true;
  }
  resume(): void {
    this.resumeCalls += 1;
    if (this.failResume) {
      throw new Error("runtime resume failed");
    }
    this.resumed = true;
    this.halted = false;
  }
  holdLastOutputs(): void {
    this.safeActionCalls += 1;
    if (this.failSafeAction) throw new Error("safe output failed");
    this.heldLast = true;
  }
  forceZeroOutputs(): void {
    this.safeActionCalls += 1;
    if (this.failSafeAction) throw new Error("safe output failed");
    this.forcedZero = true;
  }
  applySafeRecipe(recipe: string): void {
    this.safeActionCalls += 1;
    if (this.failSafeAction) throw new Error("safe output failed");
    this.appliedRecipe = recipe;
  }
}

class FakeAnchor implements AnchorBackend {
  events: AnchorEvent[] = [];
  failNext = false;

  async anchor(event: AnchorEvent): Promise<AnchorReceipt> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("anchor backend unavailable");
    }
    this.events.push(event);
    return { hash: computeAnchorHash(event), txHash: `0xtx-${event.id.slice(0, 8)}` };
  }
}

class FakeAudit implements SafeStateAuditSink {
  entries: SafeStateAuditEntry[] = [];
  failNext = false;

  async record(entry: SafeStateAuditEntry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("audit database unavailable");
    }
    this.entries.push(entry);
  }
}

class BlockingExitAudit extends FakeAudit {
  readonly exitWriteStarted: Promise<void>;
  exitWriteAttempts = 0;
  private markExitWriteStarted!: () => void;
  private releaseExitWrite!: () => void;
  private readonly exitWriteReleased: Promise<void>;

  constructor() {
    super();
    this.exitWriteStarted = new Promise<void>((resolve) => {
      this.markExitWriteStarted = resolve;
    });
    this.exitWriteReleased = new Promise<void>((resolve) => {
      this.releaseExitWrite = resolve;
    });
  }

  allowExitWrite(): void {
    this.releaseExitWrite();
  }

  override async record(entry: SafeStateAuditEntry): Promise<void> {
    if (entry.transition === "EXIT_REQUESTED") {
      this.exitWriteAttempts += 1;
      this.markExitWriteStarted();
      await this.exitWriteReleased;
    }
    await super.record(entry);
  }
}

class BlockingExitedAudit extends FakeAudit {
  readonly exitedWriteStarted: Promise<void>;
  private markStarted!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    super();
    this.exitedWriteStarted = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  allowExitedWrite(): void {
    this.release();
  }

  override async record(entry: SafeStateAuditEntry): Promise<void> {
    if (entry.transition === "EXITED") {
      this.markStarted();
      await this.released;
    }
    await super.record(entry);
  }
}

function makeConfig(overrides: Partial<SafeStateConfig> = {}): SafeStateConfig {
  return {
    enabled: true,
    tickBudgetMs: 10,
    consecutiveMissesBeforeSafeState: 3,
    safeState: "hold-last",
    ...overrides,
  };
}

// ─── Watchdog trip logic ─────────────────────────────────────────────────────

describe("Watchdog — tick budget tripping", () => {
  let runtime: FakeRuntime;
  let anchor: FakeAnchor;
  let audit: FakeAudit;

  beforeEach(() => {
    runtime = new FakeRuntime();
    anchor = new FakeAnchor();
    audit = new FakeAudit();
  });

  it("does not trip on in-budget ticks", async () => {
    const wd = new Watchdog(runtime, makeConfig(), anchor, audit);
    for (let i = 0; i < 10; i++) {
      const obs = await wd.observeTick(5);
      expect(obs.overBudget).toBe(false);
      expect(obs.tripped).toBe(false);
    }
    expect(wd.getConsecutiveMisses()).toBe(0);
    expect(wd.getStatus().runState).toBe("RUNNING");
    expect(anchor.events).toHaveLength(0);
  });

  it("resets the miss counter on any in-budget tick", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 3 }), anchor, audit);
    await wd.observeTick(50); // miss 1
    await wd.observeTick(50); // miss 2
    expect(wd.getConsecutiveMisses()).toBe(2);
    const recovery = await wd.observeTick(5); // healthy -> reset
    expect(recovery.consecutiveMisses).toBe(0);
    expect(wd.getConsecutiveMisses()).toBe(0);
    // Two more misses should NOT trip (counter was reset).
    await wd.observeTick(50);
    const obs = await wd.observeTick(50);
    expect(obs.tripped).toBe(false);
    expect(wd.getStatus().runState).toBe("RUNNING");
  });

  it("trips after exactly N consecutive over-budget ticks", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 3 }), anchor, audit);
    const o1 = await wd.observeTick(20);
    const o2 = await wd.observeTick(20);
    expect(o1.tripped).toBe(false);
    expect(o2.tripped).toBe(false);
    const o3 = await wd.observeTick(20);
    expect(o3.tripped).toBe(true);
    expect(o3.consecutiveMisses).toBe(3);
    expect(wd.getStatus().runState).toBe("SAFE_STATE");
  });

  it("halts the blueprint and applies the declared safe state on trip", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 2 }), anchor, audit);
    await wd.observeTick(20);
    await wd.observeTick(20);
    expect(runtime.halted).toBe(true);
    expect(runtime.heldLast).toBe(true); // safeState: hold-last
  });

  it("anchors a CRITICAL SafeStateEntered event on trip", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 2 }), anchor, audit);
    await wd.observeTick(20);
    await wd.observeTick(20);
    expect(anchor.events).toHaveLength(1);
    const ev = anchor.events[0];
    expect(ev.eventType).toBe("SafeStateEntered");
    expect(ev.severity).toBe("CRITICAL");
    expect(ev.siteId).toBe("site-1");
    expect(ev.data.blueprintId).toBe("bp-test");
    expect(ev.data.consecutiveMisses).toBe(2);
  });

  it("audits the entry transition", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 2 }), anchor, audit);
    await wd.observeTick(20);
    await wd.observeTick(20);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0];
    expect(entry.transition).toBe("ENTERED");
    expect(entry.blueprintId).toBe("bp-test");
    expect(entry.consecutiveMisses).toBe(2);
    expect(entry.anchorHash).toBeTruthy();
  });

  it("does not re-trip once already in safe state", async () => {
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 2 }), anchor, audit);
    await wd.observeTick(20);
    await wd.observeTick(20);
    expect(anchor.events).toHaveLength(1);
    // Further over-budget ticks while safe must not anchor again.
    const obs = await wd.observeTick(99);
    expect(obs.tripped).toBe(false);
    expect(anchor.events).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
  });

  it("is disarmed when config.enabled is false", async () => {
    const wd = new Watchdog(runtime, makeConfig({ enabled: false, consecutiveMissesBeforeSafeState: 1 }), anchor, audit);
    const obs = await wd.observeTick(9999);
    expect(obs.tripped).toBe(false);
    expect(wd.getStatus().runState).toBe("RUNNING");
    expect(anchor.events).toHaveLength(0);
  });
});

// ─── Safe-state actions ──────────────────────────────────────────────────────

describe("SafeStateController — safe state actions", () => {
  it("hold-last freezes outputs", async () => {
    const runtime = new FakeRuntime();
    const ctl = new SafeStateController(runtime, makeConfig({ safeState: "hold-last" }), new FakeAnchor(), new FakeAudit());
    await ctl.enterSafeState("test", 3);
    expect(runtime.heldLast).toBe(true);
    expect(runtime.forcedZero).toBe(false);
  });

  it("force-zero drives outputs to zero", async () => {
    const runtime = new FakeRuntime();
    const ctl = new SafeStateController(runtime, makeConfig({ safeState: "force-zero" }), new FakeAnchor(), new FakeAudit());
    await ctl.enterSafeState("test", 3);
    expect(runtime.forcedZero).toBe(true);
    expect(runtime.heldLast).toBe(false);
  });

  it("recipe applies the named safe recipe", async () => {
    const runtime = new FakeRuntime();
    const action: SafeStateAction = { recipe: "shutdown-v2" };
    const ctl = new SafeStateController(runtime, makeConfig({ safeState: action }), new FakeAnchor(), new FakeAudit());
    await ctl.enterSafeState("test", 3);
    expect(runtime.appliedRecipe).toBe("shutdown-v2");
  });

  it("falls back to a computed content hash when anchoring fails", async () => {
    const runtime = new FakeRuntime();
    const anchor = new FakeAnchor();
    anchor.failNext = true;
    const audit = new FakeAudit();
    const ctl = new SafeStateController(runtime, makeConfig(), anchor, audit);
    const status = await ctl.enterSafeState("anchor down", 3);
    // Physical safe state still applied + audited despite anchor failure.
    expect(runtime.heldLast).toBe(true);
    expect(status.anchorHash).toBeTruthy();
    expect(audit.entries[0].anchorHash).toBe(status.anchorHash);
  });

  it("fails loudly while leaving physical outputs safe when audit persistence fails", async () => {
    const runtime = new FakeRuntime();
    const audit = new FakeAudit();
    audit.failNext = true;
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );

    await expect(ctl.enterSafeState("trip", 3)).rejects.toThrow(
      /audit database unavailable/,
    );

    expect(runtime.halted).toBe(true);
    expect(runtime.forcedZero).toBe(true);
    expect(ctl.getStatus().runState).toBe("SAFE_STATE");
    expect(ctl.getStatus().entryAuditStatus).toBe("pending");

    // An undurable entry blocks resume. Once the same entry is persisted, the
    // controller may proceed without duplicating the physical trip.
    audit.failNext = true;
    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /audit database unavailable/,
    );
    expect(runtime.resumeCalls).toBe(0);
    await expect(ctl.resume("operator-a")).resolves.toMatchObject({
      runState: "RUNNING",
    });
    expect(audit.entries.filter((entry) => entry.transition === "ENTERED"))
      .toHaveLength(1);
  });
});

// ─── Operator resume ─────────────────────────────────────────────────────────

describe("SafeStateController — operator resume", () => {
  it("requires safe state to be active before resuming", async () => {
    const ctl = new SafeStateController(new FakeRuntime(), makeConfig(), new FakeAnchor(), new FakeAudit());
    await expect(ctl.resume("operator-a")).rejects.toThrow(/not in safe state/);
  });

  it("requires an operator identity", async () => {
    const ctl = new SafeStateController(new FakeRuntime(), makeConfig(), new FakeAnchor(), new FakeAudit());
    await ctl.enterSafeState("trip", 3);
    await expect(ctl.resume("")).rejects.toThrow(/operator identity/);
  });

  it("resumes, anchors SafeStateExited, and audits the exit", async () => {
    const runtime = new FakeRuntime();
    const anchor = new FakeAnchor();
    const audit = new FakeAudit();
    const ctl = new SafeStateController(runtime, makeConfig(), anchor, audit);
    await ctl.enterSafeState("trip", 3);
    const status = await ctl.resume("operator-a", "condition cleared");
    expect(status.runState).toBe("RUNNING");
    expect(runtime.resumed).toBe(true);
    const exitEvent = anchor.events.find((e) => e.eventType === "SafeStateExited");
    expect(exitEvent).toBeDefined();
    expect(exitEvent?.severity).toBe("WARNING");
    expect(exitEvent?.data.operator).toBe("operator-a");
    const exitAudit = audit.entries.find((e) => e.transition === "EXITED");
    expect(exitAudit?.operator).toBe("operator-a");
    // The EXITED audit row carries the safe state that had been applied and the
    // configured budget, so the audit trail is self-describing without joins.
    expect(exitAudit?.safeState).toBe("hold-last");
    expect(exitAudit?.tickBudgetMs).toBe(10);
    expect(exitAudit?.reason).toBe("condition cleared");
  });

  it("clears trip metadata from status on resume", async () => {
    const ctl = new SafeStateController(new FakeRuntime(), makeConfig(), new FakeAnchor(), new FakeAudit());
    await ctl.enterSafeState("trip", 4);
    const tripped = ctl.getStatus();
    expect(tripped.reason).toBe("trip");
    expect(tripped.enteredAt).toBeTruthy();
    expect(tripped.consecutiveMisses).toBe(4);
    expect(tripped.anchorHash).toBeTruthy();

    const resumed = await ctl.resume("operator-a");
    // A resumed blueprint must not advertise stale trip metadata, or the UI
    // would keep showing details from the previous (now-cleared) safe state.
    expect(resumed.runState).toBe("RUNNING");
    expect(resumed.reason).toBeUndefined();
    expect(resumed.enteredAt).toBeUndefined();
    expect(resumed.consecutiveMisses).toBeUndefined();
    expect(resumed.anchorHash).toBeUndefined();
  });

  it("keeps the declared safe state when exit authorisation cannot persist", async () => {
    const runtime = new FakeRuntime();
    const audit = new FakeAudit();
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);
    audit.failNext = true;

    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /audit database unavailable/,
    );

    expect(runtime.halted).toBe(true);
    expect(runtime.forcedZero).toBe(true);
    expect(runtime.resumeCalls).toBe(0);
    expect(runtime.resumed).toBe(false);
    expect(ctl.getStatus().runState).toBe("SAFE_STATE");

    // A rejected transition must not poison the serial queue; an operator can
    // retry once durable audit storage is healthy again.
    await expect(ctl.resume("operator-b", "audit recovered")).resolves.toMatchObject({
      runState: "RUNNING",
    });
    expect(runtime.resumeCalls).toBe(1);
  });

  it("returns to safe state when resume succeeds but the EXITED audit fails", async () => {
    const runtime = new FakeRuntime();
    const audit = new FakeAudit();
    const originalRecord = audit.record.bind(audit);
    let failExit = true;
    audit.record = async (entry) => {
      if (entry.transition === "EXITED" && failExit) {
        failExit = false;
        throw new Error("exit audit unavailable");
      }
      await originalRecord(entry);
    };
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);

    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /exit audit unavailable/,
    );

    expect(runtime.resumeCalls).toBe(1);
    expect(runtime.halted).toBe(true);
    expect(runtime.forcedZero).toBe(true);
    expect(ctl.getStatus().runState).toBe("SAFE_STATE");
    expect(audit.entries.some((entry) => entry.transition === "EXITED")).toBe(false);
    expect(audit.entries.some((entry) => entry.transition === "EXIT_ABORTED")).toBe(true);

    await expect(ctl.resume("operator-b", "audit recovered")).resolves.toMatchObject({
      runState: "RUNNING",
    });
    expect(runtime.resumeCalls).toBe(2);
  });

  it("records RESUME_FAILED and no EXITED when the runtime cannot resume", async () => {
    const runtime = new FakeRuntime();
    runtime.failResume = true;
    const audit = new FakeAudit();
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);

    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /runtime resume failed/,
    );

    expect(runtime.halted).toBe(true);
    expect(ctl.getStatus().runState).toBe("SAFE_STATE");
    expect(audit.entries.some((entry) => entry.transition === "EXITED")).toBe(false);
    expect(audit.entries.some((entry) => entry.transition === "RESUME_FAILED")).toBe(true);
  });

  it("reports RESUMING while the live runtime waits for a durable EXITED row", async () => {
    const runtime = new FakeRuntime();
    const audit = new BlockingExitedAudit();
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);

    const resume = ctl.resume("operator-a");
    await audit.exitedWriteStarted;

    expect(runtime.resumed).toBe(true);
    expect(ctl.getStatus().runState).toBe("RESUMING");

    audit.allowExitedWrite();
    await expect(resume).resolves.toMatchObject({ runState: "RUNNING" });
  });

  it("attempts halt and safe outputs independently and reports failed recovery", async () => {
    const runtime = new FakeRuntime();
    const audit = new FakeAudit();
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);
    const safeCallsBeforeResume = runtime.safeActionCalls;
    runtime.failResume = true;
    runtime.failHalt = true;
    runtime.failSafeAction = true;

    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /safety recovery was incomplete/,
    );

    expect(runtime.safeActionCalls).toBe(safeCallsBeforeResume + 1);
    expect(ctl.getStatus()).toMatchObject({
      runState: "RECOVERY_FAILED",
      recoveryErrors: [
        expect.stringMatching(/halt failed/),
        expect.stringMatching(/safe-output application failed/),
      ],
    });
    expect(audit.entries.some((entry) => entry.transition === "RECOVERY_FAILED"))
      .toBe(true);
  });

  it("retries an ambiguously committed exit request with the same anchor hash", async () => {
    const runtime = new FakeRuntime();
    const audit = new FakeAudit();
    const attemptedHashes: string[] = [];
    let throwAfterFirstCommit = true;
    const originalRecord = audit.record.bind(audit);
    audit.record = async (entry) => {
      if (entry.transition === "EXIT_REQUESTED") {
        attemptedHashes.push(entry.anchorHash);
        if (throwAfterFirstCommit) {
          throwAfterFirstCommit = false;
          audit.entries.push(entry);
          throw new Error("ambiguous database acknowledgement");
        }
        if (audit.entries.some((existing) =>
          existing.anchorHash === entry.anchorHash
        )) {
          return;
        }
      }
      await originalRecord(entry);
    };
    const ctl = new SafeStateController(
      runtime,
      makeConfig(),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);

    await expect(ctl.resume("operator-a")).rejects.toThrow(
      /ambiguous database acknowledgement/,
    );
    expect(runtime.resumeCalls).toBe(0);

    await expect(ctl.resume("operator-b")).resolves.toMatchObject({
      runState: "RUNNING",
    });
    expect(attemptedHashes).toHaveLength(3);
    expect(attemptedHashes[1]).toBe(attemptedHashes[0]);
    expect(attemptedHashes[2]).not.toBe(attemptedHashes[0]);
  });

  it("serializes concurrent resumes and enables the runtime only after exit authorisation persists", async () => {
    const runtime = new FakeRuntime();
    const audit = new BlockingExitAudit();
    const ctl = new SafeStateController(
      runtime,
      makeConfig({ safeState: "force-zero" }),
      new FakeAnchor(),
      audit,
    );
    await ctl.enterSafeState("trip", 3);

    const firstResume = ctl.resume("operator-a", "condition cleared");
    await audit.exitWriteStarted;

    const secondResume = ctl.resume("operator-b", "duplicate request");
    const secondOutcome = secondResume.then(
      (value) => ({ value, error: null as Error | null }),
      (error: Error) => ({ value: null, error }),
    );

    expect(runtime.resumeCalls).toBe(0);
    expect(runtime.halted).toBe(true);
    expect(audit.exitWriteAttempts).toBe(1);
    expect(ctl.getStatus().runState).toBe("SAFE_STATE");

    audit.allowExitWrite();
    await expect(firstResume).resolves.toMatchObject({ runState: "RUNNING" });

    const duplicate = await secondOutcome;
    expect(duplicate.value).toBeNull();
    expect(duplicate.error?.message).toMatch(/not in safe state/);
    expect(runtime.resumeCalls).toBe(1);
    expect(audit.exitWriteAttempts).toBe(1);
    expect(audit.entries.filter((entry) => entry.transition === "EXITED")).toHaveLength(1);
    expect(ctl.getStatus().runState).toBe("RUNNING");
  });

  it("Watchdog.resume clears the miss counter and re-arms", async () => {
    const runtime = new FakeRuntime();
    const wd = new Watchdog(runtime, makeConfig({ consecutiveMissesBeforeSafeState: 2 }), new FakeAnchor(), new FakeAudit());
    await wd.observeTick(20);
    await wd.observeTick(20);
    expect(wd.getStatus().runState).toBe("SAFE_STATE");
    await wd.resume("operator-b");
    expect(wd.getConsecutiveMisses()).toBe(0);
    expect(wd.getStatus().runState).toBe("RUNNING");
    // Re-armed: a fresh streak can trip again.
    await wd.observeTick(20);
    const obs = await wd.observeTick(20);
    expect(obs.tripped).toBe(true);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("WatchdogRegistry", () => {
  it("tracks, fetches and removes per-blueprint watchdogs", async () => {
    const registry = new WatchdogRegistry(new FakeAnchor(), new FakeAudit());
    const rt = new FakeRuntime("bp-a", "site-a");
    const wd = registry.register(rt, makeConfig({ consecutiveMissesBeforeSafeState: 1 }));
    expect(registry.get("bp-a")).toBe(wd);
    expect(registry.getAllStatuses()).toHaveLength(1);
    expect(registry.getSafeStateStatuses()).toHaveLength(0);

    await wd.observeTick(999); // trip (N=1)
    expect(registry.getSafeStateStatuses()).toHaveLength(1);

    registry.unregister("bp-a");
    expect(registry.get("bp-a")).toBeUndefined();
    expect(registry.getAllStatuses()).toHaveLength(0);
  });

  it("surfaces a recipe safe state as badge-renderable status", async () => {
    const registry = new WatchdogRegistry(new FakeAnchor(), new FakeAudit());
    const rt = new FakeRuntime("bp-recipe", "site-r");
    const action: SafeStateAction = { recipe: "purge-and-vent" };
    const wd = registry.register(
      rt,
      makeConfig({ consecutiveMissesBeforeSafeState: 1, safeState: action }),
    );
    await wd.observeTick(999);

    expect(rt.appliedRecipe).toBe("purge-and-vent");
    const [status] = registry.getSafeStateStatuses();
    expect(status.runState).toBe("SAFE_STATE");
    // The recipe object must survive serialisation intact so the badge can
    // render `Safe recipe: purge-and-vent`.
    expect(status.safeState).toEqual({ recipe: "purge-and-vent" });
    expect(describeSafeState(status.safeState)).toMatch(/purge-and-vent/);
  });

  it("refuses to arm a blueprint whose declared safe state is not actuatable", () => {
    const registry = new WatchdogRegistry(new FakeAnchor(), new FakeAudit());
    const rt = new FakeRuntime("bp-unactuatable", "site-x");
    rt.unsupported.add("force-zero");

    expect(() =>
      registry.register(rt, makeConfig({ safeState: "force-zero" })),
    ).toThrow(/cannot actuate force-zero/);
    // Fail-closed: nothing is registered, so nothing can report itself guarded.
    expect(registry.get("bp-unactuatable")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("skips the tick body once the blueprint is in safe state", async () => {
    const registry = new WatchdogRegistry(new FakeAnchor(), new FakeAudit());
    const rt = new FakeRuntime("bp-halt", "site-h");
    const wd = registry.register(
      rt,
      makeConfig({ tickBudgetMs: 1, consecutiveMissesBeforeSafeState: 1 }),
    );

    let executions = 0;
    const first = await wd.runTick(() => {
      executions += 1;
      return 1;
    });
    expect(first.skipped).toBe(false);
    expect(executions).toBe(1);

    await wd.observeTick(500); // trip
    expect(rt.halted).toBe(true);

    const second = await wd.runTick(() => {
      executions += 1;
      return 2;
    });
    expect(second.skipped).toBe(true);
    expect(second.result).toBeUndefined();
    expect(executions).toBe(1);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("describeSafeState labels each action", () => {
    expect(describeSafeState("hold-last")).toMatch(/hold last/i);
    expect(describeSafeState("force-zero")).toMatch(/zero/i);
    expect(describeSafeState({ recipe: "r1" })).toMatch(/r1/);
  });

  it("computeAnchorHash is deterministic and content-sensitive", () => {
    const base: AnchorEvent = {
      id: "fixed-id",
      timestamp: "2026-06-22T00:00:00.000Z",
      eventType: "SafeStateEntered",
      severity: "CRITICAL",
      siteId: "site-1",
      message: "m",
      data: { a: 1 },
    };
    expect(computeAnchorHash(base)).toBe(computeAnchorHash({ ...base }));
    expect(computeAnchorHash(base)).not.toBe(computeAnchorHash({ ...base, message: "different" }));
  });
});

// ─── Verification scenario (from the issue) ──────────────────────────────────

describe("Verification: artificial pause -> watchdog fires -> SafeStateEntered -> badge data", () => {
  it("trips after N consecutive misses and yields badge-renderable status", async () => {
    const runtime = new FakeRuntime("dosing-loop", "plant-7");
    const anchor = new FakeAnchor();
    const audit = new FakeAudit();
    const registry = new WatchdogRegistry(anchor, audit);
    const config = makeConfig({ tickBudgetMs: 10, consecutiveMissesBeforeSafeState: 3, safeState: "force-zero" });
    const wd = registry.register(runtime, config);

    // Healthy ticks first.
    await wd.runTick(() => 0);

    // Inject an artificial pause that blows the 10ms budget, sustained for N ticks.
    const pause = (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* busy-wait to simulate an over-budget control tick */
      }
    };
    let lastTripped = false;
    for (let i = 0; i < 3; i++) {
      const { observation } = await wd.runTick(() => pause(15));
      lastTripped = observation.tripped;
    }

    // Watchdog fired.
    expect(lastTripped).toBe(true);

    // A SafeStateEntered CRITICAL event was produced via the anchor backend.
    const entered = anchor.events.find((e) => e.eventType === "SafeStateEntered");
    expect(entered).toBeDefined();
    expect(entered?.severity).toBe("CRITICAL");

    // The transition was audited.
    expect(audit.entries.some((e) => e.transition === "ENTERED")).toBe(true);

    // The registry exposes badge-renderable status for the operator UI.
    const safe = registry.getSafeStateStatuses();
    expect(safe).toHaveLength(1);
    expect(safe[0]).toMatchObject({
      blueprintId: "dosing-loop",
      siteId: "plant-7",
      runState: "SAFE_STATE",
      safeState: "force-zero",
    });
    expect(safe[0].anchorHash).toBeTruthy();
    expect(safe[0].enteredAt).toBeTruthy();
  });
});
