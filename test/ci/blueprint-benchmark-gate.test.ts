import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  allocationGateFailures,
  type AllocationProbeStats,
} from "../../bench/blueprint-runtime/allocation.bench";
import { lockedGateFailures } from "../../bench/blueprint-runtime/locked.bench";
import type { LatencyStats } from "../../bench/blueprint-runtime/harness";

function stats(overrides: Partial<LatencyStats> = {}): LatencyStats {
  return {
    label: "locked gate test",
    samples: 100_000,
    min: 0.01,
    p50: 0.02,
    p90: 0.03,
    p99: 0.04,
    p999: 0.05,
    max: 0.06,
    mean: 0.02,
    stddev: 0.01,
    gcCount: 0,
    gcTotalMs: 0,
    ...overrides,
  };
}

function allocationStats(
  overrides: Partial<AllocationProbeStats> = {},
): AllocationProbeStats {
  return {
    noopGcCount: 0,
    canaryGcCount: 7,
    runtimeGcCount: 0,
    runtimeTicks: 250_000,
    ...overrides,
  };
}

describe("locked blueprint latency gate", () => {
  test("accepts a sub-millisecond run", () => {
    expect(lockedGateFailures(stats())).toEqual([]);
  });

  test("rejects a p99 SLO miss", () => {
    expect(lockedGateFailures(stats({ p99: 1 }))).toEqual([
      expect.stringContaining("p99 SLO NOT MET"),
    ]);
  });
});

describe("locked blueprint allocation gate", () => {
  test("accepts a clean runtime with working controls", () => {
    expect(allocationGateFailures(allocationStats())).toEqual([]);
  });

  test("rejects profiler contamination", () => {
    expect(
      allocationGateFailures(allocationStats({ noopGcCount: 1 })),
    ).toEqual([expect.stringContaining("probe contaminated")]);
  });

  test("rejects a vacuous allocation canary", () => {
    expect(
      allocationGateFailures(allocationStats({ canaryGcCount: 0 })),
    ).toEqual([expect.stringContaining("probe vacuous")]);
  });

  test("rejects runtime GC", () => {
    expect(
      allocationGateFailures(allocationStats({ runtimeGcCount: 4 })),
    ).toEqual([
      expect.stringContaining("tickFast() observed 4 GC pause(s)"),
    ]);
  });

  test(
    "passes end to end with exposed GC and a 1 MiB semi-space",
    () => {
      const script = resolve(
        process.cwd(),
        "bench/blueprint-runtime/allocation.bench.ts",
      );
      const output = execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--max-semi-space-size=1",
          "--import",
          "tsx",
          script,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(output).toContain("no-op control       : 0 GC pause(s)");
      expect(output).toMatch(/allocating canary {3}: [1-9]\d* GC pause\(s\)/);
      expect(output).toContain("tickFast()          : 0 GC pause(s)");
    },
    // Keep all 250k ticks: that sample is load-bearing evidence for the gate.
    60_000,
  );
});
