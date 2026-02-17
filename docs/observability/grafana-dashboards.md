# Grafana Dashboards for OT Operators

> Issue #34 — [Observability] Grafana Dashboards for OT Operators

## Overview

Pre-built Grafana dashboard definitions for monitoring 0xSCADA deployments. Dashboards are stored as JSON in `docker/grafana/dashboards/` and can be provisioned automatically.

## Available Dashboards

### 1. System Overview (`system-overview.json`)
High-level view of the entire 0xSCADA deployment:
- **CPU / Memory / Disk** — Host and container resource usage
- **Active connections** — OPC-UA sessions, WebSocket clients
- **Message throughput** — Telemetry messages per second
- **Database stats** — Query latency, connection pool usage
- **Uptime** — Service health indicators

### 2. Alarm Dashboard (`alarm-dashboard.json`)
Real-time alarm monitoring for OT operators:
- **Active alarms** — Count by severity (critical, warning, info)
- **Alarm history** — Timeline of alarm events
- **Top alarming tags** — Tags generating the most alarms
- **Acknowledgment status** — Unacknowledged vs acknowledged
- **Mean time to acknowledge (MTTA)** — Operator response metrics

### 3. Gateway Status (`gateway-status.json`)
Protocol driver health and performance:
- **Connection status** — Per-driver connected/disconnected state
- **Subscription count** — Active OPC-UA subscriptions and monitored items
- **Data change rate** — Events per second per driver
- **Read/write latency** — P50/P95/P99 operation timing
- **Error rate** — Failed operations and reconnection attempts

## Setup

### 1. Grafana with Provisioning

Add to your `docker-compose.yml`:

```yaml
grafana:
  image: grafana/grafana:latest
  ports:
    - "3000:3000"
  volumes:
    - ./docker/grafana/dashboards:/var/lib/grafana/dashboards
    - ./docker/grafana/provisioning:/etc/grafana/provisioning
  environment:
    - GF_SECURITY_ADMIN_PASSWORD=admin
```

### 2. Dashboard Provisioning Config

Create `docker/grafana/provisioning/dashboards/default.yml`:

```yaml
apiVersion: 1
providers:
  - name: "0xSCADA"
    orgId: 1
    folder: "0xSCADA"
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

### 3. Data Source

Dashboards expect a Prometheus data source named `Prometheus`. Configure your Prometheus instance to scrape 0xSCADA's `/api/metrics` endpoint.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: "0xscada"
    scrape_interval: 15s
    static_configs:
      - targets: ["scada-edge:5000"]
```

## Customization

All dashboards are editable JSON. To modify:

1. Import the dashboard in Grafana UI
2. Edit panels, thresholds, queries as needed
3. Export updated JSON via Dashboard Settings → JSON Model
4. Save back to `docker/grafana/dashboards/`

### Common Customizations
- **Alarm thresholds** — Adjust color mappings for your process limits
- **Time ranges** — Default is last 1 hour; change for your use case
- **Panel layout** — Drag and resize panels in the Grafana editor

## Metrics Reference

Dashboards query these Prometheus metrics (expose from 0xSCADA):

| Metric | Type | Description |
|--------|------|-------------|
| `scada_gateway_connections` | gauge | Active protocol connections |
| `scada_gateway_subscriptions` | gauge | Active OPC-UA subscriptions |
| `scada_gateway_data_changes_total` | counter | Total data change events |
| `scada_gateway_read_duration_seconds` | histogram | Read operation latency |
| `scada_gateway_write_duration_seconds` | histogram | Write operation latency |
| `scada_gateway_errors_total` | counter | Protocol errors |
| `scada_alarms_active` | gauge | Currently active alarms |
| `scada_alarms_total` | counter | Total alarm events |
| `scada_telemetry_messages_total` | counter | Telemetry messages sent |
| `scada_db_query_duration_seconds` | histogram | Database query latency |

## Related

- [Metrics Documentation](metrics.md)
- [System Overview Dashboard JSON](../../docker/grafana/dashboards/system-overview.json)
