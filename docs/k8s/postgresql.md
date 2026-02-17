# PostgreSQL StatefulSet

## Overview
PostgreSQL 16 deployed as a StatefulSet with persistent storage, init scripts, and security hardening.

## Files
- `k8s/database/postgresql-statefulset.yaml` — StatefulSet + init ConfigMap
- `k8s/database/postgresql-service.yaml` — ClusterIP service
- `k8s/database/postgresql-secret.yaml` — Credentials (replace in production!)

## Deployment
```bash
kubectl apply -f k8s/database/ -n oxscada
```

## Configuration
- **Storage**: 10Gi PVC per replica
- **Schemas**: `scada`, `blockchain`, `audit` (created by init script)
- **Extensions**: `uuid-ossp`, `pgcrypto`

## Security
- Runs as UID 999 (postgres user)
- No privilege escalation
- All capabilities dropped
- Network policy restricts access to server pods only

## Connecting
```bash
# Port forward for local access
kubectl port-forward svc/postgresql 5432:5432 -n oxscada

# Connection string
postgresql://oxscada:<password>@postgresql.oxscada.svc.cluster.local:5432/oxscada
```

⚠️ **Important**: Replace the default password in `postgresql-secret.yaml` before production deployment. Use sealed-secrets or external secrets operator.
