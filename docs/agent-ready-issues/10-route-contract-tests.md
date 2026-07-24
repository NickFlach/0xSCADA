# Route contract tests for /api/predictive and /api/alarm-correlation

## Summary

The predictive-maintenance and alarm-correlation services have solid unit
suites, but their HTTP surfaces have almost no contract coverage — a broken
zod schema, a renamed field, or a wrong status code would ship silently. The
repo already has the harness pattern: `server/routes/__tests__/` (see
`route-mounts.test.ts` and `twin-auth.test.ts` — port-0 express with mocked
storage/blockchain, no new dependencies). Extend it to per-endpoint contract
tests for these two routers.

## Context

- Harness pattern to copy: `server/routes/__tests__/route-mounts.test.ts`,
  `server/routes/__tests__/twin-auth.test.ts`
- Routers under test: `server/routes/predictive.ts`,
  `server/routes/alarm-correlation.ts`
- The engines behind them are deterministic and in-memory — tests can seed
  them directly (ingest points/alarms, then hit the HTTP surface)

## What done looks like

- [ ] For **every** endpoint on both routers, at least: one happy-path test
      asserting status code and response shape (field names and types, not
      exact values), and one validation-failure test asserting a 400 with an
      error message
- [ ] 404 paths covered where they exist (unknown tag/group/alert/rule ids)
- [ ] Behavioral contracts pinned where they matter: `GET
      /api/predictive/analyze/:tagId` must NOT create alerts (read-only GET);
      future-dated ingest points are rejected; alarm ingest returns per-alarm
      results including `rejected` entries
- [ ] Tests run in the default unit suite (no live DB, no network) and are
      deterministic
- [ ] No production code changes needed — if a test reveals a real contract
      bug, file it as a separate issue and mark the test `.todo` with a link
      (don't silently change the contract in this PR)

## Prove it

```bash
npx tsc --noEmit
npx vitest run server/routes/__tests__ --project node   # new suites included
npm test
```

## Size

Medium (mechanical once the first endpoint's pattern is set).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
