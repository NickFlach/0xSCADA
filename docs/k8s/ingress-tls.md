# Ingress & TLS Setup

## Overview
NGINX Ingress Controller with automatic TLS certificate management via cert-manager and Let's Encrypt.

## Files
- `k8s/ingress/ingress.yaml` — Ingress rules for client, server, and gateway
- `k8s/ingress/cert-manager.yaml` — ClusterIssuers and Certificate resources

## Prerequisites
```bash
# Install nginx ingress controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.0/deploy/static/provider/cloud/deploy.yaml

# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

## Deployment
```bash
kubectl apply -f k8s/ingress/
```

## Routing
| Host | Path | Backend |
|------|------|---------|
| oxscada.example.com | `/` | client:80 |
| oxscada.example.com | `/api` | server:5000 |
| oxscada.example.com | `/ws` | server:5000 (WebSocket) |
| api.oxscada.example.com | `/` | gateway:8080 |

## Configuration
Update `oxscada.example.com` to your actual domain in:
- `k8s/ingress/ingress.yaml`
- `k8s/ingress/cert-manager.yaml`
- `helm/oxscada/values.yaml`
