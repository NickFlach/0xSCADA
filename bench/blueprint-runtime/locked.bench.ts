/**
 * LOCKED benchmark — Issue #457 (Deterministic Blueprint Runtime).
 *
 * The "after" picture: the real, production {@link BlueprintRuntime} running a
 * 1000-tag blueprint with the bounded-allocation guarantees the issue requires
 * (pre-allocated buffers, indexed typed-array tag access, branch-table dispatch,
 * no awaits/microtasks in the tick).
 *
 * This file is the SLO gate referenced in the issue's Verification section:
 *   "assertion: p99 under 1ms for the 1000-tag fixture."
 * When run as a script it exits non-zero if the measured p99 misses the SLO, so
 * CI can fail the build (or the workflow can route to the gate-decision path).
 *
 * IMPORTANT (honesty): the < 1 ms p99 target is specified for REFERENCE ARM
 * hardware (1 ARM OCPU / 6 GB RAM). The number printed here is whatever THIS
 * machine measures; do not interpret a local pass/fail as the reference verdict.
 * See docs/decisions/ADR-0026-deterministic-blueprint-runtime.md for the gate
 * procedure if the reference target is not met.
 */

import { compileBlueprint } from "../../server/blueprint/compiler.js";
import { BlueprintRuntime } from "../../server/blueprint/runtime.js";
import { makeControlFarmBlueprint, makeInputVector } from "../../server/blueprint/fixtures.js";
import {
  runLatencyBench,
  formatReport,
  meetsSlo,
  isMain,
  type LatencyStats,
} from "./harness.js";

const TAG_COUNT = 1000;

export function runLockedBench(): LatencyStats {
  const def = makeControlFarmBlueprint(TAG_COUNT);
  const program = compileBlueprint(def);
  const rt = new BlueprintRuntime(program);

  // Pre-allocate input vectors ONCE (outside the timed loop). Rotating between a
  // few keeps the branch predictor honest without per-tick allocation.
  const v1 = makeInputVector(rt.inputCount, 1);
  const v2 = makeInputVector(rt.inputCount, 2);
  const v3 = makeInputVector(rt.inputCount, 3);
  const vectors = [v1, v2, v3];

  return runLatencyBench({
    label: `LOCKED BlueprintRuntime — ${program.tagCount}-tag / ${program.instructionCount}-instruction blueprint`,
    warmup: 20_000,
    iterations: 100_000,
    beforeTick: (i) => {
      // writeInputs is allocation-free; this is the realistic IO marshalling
      // that precedes every real scan.
      rt.writeInputs(vectors[i % vectors.length]);
    },
    tick: () => {
      // The genuinely hot, allocation-free, synchronous scan.
      rt.tickFast();
    },
  });
}

function main(): void {
  const stats = runLockedBench();
  console.log(formatReport(stats));
  console.log("");
  console.log(
    "NOTE: SLO target is for reference ARM hardware (1 OCPU / 6GB). " +
      "The verdict above reflects THIS machine only.",
  );

  if (!meetsSlo(stats)) {
    console.error(
      `\np99 SLO NOT MET on this host (p99=${stats.p99.toFixed(4)} ms >= 1.0 ms). ` +
        `If this reproduces on reference ARM hardware with p99 > 1.5 ms, follow the ` +
        `gate decision in ADR-0026 (Rust control-loop crate via N-API).`,
    );
    // Non-zero exit so CI's "p99 < 1ms" assertion fails loudly.
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  main();
}
