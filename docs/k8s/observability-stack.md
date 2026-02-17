# Observability Stack

## Overview
Full observability with Prometheus (metrics), Grafana (dashboards), Loki (logs), and Alertmanager (alerts).

## Files
- `k8s/observability/prometheus-deployment.yaml` — Prometheus + config
- `k8s/observability/grafana-deployment.yaml` — Grafana + datasources
- `k8s/observability/loki-deployment.yaml` — Loki + config
- `k8s/observability/alertmanager-config.yaml` — Alert rules and routing

## Deployment
```bash
kubectl apply -f k8s/observability/ -n oxscada-observability
```

## Access
```bash
# Grafana
kubectl port-forward svc/grafana 3000:3000 -n oxscada-observability

# Prometheus
kubectl port-forward svc/prometheus 9090:9090 -n oxscada-observability
```

## Alerts
| Alert | Severity | Condition |
|-------|----------|-----------|
| ServerDown | Critical | Server unreachable for 1m |
| HighMemoryUsage | Warning | Container memory > 90% for 5m |
| ProtocolDriverDown | Critical | Protocol driver down for 30s |
| DatabaseConnectionFailure | Critical | PostgreSQL unreachable for 1m |
