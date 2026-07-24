# SQLite dev schema: add the alarm tables (parity with Postgres)

## Summary

`shared/schema.ts` defines `alarms` and `alarm_history` (with the
`alarm_severity` and `alarm_state` enums), but `shared/schema-sqlite.ts` —
the dev-mode fallback — has **no alarm tables at all** (`grep -c alarm
shared/schema-sqlite.ts` → 0). Any code path that persists or queries alarms
works in production Postgres and silently has nothing to talk to in dev.
Bring the SQLite schema to parity.

## Context

- Postgres source of truth: `shared/schema.ts` (alarms ~lines 193–210,
  alarm_history ~212–227, enums ~43–44)
- SQLite schema: `shared/schema-sqlite.ts` (follow its existing conventions —
  enums become text columns, timestamps follow the file's existing pattern)
- DB init / fallback selection: `server/storage.ts`

## What done looks like

- [ ] `shared/schema-sqlite.ts` defines `alarms` and `alarm_history` with the
      same table names, column names, and column intent as the Postgres
      schema (enum columns as text; document the mapping in a comment)
- [ ] Insert schemas / inferred types exported following the file's existing
      pattern
- [ ] A parity test asserts the two schema modules define the same alarm
      tables and column-name sets, so future drift fails CI instead of
      passing silently
- [ ] `npx tsc --noEmit` stays clean; nothing else in dev-mode startup breaks

## Prove it

```bash
npx tsc --noEmit
npx vitest run shared/__tests__/schema-parity.test.ts   # new parity suite (name yours accordingly)
npm test
```

## Size

Small.

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
