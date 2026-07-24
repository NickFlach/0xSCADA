# Retire the mock maintenance/digitaltwin endpoints in /api/intelligence

## Summary

`server/routes/intelligence.ts` still serves `Math.random()` mock data on
`/maintenance/analyze`, `/maintenance/insights/:assetId`,
`/digitaltwin/operate`, and `/digitaltwin/status/:assetId` — while the real
implementations now exist at `/api/predictive` (#547) and `/api/twin` (#551).
Two competing surfaces where one is fake violates the repo integrity rule
("no fake data"). Retire the mocks.

## Context

- Mocks: `server/routes/intelligence.ts` (maintenance + digitaltwin handlers)
- Real services: `server/services/predictive` (engine, alerts, predictions),
  `server/services/twin` (models, scenarios, compare)
- Out of scope: the `/nlquery` mock (that's ADR-0013 [13.5], tracked
  separately) and the `/ml/*` mock endpoints

## What done looks like

- [ ] `/maintenance/insights/:assetId` delegates to the predictive service:
      real assessment/alerts for tags belonging to the asset (tag convention
      `ASSET.CHANNEL`), or an honest empty result — no random numbers
- [ ] `/maintenance/analyze` either delegates to
      `predictiveMaintenanceService` (mapping its response into the existing
      shape where feasible) or returns `410 Gone` with a JSON pointer to
      `/api/predictive` — pick one, document it in the PR
- [ ] `/digitaltwin/operate` and `/digitaltwin/status/:assetId` same
      treatment, pointing at `/api/twin`
- [ ] No `Math.random()` remains in `server/routes/intelligence.ts` outside
      the explicitly out-of-scope `/ml/*` handlers
- [ ] Route tests cover the new behavior (delegation output or 410 + pointer)

## Prove it

```bash
npx tsc --noEmit
grep -n "Math.random" server/routes/intelligence.ts   # only /ml/* handlers remain
npx vitest run server/routes/__tests__ --project node
npm test
```

## Size

Small-medium.

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
