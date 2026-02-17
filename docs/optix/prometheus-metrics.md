# Prometheus Metrics Exporter

## Overview

0xSCADA exposes a `/metrics` endpoint in Prometheus text exposition format for monitoring with Prometheus, Grafana, and other observability tools.

## Architecture

- **`server/observability/prometheus-exporter.ts`** — Registry, SCADA metrics, Express middleware

## Available Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `scada_http_request_duration_seconds` | histogram | method, path, status | Request latency |
| `scada_active_connections` | gauge | — | Current active connections |
| `scada_tag_reads_total` | counter | gateway | Tag read operations |
| `scada_tag_writes_total` | counter | gateway | Tag write operations |
| `scada_alarms_total` | counter | severity | Alarm count by severity |
| `scada_gateway_connected` | gauge | gateway | Gateway connection status (1/0) |

## Setup

```typescript
import { createSCADAMetrics, metricsMiddleware, metricsHandler } from './server/observability/prometheus-exporter';

const { registry, metrics } = createSCADAMetrics();

// Track request latency automatically
app.use(metricsMiddleware(metrics));

// Expose /metrics endpoint
app.get('/metrics', metricsHandler(registry));

// Record SCADA-specific metrics
metrics.incTagReads('gateway-1', 10);
metrics.setGatewayConnectionStatus('gateway-1', true);
metrics.incAlarmCount('critical');
```

## Prometheus Configuration

```yaml
scrape_configs:
  - job_name: '0xscada'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
```

## Grafana Dashboard

Import the metrics into Grafana for visualization:

- **Request latency** — `histogram_quantile(0.95, rate(scada_http_request_duration_seconds_bucket[5m]))`
- **Tag throughput** — `rate(scada_tag_reads_total[1m])`
- **Active alarms** — `increase(scada_alarms_total[1h])`
- **Gateway health** — `scada_gateway_connected`
