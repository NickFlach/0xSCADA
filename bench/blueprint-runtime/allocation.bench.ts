/**
 * Bounded-allocation gate for issue #457.
 *
 * The latency harness necessarily times calls and performs IO marshalling, so
 * its GC count cannot attribute a pause specifically to BlueprintRuntime.
 * This probe profiles a loop containing only tickFast() and surrounds it with
 * negative and positive controls. CI runs it with a small V8 semi-space to make
 * transient allocation regressions reliably produce a collection.
 */

import { GCProfiler } from "node:v8";
import { compileBlueprint } from "../../server/blueprint/compiler.js";
import {
  makeControlFarmBlueprint,
  makeInputVector,
} from "../../server/blueprint/fixtures.js";
import { BlueprintRuntime } from "../../server/blueprint/runtime.js";
import { isMain } from "./harness.js";

const TAG_COUNT = 1000;
const INSTRUCTION_COUNT = 800;
const WARMUP_TICKS = 20_000;
const PROBE_TICKS = 250_000;
const CANARY_ALLOCATIONS = 250_000;
const CANARY_SLOTS = 1024;

export interface AllocationProbeStats {
  noopGcCount: number;
  canaryGcCount: number;
  runtimeGcCount: number;
  runtimeTicks: number;
}

function exposedGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    throw new Error(
      "allocation probe requires Node to run with --expose-gc",
    );
  }
  return gc;
}

function profileGc<T>(gc: () => void, run: () => T): {
  gcCount: number;
  result: T;
} {
  gc();
  const profiler = new GCProfiler();
  profiler.start();
  const result = run();
  const profile = profiler.stop();
  return { gcCount: profile.statistics.length, result };
}

function runNoopControl(): number {
  let checksum = 0;
  for (let i = 0; i < PROBE_TICKS; i++) {
    checksum = (checksum + i) | 0;
  }
  return checksum;
}

function runRuntimeTicks(runtime: BlueprintRuntime, ticks: number): number {
  for (let i = 0; i < ticks; i++) runtime.tickFast();
  return runtime.ticks;
}

export function runAllocationProbe(): AllocationProbeStats {
  const gc = exposedGc();

  // Negative control: the profiler and a tight arithmetic loop must not create
  // a collection by themselves. Warm this exact function first so JIT work is
  // outside the profiled window.
  runNoopControl();
  runNoopControl();
  const noop = profileGc(gc, runNoopControl);

  const program = compileBlueprint(makeControlFarmBlueprint(TAG_COUNT));
  if (
    program.tagCount !== TAG_COUNT ||
    program.instructionCount !== INSTRUCTION_COUNT
  ) {
    throw new Error(
      `allocation fixture must contain exactly ${TAG_COUNT} tags / ` +
        `${INSTRUCTION_COUNT} instructions, got ${program.tagCount} / ` +
        `${program.instructionCount}`,
    );
  }
  const runtime = new BlueprintRuntime(program);
  runtime.writeInputs(makeInputVector(runtime.inputCount, 7));
  runRuntimeTicks(runtime, WARMUP_TICKS);

  // Nothing except tickFast() executes while this profiler is active.
  const runtimeProfile = profileGc(gc, () =>
    runRuntimeTicks(runtime, PROBE_TICKS),
  );
  const expectedTicks = WARMUP_TICKS + PROBE_TICKS;
  if (runtimeProfile.result !== expectedTicks) {
    throw new Error(
      `allocation probe expected ${expectedTicks} ticks, observed ` +
        `${runtimeProfile.result}`,
    );
  }

  // Positive control runs last so its deliberate garbage cannot contaminate
  // the runtime result. Keep a rotating set of objects observable while
  // replacing them. Under CI's 1 MiB semi-space this must collect, proving the
  // profiler cannot silently report a vacuous zero.
  const canarySlots: Array<{ value: number } | undefined> = new Array(
    CANARY_SLOTS,
  );
  const canary = profileGc(gc, () => {
    let checksum = 0;
    for (let i = 0; i < CANARY_ALLOCATIONS; i++) {
      const slot = i & (CANARY_SLOTS - 1);
      const previous = canarySlots[slot];
      if (previous) checksum = (checksum + previous.value) | 0;
      canarySlots[slot] = { value: i };
    }
    return checksum;
  });
  if (!Number.isInteger(noop.result) || !Number.isInteger(canary.result)) {
    throw new Error("allocation probe controls did not complete");
  }

  return {
    noopGcCount: noop.gcCount,
    canaryGcCount: canary.gcCount,
    runtimeGcCount: runtimeProfile.gcCount,
    runtimeTicks: PROBE_TICKS,
  };
}

export function allocationGateFailures(stats: AllocationProbeStats): string[] {
  const failures: string[] = [];
  if (stats.noopGcCount !== 0) {
    failures.push(
      `allocation probe contaminated: no-op control observed ` +
        `${stats.noopGcCount} GC pause(s)`,
    );
  }
  if (stats.canaryGcCount === 0) {
    failures.push(
      "allocation probe vacuous: allocating canary did not trigger GC; " +
        "run with --max-semi-space-size=1",
    );
  }
  if (stats.runtimeGcCount !== 0) {
    failures.push(
      `bounded-allocation gate failed: tickFast() observed ` +
        `${stats.runtimeGcCount} GC pause(s) across ` +
        `${stats.runtimeTicks.toLocaleString()} ticks`,
    );
  }
  return failures;
}

function formatAllocationReport(stats: AllocationProbeStats): string {
  return [
    "── LOCKED BlueprintRuntime allocation probe ──",
    `  no-op control       : ${stats.noopGcCount} GC pause(s)`,
    `  allocating canary   : ${stats.canaryGcCount} GC pause(s)`,
    `  tickFast()          : ${stats.runtimeGcCount} GC pause(s)`,
    `  measured ticks      : ${stats.runtimeTicks.toLocaleString()}`,
  ].join("\n");
}

function main(): void {
  const stats = runAllocationProbe();
  console.log(formatAllocationReport(stats));

  const failures = allocationGateFailures(stats);
  for (const failure of failures) {
    console.error(`\n${failure}`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err: unknown) {
    console.error(err);
    process.exitCode = 1;
  }
}
