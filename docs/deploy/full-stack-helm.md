# Full-Stack Helm Deployment

> Issue #159: [Deploy] Single Helm chart for full stack deployment

## Overview

`helm/oxscada-full` is one parent-authoritative chart for the 0xSCADA server,
client, gateway, validator, Prometheus, and Grafana. Each first-party component
is rendered by the templates in this chart and can be enabled or scaled
independently. The chart does not declare local component subcharts.

PostgreSQL is an external prerequisite. The server reads `DATABASE_URL` from an
existing Kubernetes Secret so database credentials never need to live in a
values file.

## Prerequisites

- Kubernetes 1.24 or newer
- Helm 3.12 or newer
- a PostgreSQL instance reachable from the cluster
- Secrets for the database URL, Grafana administrator password, and API keys

Create the namespace and required Secrets before installation:

```bash
kubectl create namespace oxscada --dry-run=client -o yaml | kubectl apply -f -

kubectl -n oxscada create secret generic oxscada-database \
  --from-literal=DATABASE_URL='postgresql://oxscada:<password>@postgresql.example:5432/oxscada'

kubectl -n oxscada create secret generic oxscada-grafana \
  --from-literal=admin-password='<generated-password>'

kubectl -n oxscada create secret generic oxscada-api-keys \
  --from-literal=API_KEYS='<generated-key>:bootstrap-admin:admin'
```

See [Control-Plane API Keys](../security/control-plane-api-keys.md) for secure
key generation, required scopes, global gateway authentication, and rotation
guidance.

## Validate and install

The chart intentionally has no component dependencies, but running dependency
build is part of the supported clean-checkout workflow and catches accidental
reintroduction of missing local charts:

```bash
helm dependency build ./helm/oxscada-full
helm lint --strict ./helm/oxscada-full
helm template oxscada ./helm/oxscada-full \
  --namespace oxscada \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys \
  > /tmp/oxscada-default.yaml
```

Install the default topology:

```bash
helm upgrade --install oxscada ./helm/oxscada-full \
  --namespace oxscada \
  --create-namespace \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys
```

### Optional-component dependency checks

The chart rejects combinations that would render references to Services that
do not exist:

- an enabled gateway needs either the in-chart server or an explicit
  `gateway.serverUrl`
- the built-in Prometheus job needs the in-chart server
- the built-in Grafana datasource needs the in-chart Prometheus instance
- every configured ingress path must name an enabled chart component

When disabling a component, also remove any ingress path that targets it.
These checks fail during `helm lint` and `helm template`, before Kubernetes can
accept a deployment with a dangling upstream, scrape target, datasource, or
Ingress backend.

Global authentication is on by default; rendering fails until the existing
Secret name is supplied. The chart never ships a default credential.
See [Control-Plane API Keys](../security/control-plane-api-keys.md) for secure
key generation, required operator and service scopes, global gateway
authentication, and rotation guidance.

For a production-shaped render, start from the tracked
`values-production.yaml`, create the Secrets named by that file, and override
the example hostname and image tags for the target environment:

```bash
helm dependency build ./helm/oxscada-full
helm lint --strict ./helm/oxscada-full \
  -f ./helm/oxscada-full/values-production.yaml
helm template oxscada-production ./helm/oxscada-full \
  --namespace oxscada \
  -f ./helm/oxscada-full/values-production.yaml
```

## Components

| Component | Workload | Service port | Health probes |
|-----------|----------|--------------|---------------|
| Server | Deployment | 5000 | `/api/healthz`, `/api/readyz` |
| Client | Deployment | 80 | `/health`, `/` |
| Gateway | Deployment | 8080 | `/health`, `/readyz` |
| Blockchain validator | StatefulSet | 8545 RPC, 30303 P2P | `/health` on RPC |
| Prometheus | Deployment | 9090 | `/-/healthy`, `/-/ready` |
| Grafana | Deployment | 3000 | `/api/health` |

All names are release-scoped, for example `oxscada-server` and
`oxscada-prometheus`. Selectors include the Helm release identity so multiple
releases in one namespace cannot select each other's pods.

Prometheus scrapes the server's `/api/metrics` endpoint through the
release-scoped server Service. Grafana is provisioned with that Prometheus
Service as its default datasource.

## Security defaults

Every pod runs as the non-root UID used by its image and applies the Runtime
Default seccomp profile. Containers disable privilege escalation and drop all
Linux capabilities. Server, gateway, Prometheus, and Grafana also use a
read-only root filesystem; writable data and temporary paths are mounted
explicitly.

The chart references existing Secrets for `DATABASE_URL`, `API_KEYS`, and the
Grafana administrator password. It does not generate or store credentials.

## Configuration

Override values with `--set` or a custom values file:

```bash
helm upgrade --install oxscada ./helm/oxscada-full \
  --namespace oxscada \
  --set server.replicaCount=3 \
  --set-string server.apiKeys.existingSecret=oxscada-api-keys \
  --set blockchain.persistence.size=50Gi \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=oxscada.example.com
```

The ingress template resolves each backend's actual Service port. The default
paths route `/` to the client on 80, `/api` to the server on 5000, and
`/gateway` to the gateway on 8080.

## Disabling components

```yaml
# values-minimal.yaml
blockchain:
  enabled: false
observability:
  enabled: false
```

```bash
helm upgrade --install oxscada ./helm/oxscada-full \
  --namespace oxscada \
  -f values-minimal.yaml
```

Disabling observability removes Prometheus, Grafana, their Services,
configuration, and storage resources. Disabling blockchain removes its
StatefulSet and both validator Services.

## Packaging

Package and render the archive before distributing it:

```bash
helm package ./helm/oxscada-full --destination /tmp
helm template packaged /tmp/oxscada-full-0.1.1.tgz \
  --namespace oxscada \
  -f ./helm/oxscada-full/values-production.yaml
```

Rendering the packaged archive proves the chart does not depend on untracked
local `charts/` content.
