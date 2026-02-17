# Application Deployment

## Overview
Kubernetes deployments for the three core 0xSCADA services: server, client, and gateway.

## Files
- `k8s/app/server-deployment.yaml` — API server (2 replicas)
- `k8s/app/client-deployment.yaml` — React frontend via nginx (2 replicas)
- `k8s/app/gateway-deployment.yaml` — API gateway (2 replicas)

## Deployment
```bash
kubectl apply -f k8s/app/ -n oxscada
```

## Architecture
```
Client (nginx:80) → Server (:5000) → PostgreSQL (:5432)
Gateway (:8080) → Server (:5000)
```

## Features
- Health checks (liveness + readiness) on all pods
- Resource limits and requests
- Security contexts (non-root, read-only FS, no privilege escalation)
- Rolling update strategy

## Scaling
```bash
kubectl scale deployment oxscada-server --replicas=4 -n oxscada
```
