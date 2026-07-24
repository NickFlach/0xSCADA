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
| `locked.bench.ts`   | The "after": the production `BlueprintRuntime`. **Exits non-zero if measured p99 ≥ 1 ms** so CI can gate on it. |

## Running (deps must be installed in the repo)

```bash
npx tsx bench/blueprint-runtime/baseline.bench.ts
npx tsx bench/blueprint-runtime/locked.bench.ts      # CI gate: nonzero exit on SLO miss

# With GC visibility (recommended for tail analysis):
NODE_OPTIONS="--expose-gc" npx tsx bench/blueprint-runtime/locked.bench.ts
```

Both files also export a programmatic API (`runLockedBench()` / `runBaselineBench()`
returning `LatencyStats`) for wiring into a CI assertion harness.

## Honesty note

`locked.bench.ts` prints the verdict for **whatever machine it runs on**. A local
x86 pass is *not* the reference ARM verdict. The binding gate is the CI run on the
reference image. See
[`docs/decisions/ADR-0026-deterministic-blueprint-runtime.md`](../../docs/decisions/ADR-0026-deterministic-blueprint-runtime.md)
for measured results and the Rust/N-API contingency if the reference target is
missed.
