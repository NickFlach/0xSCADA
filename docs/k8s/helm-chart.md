# Helm Chart Package

## Overview
Helm chart for deploying the complete 0xSCADA stack.

## Files
- `helm/oxscada/Chart.yaml` — Chart metadata
- `helm/oxscada/values.yaml` — Default values
- `helm/oxscada/templates/` — Kubernetes templates

## Install
```bash
helm install oxscada ./helm/oxscada -n oxscada --create-namespace

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
| `ingress.enabled` | true | Enable ingress |
| `ingress.host` | oxscada.example.com | Hostname |
| `blockchain.enabled` | true | Deploy validators |
| `observability.enabled` | true | Deploy monitoring |
