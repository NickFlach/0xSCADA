# Application Deployment

## Overview
Kubernetes deployments for the three core 0xSCADA services: server, client, and gateway.

## Files
- `k8s/app/server-deployment.yaml` — API server (2 replicas)
- `k8s/app/client-deployment.yaml` — React frontend via nginx (2 replicas)
- `k8s/app/gateway-deployment.yaml` — API gateway (2 replicas)

## Deployment

Create the API-key bootstrap Secret before applying the raw manifests:

```bash
kubectl create namespace oxscada --dry-run=client -o yaml | kubectl apply -f -
kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS='<generated-key>:bootstrap-admin:admin'
```

Generate the key with a cryptographically secure secret generator and keep it
outside source control. The server deployment intentionally fails to start
when the Secret or `API_KEYS` entry is absent.

```bash
kubectl apply -f k8s/app/ -n oxscada
```

## Architecture
```
Client (nginx:80) → Server (:5000) → PostgreSQL (:5432)
Gateway (:8080) → Server (:5000)
```

The gateway is a stateless HTTP/WebSocket reverse proxy. `SERVER_URL` is
required and must be one fixed `http://` or `https://` origin without embedded
credentials, a path, query, or fragment. HTTP traffic is forwarded unchanged
to that origin, and WebSocket upgrades are accepted only on `/ws` and
`/ws/tags`.

`GET /health` is a process-only liveness check and remains healthy while the
server is unavailable. `GET /readyz` checks the configured server's
`/api/healthz` endpoint and is the Kubernetes readiness probe. Request bodies
larger than 10 MiB are rejected by the gateway.

## Features
- Separate process liveness and upstream-aware readiness checks
- Resource limits and requests
- Security contexts (non-root, read-only FS, no privilege escalation)
- Rolling update strategy

## Scaling
```bash
kubectl scale deployment oxscada-server --replicas=4 -n oxscada
```
