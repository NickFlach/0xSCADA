/**
 * Control-loop host tests — Issue #457.
 *
 * Covers the properties that make the loop safe to ship:
 *   - disabled by default, and not switchable on by an accidental truthy value;
 *   - when enabled it really executes the compiled program (inputs in → computed
 *     outputs out) and advances its counters;
 *   - stop() clears its timer and leaks nothing;
 *   - a malformed / oversized / uncompilable blueprint fails CLOSED with a clear
 *     error and cannot take down startup;
 *   - health and Prometheus surfaces report the truth in each of those states.
 *
 * These are real timer tests against real files: no fake timers, no mocked fs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlueprintControlLoop,
  BlueprintControlLoopError,
  describeBlueprintControlLoopHealth,
  getBlueprintControlLoop,
  loadBlueprintControlLoopConfig,
  startBlueprintControlLoop,
  type BlueprintControlLoopStatus,
} from "../control-loop";
import { registry } from "../../metrics/prometheus";
import type { BlueprintDefinition } from "../types";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** SUM = A + B, plus a latch that sets itself on the first scan. */
const ADDER: BlueprintDefinition = {
  id: "adder",
  name: "Two-input adder",
  tags: [
    { name: "A", direction: "input", dataType: "float", initial: 0 },
    { name: "B", direction: "input", dataType: "float", initial: 0 },
    { name: "ALWAYS", direction: "internal", dataType: "bool", initial: 1 },
    { name: "SUM", direction: "output", dataType: "float" },
    { name: "HEARTBEAT", direction: "output", dataType: "bool" },
  ],
  nodes: [
    { id: "sum", op: "ADD", inputs: [{ tag: "A" }, { tag: "B" }], output: "SUM" },
    {
      id: "hb",
      op: "LATCH",
      inputs: [{ tag: "ALWAYS" }, { const: 0 }],
      output: "HEARTBEAT",
    },
  ],
  scanPeriodMs: 5,
};

const tempDirs: string[] = [];
const liveLoops: BlueprintControlLoop[] = [];

function writeDefinition(contents: string, filename = "blueprint.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "blueprint-control-loop-"));
  tempDirs.push(dir);
  const path = join(dir, filename);
  writeFileSync(path, contents, "utf8");
  return path;
}

function writeBlueprint(def: BlueprintDefinition): string {
  return writeDefinition(JSON.stringify(def));
}

/** Build a loop from an explicit env map so no test depends on the real env. */
function makeLoop(env: NodeJS.ProcessEnv): BlueprintControlLoop {
  const loop = new BlueprintControlLoop(loadBlueprintControlLoopConfig(env));
  liveLoops.push(loop);
  return loop;
}

function enabledEnv(path: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BLUEPRINT_CONTROL_LOOP_ENABLED: "true",
    BLUEPRINT_CONTROL_LOOP_DEFINITION: path,
    ...extra,
  };
}

/** Poll until the predicate holds or the budget expires. Real timers. */
async function waitFor(predicate: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

afterEach(() => {
  // Never leave a scan timer armed, even if an expectation threw mid-test.
  while (liveLoops.length > 0) liveLoops.pop()?.stop();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ── Configuration gating ────────────────────────────────────────────────────

describe("BlueprintControlLoop — configuration gating", () => {
  it("is disabled when no environment variables are set", () => {
    const config = loadBlueprintControlLoopConfig({});
    expect(config.enabled).toBe(false);
    expect(config.definitionPath).toBeNull();
  });

  it("refuses to enable on anything other than the exact string \"true\"", () => {
    for (const value of ["1", "yes", "on", "TRUE", "True", "true ", ""]) {
      const config = loadBlueprintControlLoopConfig({
        BLUEPRINT_CONTROL_LOOP_ENABLED: value,
        BLUEPRINT_CONTROL_LOOP_DEFINITION: "/nonexistent.json",
      });
      expect(config.enabled).toBe(false);
    }
  });

  it("enables only on the exact opt-in string", () => {
    const config = loadBlueprintControlLoopConfig({
      BLUEPRINT_CONTROL_LOOP_ENABLED: "true",
      BLUEPRINT_CONTROL_LOOP_DEFINITION: "/some/blueprint.json",
    });
    expect(config.enabled).toBe(true);
    expect(config.definitionPath).toBe("/some/blueprint.json");
  });

  it("rejects an unparseable numeric override instead of silently defaulting", () => {
    expect(() =>
      loadBlueprintControlLoopConfig({ BLUEPRINT_CONTROL_LOOP_PERIOD_MS: "not-a-number" }),
    ).toThrow(BlueprintControlLoopError);
  });

  it("arms no timer when disabled", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const loop = makeLoop({});

    expect(loop.start()).toBe(false);
    expect(loop.isRunning).toBe(false);
    expect(loop.status().state).toBe("disabled");
    expect(setInterval).not.toHaveBeenCalled();

    await sleep(30);
    expect(loop.status().ticks).toBe(0);
  });

  it("the process singleton is disabled under the ambient test environment", () => {
    const loop = startBlueprintControlLoop();
    expect(loop.isRunning).toBe(false);
    expect(getBlueprintControlLoop()).toBe(loop);
  });
});

// ── Running ─────────────────────────────────────────────────────────────────

describe("BlueprintControlLoop — enabled by flag", () => {
  it("runs scans on a fixed cadence and advances its counters", async () => {
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));

    expect(loop.start()).toBe(true);
    expect(loop.isRunning).toBe(true);

    await waitFor(() => loop.status().ticks >= 5);

    const status = loop.status();
    expect(status.state).toBe("running");
    expect(status.blueprintId).toBe("adder");
    expect(status.scanPeriodMs).toBe(5);
    expect(status.ticks).toBeGreaterThanOrEqual(5);
    expect(status.windowSamples).toBeGreaterThanOrEqual(5);
    expect(status.lastTickDurationMs).not.toBeNull();
    expect(Number.isFinite(status.lastTickDurationMs ?? Number.NaN)).toBe(true);
    expect(status.lastTickDurationMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(status.p50Ms).not.toBeNull();
    expect(status.p99Ms).not.toBeNull();
    expect(status.p99Ms ?? -1).toBeGreaterThanOrEqual(status.p50Ms ?? 0);
    expect(status.maxMs ?? -1).toBeGreaterThanOrEqual(status.p99Ms ?? 0);
    expect(status.loadFailures).toBe(0);
    expect(status.lastError).toBeNull();
  });

  it("really executes the compiled program (inputs are read, outputs computed)", async () => {
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));
    loop.start();

    expect(loop.inputCount).toBe(2);
    expect(loop.outputCount).toBe(2);

    // Stateful op advanced by the loop itself, with no external input at all.
    await waitFor(() => loop.getTagValue("HEARTBEAT") === 1);

    // Field-IN direction: values written between scans are consumed by the
    // next scan and show up in the computed outputs.
    loop.writeInputs(Float64Array.from([2, 40]));
    const before = loop.status().ticks;
    await waitFor(() => loop.status().ticks > before + 1);

    const outputs = new Float64Array(loop.outputCount);
    loop.readOutputs(outputs);
    expect(loop.getTagValue("SUM")).toBe(42);
    expect(Array.from(outputs)).toEqual([42, 1]);
  });

  it("start() is idempotent and arms exactly one timer", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));

    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(true);

    expect(setInterval).toHaveBeenCalledTimes(1);
    await waitFor(() => loop.status().ticks >= 3);
    expect(loop.isRunning).toBe(true);
  });

  it("honours a scan-period override and compiles the blueprint with it", async () => {
    const loop = makeLoop(
      enabledEnv(writeBlueprint(ADDER), { BLUEPRINT_CONTROL_LOOP_PERIOD_MS: "20" }),
    );
    loop.start();

    // The override must reach the compiled program, not just the timer, so that
    // stateful ops integrate with the same dt the scheduler actually uses.
    expect(loop.status().scanPeriodMs).toBe(20);

    const startedAt = Date.now();
    await waitFor(() => loop.status().ticks >= 3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe("BlueprintControlLoop — stop()", () => {
  it("clears its interval and stops ticking", async () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));
    loop.start();
    await waitFor(() => loop.status().ticks >= 3);

    loop.stop();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(loop.isRunning).toBe(false);
    expect(loop.status().state).toBe("stopped");

    const ticksAtStop = loop.status().ticks;
    await sleep(50); // ≥ 10 scan periods
    expect(loop.status().ticks).toBe(ticksAtStop);
  });

  it("is idempotent and does not clear a timer twice", async () => {
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));
    loop.start();
    await waitFor(() => loop.status().ticks >= 1);

    loop.stop();
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    loop.stop();
    loop.stop();
    expect(clearInterval).not.toHaveBeenCalled();
    expect(loop.status().state).toBe("stopped");
  });

  it("can be restarted after a stop and keeps counting", async () => {
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));
    loop.start();
    await waitFor(() => loop.status().ticks >= 2);
    loop.stop();

    const ticksAtStop = loop.status().ticks;
    expect(loop.start()).toBe(true);
    await waitFor(() => loop.status().ticks > ticksAtStop + 1);
    expect(loop.status().state).toBe("running");
  });
});

// ── Fail-closed load ────────────────────────────────────────────────────────

describe("BlueprintControlLoop — fails closed at load", () => {
  function expectFailedClosed(loop: BlueprintControlLoop, ...fragments: string[]): void {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    let thrown: unknown;
    try {
      loop.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BlueprintControlLoopError);
    for (const fragment of fragments) {
      expect((thrown as Error).message).toContain(fragment);
    }
    expect(setInterval).not.toHaveBeenCalled();

    const status = loop.status();
    expect(status.state).toBe("failed");
    expect(status.running).toBe(false);
    expect(status.loadFailures).toBe(1);
    expect(status.lastError).toContain(fragments[0] ?? "");
  }

  it("rejects an enabled loop with no definition path", () => {
    expectFailedClosed(
      makeLoop({ BLUEPRINT_CONTROL_LOOP_ENABLED: "true" }),
      "BLUEPRINT_CONTROL_LOOP_DEFINITION",
    );
  });

  it("rejects a missing file", () => {
    // Reported by `open` rather than `stat` since the size check moved onto the
    // descriptor; the message still names the file and carries the errno.
    const missing = join(tmpdir(), "definitely-not-here-457.json");
    expectFailedClosed(makeLoop(enabledEnv(missing)), "cannot read blueprint definition");
  });

  it("rejects invalid JSON", () => {
    expectFailedClosed(makeLoop(enabledEnv(writeDefinition("{ not json"))), "not valid JSON");
  });

  it("rejects a schema violation (unknown op)", () => {
    const path = writeDefinition(
      JSON.stringify({
        ...ADDER,
        nodes: [{ id: "x", op: "TELEPORT", inputs: [{ tag: "A" }], output: "SUM" }],
      }),
    );
    expectFailedClosed(makeLoop(enabledEnv(path)), "rejected", "schema validation failed");
  });

  it("rejects unknown fields rather than ignoring them", () => {
    const path = writeDefinition(JSON.stringify({ ...ADDER, exploit: "payload" }));
    expectFailedClosed(makeLoop(enabledEnv(path)), "rejected");
  });

  it("rejects a blueprint that exceeds the configured node ceiling", () => {
    const path = writeBlueprint(ADDER);
    expectFailedClosed(
      makeLoop(enabledEnv(path, { BLUEPRINT_CONTROL_LOOP_MAX_NODES: "1" })),
      "exceeding the configured maximum of 1",
    );
  });

  it("rejects an oversized file before parsing it", () => {
    // Structurally valid, just too big: size is the only reason it is rejected.
    const path = writeBlueprint({ ...ADDER, name: "x".repeat(2_000) });
    expectFailedClosed(
      makeLoop(enabledEnv(path, { BLUEPRINT_CONTROL_LOOP_MAX_BYTES: "1024" })),
      "exceeding the configured maximum of 1024 bytes",
    );
  });

  it("rejects a semantically invalid blueprint the compiler refuses", () => {
    const path = writeDefinition(
      JSON.stringify({
        ...ADDER,
        nodes: [
          { id: "a", op: "MOVE", inputs: [{ tag: "A" }], output: "SUM" },
          { id: "b", op: "MOVE", inputs: [{ tag: "B" }], output: "SUM" },
        ],
      }),
    );
    expectFailedClosed(makeLoop(enabledEnv(path)), "failed to compile", "multiple drivers");
  });

  it("tryStart() swallows the failure so startup survives a bad blueprint", async () => {
    const loop = makeLoop(enabledEnv(join(tmpdir(), "definitely-not-here-457.json")));

    expect(() => loop.tryStart()).not.toThrow();
    expect(loop.tryStart()).toBe(false);
    expect(loop.isRunning).toBe(false);
    expect(loop.status().state).toBe("failed");

    await sleep(30);
    expect(loop.status().ticks).toBe(0);
  });

  it("an unparseable configuration yields a disabled loop, not an exception", () => {
    const loop = BlueprintControlLoop.failedToConfigure(new Error("BOOM"));
    liveLoops.push(loop);

    expect(loop.tryStart()).toBe(false);
    expect(loop.isRunning).toBe(false);

    const status = loop.status();
    expect(status.state).toBe("failed");
    expect(status.enabled).toBe(false);
    expect(status.lastError).toBe("BOOM");
  });

  it("has no loaded blueprint to marshal IO against", () => {
    const loop = makeLoop({});
    expect(() => loop.writeInputs(Float64Array.from([1]))).toThrow(BlueprintControlLoopError);
    expect(() => loop.readOutputs(new Float64Array(1))).toThrow(BlueprintControlLoopError);
    expect(() => loop.getTagValue("SUM")).toThrow(BlueprintControlLoopError);
  });
});

// ── Health surface ──────────────────────────────────────────────────────────

describe("describeBlueprintControlLoopHealth", () => {
  const base: BlueprintControlLoopStatus = {
    state: "disabled",
    enabled: false,
    running: false,
    definitionPath: null,
    blueprintId: null,
    blueprintName: null,
    scanPeriodMs: null,
    ticks: 0,
    lastTickDurationMs: null,
    missedDeadlines: 0,
    missedDeadlineRecently: false,
    overruns: 0,
    windowSamples: 0,
    p50Ms: null,
    p99Ms: null,
    maxMs: null,
    loadFailures: 0,
    lastError: null,
    actuatesOutputs: false,
  };

  it("reports a deliberately-disabled loop as healthy", () => {
    const health = describeBlueprintControlLoopHealth(base);
    expect(health.status).toBe("healthy");
    expect(health.message).toContain("disabled");
  });

  it("reports a load failure as unhealthy, carrying the reason", () => {
    const health = describeBlueprintControlLoopHealth({
      ...base,
      state: "failed",
      enabled: true,
      lastError: "blueprint definition \"/x.json\" is not valid JSON",
      loadFailures: 1,
    });
    expect(health.status).toBe("unhealthy");
    expect(health.message).toContain("not valid JSON");
  });

  it("reports enabled-but-not-running as degraded", () => {
    const health = describeBlueprintControlLoopHealth({
      ...base,
      state: "stopped",
      enabled: true,
    });
    expect(health.status).toBe("degraded");
  });

  it("reports a healthy running loop, naming the no-actuation boundary", () => {
    const health = describeBlueprintControlLoopHealth({
      ...base,
      state: "running",
      enabled: true,
      running: true,
      blueprintId: "adder",
      scanPeriodMs: 5,
      ticks: 100,
    });
    expect(health.status).toBe("healthy");
    expect(health.message).toContain("no actuation");
  });

  it("reports a recently-missed deadline as degraded", () => {
    const health = describeBlueprintControlLoopHealth({
      ...base,
      state: "running",
      enabled: true,
      running: true,
      missedDeadlines: 3,
      missedDeadlineRecently: true,
    });
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("3 missed scan deadline");
  });

  it("describes a live loop truthfully end to end", async () => {
    const loop = makeLoop(enabledEnv(writeBlueprint(ADDER)));
    loop.start();
    await waitFor(() => loop.status().ticks >= 3);

    const status = loop.status();
    expect(status.actuatesOutputs).toBe(false);
    expect(["healthy", "degraded"]).toContain(describeBlueprintControlLoopHealth(status).status);

    loop.stop();
    expect(describeBlueprintControlLoopHealth(loop.status()).status).toBe("degraded");
  });
});

// ── Prometheus surface ──────────────────────────────────────────────────────

describe("BlueprintControlLoop — Prometheus surface", () => {
  /** Read one series out of the real exposition text the /metrics endpoint serves. */
  function metricValue(name: string, blueprint?: string): number | null {
    const series = blueprint === undefined ? name : `${name}{blueprint="${blueprint}"}`;
    for (const line of registry.metrics().split("\n")) {
      if (line.startsWith("#")) continue;
      const separator = line.lastIndexOf(" ");
      if (separator < 0) continue;
      if (line.slice(0, separator) === series) return Number(line.slice(separator + 1));
    }
    return null;
  }

  it("publishes running state, tick counts and window quantiles on the shared registry", async () => {
    // A distinct blueprint id keeps this test's label series isolated from the
    // counters other tests in this file already accumulated.
    const probe = { ...ADDER, id: "metrics-probe" };
    const loop = makeLoop(
      // Publish every scan-ish so the assertion does not wait a full second.
      enabledEnv(writeBlueprint(probe), { BLUEPRINT_CONTROL_LOOP_METRICS_INTERVAL_MS: "100" }),
    );
    loop.start();
    expect(metricValue("scada_blueprint_control_loop_enabled")).toBe(1);
    expect(metricValue("scada_blueprint_control_loop_running")).toBe(1);

    await waitFor(
      () => (metricValue("scada_blueprint_control_loop_window_samples", "metrics-probe") ?? 0) >= 5,
    );

    const exposition = registry.metrics();
    expect(exposition).toContain(
      'scada_blueprint_control_loop_scan_period_ms{blueprint="metrics-probe"} 5',
    );
    expect(
      metricValue("scada_blueprint_control_loop_ticks_total", "metrics-probe"),
    ).toBeGreaterThanOrEqual(5);
    expect(
      metricValue("scada_blueprint_control_loop_tick_p99_ms", "metrics-probe"),
    ).toBeGreaterThanOrEqual(0);
    expect(
      metricValue("scada_blueprint_control_loop_last_tick_duration_ms", "metrics-probe"),
    ).toBeGreaterThanOrEqual(0);

    loop.stop();
    expect(metricValue("scada_blueprint_control_loop_running")).toBe(0);
  });

  it("counts a fail-closed load as a load failure", () => {
    const before = metricValue("scada_blueprint_control_loop_load_failures_total") ?? 0;
    const loop = makeLoop(enabledEnv(join(tmpdir(), "definitely-not-here-457.json")));

    loop.tryStart();

    expect(metricValue("scada_blueprint_control_loop_load_failures_total")).toBe(before + 1);
    expect(metricValue("scada_blueprint_control_loop_running")).toBe(0);
  });
});
