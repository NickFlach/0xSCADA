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
  type BlueprintRuntime,
  type SafeStateAuditEntry,
  type SafeStateAuditSink,
} from "../blueprint/safe-state";
import { Watchdog } from "../blueprint/watchdog";
import { WatchdogRegistry } from "../blueprint/index";
import type { SafeStateConfig, SafeStateAction } from "@shared/schema";

// ─── In-memory fakes ─────────────────────────────────────────────────────────

class FakeRuntime implements BlueprintRuntime {
  readonly blueprintId: string;
  readonly siteId?: string;
  halted = false;
  resumed = false;
  heldLast = false;
  forcedZero = false;
  appliedRecipe: string | null = null;

  constructor(blueprintId = "bp-test", siteId = "site-1") {
    this.blueprintId = blueprintId;
    this.siteId = siteId;
  }

  halt(): void {
    this.halted = true;
  }
  resume(): void {
    this.resumed = true;
    this.halted = false;
  }
  holdLastOutputs(): void {
    this.heldLast = true;
  }
  forceZeroOutputs(): void {
    this.forcedZero = true;
  }
  applySafeRecipe(recipe: string): void {
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
  async record(entry: SafeStateAuditEntry): Promise<void> {
    this.entries.push(entry);
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
    expect(exitEvent?.data.operator).toBe("operator-a");
    const exitAudit = audit.entries.find((e) => e.transition === "EXITED");
    expect(exitAudit?.operator).toBe("operator-a");
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
