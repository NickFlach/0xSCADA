# Full-Stack Helm Deployment

> Issue #159: [Deploy] Single Helm chart for full stack deployment

## Overview

The `oxscada-full` Helm chart deploys the entire 0xSCADA stack in a single command: server, client, gateway, blockchain node, and observability (Prometheus + Grafana).

## Quick Start

```bash
helm install oxscada ./helm/oxscada-full -n oxscada --create-namespace
```

## Components

| Component | Default Port | Replicas | Description |
|-----------|-------------|----------|-------------|
| Server | 3000 | 2 | API server + consensus engine |
| Client | 80 | 2 | React frontend |
| Gateway | 8080 | 1 | WebSocket gateway |
| Blockchain | 8545/8546 | 1 | Hardhat/Geth fork node |
| Prometheus | 9090 | 1 | Metrics collection |
| Grafana | 3001 | 1 | Dashboards |
| PostgreSQL | 5432 | 1 | Database |

## Configuration

Override values with `--set` or a custom values file:

```bash
helm install oxscada ./helm/oxscada-full \
  --set server.replicaCount=3 \
  --set blockchain.persistence.size=50Gi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=oxscada.example.com
```

## Disabling Components

```yaml
# values-minimal.yaml
blockchain:
  enabled: false
observability:
  enabled: false
```

```bash
helm install oxscada ./helm/oxscada-full -f values-minimal.yaml
```

## Architecture

```
                    ┌─────────┐
                    │ Ingress │
                    └────┬────┘
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌─────────┐
         │ Client │ │ Server │ │ Gateway │
         └────────┘ └───┬────┘ └─────────┘
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
         ┌────────┐ ┌──────┐ ┌───────────┐
         │Postgres│ │Blockchain│ │Observability│
         └────────┘ └──────┘ └───────────┘
```

## Relation to #133

This chart extends the containerization work from #133 (`helm/oxscada/`) by adding:
- Sub-chart architecture for independent component scaling
- Blockchain node deployment with persistence
- Observability stack (Prometheus + Grafana)
- Ingress configuration
- Full values.yaml with all tunables
