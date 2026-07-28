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
 * When run as a script it exits non-zero if the measured p99 misses the SLO.
 * Per-tick allocation is gated separately by allocation.bench.ts so timing
 * instrumentation and IO marshalling cannot be mistaken for runtime allocation.
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
const INSTRUCTION_COUNT = 800;
const WARMUP_TICKS = 20_000;
const MEASURED_TICKS = 100_000;

function assertRuntimeSemantics(rt: BlueprintRuntime): void {
  rt.reset();
  const inputs = new Float64Array(rt.inputCount);
  for (let i = 0; i < inputs.length; i += 2) {
    inputs[i] = 80;
    inputs[i + 1] = 10;
  }
  rt.writeInputs(inputs);
  for (let i = 0; i < 6; i++) rt.tickFast();

  if (rt.ticks !== 6) {
    throw new Error(`semantic sentinel expected 6 ticks, observed ${rt.ticks}`);
  }
  const outputs = new Float64Array(rt.outputCount);
  rt.readOutputs(outputs);
  for (let i = 0; i < outputs.length; i++) {
    if (outputs[i] !== 90) {
      throw new Error(
        `semantic sentinel output ${i} expected 90, observed ${outputs[i]}`,
      );
    }
  }
}

export async function runLockedBench(): Promise<LatencyStats> {
  const def = makeControlFarmBlueprint(TAG_COUNT);
  const program = compileBlueprint(def);
  if (program.tagCount !== TAG_COUNT) {
    throw new Error(
      `benchmark fixture must contain exactly ${TAG_COUNT} tags, got ${program.tagCount}`,
    );
  }
  if (program.instructionCount !== INSTRUCTION_COUNT) {
    throw new Error(
      `benchmark fixture must contain exactly ${INSTRUCTION_COUNT} instructions, ` +
        `got ${program.instructionCount}`,
    );
  }
  const rt = new BlueprintRuntime(program);

  // Pre-allocate input vectors ONCE (outside the timed loop). Rotating between a
  // few keeps the branch predictor honest without per-tick allocation.
  const v1 = makeInputVector(rt.inputCount, 1);
  const v2 = makeInputVector(rt.inputCount, 2);
  const v3 = makeInputVector(rt.inputCount, 3);
  const vectors = [v1, v2, v3];

  const stats = await runLatencyBench({
    label: `LOCKED BlueprintRuntime — ${program.tagCount}-tag / ${program.instructionCount}-instruction blueprint`,
    warmup: WARMUP_TICKS,
    iterations: MEASURED_TICKS,
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
  if (rt.ticks !== WARMUP_TICKS + MEASURED_TICKS) {
    throw new Error(
      `benchmark expected ${WARMUP_TICKS + MEASURED_TICKS} ticks, observed ${rt.ticks}`,
    );
  }
  assertRuntimeSemantics(rt);
  return stats;
}

/** Return every failed latency invariant for a single CI report. */
export function lockedGateFailures(stats: LatencyStats): string[] {
  const failures: string[] = [];

  if (!meetsSlo(stats)) {
    failures.push(
      `p99 SLO NOT MET on this host (p99=${stats.p99.toFixed(4)} ms >= 1.0 ms). ` +
        `If this reproduces on accepted reference ARM hardware with p99 > 1.5 ms, ` +
        `follow the gate decision in ADR-0026 (Rust control-loop crate via N-API).`,
    );
  }

  return failures;
}

async function main(): Promise<void> {
  const stats = await runLockedBench();
  console.log(formatReport(stats));
  console.log("");
  console.log(
    "NOTE: SLO target is for reference ARM hardware (1 OCPU / 6GB). " +
      "The verdict above reflects THIS machine only.",
  );

  const failures = lockedGateFailures(stats);
  for (const failure of failures) {
    console.error(`\n${failure}`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
