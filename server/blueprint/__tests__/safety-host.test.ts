/**
 * WatchdogRegistry.register() must be reached from the production path (#459).
 *
 * The composition root under test is the same one server/index.ts starts at
 * boot. These tests assert that:
 *   - with no bindings configured the host reports DISABLED with a reason that
 *     says *nothing is loaded* (not "nothing ever registers"),
 *   - with bindings configured a watchdog is really registered and ticked,
 *   - a trip halts the real actuator and stops further ticks,
 *   - a binding whose safe state cannot be actuated is refused (fail-closed).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BlueprintSafetyHost, SAFETY_BINDINGS_ENV, SAFETY_BINDINGS_FILE_ENV } from "../safety-host";
import { WatchdogRegistry } from "../registry";
import { OUTPUT_WRITE_OPT_IN_ENV } from "../runtime-actuator";
import {
  computeAnchorHash,
  type AnchorBackend,
  type AnchorEvent,
  type AnchorReceipt,
  type SafeStateAuditEntry,
  type SafeStateAuditSink,
} from "../safe-state";

class CapturingAnchor implements AnchorBackend {
  readonly events: AnchorEvent[] = [];
  async anchor(event: AnchorEvent): Promise<AnchorReceipt> {
    this.events.push(event);
    return { hash: computeAnchorHash(event) };
  }
}

class CapturingAudit implements SafeStateAuditSink {
  readonly entries: SafeStateAuditEntry[] = [];
  async record(entry: SafeStateAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

const BLUEPRINT = {
  id: "bp-host",
  name: "Host fixture",
  scanPeriodMs: 50,
  tags: [
    { name: "IN_A", direction: "input", dataType: "float", initial: 6 },
    { name: "OUT_CMD", direction: "output", dataType: "float" },
  ],
  nodes: [
    { id: "n_copy", op: "MOVE", inputs: [{ tag: "IN_A" }], output: "OUT_CMD" },
  ],
};

function bindings(safeState: unknown): string {
  return JSON.stringify({
    bindings: [
      {
        siteId: "site-1",
        blueprint: BLUEPRINT,
        safeState,
      },
    ],
  });
}

const HOLD_LAST = {
  enabled: true,
  tickBudgetMs: 5,
  consecutiveMissesBeforeSafeState: 2,
  safeState: "hold-last",
};

describe("BlueprintSafetyHost", () => {
  let anchor: CapturingAnchor;
  let audit: CapturingAudit;
  let registry: WatchdogRegistry;
  let host: BlueprintSafetyHost;

  beforeEach(() => {
    anchor = new CapturingAnchor();
    audit = new CapturingAudit();
    registry = new WatchdogRegistry(anchor, audit);
    host = new BlueprintSafetyHost(registry);
  });

  afterEach(() => {
    host.stop();
  });

  it("reports DISABLED-because-nothing-is-loaded when no bindings are configured", () => {
    const status = host.start({});

    expect(status.state).toBe("DISABLED");
    expect(status.source).toBeNull();
    expect(status.reason).toContain(SAFETY_BINDINGS_FILE_ENV);
    expect(status.reason).toContain("no blueprint is loaded");
    expect(status.registeredBlueprintIds).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it("registers a watchdog and drives real ticks for a configured binding", async () => {
    const status = host.start({ [SAFETY_BINDINGS_ENV]: bindings(HOLD_LAST) });

    expect(status.state).toBe("RUNNING");
    expect(status.source).toBe(SAFETY_BINDINGS_ENV);
    expect(status.registeredBlueprintIds).toEqual(["bp-host"]);
    expect(status.actuators[0]).toMatchObject({
      blueprintId: "bp-host",
      outputSink: "runtime-tag-store",
      fieldSinkBound: false,
    });

    // register() really happened: the API-visible registry is populated.
    expect(registry.size()).toBe(1);
    expect(registry.getAllStatuses()).toEqual([
      expect.objectContaining({ blueprintId: "bp-host", runState: "RUNNING" }),
    ]);

    const runtime = host.getRuntime("bp-host")!;
    expect(runtime.ticks).toBe(0);
    await host.tickOnce("bp-host");
    expect(runtime.ticks).toBe(1);
    expect(runtime.get("OUT_CMD")).toBe(6);
  });

  it("loads bindings from a file as well as inline JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "safety-host-"));
    try {
      const file = join(directory, "bindings.json");
      writeFileSync(file, bindings(HOLD_LAST), "utf8");

      const status = host.start({ [SAFETY_BINDINGS_FILE_ENV]: file });

      expect(status.state).toBe("RUNNING");
      expect(status.source).toBe(SAFETY_BINDINGS_FILE_ENV);
      expect(registry.blueprintIds()).toEqual(["bp-host"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("halts the actuator on a trip and stops executing ticks", async () => {
    host.start({ [SAFETY_BINDINGS_ENV]: bindings(HOLD_LAST) });
    const runtime = host.getRuntime("bp-host")!;
    const actuator = host.getActuator("bp-host")!;
    const watchdog = registry.get("bp-host")!;

    await host.tickOnce("bp-host");
    const ticksBeforeTrip = runtime.ticks;

    // Two consecutive over-budget ticks trip the watchdog.
    await watchdog.observeTick(50);
    await watchdog.observeTick(50);

    expect(watchdog.getStatus().runState).toBe("SAFE_STATE");
    expect(actuator.isHalted()).toBe(true);
    expect(actuator.getOutputMode()).toBe("hold-last");
    expect(anchor.events.map((e) => e.eventType)).toContain("SafeStateEntered");
    expect(audit.entries.map((e) => e.transition)).toContain("ENTERED");

    // The halt is real: further host ticks do not execute the scan.
    await host.tickOnce("bp-host");
    await host.tickOnce("bp-host");
    expect(runtime.ticks).toBe(ticksBeforeTrip);

    // Only an operator resume restarts the loop.
    await watchdog.resume("safety-op", "condition cleared");
    expect(actuator.isHalted()).toBe(false);
    await host.tickOnce("bp-host");
    expect(runtime.ticks).toBe(ticksBeforeTrip + 1);
  });

  it("refuses to arm a force-zero blueprint without the plant-output opt-in", () => {
    const status = host.start({
      [SAFETY_BINDINGS_ENV]: bindings({ ...HOLD_LAST, safeState: "force-zero" }),
    });

    expect(status.state).toBe("FAILED");
    expect(status.registeredBlueprintIds).toEqual([]);
    expect(status.rejected).toEqual([
      { blueprintId: "bp-host", message: expect.stringContaining(OUTPUT_WRITE_OPT_IN_ENV) },
    ]);
    // Fail-closed: nothing armed, nothing ticking, nothing claimed.
    expect(registry.size()).toBe(0);
    expect(host.getRuntime("bp-host")).toBeUndefined();
  });

  it("arms a force-zero blueprint once the opt-in is present", async () => {
    const status = host.start({
      [SAFETY_BINDINGS_ENV]: bindings({ ...HOLD_LAST, safeState: "force-zero" }),
      [OUTPUT_WRITE_OPT_IN_ENV]: "true",
    });

    expect(status.state).toBe("RUNNING");
    const runtime = host.getRuntime("bp-host")!;
    const watchdog = registry.get("bp-host")!;
    await host.tickOnce("bp-host");
    expect(runtime.get("OUT_CMD")).toBe(6);

    await watchdog.observeTick(50);
    await watchdog.observeTick(50);

    // The declared safe state genuinely de-energised the output.
    expect(runtime.get("OUT_CMD")).toBe(0);
  });

  it("reports invalid binding documents instead of silently running unguarded", () => {
    const status = host.start({ [SAFETY_BINDINGS_ENV]: '{"bindings":[{"blueprint":{}}]}' });

    expect(status.state).toBe("FAILED");
    expect(status.reason).toContain("invalid");
    expect(registry.size()).toBe(0);
  });

  it("reports unreadable binding sources instead of silently running unguarded", () => {
    const status = host.start({
      [SAFETY_BINDINGS_FILE_ENV]: join(tmpdir(), "definitely-missing-bindings.json"),
    });

    expect(status.state).toBe("FAILED");
    expect(status.reason).toContain("could not be read");
    expect(registry.size()).toBe(0);
  });

  it("refuses a duplicate binding without disturbing the armed one", () => {
    const document = JSON.stringify({
      bindings: [
        { siteId: "site-1", blueprint: BLUEPRINT, safeState: HOLD_LAST },
        { siteId: "site-2", blueprint: BLUEPRINT, safeState: HOLD_LAST },
      ],
    });

    const status = host.start({ [SAFETY_BINDINGS_ENV]: document });

    expect(status.state).toBe("RUNNING");
    expect(status.registeredBlueprintIds).toEqual(["bp-host"]);
    expect(status.rejected).toEqual([
      { blueprintId: "bp-host", message: expect.stringContaining("duplicate binding") },
    ]);
    expect(host.getActuator("bp-host")!.siteId).toBe("site-1");
  });

  it("unregisters everything on stop", () => {
    host.start({ [SAFETY_BINDINGS_ENV]: bindings(HOLD_LAST) });
    expect(registry.size()).toBe(1);

    host.stop();

    expect(registry.size()).toBe(0);
    expect(host.getStatus().state).toBe("DISABLED");
  });
});
