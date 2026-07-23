# ADR-0023 ParadoxResolver — Wave-2 Devil's-Advocate Review

> Issue #451, reviewed 2026-07-21 against current `main`. Wave-1 fixes
> (#399 fitness pruning, #402 rate_filter dt=0, #403 vote bucketing,
> #404 neighbor normalization, via PRs #426/#427) verified present and not
> re-reported. Scope: `server/services/integrity/evolutionary/**`,
> `server/services/integrity/paradox-resolver.ts`, governance gate code in
> `explainability-monitor.ts`, ADR-0023.

## Verdict

**The evolutionary stack is simultaneously unreachable and self-disabling.**
Nothing instantiates `EvolutionaryResolver` (dead code, M1), and if it were
wired, the novelty-budget accounting (B1) would permanently disable evolution
after the first evolved resolution, while blocked-genome fitness crediting
(B2) inverts selection pressure. The "silent bias" risk in #451 is real but
currently latent — fix order matters: land B1/B2/M2/M3 before wiring M1.

## Blockers

### B1 — Novelty-budget deadlock permanently bricks evolution
`evolutionary/safety-guard.ts:176-204` + `evolutionary-resolver.ts:203`.
The novelty window only records **allowed** evolved resolutions, and the
ratio denominator is the window length — "fraction of evolved resolutions
that were experimental," not "fraction of all resolutions" per ADR-0023.
Fresh population → first check passes (0/0), second check ratio 1/1 ≥ 0.3 →
blocked. Blocked resolutions fall back to static and never call
`engine.recordResolution`, so the 100-resolution evolution trigger never
fires, generations never advance, genomes stay experimental forever.
Net: exactly one evolved resolution ever occurs per process area.

### B2 — Safety-blocked genomes credited with the static strategy's fitness
`evolutionary-resolver.ts:164-168` + `fitness.ts:71-103`. On the blocked
path, `fitness.evaluate(genome, resolution, ...)` receives the **static
resolver's** resolution, so the blocked genome records the static
strategy's high confidence (0.7–0.85) as its own fitness and wins future
tournaments. The comment says "low score for blocked genome"; the code
does the opposite. Selection pressure is inverted: reliably-failing
genomes inherit floor-strategy fitness. This is exactly the "small bug in
genome scoring silently biases the whole stack."

### B3 — `resolveByVoting` crashes on empty device set; quorum bypassed
`paradox-resolver.ts:505-524, 563`. `applyStrategy('voting')` performs no
quorum check (unlike `resolveByBestStrategy:497`); the tag window prunes
to ~1s, so a deferred `resolve()` on an area with
`preferredStrategy: 'voting'` sees an empty window → `votes.get('')!` →
TypeError at `:569`, unhandled inside `ingestEvent`'s await chain. With
1–2 in-window devices, "voting" proceeds anyway — `minVotingQuorum` is
silently ignored and one device wins with confidence 1.0.

## Major

- **M1 — Engine is dead code.** No module imports `evolutionary-resolver`
  outside its own barrel; `index.ts` doesn't export `./evolutionary`;
  `ParadoxResolver.ingestEvent:299,312` calls `this.resolve()` directly with
  no hook. Even when wired, the evolved path never populates the base
  resolver's `resolutions`/`resolvedEvents` maps or emits `resolved` events —
  ADR-0024/0025 listeners would see nothing.
- **M2 — Fitness memory wiped every generation.** Elites are `clone()`d with
  new IDs, then `pruneInactive` deletes all old-ID fitness records — every
  genome enters each generation at fitness 0; the logged `bestFitness` is
  always 0. (`evolution-engine.ts:175, 211-213`, `genome.ts:166-174`.)
- **M3 — Only the best genome is ever evaluated.** `resolveConflict` always
  uses `getBestGenome`; the other 29 genomes stay at 0, so tournament
  selection among all-zero fitness degenerates to first-drawn-index wins.
  Evolution is random drift plus one evaluated genome.
- **M4 — Degenerate genomes structurally favored; winner defaults to stale
  event.** Unknown primitive IDs are silently skipped → neutral 0.5 clears
  the confidence floor and earns the maximum efficiency bonus; with no
  primitive votes the winner defaults to `conflict.events[0]`, the **older**
  event for `simultaneous_reading`. (`genome.ts:89-108`, `fitness.ts:79-88`,
  `evolutionary-resolver.ts:189-191`, `paradox-resolver.ts:352`.)
- **M5 — ConflictContext never populated.** `recentReadings`/`neighborValues`
  hardcoded `undefined`, so `history_bias`/`neighbor_correlation`/`rate_filter`
  always return neutral — the Wave-1 fixes to those primitives fixed code
  that can never execute. The physics penalty triggers only on
  `method === 'physics_arbitration'`, but evolved resolutions hardcode
  `confidence_weighted` — the ADR's physics penalty is unreachable.
- **M6 — Crossover off-by-one.** Cuts sampled in [0, len−1] instead of
  [0, len]: parent 1's last gene is never inheritable, parent 2's last gene
  always is — systematic positional bias. (`evolution-engine.ts:281-287`.)
- **M7 — ADR-mandated governance gate + CFR 21 Part 11 explainability audit
  not implemented.** `EvolutionaryResolver` never calls
  `checkGovernanceGates` or the explainability monitor; `SafetyGuard` keeps
  only a private in-memory log. The claimed regulatory control does not exist.

## Minor

- NaN `sensorConfidence` unguarded end-to-end; `Math.max(0, Math.min(1, NaN))`
  does not clamp NaN; NaN fitness poisons ranking and `getBestGenome`.
- Voting merge divides by zero when all winning-bucket weights are 0 →
  `mergedValue = NaN` propagated as the resolved process value
  (`paradox-resolver.ts:570-575`).
- `Math.random()` throughout; no seedable RNG → evolution not replayable for
  audit; `sort(() => Math.random() - 0.5)` is a biased shuffle.
- `recordValidation` adjusts only the latest record; interleaved resolutions
  mis-attribute feedback (`fitness.ts:109-118`).
- Unbounded growth: elite `ancestry` arrays (one entry per generation,
  forever) and the `conflicts` map when auto-resolve is off
  (`paradox-resolver.ts:474`).
- `resolveByConfidenceWeighting` crashes on empty `conflict.events`
  (`paradox-resolver.ts:630`); `shouldAutoResolve` conflates the global flag
  with per-area thresholds (`:336`).

## Nits

`SafetyGuard.fitnessEval` injected but unused; `FLOOR_STRATEGIES` maps to
`'sensor_confidence'`, which is not a `ResolutionMethod`; saturated-genome
mutation skews remove-probability to 66%; `checkGovernanceGates` reason
overwrite when both checks fail; `PrimitiveRegistry.getMap()/getEventLog()`
leak mutable internals.

## Clean categories

Termination (no infinite loops possible), governance boundary comparisons
(no off-by-one at thresholds/quorum), fitness decay direction, genome
serialize/deserialize field-completeness.

## Coverage

**Zero tests** exist for `evolutionary/**` and `paradox-resolver.ts`.
Every edge case on the #451 checklist is untested: empty/single/identical
populations, NaN fitness, ties, crossover bounds, mutation invariants,
novelty window sequences, blocked-path fitness, elitism persistence,
voting quorum boundaries, stale-primitive deserialization.

## Follow-ups filed from this review

1. Engine correctness: B1 novelty deadlock, B2 blocked-path fitness,
   M2/M3 fitness identity + population sampling, M6 crossover bounds +
   seedable RNG — with the edge-case test suite as the gate.
2. ParadoxResolver hardening: B3 voting crash + quorum enforcement,
   NaN/zero-weight guards, empty-events guard, auto-resolve flag conflation.
3. Wiring + governance: M1 instantiation into the integrity service,
   M5 ConflictContext population, M7 governance gates + explainability
   audit — to land only after (1).
