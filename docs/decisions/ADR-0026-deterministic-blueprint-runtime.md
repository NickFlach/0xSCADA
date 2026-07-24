# ADR-0026: Deterministic Blueprint Runtime

**Status:** Accepted (with a measured gate condition — see "Gate decision")
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
> ARM verdict. The reference run must be executed in CI on the target image.

Fixture: control-farm blueprint, **1250 tags / 1000 instructions** (the
`makeControlFarmBlueprint(1000)` fixture rounds to 125 units × 10 tags / 8 nodes,
i.e. slightly *more* than 1000 tags — a conservative test).

| Metric        | Baseline (naive Map + alloc) | Locked (compiled SoA) | Improvement |
| ------------- | ---------------------------- | --------------------- | ----------- |
| p50           | 0.2303 ms                    | 0.0065 ms             | ~35×        |
| p90           | 0.3971 ms                    | 0.0101 ms             | ~39×        |
| p99           | 0.7867 ms                    | **0.0319 ms**         | ~25×        |
| p99.9         | 1.1275 ms (over SLO)         | 0.0538 ms             | ~21×        |
| max           | 6.6983 ms                    | 0.2292 ms             | ~29×        |
| stddev/jitter | 0.1382 ms                    | 0.0044 ms             | ~31×        |

Allocation probe (`tickFast` × 200,000 with `--expose-gc`): heap growth across
the measured window was **−0.96 B/tick** (negative — i.e. effectively zero;
within GC noise), and the bench observed **0 GC pauses** in the measured loop.
This empirically confirms the no-allocation-in-tick invariant.

On this x86_64 host the locked runtime's measured p99 (0.0319 ms) is ~31× under
the 1 ms SLO, and even its worst observed single tick (0.2292 ms) is under 1 ms.

## Gate decision

The issue defines the gate: *"If Node's event loop refuses to be tamed enough
(p99 still over 1.5 ms after the above), open a follow-up cycle:gate issue
proposing swap for a Rust control-loop crate via N-API. Mark this issue as
deferred, not abandoned."*

**Local verdict:** p99 = 0.0319 ms ≪ 1 ms, with zero GC pauses and confirmed
bounded allocation. The gate condition (p99 > 1.5 ms) is **not** triggered on the
development host. Therefore #457 is **Accepted**, not deferred, pending the
reference-ARM CI confirmation below.

**If the reference ARM CI run measures p99 > 1.5 ms** (e.g. due to GC behaviour
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

- The local x86 numbers do not bind the reference ARM target; the CI assertion on
  the reference image is the source of truth and must be wired up.
- The float64-only tag model (booleans as 0.0/1.0) trades a richer type system
  for a single homogeneous cache-friendly buffer. Acceptable for control logic;
  documented in `server/blueprint/types.ts`.
- `performance.now()` resolution on some hosts limits the precision of the
  smallest samples; percentiles remain meaningful because they aggregate 10⁵
  samples.

## Verification procedure (reference hardware)

```bash
# On the reference ARM image, from the repo root, with deps installed:
npx tsx bench/blueprint-runtime/baseline.bench.ts   # contrast numbers
npx tsx bench/blueprint-runtime/locked.bench.ts     # exits non-zero if p99 >= 1ms

# Allocation invariant (any host):
NODE_OPTIONS="--expose-gc" npx vitest run server/blueprint/__tests__/runtime.test.ts
```

CI must assert `p99 < 1 ms` for the 1000-tag fixture on the reference image; that
assertion — not the local development numbers above — is the binding gate.
