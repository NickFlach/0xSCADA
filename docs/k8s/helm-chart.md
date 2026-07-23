# Helm Chart Package

## Overview
Helm chart for deploying the complete 0xSCADA stack.

## Files
- `helm/oxscada/Chart.yaml` — Chart metadata
- `helm/oxscada/values.yaml` — Default values
- `helm/oxscada/templates/` — Kubernetes templates

## Install

Create an API-key Secret before installation so operator-only control-plane
routes are usable:

```bash
kubectl create namespace oxscada --dry-run=client -o yaml | kubectl apply -f -
kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS='<generated-key>:anchor-operations:operator+anchor.admin'
```

```bash
helm install oxscada ./helm/oxscada -n oxscada --create-namespace \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys

# With custom values
helm install oxscada ./helm/oxscada -n oxscada -f my-values.yaml
```

## Upgrade
```bash
helm upgrade oxscada ./helm/oxscada -n oxscada
```

## Key Values
| Value | Default | Description |
|-------|---------|-------------|
| `server.replicaCount` | 2 | Server replicas |
| `server.apiKeys.existingSecret` | `""` | Existing Secret containing `API_KEYS` |
| `server.apiKeys.secretKey` | `API_KEYS` | Key within the existing Secret |
| `server.apiKeys.enableGlobalAuth` | `false` | Require keys on all non-public API routes |
| `ingress.enabled` | true | Enable ingress |
| `ingress.host` | oxscada.example.com | Hostname |
| `blockchain.enabled` | true | Deploy validators |
| `observability.enabled` | true | Deploy monitoring |

The chart never includes a default credential. See
[Control-Plane API Keys](../security/control-plane-api-keys.md) for secure key
generation, operator and service scope examples, rotation, and the equivalent
Docker Compose configuration.
