# [13.4] Port PID auto-tuning (safety envelopes + approval gate + RL) onto current main

## Summary

ADR-0013 [13.4] was implemented upstream as
[NickFlach/0xSCADA#499](https://github.com/NickFlach/0xSCADA/pull/499) but has
not been ported to this repo (the sibling modules 13.1–13.3 already were, in
#547, #576, #551). Port it onto current `main`, following the same
rebase-and-harden pattern those PRs used.

## Context

- Reference implementation: upstream PR #499 (branch `feat/215-pid-autotuning`)
- The classical stack it composes already exists here:
  `server/services/optimization/` (PIDController, relay feedback,
  Ziegler-Nichols, Cohen-Coon) and `server/services/governance/gate-manager.ts`
  (approval state machine)
- Mount point conventions: `server/routes.ts`; note `/api/pid` is claimed by
  P&ID diagrams — use `/api/tuning`

## What done looks like

- [ ] `server/services/tuning/` exists: absolute gain envelopes (ADR-0009),
      FOPDT process simulation, sim-time relay identification, tabular
      Q-learning tuner with seeded RNG, and a GateManager-backed proposal flow
- [ ] Every gain change becomes a pending `TuningProposal`; nothing
      auto-applies. The existing autotuner's `automatic`-mode self-apply paths
      are removed (they contradict ADR-0013's human-in-the-loop mandate)
- [ ] Approved changes apply envelope-clamped AND rate-limited (partial
      application reported when the 25%-per-step limit truncates a move);
      `forceGains` is not exposed over HTTP
- [ ] `/api/tuning` mounted: loops + envelopes, relay/cohen-coon/rl tuning,
      proposals with approve/reject, status — zod-validated
- [ ] Service registered in the services barrel and actually initialized at
      startup
- [ ] Unit tests cover: envelope validation/clamping, rate-limit stepping,
      FOPDT physics, relay identification producing stabilizing gains, RL
      improvement + determinism + envelope containment, approval lifecycle,
      and a regression pinning that `automatic` mode never self-applies

## Prove it

```bash
npx tsc --noEmit                                        # clean
npx vitest run server/services/tuning --project node    # new suite passes
npx vitest run server/services/optimization             # existing behavior intact
npm test                                                # no regressions
```

## Size

Large (the upstream PR is a complete reference — porting + conflict
resolution, not design work).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
