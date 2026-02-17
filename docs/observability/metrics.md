# Prometheus Metrics

0xSCADA exports Prometheus-compatible metrics for monitoring and alerting.

## Quick Start

### Enabling Metrics

Metrics are automatically available at `/metrics` endpoint:

```bash
curl http://localhost:5000/metrics
```

### Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: '0xscada'
    static_configs:
      - targets: ['localhost:5000']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

## Available Metrics

### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_http_requests_total` | Counter | method, path, status | Total HTTP requests |
| `scada_http_request_duration_seconds` | Histogram | method, path | Request latency |

### Database Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_db_queries_total` | Counter | operation, table | Total DB queries |
| `scada_db_query_duration_seconds` | Histogram | operation | Query latency |
| `scada_db_connections_active` | Gauge | - | Active connections |

### Blockchain Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_blockchain_anchors_total` | Counter | status | Total anchoring operations |
| `scada_blockchain_anchor_duration_seconds` | Histogram | - | Anchoring latency |
| `scada_blockchain_gas_used_total` | Counter | - | Total gas consumption |

### Event Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_events_total` | Counter | type, severity, site_id | Total events processed |
| `scada_events_queue_size` | Gauge | - | Events pending anchoring |

### Site Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_sites_active` | Gauge | - | Active sites count |
| `scada_assets_total` | Gauge | site_id | Assets per site |

### Process Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `scada_process_uptime_seconds` | Gauge | - | Process uptime |
| `scada_process_memory_bytes` | Gauge | type | Memory usage |
| `scada_process_cpu_usage_percent` | Gauge | - | CPU utilization |

## Example PromQL Queries

### Request Rate

```promql
rate(scada_http_requests_total[5m])
```

### Error Rate

```promql
sum(rate(scada_http_requests_total{status=~"5.."}[5m])) 
/ 
sum(rate(scada_http_requests_total[5m]))
```

### P95 Latency

```promql
histogram_quantile(0.95, 
  sum(rate(scada_http_request_duration_seconds_bucket[5m])) by (le)
)
```

### Event Rate by Severity

```promql
sum(rate(scada_events_total[5m])) by (severity)
```

### Database Query Rate

```promql
sum(rate(scada_db_queries_total[5m])) by (operation)
```

### Blockchain Anchoring Success Rate

```promql
sum(rate(scada_blockchain_anchors_total{status="success"}[5m])) 
/ 
sum(rate(scada_blockchain_anchors_total[5m]))
```

### Memory Usage

```promql
scada_process_memory_bytes{type="heap_used"}
```

## Alerting Rules

Example alerting rules for Prometheus:

```yaml
groups:
  - name: 0xscada
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          sum(rate(scada_http_requests_total{status=~"5.."}[5m])) 
          / sum(rate(scada_http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: High HTTP error rate detected
          description: "Error rate is {{ $value | humanizePercentage }}"

      # Slow requests
      - alert: SlowRequests
        expr: |
          histogram_quantile(0.95, 
            sum(rate(scada_http_request_duration_seconds_bucket[5m])) by (le)
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: High request latency
          description: "P95 latency is {{ $value }}s"

      # Event queue growing
      - alert: EventQueueBacklog
        expr: scada_events_queue_size > 1000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: Event queue backlog detected
          description: "{{ $value }} events pending anchoring"

      # Blockchain anchoring failures
      - alert: BlockchainAnchoringFailures
        expr: |
          rate(scada_blockchain_anchors_total{status="failure"}[5m]) 
          / rate(scada_blockchain_anchors_total[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: Blockchain anchoring failures detected

      # High memory usage
      - alert: HighMemoryUsage
        expr: scada_process_memory_bytes{type="heap_used"} > 1e9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: High memory usage
          description: "Heap usage is {{ $value | humanize1024 }}B"

      # Process restart
      - alert: ProcessRestarted
        expr: changes(scada_process_uptime_seconds[15m]) > 0
        labels:
          severity: info
        annotations:
          summary: 0xSCADA process restarted
```

## Grafana Dashboard

Import the provided dashboard or create panels with these queries:

### Overview Panel
- Request rate: `sum(rate(scada_http_requests_total[5m]))`
- Error rate: `sum(rate(scada_http_requests_total{status=~"5.."}[5m]))`
- Active sites: `scada_sites_active`
- Events/sec: `sum(rate(scada_events_total[5m]))`

### Latency Panel
- P50: `histogram_quantile(0.50, ...)`
- P95: `histogram_quantile(0.95, ...)`
- P99: `histogram_quantile(0.99, ...)`

### Resource Usage
- Memory: `scada_process_memory_bytes`
- CPU: `scada_process_cpu_usage_percent`
- DB Connections: `scada_db_connections_active`

## Label Cardinality

To prevent high cardinality issues:

1. **Paths are normalized**: `/sites/123` becomes `/sites/:id`
2. **UUIDs are replaced**: `/events/abc-123...` becomes `/events/:uuid`
3. **Limited severity values**: `info`, `warning`, `error`, `critical`
4. **Site IDs are used sparingly**: Only on event metrics

## Performance

The metrics exporter is designed for low overhead:

- Target: <2% CPU overhead
- Memory: ~10MB for typical cardinality
- Collection: O(n) where n = unique label combinations
