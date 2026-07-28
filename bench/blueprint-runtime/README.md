# Blueprint Runtime Benchmarks (Issue #457)

Tail-latency benchmarks for the Deterministic Blueprint Runtime. The SLO is a
**p99 tick < 1 ms for a 1000-tag blueprint on reference ARM hardware**
(1 ARM OCPU / 6 GB RAM). These benches measure the *distribution* of per-tick
latency (p50/p90/p99/p99.9/max + jitter), not throughput.

## Files

| File                | What it measures                                                            |
| ------------------- | --------------------------------------------------------------------------- |
| `harness.ts`        | Dependency-free latency harness (percentiles, jitter, GC-pause instrumentation). Allocation-free inside the measured loop. |
| `baseline.bench.ts` | The "before": a naive `Map`-lookup, per-tick-allocating interpreter. Establishes the contrast numbers. |
| `locked.bench.ts`   | The "after": the production `BlueprintRuntime`. **Exits non-zero if measured p99 ≥ 1 ms** so CI can gate latency. |
| `allocation.bench.ts` | Isolates `tickFast()` under `v8.GCProfiler`, with no-op and allocating controls. **Exits non-zero on probe contamination, a vacuous canary, or runtime GC.** |

## Running (deps must be installed in the repo)

```bash
npx tsx bench/blueprint-runtime/baseline.bench.ts
npx tsx bench/blueprint-runtime/locked.bench.ts      # CI gate: nonzero exit on SLO miss

# Bounded-allocation gate with a deliberately small V8 nursery:
node --expose-gc --max-semi-space-size=1 --import tsx \
  bench/blueprint-runtime/allocation.bench.ts
```

Both latency files export a programmatic API (`runLockedBench()` / `runBaselineBench()`
returning `Promise<LatencyStats>`) for wiring into a CI assertion harness.

## Honesty note

`locked.bench.ts` prints the verdict for **whatever machine it runs on**. A local
x86 pass is *not* the reference ARM verdict. The
`Blueprint Runtime ARM p99 + allocation (constrained proxy)` CI job runs on GitHub's native
`ubuntu-24.04-arm` runner, then executes the benchmark inside an ARM64 Node 20
container constrained to one CPU and 6 GiB of memory. Node 20 matches the
current server image. The job verifies the architecture, Node major, effective
CPU count, and cgroup memory ceiling before measuring, and preserves the report
as a build artifact. It also requires exposed GC, runs the runtime's forced-GC
heap-retention invariant, and runs the isolated allocation probe with a 1 MiB V8
semi-space. That probe profiles a loop containing only `tickFast()`: a no-op
control must observe zero collections, an escaping-object canary must observe at
least one, and the runtime must observe zero. These are empirical regression
signals rather than a formal proof that V8 performs no allocation.

That required CI environment is a native-ARM regression **proxy** for the issue's
reference shape. It does not claim that GitHub's physical CPU model, frequency,
virtualization, or host contention is identical to the intended appliance. The
strict reference-hardware verdict still requires the same command on the
1-OCPU / 6-GB target, or explicit maintainer designation of this constrained
profile as the reference image. See
[`docs/decisions/ADR-0026-deterministic-blueprint-runtime.md`](../../docs/decisions/ADR-0026-deterministic-blueprint-runtime.md)
for measured results and the Rust/N-API contingency if the reference target is
missed.
