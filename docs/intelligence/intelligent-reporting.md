# Intelligent reporting engine

Issue [#219](https://github.com/NickFlach/0xSCADA/issues/219) implements the
ADR-0013 historical reporting engine. It ships three templates:

| Template           | Content                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `shift-summary`    | period coverage, alarms, OEE/throughput/quality KPIs, operator notes |
| `compliance-audit` | pass/warning/fail control evidence, alarms, process-data coverage    |
| `trend-analysis`   | per-tag statistics, timestamped trend points, alarms                 |

Custom templates use the same section types and safe renderers as the built-ins.
Templates contain data declarations, not executable HTML.

## Historian input

Inject a `HistoricalDataProvider`:

```ts
import { ReportingEngine } from "../../server/services/reporting";

const reports = new ReportingEngine({
  dataProvider: {
    querySeries: (pattern, period) => historian.series(pattern, period),
    queryAlarms: (period) => historian.alarms(period),
    queryKPIs: (names, period) => historian.kpis(names, period),
    queryCompliance: (period) => auditStore.controls(period),
    queryNotes: (kind, period) => shiftLog.notes(kind, period),
  },
});

const report = await reports.generate("shift-summary", shiftStartMs, shiftEndMs);
```

The engine validates the period, filters provider over-fetch, orders historical
records deterministically, and fails explicitly if no provider is configured.
Historical windows use `(start, end]` semantics so adjacent scheduled reports
cover a boundary sample exactly once.
It does not silently emit a successful report containing data-source errors.
The original `queryTags`/`queryAlarms`/`queryKPIs` provider shape is supported
through a compatibility adapter.

## Safe rendering

`renderHTML`, `renderText`, and `renderJSON` render the same generated report.
HTML escapes the report title, section titles, table headers, table cells,
plain text, and serialized objects. Raw HTML sections are not supported. The
document includes a restrictive Content Security Policy and has no scripts or
external assets.

## Delivery

Webhook and email are delivery-channel abstractions. No live network or SMTP
client is created by default:

```ts
import {
  EmailDeliveryChannel,
  ReportingEngine,
  WebhookDeliveryChannel,
} from "../../server/services/reporting";

const reports = new ReportingEngine({
  dataProvider,
  deliveryChannels: [
    new WebhookDeliveryChannel({
      post: (request) => approvedHttpClient.post(request),
    }),
    new EmailDeliveryChannel({
      send: (message) => approvedMailProvider.send(message),
    }),
  ],
});
```

Every delivery returns and retains a `DeliveryStatus` with each attempt,
timestamps, HTTP status (when applicable), retryability, provider ID, and final
error. A stable `x-0xscada-delivery-id` is supplied to webhook and email
transports on every retry so providers can make ambiguous retries idempotent.
Retries use bounded exponential backoff. HTTP 408/425/429 and 5xx
responses are retryable; permanent 4xx responses are not. `Sleeper` and retry
policy are injectable for deterministic tests.

Webhook target authorization and network egress policy remain the
deployment-owned transport's responsibility. The built-in adapter validates
HTTP(S) syntax and rejects credentials embedded in a URL.

## Scheduling

The default scheduler uses an unreferenced Node interval. A scheduler and clock
can be injected for a job system or deterministic test:

```ts
reports.schedule({
  id: "plant-a-shift",
  templateId: "shift-summary",
  intervalMs: 8 * 60 * 60 * 1000,
  lookbackMs: 8 * 60 * 60 * 1000,
  deliveries: [{ method: "email", target: "shift-lead@example.com" }],
});
```

`runSchedule()` is public for job runners. A schedule never overlaps itself;
an attempted overlap increments `skippedOverlaps`. Status records run count,
consecutive failures, last report, delivery IDs, timestamps, and the last
error. `unscheduleReport()` and `destroyAll()` cancel timers cleanly.

Primary imports use `server/services/reporting`. The historical
`server/intelligence/reporting-engine.ts` path remains as a compatibility
export.
