# ADR-0026: Deterministic Blueprint Runtime

**Status:** Provisionally accepted (strict reference-hardware gate pending)
**Date:** 2026-06-22
**Deciders:** 0xSCADA Core Team
**References:** [ADR-0021 (Dual-Time Control Plane)](ADR-0021-dual-time-control-plane.md), [Wave-2 Build Set Design](../plans/2026-06-01-wave-2-build-set-design.md), [Issue #457](https://github.com/NickFlach/0xSCADA/issues/457)

## Context

ADR-0021 promised a real-time control plane. The cryptographic-audit half shipped;
the deterministic-execution half was underdeveloped. Wave 2b (#457) is the hard
gate that the rest of 2b (watchdog #3, etc.) depends on: the blueprint execution
hot loop must be **bounded-allocation** and **predictable**, with a target of a
**p99 tick under 1 ms for a 1000-tag blueprint on the reference ARM hardware
(1 ARM OCPU / 6 GB RAM)**.

The pre-#457 execution path used the anti-patterns typical of a first-cut
interpreter: a `Map<string, number>` tag store keyed by name (dynamic hashing in
the hot path), per-tick operand/result object allocation (GC pressure → tail
latency), and string-opcode dispatch (megamorphic, no jump table). Those produce
exactly the long-tail jitter the issue exists to remove.

## Decision

Compile each blueprint **once at load time** into a flat, branch-light
Structure-of-Arrays (SoA) program, then execute it in a synchronous,
allocation-free hot loop.

### 1. Ahead-of-time compilation (`server/blueprint/compiler.ts`)

`compileBlueprint(def)` performs ALL the work that can be done once:

- builds the **tag-index table** (name → dense integer slot);
- validates operand arity, tag references, and single-driver-per-tag;
- **topologically orders** nodes so producers run before consumers within a tick
  (feedback through stateful ops — LATCH/TON — reads last tick's value from the
  state buffer and therefore does not constitute a combinational cycle);
- packs the instruction stream into fixed-stride typed arrays: `opcodes`
  (`Uint8Array`), `destIndices`/`operandTagIndices`/`stateIndices` (`Int32Array`),
  `immediates`/`operandConsts` (`Float64Array`).

### 2. Bounded-allocation runtime (`server/blueprint/runtime.ts`)

`BlueprintRuntime`:

- allocates the I/O tag buffer (`Float64Array(tagCount)`) and the state buffer
  **once, in the constructor** (load time);
- `tickFast()` performs **zero allocation** — no closures, arrays, objects,
  string work, or Map access; tag access is by integer index into the single
  `Float64Array`;
- dispatch is a dense `switch` on the `Uint8Array` opcode (V8 lowers this to a
  jump table);
- the tick is **fully synchronous** — no `await`, Promise, or microtask in the
  critical path, so the scan cannot be preempted by the event loop mid-tick;
- IO marshalling (`writeInputs`/`readOutputs`) uses caller-supplied buffers and
  is also allocation-free.

### 3. Benchmark suite (`bench/blueprint-runtime/`)

- `baseline.bench.ts` — the naive Map+allocation interpreter (the "before").
- `locked.bench.ts` — the production `BlueprintRuntime` (the "after"); exits
  non-zero if the measured p99 misses 1 ms, so CI can gate on it.
- `harness.ts` — a dependency-free **tail-latency** harness (p50/p90/p99/p99.9/
  max + jitter stddev + GC-pause instrumentation). We measure the *distribution*
  of per-tick latency, not throughput, because the SLO is a tail target.

## Measured results

> **Honesty note:** the SLO is specified for reference ARM hardware
> (1 ARM OCPU / 6 GB). The numbers below were measured on the **development
> x86_64 host** (Node v24, Windows). They demonstrate the design works and that
> the bounded-allocation goal is met, but a local pass is **not** the reference
> ARM verdict. Required CI supplies a native-ARM constrained proxy; the strict
> verdict still requires the accepted target image described below.

Fixture: control-farm blueprint, **1000 tags / 800 instructions** (100 units ×
10 tags / 8 nodes). The benchmark asserts the exact tag count before measuring
so a fixture-size regression fails rather than silently changing the workload.

| Metric        | Baseline (naive Map + alloc) | Locked (compiled SoA) | Improvement |
| ------------- | ---------------------------- | --------------------- | ----------- |
| p50           | 0.2723 ms                    | 0.0087 ms             | ~31×        |
| p90           | 0.3923 ms                    | 0.0110 ms             | ~36×        |
| p99           | 0.7897 ms                    | **0.0383 ms**         | ~21×        |
| p99.9         | 1.6207 ms (over SLO)         | 0.0907 ms             | ~18×        |
| max           | 17.9633 ms                   | 1.8549 ms             | ~10×        |
| stddev/jitter | 0.1726 ms                    | 0.0118 ms             | ~15×        |

On this run the repaired GC observer recorded **0 pauses** for the locked loop
and **738 pauses / 249.0687 ms** for the deliberately allocating baseline. The
observer starts after warm-up, the benchmark yields once after measurement so
Node can deliver queued entries, and a forced-GC regression test proves the
accounting is non-vacuous. The isolated allocation gate independently observed
**0 pauses** for its no-op control, **8 pauses** for its allocating canary, and
**0 pauses** across 250,000 `tickFast()` calls. This is empirical evidence, not
a proof that V8 can never allocate.

On this x86_64 host the locked runtime's measured p99 (0.0383 ms) is ~26× under
the 1 ms SLO. A single 1.8549 ms outlier reinforces why the issue gates p99
rather than claiming a hard per-tick maximum.

## Gate decision

The issue defines the gate: *"If Node's event loop refuses to be tamed enough
(p99 still over 1.5 ms after the above), open a follow-up cycle:gate issue
proposing swap for a Rust control-loop crate via N-API. Mark this issue as
deferred, not abandoned."*

**Local verdict:** p99 = 0.0383 ms ≪ 1 ms, with zero observed runtime GC and
non-vacuous controls. The gate condition (p99 > 1.5 ms) is **not** triggered on
the development host. Therefore #457 is not deferred, pending an accepted
reference-ARM confirmation.

**If an accepted reference ARM run measures p99 > 1.5 ms** (e.g. due to GC behaviour
or scheduler jitter under a single OCPU), the contingency is:

1. Mark #457 **deferred, not abandoned** (the TS runtime stays as the reference
   implementation and the conformance oracle).
2. Open a `cycle:gate` follow-up: re-implement only the hot loop
   (`tickFast` + the compiled SoA program) as a **Rust control-loop crate exposed
   via N-API (napi-rs)**. The compiler, types, fixtures, benchmark harness, and
   IO contract stay in TypeScript and are reused unchanged; the Rust crate
   consumes the same SoA typed arrays (zero-copy via `Float64Array` / `Uint8Array`
   backing `ArrayBuffer`s), so the swap is contained behind the existing
   `BlueprintRuntime` interface.
3. The N-API boundary is crossed **once per tick** (or batched per scan window),
   never per instruction, to keep FFI overhead off the per-op path.

## Consequences

**Positive**

- The 2b watchdog (#3) can now build on a deterministic runtime with a measured,
  reproducible latency profile and a CI gate.
- The baseline/locked split gives every future change a regression detector for
  both latency and (via the alloc probe) GC behaviour.
- The TS hot loop is also a ready-made conformance oracle if the Rust swap is
  ever needed.

**Negative / risks**

- Neither local x86 numbers nor the required constrained GitHub-hosted ARM proxy
  bind the appliance's physical CPU. The accepted reference-image run remains
  the source of truth.
- The float64-only tag model (booleans as 0.0/1.0) trades a richer type system
  for a single homogeneous cache-friendly buffer. Acceptable for control logic;
  documented in `server/blueprint/types.ts`.
- `performance.now()` resolution on some hosts limits the precision of the
  smallest samples; percentiles remain meaningful because they aggregate 10⁵
  samples.

## Amendment (2026-07): production control-loop host

**Problem.** The decision above shipped a well-tested interpreter that nothing in
production ever constructed — `new BlueprintRuntime(...)` appeared only in the
unit tests and the benchmark. As deployed, the deterministic runtime executed
nothing, so none of the guarantees above were observable on a running system.

**Decision.** Add `server/blueprint/control-loop.ts`: a host that loads a
blueprint definition from disk, validates it, compiles it once, and drives
`tickFast()` from a single `setInterval` at the compiled scan period.

- **Gated OFF by default.** The loop starts only when
  `BLUEPRINT_CONTROL_LOOP_ENABLED` is exactly the string `"true"` *and*
  `BLUEPRINT_CONTROL_LOOP_DEFINITION` names a readable definition file. There is
  no truthy coercion, so `1`/`yes`/`on`/`TRUE` leave it off. This follows the
  existing opt-in convention (`ENABLE_BLOCKCHAIN`, `SPARKPLUG_BROKER_URL`,
  `FLUX_URL`) rather than introducing a new one.
- **Execution, not actuation.** The host contains no field-bus, gateway,
  OPC-UA/Modbus/DNP3 or storage write. Enabling it creates no plant-output path
  that did not already exist; computed outputs stay in the runtime's own
  `Float64Array`. Until a field-IO binding lands (with the safety review such a
  write path requires), input tags hold their load-time initial values unless an
  in-process caller uses `writeInputs()`. `status().actuatesOutputs` is a
  hard-coded `false` so operators can confirm the boundary from `/health`.
- **Fail closed at load.** The definition is size-checked before it is read,
  parsed as JSON, validated by a `.strict()` Zod schema derived from the runtime
  opcode table (`server/blueprint/definition-schema.ts`), bounded by configurable
  tag/node ceilings, and only then compiled. Every failure raises a
  `BlueprintControlLoopError` naming the file and the reason; `tryStart()` logs
  it and leaves the loop off, so a bad blueprint cannot take down server startup.
- **Hot-path contract preserved.** The measured scan is allocation-free: the
  timer callback does only numeric work around `tickFast()` — two
  `performance.now()` reads, counter updates and one store into a pre-allocated
  `Float64Array` ring buffer. No closure is allocated per arm (the callback is
  bound once), and there is no `await`/Promise, so the scan still cannot be
  preempted mid-tick. **One honest exception:** at most once per
  `BLUEPRINT_CONTROL_LOOP_METRICS_INTERVAL_MS` (default 1 s) the same callback
  also publishes metrics, and that path *does* allocate — two `subarray` views
  plus the registry's per-call label key (`labelNames.map(...).join()`). It runs
  strictly after the scan duration has been recorded, so it cannot inflate a
  measured tick, but it is real work on the scan timer; any resulting lateness
  is not hidden, it surfaces as a missed deadline. Moving publication to its own
  timer would remove even that; it is kept on one timer deliberately.

**Telemetry shape (and why it is not a histogram).** Scan durations go into a
pre-allocated ring buffer; p50/p99/max over that window are mirrored onto the
existing `server/metrics` registry on a slow cadence (default 1 s) as gauges
under `scada_blueprint_control_loop_*`, alongside counters for ticks, missed
deadlines, overruns and load failures. A histogram would be the idiomatic shape,
but this registry's `Histogram.observe()` builds a label key per call — i.e. it
allocates — and calling it once per scan would put an allocation on the control
loop and undermine the property this ADR exists to protect. The cost of the
chosen shape is that the exported quantiles are per-window and per-instance, and
therefore not aggregatable across replicas the way buckets would be.

**Health.** `blueprint-control-loop` is registered as an optional check.
Disabled reports *healthy* (an intentionally-off subsystem is not a fault);
a load failure reports *unhealthy* with the reason; enabled-but-not-running and
a recently-missed deadline report *degraded* (the latter self-clears after
`BLUEPRINT_CONTROL_LOOP_DEGRADED_WINDOW_MS`).

**Definition format.** No blueprint definition ships with the repository — a
production loop must be pointed at an operator-authored file, deliberately, so
that nothing here can be mistaken for a plant-ready program. The authoring shape
is `BlueprintDefinition` in `server/blueprint/types.ts`, validated by
`server/blueprint/definition-schema.ts`. A minimal, complete example of the JSON
that schema accepts:

```json
{
  "id": "pump-interlock",
  "name": "Pump start interlock",
  "tags": [
    { "name": "LEVEL",      "direction": "input",    "dataType": "float", "initial": 0 },
    { "name": "ESTOP",      "direction": "input",    "dataType": "bool",  "initial": 0 },
    { "name": "PERMIT",     "direction": "internal", "dataType": "bool" },
    { "name": "RUN_CMD",    "direction": "output",   "dataType": "bool" },
    { "name": "HIGH_LEVEL", "direction": "output",   "dataType": "bool" }
  ],
  "nodes": [
    { "id": "hi",  "op": "GT",  "inputs": [{ "tag": "LEVEL" }, { "const": 80 }], "output": "HIGH_LEVEL" },
    { "id": "ok",  "op": "NOT", "inputs": [{ "tag": "ESTOP" }],                  "output": "PERMIT" },
    { "id": "run", "op": "AND", "inputs": [{ "tag": "PERMIT" }, { "tag": "HIGH_LEVEL" }], "output": "RUN_CMD" }
  ],
  "scanPeriodMs": 100
}
```

The schema is `.strict()`: an unrecognised field is a rejection, not something
ignored. `op` must be one of the names in `OP_TO_OPCODE`, and per-op arity is
enforced by the compiler. Note that `RUN_CMD` above is computed and readable and
nothing more — per the actuation boundary, no output reaches a field device.

**Known gap.** The repository has no SIGTERM/shutdown orchestration, so
`stop()` — which clears the timer and needs no draining, the scan being fully
synchronous — is exercised by the test suite and available to callers, but is
not yet wired to a process shutdown hook. That wiring belongs with a
server-wide graceful-shutdown change, not with this one.

## Verification procedure (proxy CI and reference hardware)

```bash
# On the reference ARM image, from the repo root, with deps installed:
npx tsx bench/blueprint-runtime/baseline.bench.ts   # contrast numbers
node --expose-gc --import tsx bench/blueprint-runtime/locked.bench.ts
node --expose-gc --max-semi-space-size=1 --import tsx \
  bench/blueprint-runtime/allocation.bench.ts

# Heap-retention invariant (any host):
node --expose-gc node_modules/vitest/vitest.mjs run \
  server/blueprint/__tests__/runtime.test.ts
```

The `Blueprint Runtime ARM p99 + allocation (constrained proxy)` job in
`.github/workflows/ci.yml` is a required repository regression gate. It runs on
a native `ubuntu-24.04-arm` GitHub-hosted runner and executes `locked.bench.ts`
inside an ARM64 Node 20 container constrained with a one-CPU cpuset and a 6 GiB
cgroup memory ceiling. Node 20 matches the current server container. Before
measuring, the job fails unless `process.arch` is `arm64`, the Node major is 20,
`os.availableParallelism()` is `1`, and `memory.max` is `6442450944`. The
benchmark itself exits non-zero unless the exact 1000-tag fixture has
`p99 < 1 ms`. A separate `v8.GCProfiler` gate runs with a 1 MiB V8 semi-space
and profiles a loop containing only `tickFast()`, excluding timing and IO
marshalling. Its no-op control must observe zero collections, its
escaping-object canary must observe at least one, and the runtime must observe
zero. The job also runs the forced-GC heap-retention invariant under
`--expose-gc`. These are complementary empirical signals, not a formal
no-allocation proof. `CI Complete` requires the job, and the complete report is
retained as an artifact.

This is an honest native-ARM proxy, not an assertion that a constrained
GitHub-hosted VM has the same CPU model, frequency, virtualization, or host
contention as the 1-OCPU / 6-GB appliance. The strict reference verdict requires
the same benchmark on that target (or explicit maintainer designation of this
profile as the reference image). Only that accepted reference result can trigger
the Rust/N-API gate decision above.
