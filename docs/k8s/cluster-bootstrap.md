# Kubernetes Cluster Bootstrap

## Overview
Bootstrap configuration for 0xSCADA Kubernetes deployment, supporting both KIND (development) and k3s (production/edge).

## Files
- `k8s/bootstrap/cluster-config.yaml` — KIND and k3s cluster configuration
- `k8s/bootstrap/namespaces.yaml` — Namespace definitions with Pod Security Standards
- `k8s/bootstrap/resource-quotas.yaml` — Resource quotas and limit ranges
- `k8s/bootstrap/rbac.yaml` — Service accounts, roles, and role bindings

## Namespaces
| Namespace | Purpose |
|-----------|---------|
| `oxscada` | Core application (server, client, gateway, database) |
| `oxscada-protocols` | Protocol drivers (Modbus, OPC-UA) |
| `oxscada-blockchain` | Blockchain validator nodes |
| `oxscada-observability` | Prometheus, Grafana, Loki |

## Quick Start (Development)
```bash
# Create KIND cluster
kind create cluster --config k8s/bootstrap/cluster-config.yaml

# Apply bootstrap resources
kubectl apply -f k8s/bootstrap/namespaces.yaml
kubectl apply -f k8s/bootstrap/resource-quotas.yaml
kubectl apply -f k8s/bootstrap/rbac.yaml
```

## Quick Start (Production - k3s)
```bash
# Install k3s with custom config
curl -sfL https://get.k3s.io | sh -s - --config /etc/rancher/k3s/config.yaml

# Apply bootstrap resources
kubectl apply -f k8s/bootstrap/
```

## RBAC Structure
- **oxscada-admin** — Cluster-wide admin for 0xSCADA resources
- **oxscada-app** — Application-level access (configmaps, secrets read-only)
- **oxscada-protocol** — Protocol namespace access

## Related
- [Container Images](container-images.md)
- [Application Deployment](application-deployment.md)
