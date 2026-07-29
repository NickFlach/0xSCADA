# Production SLO and SLI Catalog

The executable catalog is `CRITICAL_PATH_SLOS` in
`server/services/sre/index.ts`. `GET /api/governance/sre/slos` returns the same
definitions. The catalog uses good-event ratios so each objective can be fed by
counter deltas from Prometheus or another telemetry backend.

| SLO id | Critical path | Good event | Objective/window | Owner |
|---|---|---|---|---|
| `tag-ingest-freshness` | Device → gateway → event pipeline | Good-quality update accepted within 1 second | 99.9% / 30d | edge-platform |
| `control-loop-confirmation` | Tick → batch → sign → anchor → confirmation | Round trip ≤ 4.8 seconds and each recorded stage within budget | 99.9% / 30d | integrity-platform |
| `api-tag-read-availability` | Client → API → cache/historian | Non-5xx authorized read within 500 ms | 99.95% / 30d | control-plane |
| `websocket-delivery` | Event pipeline → WebSocket → subscriber | Eligible event delivered within 2 seconds | 99.9% / 30d | control-plane |
| `historian-durability` | Event pipeline → historian → verification | Accepted write remains readable and Merkle-verifiable | 99.999% / 30d | data-platform |
| `gateway-failover-rto` | Heartbeat loss → drain → rebalance → telemetry | All affected shards fresh within 60 seconds | 99% / 90d | edge-platform |
| `database-recovery-rto` | DB incident → failover/restore → verified writes | Verified service restored within 15 minutes with RPO ≤ 60 seconds | 99% / 90d | data-platform |

## Error-budget evaluation

For events inside the rolling window:

```text
SLI                    = good events / total events
allowed bad events     = total events × (1 - objective)
burn rate              = observed bad events / allowed bad events
error budget remaining = max(0, 1 - burn rate)
```

- `healthy`: less than half of the available error budget is consumed;
- `warning`: 50–100% is consumed;
- `breached`: 100% or more is consumed;
- `no-data`: no eligible events; this must alert on telemetry coverage and must
  not be treated as success.

Evaluate an aggregated counter window with:

```http
POST /api/governance/sre/slos/tag-ingest-freshness/evaluate
Content-Type: application/json

{
  "observations": [
    {
      "timestamp": "2026-07-28T12:00:00.000Z",
      "goodEvents": 999500,
      "totalEvents": 1000000
    }
  ]
}
```

Counter samples must be non-negative integers and `goodEvents` cannot exceed
`totalEvents`. The evaluator ignores valid samples outside the SLO window and
rejects malformed timestamps or counters.

## Alerting and release policy

- Page the owning team for `breached` on tag ingestion, control-loop,
  durability, or recovery objectives.
- Create an urgent ticket for `warning`; page if warning persists for two
  evaluation intervals.
- Page telemetry owners if a critical SLO is `no-data` for two scrape intervals.
- Freeze non-remediation changes when a critical-path budget is exhausted.
- Unfreeze only after the incident commander records mitigation, the SLI
  returns to baseline, and a recovery projection shows positive budget.

All SLO alerts must include SLO id, window, burn rate, owner, affected site/tag
scope, dashboard link, and the catalog runbook path.
