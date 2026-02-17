# Vendor Learning Tract: Metrics & Visibility

Comprehensive guide to observability in 0xSCADA — Prometheus metrics, Grafana dashboards, alerting rules, and custom metric creation.

---

## 1. Observability Architecture

```
┌─────────────┐    ┌────────────┐    ┌─────────────┐    ┌──────────┐
│  0xSCADA    │───▶│ Prometheus │───▶│   Grafana   │───▶│  Alerts  │
│  /metrics   │    │            │    │  Dashboards │    │ PagerDuty│
└─────────────┘    └────────────┘    └─────────────┘    │ Slack    │
                                                         │ Email    │
                                                         └──────────┘
```

0xSCADA exposes a Prometheus-compatible metrics endpoint at `/metrics` with process, application, and industrial metrics.

---

## 2. Prometheus Setup

### 2.1 Scrape Configuration

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: '0xscada'
    scrape_interval: 15s
    static_targets:
      - targets: ['localhost:5000']
    metrics_path: /metrics
    bearer_token: '<api-key>'

  - job_name: '0xscada-gateways'
    scrape_interval: 30s
    static_targets:
      - targets: ['gateway-1:9100', 'gateway-2:9100']
```

### 2.2 Core Metrics

**HTTP / API Metrics:**

| Metric | Type | Description |
|---|---|---|
| `oxscada_http_requests_total` | Counter | Total HTTP requests by method, path, status |
| `oxscada_http_request_duration_seconds` | Histogram | Request latency |
| `oxscada_http_request_size_bytes` | Histogram | Request body size |
| `oxscada_http_response_size_bytes` | Histogram | Response body size |

**Tag Metrics:**

| Metric | Type | Description |
|---|---|---|
| `oxscada_tags_total` | Gauge | Total registered tags |
| `oxscada_tags_reads_total` | Counter | Tag read operations |
| `oxscada_tags_writes_total` | Counter | Tag write operations |
| `oxscada_tags_quality_ratio` | Gauge | Ratio of good-quality tags |
| `oxscada_tag_update_lag_seconds` | Histogram | Time since last tag update |

**Gateway Metrics:**

| Metric | Type | Description |
|---|---|---|
| `oxscada_gateways_total` | Gauge | Total gateways by status |
| `oxscada_gateway_messages_total` | Counter | Messages received per gateway |
| `oxscada_gateway_errors_total` | Counter | Gateway errors |
| `oxscada_gateway_reconnections_total` | Counter | Reconnection count |
| `oxscada_gateway_latency_seconds` | Histogram | Gateway round-trip time |

**Alarm Metrics:**

| Metric | Type | Description |
|---|---|---|
| `oxscada_alarms_active` | Gauge | Active alarms by severity |
| `oxscada_alarms_triggered_total` | Counter | Alarms triggered |
| `oxscada_alarms_acknowledged_total` | Counter | Alarms acknowledged |
| `oxscada_alarm_response_time_seconds` | Histogram | Time to acknowledge |

**Blockchain Metrics:**

| Metric | Type | Description |
|---|---|---|
| `oxscada_anchors_total` | Counter | Anchor transactions |
| `oxscada_anchor_gas_used` | Histogram | Gas per anchor |
| `oxscada_anchor_confirmation_seconds` | Histogram | Time to confirm |
| `oxscada_blockchain_block_height` | Gauge | Current block height |

**Process Metrics (automatic):**

| Metric | Type | Description |
|---|---|---|
| `process_cpu_seconds_total` | Counter | CPU time |
| `process_resident_memory_bytes` | Gauge | Memory usage |
| `nodejs_eventloop_lag_seconds` | Histogram | Event loop lag |
| `nodejs_active_handles_total` | Gauge | Active handles |

---

## 3. Grafana Dashboards

### 3.1 Import Pre-built Dashboards

0xSCADA ships dashboard JSON at `docs/observability/grafana/`:
- `system-overview.json` — Overall health
- `gateway-performance.json` — Gateway metrics
- `alarm-analytics.json` — Alarm trends
- `blockchain-anchoring.json` — Anchor performance

Import via Grafana UI → Dashboards → Import → Upload JSON.

### 3.2 System Overview Dashboard

**Panels to include:**

1. **Service Status** — Stat panel showing up/down for each component
2. **Request Rate** — Graph: `rate(oxscada_http_requests_total[5m])`
3. **Request Latency (p95)** — Graph: `histogram_quantile(0.95, rate(oxscada_http_request_duration_seconds_bucket[5m]))`
4. **Error Rate** — Graph: `rate(oxscada_http_requests_total{status=~"5.."}[5m])`
5. **Active Alarms** — Stat panel: `oxscada_alarms_active`
6. **Tag Quality** — Gauge: `oxscada_tags_quality_ratio`
7. **Memory & CPU** — Graph: process metrics

### 3.3 Gateway Performance Dashboard

**Key queries:**

```promql
# Messages per second per gateway
rate(oxscada_gateway_messages_total[5m])

# Gateway latency p99
histogram_quantile(0.99, rate(oxscada_gateway_latency_seconds_bucket[5m]))

# Error rate by gateway
rate(oxscada_gateway_errors_total[5m])

# Reconnection frequency
increase(oxscada_gateway_reconnections_total[1h])
```

### 3.4 Alarm Analytics Dashboard

```promql
# Alarm trigger rate by severity
rate(oxscada_alarms_triggered_total[1h])

# Mean time to acknowledge
histogram_quantile(0.5, rate(oxscada_alarm_response_time_seconds_bucket[24h]))

# Active alarms heatmap by site and severity
oxscada_alarms_active
```

---

## 4. Alerting Rules

### 4.1 Prometheus Alert Rules

Create `0xscada-alerts.yml`:

```yaml
groups:
  - name: 0xscada
    rules:
      - alert: HighErrorRate
        expr: rate(oxscada_http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High API error rate ({{ $value | humanizePercentage }})"

      - alert: GatewayDown
        expr: oxscada_gateways_total{status="offline"} > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} gateway(s) offline"

      - alert: CriticalAlarmsActive
        expr: oxscada_alarms_active{severity="critical"} > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} critical alarm(s) active"

      - alert: HighAlarmResponseTime
        expr: histogram_quantile(0.5, rate(oxscada_alarm_response_time_seconds_bucket[1h])) > 300
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Median alarm response time > 5 minutes"

      - alert: TagQualityDegraded
        expr: oxscada_tags_quality_ratio < 0.95
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Tag quality ratio below 95% ({{ $value | humanizePercentage }})"

      - alert: AnchorBacklog
        expr: increase(oxscada_anchors_total[1h]) == 0 and oxscada_alarms_triggered_total > 0
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "No blockchain anchors in the last hour despite activity"

      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes / 1024 / 1024 > 512
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "0xSCADA memory usage > 512MB"

      - alert: EventLoopLag
        expr: histogram_quantile(0.99, rate(nodejs_eventloop_lag_seconds_bucket[5m])) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node.js event loop lag p99 > 100ms"
```

### 4.2 Alertmanager Routing

```yaml
route:
  receiver: 'default'
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: 'pagerduty'
      repeat_interval: 15m
    - match:
        severity: warning
      receiver: 'slack'

receivers:
  - name: 'default'
    email_configs:
      - to: 'ops@your-company.com'
  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: '<key>'
  - name: 'slack'
    slack_configs:
      - api_url: '<webhook-url>'
        channel: '#0xscada-alerts'
```

---

## 5. Custom Metric Creation

### 5.1 Adding Metrics in 0xSCADA

```typescript
import { Counter, Histogram, Gauge, register } from 'prom-client';

// Counter
const myOperations = new Counter({
  name: 'oxscada_custom_operations_total',
  help: 'Total custom operations',
  labelNames: ['type', 'status'],
});

// Histogram
const myDuration = new Histogram({
  name: 'oxscada_custom_duration_seconds',
  help: 'Custom operation duration',
  labelNames: ['type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
});

// Gauge
const myQueueSize = new Gauge({
  name: 'oxscada_custom_queue_size',
  help: 'Current queue depth',
  labelNames: ['queue'],
});

// Usage
myOperations.inc({ type: 'import', status: 'success' });
const end = myDuration.startTimer({ type: 'import' });
// ... do work ...
end();
myQueueSize.set({ queue: 'events' }, 42);
```

### 5.2 Naming Conventions

Follow Prometheus naming best practices:
- Prefix: `oxscada_`
- Suffix for units: `_seconds`, `_bytes`, `_total`
- Use snake_case
- Counters end with `_total`
- Use labels sparingly (< 10 cardinality per label)

### 5.3 Metric Types Decision Guide

| Use Case | Type |
|---|---|
| Count of events | Counter |
| Current value / level | Gauge |
| Latency / size distributions | Histogram |
| Quantiles (if cardinality is low) | Summary |

---

## 6. Troubleshooting

### 6.1 Verify Metrics Endpoint

```bash
curl -H "Authorization: Bearer <key>" http://localhost:5000/metrics
# Or via CLI:
0xscada status --json | jq '.metrics'
```

### 6.2 Common Issues

| Issue | Solution |
|---|---|
| No metrics scraped | Check Prometheus targets page, verify bearer token |
| Missing custom metrics | Ensure `register` is the default registry |
| High cardinality | Reduce label values, avoid tag IDs as labels |
| Stale data | Check scrape interval and up metric |
| Dashboard empty | Verify data source in Grafana, check time range |

### 6.3 Performance Impact

- Metrics endpoint serialization: ~10ms for <10k series
- Memory: ~1KB per time series
- Keep total series under 100k for single-node Prometheus
