# Wire GR::LISTEN as the notification-fatigue filter behind alarm correlation

## Summary

`server/services/gr-listen/` (issue #350, ADR-0022) implements alert
filtering — attention budgets, time-of-day rules, fatigue
suppress/escalate/group decisions — but has **zero call sites**: the singleton
is exported from the services barrel and never invoked. Meanwhile the alarm
correlation engine (#576) now enriches every published alarm with
group/root-cause/suppression info. Chain them: correlation does structural
grouping, GR::LISTEN decides notification worthiness.

## Context

- `server/services/gr-listen/index.ts` — `AlertInput`, `FilterDecision`
  (`pass|suppress|escalate|group`), `getGrListenFilter()`
- `server/websocket/cached-event-bridge.ts` — `publishAlarm()` already runs
  alarms through `alarmCorrelationService` and attaches a `correlation` field
- `server/services/alarm-correlation/` — severity vocabulary
  (`critical|high|medium|low|info`) matches gr-listen's `Severity`

## What done looks like

- [ ] A small bridge maps the correlation-enriched alarm to gr-listen's
      `AlertInput` and attaches the `FilterDecision` to the broadcast payload
      as a `notification` field (e.g.
      `{ decision, effectivePriority, incidentId?, reason }`)
- [ ] Alarms are never dropped: a `suppress` decision still broadcasts, with
      the decision attached so consumers can de-clutter (same non-destructive
      posture the `correlation` field uses)
- [ ] Alarms already suppressed by correlation skip gr-listen (no
      double-processing); root-cause alarms always reach it
- [ ] The wiring is behind `GR_LISTEN_ENABLED` (default off) so behavior only
      changes deliberately; a gr-listen failure never blocks alarm fan-out
- [ ] Unit tests for the bridge mapping (severity passthrough, correlation-
      suppressed skip, decision attachment, disabled-flag no-op) and at least
      one test exercising a real `GrListenFilter` end to end

## Prove it

```bash
npx tsc --noEmit
npx vitest run server/services/gr-listen --project node    # new bridge tests
npx vitest run server/services/alarm-correlation           # existing suite intact
npm test
```

## Size

Small-medium.

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
