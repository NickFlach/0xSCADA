# 0xSCADA Containerization Issues

> **Epic**: 9.3 - Process Isolation & Containerization
> **Parent Strategy**: [CONTAINERIZATION_STRATEGY.md](./CONTAINERIZATION_STRATEGY.md)

This document provides a complete breakdown of workable issues for agentic workers. Each issue is self-contained with clear acceptance criteria, implementation hints, and learning objectives.

---

## Issue Index

| ID | Title | Track | Difficulty | Dependencies |
|----|-------|-------|------------|--------------|
| 9.3.1 | Kubernetes Cluster Bootstrap | D | Level 2 | - |
| 9.3.2 | Core Container Images | B | Level 1 | - |
| 9.3.3 | PostgreSQL StatefulSet | B | Level 2 | 9.3.1 |
| 9.3.4 | Application Deployment | B | Level 2 | 9.3.2, 9.3.3 |
| 9.3.5 | Ingress & TLS Setup | B | Level 2 | 9.3.4 |
| 9.3.6 | Container Network Policies | D | Level 2 | 9.3.4 |
| 9.3.7 | Industrial I/O Device Plugin | D | Level 3 | 9.3.1 |
| 9.3.8 | Protocol Container - Modbus | B+E | Level 3 | 9.3.6 |
| 9.3.9 | Protocol Container - OPC-UA | B+E | Level 3 | 9.3.6 |
| 9.3.10 | Blockchain Validator Container | C | Level 3 | 9.3.4 |
| 9.3.11 | Real-Time Scheduler Extension | D | Level 4 | 9.3.7 |
| 9.3.12 | Helm Chart Package | B | Level 2 | 9.3.1-9.3.5 |
| 9.3.13 | GitOps with ArgoCD | B | Level 3 | 9.3.12 |
| 9.3.14 | Container Security Hardening | D+Q | Level 3 | 9.3.4 |
| 9.3.15 | Observability Stack | B+Q | Level 2 | 9.3.4 |
| 9.3.16 | CLI Container Commands | B | Level 2 | 9.3.4 |

---

## Phase 1: Foundation

### 9.3.1 - Kubernetes Cluster Bootstrap

**Track**: D (Systems) | **Difficulty**: Level 2 | **Effort**: 4-8 hours

#### Description
Set up a production-ready Kubernetes cluster with bare metal worker nodes optimized for industrial workloads. Use k3s for lightweight deployment with custom configuration for PREEMPT_RT kernel integration.

#### Learning Objectives
- Kubernetes cluster architecture
- k3s installation and configuration
- Node labeling and taints for specialized workloads
- kubeconfig and RBAC setup

#### Acceptance Criteria
- [ ] k3s cluster with 1 control plane + 2 worker nodes
- [ ] Workers labeled: `node-role.oxscada.io/compute`, `node-role.oxscada.io/control`
- [ ] RBAC configured with admin, operator, and viewer roles
- [ ] Cluster health verified via `kubectl get nodes`
- [ ] Documentation in `docs/deployment/kubernetes-setup.md`

#### Implementation Hints
```bash
# Start with k3s for simplicity
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644

# Label nodes for specialized workloads
kubectl label nodes worker-1 node-role.oxscada.io/compute=true
kubectl label nodes worker-2 node-role.oxscada.io/control=true
```

#### Files to Create/Modify
- `k8s/cluster/k3s-config.yaml` - k3s server configuration
- `k8s/cluster/rbac.yaml` - RBAC roles and bindings
- `docs/deployment/kubernetes-setup.md` - Setup documentation

#### Agent Onboarding
```
Context: 0xSCADA uses Kubernetes for orchestrating industrial control workloads.
Goal: Bootstrap a k3s cluster that can run the existing docker-compose services.
Constraints: Must support PREEMPT_RT kernel on worker nodes for real-time control.
Test: `kubectl get nodes` shows all nodes Ready, `kubectl auth can-i` verifies RBAC.
```

---

### 9.3.2 - Core Container Images

**Track**: B (Backend) | **Difficulty**: Level 1 | **Effort**: 2-4 hours

#### Description
Create optimized base container images for 0xSCADA services. Extend existing Dockerfile with multi-architecture support and security hardening.

#### Learning Objectives
- Multi-stage Docker builds
- Alpine Linux security hardening
- Multi-architecture images (amd64, arm64)
- Container image scanning

#### Acceptance Criteria
- [ ] Base image `oxscada/base:1.0` with Node.js 20 + security hardening
- [ ] Application image `oxscada/server:1.0` builds successfully
- [ ] Images scan clean with Trivy (no HIGH/CRITICAL vulnerabilities)
- [ ] GitHub Actions workflow for automated builds
- [ ] Images pushed to GitHub Container Registry (ghcr.io)

#### Implementation Hints
```dockerfile
# Multi-arch build
FROM --platform=$TARGETPLATFORM node:20-alpine AS base
RUN apk add --no-cache dumb-init && \
    addgroup -g 1001 -S oxscada && \
    adduser -S oxscada -u 1001

# Security hardening
RUN apk upgrade --no-cache && \
    rm -rf /var/cache/apk/*
```

#### Files to Create/Modify
- `docker/Dockerfile.base` - Base image definition
- `docker/Dockerfile.server` - Server image (extend existing)
- `.github/workflows/container-build.yml` - Build workflow
- `docker/trivy-config.yaml` - Vulnerability scanning config

#### Agent Onboarding
```
Context: Existing Dockerfile at project root builds the server.
Goal: Create optimized base images with security hardening and multi-arch support.
Constraints: Must maintain compatibility with existing docker-compose.yml.
Test: `docker build` succeeds, `trivy image oxscada/server:1.0` shows no HIGH vulnerabilities.
```

---

### 9.3.3 - PostgreSQL StatefulSet

**Track**: B (Backend) | **Difficulty**: Level 2 | **Effort**: 4-6 hours

#### Description
Migrate PostgreSQL from docker-compose to Kubernetes StatefulSet with persistent volumes, automated backups, and high availability preparation.

#### Learning Objectives
- Kubernetes StatefulSets for stateful workloads
- PersistentVolumeClaims and storage classes
- ConfigMaps and Secrets for database configuration
- Database backup strategies in Kubernetes

#### Acceptance Criteria
- [ ] PostgreSQL 15 StatefulSet with 1 replica
- [ ] PVC with `storageClassName: local-path` (k3s default)
- [ ] Secrets for database credentials
- [ ] ConfigMap for custom postgresql.conf
- [ ] CronJob for daily pg_dump backups
- [ ] Database accessible from within cluster at `postgres.oxscada.svc.cluster.local`

#### Implementation Hints
```yaml
# StatefulSet pattern
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: oxscada
spec:
  serviceName: postgres
  replicas: 1
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
```

#### Files to Create/Modify
- `k8s/database/statefulset.yaml` - PostgreSQL StatefulSet
- `k8s/database/service.yaml` - Headless service
- `k8s/database/configmap.yaml` - PostgreSQL configuration
- `k8s/database/secret.yaml` - Database credentials (template)
- `k8s/database/backup-cronjob.yaml` - Backup job

#### Agent Onboarding
```
Context: Current docker-compose runs postgres:15-alpine with volume postgres_data.
Goal: Create Kubernetes-native PostgreSQL deployment with same functionality.
Constraints: Must preserve data migration path from docker-compose volume.
Test: `kubectl exec` into postgres pod, `psql -c "SELECT 1"` succeeds.
```

---

### 9.3.4 - Application Deployment

**Track**: B (Backend) | **Difficulty**: Level 2 | **Effort**: 4-6 hours

#### Description
Deploy the 0xSCADA server application as a Kubernetes Deployment with health checks, resource limits, and environment configuration.

#### Learning Objectives
- Kubernetes Deployments and ReplicaSets
- Liveness and readiness probes
- Resource requests and limits
- Environment configuration with ConfigMaps

#### Acceptance Criteria
- [ ] Deployment with 2 replicas for high availability
- [ ] Readiness probe on `/api/health`
- [ ] Liveness probe with appropriate timeouts
- [ ] Resource limits: 512Mi memory, 500m CPU
- [ ] Environment variables from ConfigMap and Secrets
- [ ] Rolling update strategy configured

#### Implementation Hints
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oxscada-server
  namespace: oxscada
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
      - name: server
        image: ghcr.io/oxscada/server:1.0
        ports:
        - containerPort: 5000
        readinessProbe:
          httpGet:
            path: /api/health
            port: 5000
          initialDelaySeconds: 10
          periodSeconds: 5
```

#### Files to Create/Modify
- `k8s/server/deployment.yaml` - Server Deployment
- `k8s/server/service.yaml` - ClusterIP Service
- `k8s/server/configmap.yaml` - Environment configuration
- `k8s/server/hpa.yaml` - Horizontal Pod Autoscaler (optional)

#### Agent Onboarding
```
Context: Server runs on port 5000, health check at /api/health.
Goal: Deploy server with Kubernetes-native health management and scaling.
Constraints: Must connect to PostgreSQL via DATABASE_URL from secrets.
Test: `kubectl get pods` shows 2/2 Ready, `curl /api/health` returns 200.
```

---

### 9.3.5 - Ingress & TLS Setup

**Track**: B (Backend) | **Difficulty**: Level 2 | **Effort**: 3-5 hours

#### Description
Configure Kubernetes Ingress with TLS termination using Traefik (k3s default) and cert-manager for automated certificate management.

#### Learning Objectives
- Kubernetes Ingress resources
- TLS certificate management
- cert-manager and Let's Encrypt
- Traefik IngressRoute (k3s)

#### Acceptance Criteria
- [ ] Ingress routes traffic to oxscada-server service
- [ ] TLS certificate via cert-manager (staging first, then prod)
- [ ] HTTP to HTTPS redirect
- [ ] WebSocket support for real-time features
- [ ] Custom headers for security (HSTS, CSP)

#### Implementation Hints
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oxscada-ingress
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    traefik.ingress.kubernetes.io/router.middlewares: oxscada-https-redirect@kubernetescrd
spec:
  tls:
  - hosts:
    - api.oxscada.local
    secretName: oxscada-tls
  rules:
  - host: api.oxscada.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: oxscada-server
            port:
              number: 5000
```

#### Files to Create/Modify
- `k8s/ingress/ingress.yaml` - Ingress resource
- `k8s/ingress/certificate.yaml` - Certificate request
- `k8s/ingress/cluster-issuer.yaml` - Let's Encrypt issuer
- `k8s/ingress/middleware.yaml` - Traefik middlewares

#### Agent Onboarding
```
Context: k3s includes Traefik as default ingress controller.
Goal: Expose 0xSCADA API with TLS and proper security headers.
Constraints: Must support WebSocket connections for real-time features.
Test: `curl -I https://api.oxscada.local` returns 200 with valid TLS.
```

---

## Phase 2: Integration

### 9.3.6 - Container Network Policies

**Track**: D (Systems) | **Difficulty**: Level 2 | **Effort**: 4-6 hours

#### Description
Implement Kubernetes NetworkPolicies for micro-segmentation between 0xSCADA components. Define policies for control plane, data plane, and industrial protocol traffic.

#### Learning Objectives
- Kubernetes NetworkPolicy resources
- Network segmentation strategies
- Pod selectors and namespace isolation
- Debugging network policies

#### Acceptance Criteria
- [ ] Default deny policy for oxscada namespace
- [ ] Allow policy: server → postgres (port 5432)
- [ ] Allow policy: server → blockchain (port 8545)
- [ ] Allow policy: ingress → server (port 5000)
- [ ] Allow policy: protocol containers → server (port 5000)
- [ ] Deny all egress except explicitly allowed

#### Implementation Hints
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: oxscada
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-server-to-postgres
spec:
  podSelector:
    matchLabels:
      app: oxscada-server
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - port: 5432
```

#### Files to Create/Modify
- `k8s/network/default-deny.yaml` - Default deny policy
- `k8s/network/server-policies.yaml` - Server network rules
- `k8s/network/protocol-policies.yaml` - Protocol container rules
- `docs/security/network-segmentation.md` - Network documentation

#### Agent Onboarding
```
Context: 0xSCADA has multiple components that should be isolated.
Goal: Implement zero-trust network model within the cluster.
Constraints: Must not break existing service communication.
Test: `kubectl exec` from unauthorized pod fails to reach postgres.
```

---

### 9.3.7 - Industrial I/O Device Plugin

**Track**: D (Systems) | **Difficulty**: Level 3 | **Effort**: 8-12 hours

#### Description
Develop a Kubernetes Device Plugin for industrial I/O devices, allowing containers to request and access serial ports, GPIO pins, and industrial communication hardware.

#### Learning Objectives
- Kubernetes Device Plugin API
- Linux device management (udev)
- gRPC plugin implementation
- Industrial I/O hardware abstraction

#### Acceptance Criteria
- [ ] Device plugin discovers serial devices (/dev/ttyUSB*, /dev/ttyS*)
- [ ] Pods can request `oxscada.io/serial-port: 1`
- [ ] Plugin handles hot-plug events
- [ ] Health checking for device availability
- [ ] DaemonSet deployment for plugin

#### Implementation Hints
```go
// Device Plugin registration
func (p *IndustrialIOPlugin) Register() error {
    sock := filepath.Join(pluginapi.DevicePluginPath, "industrial-io.sock")
    // Implement ListAndWatch, Allocate
}

// Resource annotation
// Pod spec:
// resources:
//   limits:
//     oxscada.io/serial-port: 1
```

#### Files to Create/Modify
- `k8s/device-plugins/industrial-io/main.go` - Plugin implementation
- `k8s/device-plugins/industrial-io/Dockerfile` - Plugin image
- `k8s/device-plugins/industrial-io/daemonset.yaml` - Deployment
- `docs/deployment/industrial-io-plugin.md` - Usage documentation

#### Agent Onboarding
```
Context: Industrial control requires direct access to serial ports and GPIO.
Goal: Enable Kubernetes pods to request industrial I/O devices.
Constraints: Must work with PREEMPT_RT kernel, handle device hot-plug.
Test: Pod with `oxscada.io/serial-port: 1` can access /dev/ttyUSB0.
```

---

### 9.3.8 - Protocol Container - Modbus

**Track**: B + E | **Difficulty**: Level 3 | **Effort**: 6-8 hours

#### Description
Containerize the Modbus TCP/RTU driver as a standalone microservice that communicates with the main server via gRPC or REST.

#### Learning Objectives
- Microservice architecture patterns
- Protocol driver containerization
- gRPC service design
- Industrial protocol best practices

#### Acceptance Criteria
- [ ] Modbus container image with driver from `server/gateway/modbus/`
- [ ] gRPC API for read/write operations
- [ ] Configuration via environment variables and ConfigMap
- [ ] Prometheus metrics for connection status, latency, errors
- [ ] Integration with main server for event forwarding
- [ ] Support both TCP and RTU (via serial device plugin)

#### Implementation Hints
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: modbus-driver
spec:
  template:
    spec:
      containers:
      - name: modbus
        image: ghcr.io/oxscada/modbus-driver:1.0
        env:
        - name: MODBUS_MODE
          value: "tcp"  # or "rtu"
        - name: MODBUS_HOST
          value: "192.168.1.100"
        - name: MODBUS_PORT
          value: "502"
        ports:
        - containerPort: 50051  # gRPC
```

#### Files to Create/Modify
- `services/modbus-driver/Dockerfile` - Modbus container
- `services/modbus-driver/proto/modbus.proto` - gRPC service definition
- `k8s/protocols/modbus/deployment.yaml` - Kubernetes deployment
- `k8s/protocols/modbus/service.yaml` - gRPC service

#### Agent Onboarding
```
Context: Existing Modbus driver at server/gateway/modbus-driver.ts.
Goal: Extract into standalone containerized microservice.
Constraints: Must maintain existing API compatibility with server.
Test: gRPC client can read Modbus registers via container.
```

---

### 9.3.9 - Protocol Container - OPC-UA

**Track**: B + E | **Difficulty**: Level 3 | **Effort**: 6-8 hours

#### Description
Containerize the OPC-UA driver as a standalone microservice with subscription management and event forwarding.

#### Learning Objectives
- OPC-UA protocol concepts
- Subscription-based data acquisition
- Event-driven architecture
- Container networking for OPC-UA

#### Acceptance Criteria
- [ ] OPC-UA container image with driver
- [ ] gRPC API for browse, read, write, subscribe
- [ ] Subscription management with configurable sampling
- [ ] Certificate management for OPC-UA security
- [ ] Prometheus metrics for server connections, subscriptions

#### Implementation Hints
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opcua-driver
spec:
  template:
    spec:
      containers:
      - name: opcua
        image: ghcr.io/oxscada/opcua-driver:1.0
        env:
        - name: OPCUA_ENDPOINT
          value: "opc.tcp://192.168.1.100:4840"
        - name: OPCUA_SECURITY_MODE
          value: "SignAndEncrypt"
        volumeMounts:
        - name: opcua-certs
          mountPath: /certs
```

#### Files to Create/Modify
- `services/opcua-driver/Dockerfile` - OPC-UA container
- `services/opcua-driver/proto/opcua.proto` - gRPC service definition
- `k8s/protocols/opcua/deployment.yaml` - Kubernetes deployment
- `k8s/protocols/opcua/certificate-secret.yaml` - OPC-UA certificates

#### Agent Onboarding
```
Context: OPC-UA is the primary industrial protocol for 0xSCADA.
Goal: Create containerized OPC-UA driver with subscription support.
Constraints: Must handle OPC-UA security modes and certificate management.
Test: gRPC client can browse OPC-UA server and subscribe to nodes.
```

---

### 9.3.10 - Blockchain Validator Container

**Track**: C (Blockchain) | **Difficulty**: Level 3 | **Effort**: 8-12 hours

#### Description
Containerize the 0xSCADA blockchain validator (geth fork) with proper persistence, networking, and integration with the governance system.

#### Learning Objectives
- Ethereum node containerization
- Clique PoA configuration
- Validator key management
- Blockchain data persistence

#### Acceptance Criteria
- [ ] Validator container from `geth-fork/` source
- [ ] StatefulSet with persistent chain data
- [ ] Genesis block configuration via ConfigMap
- [ ] Validator key stored in Kubernetes Secret
- [ ] P2P networking between validator pods
- [ ] JSON-RPC API exposed internally

#### Implementation Hints
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: oxscada-validator
spec:
  serviceName: validator
  replicas: 3
  volumeClaimTemplates:
  - metadata:
      name: chaindata
    spec:
      resources:
        requests:
          storage: 50Gi
  template:
    spec:
      containers:
      - name: geth
        image: ghcr.io/oxscada/geth:1.0
        args:
        - --config=/config/config.toml
        - --datadir=/data
        - --unlock=$(VALIDATOR_ADDRESS)
        - --password=/secrets/password
        - --mine
```

#### Files to Create/Modify
- `services/validator/Dockerfile` - Validator image
- `k8s/blockchain/statefulset.yaml` - Validator StatefulSet
- `k8s/blockchain/genesis-configmap.yaml` - Genesis configuration
- `k8s/blockchain/validator-secrets.yaml` - Key management

#### Agent Onboarding
```
Context: Custom geth fork at geth-fork/ with Clique PoA consensus.
Goal: Deploy 3-node validator cluster in Kubernetes.
Constraints: Must maintain chain ID 0x5CADA, 5-second block time.
Test: `eth_blockNumber` increases, `eth_mining` returns true.
```

---

## Phase 3: Advanced Features

### 9.3.11 - Real-Time Scheduler Extension

**Track**: D (Systems) | **Difficulty**: Level 4 | **Effort**: 12-16 hours

#### Description
Extend Kubernetes scheduler to support real-time workload placement with PREEMPT_RT priority classes and CPU isolation.

#### Learning Objectives
- Kubernetes scheduler framework
- Real-time Linux scheduling (SCHED_FIFO, SCHED_RR)
- CPU pinning and isolation
- Custom scheduler plugins

#### Acceptance Criteria
- [ ] Custom scheduler plugin for RT workloads
- [ ] PriorityClass definitions for RT_CRITICAL, RT_HIGH, RT_NORMAL
- [ ] CPU manager static policy for RT pods
- [ ] Node affinity for PREEMPT_RT kernel nodes
- [ ] Latency metrics and SLA enforcement

#### Implementation Hints
```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: rt-critical
value: 1000000
preemptionPolicy: PreemptLowerPriority
description: "Real-time critical industrial control"
---
# Pod spec
spec:
  priorityClassName: rt-critical
  containers:
  - resources:
      requests:
        cpu: "2"
      limits:
        cpu: "2"
  # Guaranteed QoS for CPU manager static policy
```

#### Files to Create/Modify
- `k8s/scheduler/priority-classes.yaml` - RT priority definitions
- `k8s/scheduler/scheduler-config.yaml` - Scheduler configuration
- `k8s/scheduler/rt-scheduler-plugin/` - Custom plugin (Go)
- `docs/deployment/realtime-scheduling.md` - RT scheduling guide

#### Agent Onboarding
```
Context: Industrial control requires deterministic scheduling.
Goal: Enable Kubernetes to schedule RT-critical pods appropriately.
Constraints: Must work with PREEMPT_RT kernel, sub-millisecond latency.
Test: RT pod gets dedicated CPUs, latency histogram shows < 1ms p99.
```

---

### 9.3.12 - Helm Chart Package

**Track**: B (Backend) | **Difficulty**: Level 2 | **Effort**: 6-8 hours

#### Description
Package all Kubernetes manifests into a Helm chart for parameterized deployment across environments.

#### Learning Objectives
- Helm chart structure
- Go templating for Kubernetes
- Values files and overrides
- Chart dependencies

#### Acceptance Criteria
- [ ] Helm chart at `charts/oxscada/`
- [ ] Values for: replicas, resources, image tags, database config
- [ ] Sub-charts for database, server, protocols
- [ ] Environment-specific values (dev, staging, prod)
- [ ] `helm test` hooks for deployment verification
- [ ] Chart published to GitHub Pages or OCI registry

#### Implementation Hints
```yaml
# charts/oxscada/values.yaml
replicaCount: 2
image:
  repository: ghcr.io/oxscada/server
  tag: "1.0"
database:
  enabled: true
  storage: 10Gi
protocols:
  modbus:
    enabled: true
  opcua:
    enabled: true
```

#### Files to Create/Modify
- `charts/oxscada/Chart.yaml` - Chart metadata
- `charts/oxscada/values.yaml` - Default values
- `charts/oxscada/templates/` - Kubernetes templates
- `charts/oxscada/values-prod.yaml` - Production overrides

#### Agent Onboarding
```
Context: k8s/ directory contains raw manifests.
Goal: Convert to parameterized Helm chart for multi-environment deployment.
Constraints: Must maintain backwards compatibility with raw manifests.
Test: `helm install oxscada ./charts/oxscada` deploys successfully.
```

---

### 9.3.13 - GitOps with ArgoCD

**Track**: B (Backend) | **Difficulty**: Level 3 | **Effort**: 6-8 hours

#### Description
Implement GitOps workflow using ArgoCD for declarative, version-controlled deployments.

#### Learning Objectives
- GitOps principles and practices
- ArgoCD Application and Project resources
- Automated sync and rollback
- Multi-environment promotion

#### Acceptance Criteria
- [ ] ArgoCD installed in cluster
- [ ] Application definitions for dev, staging, prod
- [ ] Automated sync from main branch
- [ ] Health checks and sync status
- [ ] Slack/webhook notifications for sync events
- [ ] Rollback capability via git revert

#### Implementation Hints
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: oxscada-prod
  namespace: argocd
spec:
  project: oxscada
  source:
    repoURL: https://github.com/org/oxscada
    targetRevision: main
    path: charts/oxscada
    helm:
      valueFiles:
      - values-prod.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: oxscada-prod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

#### Files to Create/Modify
- `argocd/projects/oxscada.yaml` - ArgoCD Project
- `argocd/applications/oxscada-dev.yaml` - Dev Application
- `argocd/applications/oxscada-prod.yaml` - Prod Application
- `docs/deployment/gitops.md` - GitOps workflow documentation

#### Agent Onboarding
```
Context: Helm chart exists, need automated deployment pipeline.
Goal: Implement GitOps workflow for declarative deployments.
Constraints: Must support multiple environments, require PR approval for prod.
Test: Push to main triggers sync, ArgoCD shows Healthy/Synced.
```

---

### 9.3.14 - Container Security Hardening

**Track**: D + Q | **Difficulty**: Level 3 | **Effort**: 8-12 hours

#### Description
Implement comprehensive container security including image scanning, runtime protection, and compliance verification.

#### Learning Objectives
- Container vulnerability scanning
- Pod Security Standards
- Runtime threat detection (Falco)
- CIS Kubernetes benchmarks

#### Acceptance Criteria
- [ ] Trivy scanning in CI/CD with blocking on HIGH/CRITICAL
- [ ] Pod Security Standards (restricted) enforced
- [ ] Falco deployed for runtime monitoring
- [ ] SecComp profiles for all pods
- [ ] CIS benchmark compliance (kube-bench)
- [ ] Security dashboards in Grafana

#### Implementation Hints
```yaml
# Pod Security Standard
apiVersion: v1
kind: Namespace
metadata:
  name: oxscada
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
---
# SecComp profile
securityContext:
  seccompProfile:
    type: RuntimeDefault
  runAsNonRoot: true
  allowPrivilegeEscalation: false
```

#### Files to Create/Modify
- `k8s/security/pod-security-policy.yaml` - PSS labels
- `k8s/security/seccomp-profiles/` - Custom SecComp profiles
- `k8s/security/falco/` - Falco deployment
- `.github/workflows/security-scan.yml` - CI security scanning

#### Agent Onboarding
```
Context: Security is critical for industrial control systems.
Goal: Implement defense-in-depth container security.
Constraints: Must not break industrial I/O device access.
Test: kube-bench passes, Falco detects simulated attack.
```

---

### 9.3.15 - Observability Stack

**Track**: B + Q | **Difficulty**: Level 2 | **Effort**: 6-8 hours

#### Description
Deploy comprehensive observability stack with Prometheus, Grafana, and Loki for metrics, dashboards, and log aggregation.

#### Learning Objectives
- Prometheus metrics and alerting
- Grafana dashboards and visualization
- Loki for log aggregation
- OpenTelemetry integration

#### Acceptance Criteria
- [ ] Prometheus Operator deployed
- [ ] ServiceMonitors for all 0xSCADA components
- [ ] Grafana with pre-built dashboards (server, database, protocols)
- [ ] Loki for centralized logging
- [ ] AlertManager with Slack/PagerDuty integration
- [ ] SLA dashboards (uptime, latency, error rates)

#### Implementation Hints
```yaml
# Using kube-prometheus-stack
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: oxscada-server
spec:
  selector:
    matchLabels:
      app: oxscada-server
  endpoints:
  - port: http
    path: /metrics
    interval: 15s
```

#### Files to Create/Modify
- `k8s/monitoring/kube-prometheus-stack-values.yaml` - Helm values
- `k8s/monitoring/servicemonitors/` - Component monitors
- `k8s/monitoring/dashboards/` - Grafana dashboard JSON
- `k8s/monitoring/alerts/` - AlertManager rules

#### Agent Onboarding
```
Context: 0xSCADA exposes Prometheus metrics at /metrics endpoint.
Goal: Full observability with metrics, logs, and alerting.
Constraints: Must integrate with existing OpenTelemetry traces.
Test: Grafana dashboard shows all components, alerts fire correctly.
```

---

### 9.3.16 - CLI Container Commands

**Track**: B (Backend) | **Difficulty**: Level 2 | **Effort**: 4-6 hours

#### Description
Extend the 0xSCADA CLI with container management commands for deployment, scaling, and troubleshooting.

#### Learning Objectives
- CLI extension patterns
- Kubernetes API client usage
- Container troubleshooting tools
- User experience for operations

#### Acceptance Criteria
- [ ] `0xscada containers list` - List running pods
- [ ] `0xscada containers logs <pod>` - View pod logs
- [ ] `0xscada containers exec <pod> <cmd>` - Execute in pod
- [ ] `0xscada containers deploy <env>` - Trigger deployment
- [ ] `0xscada containers rollback <revision>` - Rollback deployment
- [ ] `0xscada containers status` - Cluster health overview

#### Implementation Hints
```typescript
// cli/src/commands/containers.ts
import { Command } from "commander";
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";

export function registerContainersCommand(program: Command): void {
  const containers = program.command("containers")
    .description("Container and Kubernetes management");

  containers.command("list")
    .description("List running containers")
    .action(async () => {
      const kc = new KubeConfig();
      kc.loadFromDefault();
      const k8sApi = kc.makeApiClient(CoreV1Api);
      const pods = await k8sApi.listNamespacedPod("oxscada");
      // Format and output
    });
}
```

#### Files to Create/Modify
- `cli/src/commands/containers.ts` - Container commands
- `cli/src/commands/index.ts` - Register containers command
- `cli/package.json` - Add @kubernetes/client-node dependency
- `docs/cli/containers.md` - CLI documentation

#### Agent Onboarding
```
Context: CLI at cli/src/ with Commander.js pattern.
Goal: Add container management commands for operators.
Constraints: Must work with kubeconfig, support multiple contexts.
Test: `0xscada containers list` shows running pods.
```

---

## Beads Issue Format

For import into the Beads issue tracking system, use the following JSONL format:

```jsonl
{"id":"0xSCADA-931","title":"9.3.1: Kubernetes Cluster Bootstrap","description":"Set up k3s cluster with bare metal workers, RBAC, and node labeling for industrial workloads.","status":"open","priority":1,"issue_type":"task","dependencies":[]}
{"id":"0xSCADA-932","title":"9.3.2: Core Container Images","description":"Create multi-arch base images with security hardening and CI/CD build pipeline.","status":"open","priority":1,"issue_type":"task","dependencies":[]}
{"id":"0xSCADA-933","title":"9.3.3: PostgreSQL StatefulSet","description":"Migrate PostgreSQL to Kubernetes StatefulSet with PVC and backup CronJob.","status":"open","priority":1,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-931"}]}
{"id":"0xSCADA-934","title":"9.3.4: Application Deployment","description":"Deploy 0xSCADA server as Kubernetes Deployment with probes and resource limits.","status":"open","priority":1,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-932"},{"depends_on_id":"0xSCADA-933"}]}
{"id":"0xSCADA-935","title":"9.3.5: Ingress & TLS Setup","description":"Configure Traefik Ingress with cert-manager for automated TLS.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
{"id":"0xSCADA-936","title":"9.3.6: Container Network Policies","description":"Implement NetworkPolicies for micro-segmentation and zero-trust networking.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
{"id":"0xSCADA-937","title":"9.3.7: Industrial I/O Device Plugin","description":"Kubernetes Device Plugin for serial ports and industrial hardware passthrough.","status":"open","priority":1,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-931"}]}
{"id":"0xSCADA-938","title":"9.3.8: Protocol Container - Modbus","description":"Containerize Modbus driver as gRPC microservice.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-936"}]}
{"id":"0xSCADA-939","title":"9.3.9: Protocol Container - OPC-UA","description":"Containerize OPC-UA driver with subscription management.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-936"}]}
{"id":"0xSCADA-93a","title":"9.3.10: Blockchain Validator Container","description":"Containerize geth fork validators as StatefulSet with persistent chaindata.","status":"open","priority":1,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
{"id":"0xSCADA-93b","title":"9.3.11: Real-Time Scheduler Extension","description":"Custom Kubernetes scheduler plugin for PREEMPT_RT workload placement.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-937"}]}
{"id":"0xSCADA-93c","title":"9.3.12: Helm Chart Package","description":"Package all manifests into parameterized Helm chart.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-931"},{"depends_on_id":"0xSCADA-932"},{"depends_on_id":"0xSCADA-933"},{"depends_on_id":"0xSCADA-934"},{"depends_on_id":"0xSCADA-935"}]}
{"id":"0xSCADA-93d","title":"9.3.13: GitOps with ArgoCD","description":"Implement GitOps workflow for declarative deployments.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-93c"}]}
{"id":"0xSCADA-93e","title":"9.3.14: Container Security Hardening","description":"Implement Pod Security Standards, Falco, and CIS compliance.","status":"open","priority":1,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
{"id":"0xSCADA-93f","title":"9.3.15: Observability Stack","description":"Deploy Prometheus, Grafana, Loki with custom dashboards and alerts.","status":"open","priority":2,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
{"id":"0xSCADA-940","title":"9.3.16: CLI Container Commands","description":"Extend CLI with container management commands.","status":"open","priority":3,"issue_type":"task","dependencies":[{"depends_on_id":"0xSCADA-934"}]}
```

---

## GitHub Labels for These Issues

```
phase:9-os
track:backend
track:systems
track:blockchain
track:automation
track:quality
difficulty:beginner
difficulty:intermediate
difficulty:advanced
difficulty:expert
type:feature
component:server
component:gateway
component:blockchain
```

---

## Dependency Graph

```
           ┌─────────────────────────────────────────────────────┐
           │                   9.3.1 K8s Bootstrap                │
           └───────────┬──────────────┬──────────────┬───────────┘
                       │              │              │
           ┌───────────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐
           │ 9.3.2 Images     │ │9.3.7 I/O  │ │9.3.3 PG   │
           └───────────┬──────┘ │Device     │ └─────┬─────┘
                       │        └─────┬─────┘       │
                       │              │             │
           ┌───────────▼──────────────▼─────────────▼───────────┐
           │                 9.3.4 Application Deployment        │
           └──┬─────────┬──────────┬──────────┬─────────┬───────┘
              │         │          │          │         │
    ┌─────────▼───┐ ┌───▼───┐ ┌────▼────┐ ┌───▼───┐ ┌───▼────┐
    │9.3.5 Ingress│ │9.3.6  │ │9.3.10   │ │9.3.14 │ │9.3.15  │
    │& TLS        │ │Network│ │Validator│ │Security│ │Observe │
    └─────────┬───┘ └───┬───┘ └─────────┘ └───────┘ └────────┘
              │         │
              │    ┌────▼────┐    ┌────────────┐
              │    │9.3.8-9  │    │9.3.11 RT   │
              │    │Protocol │    │Scheduler   │
              │    │Containers│   └────────────┘
              │    └─────────┘
              │
    ┌─────────▼─────────────────────────────────────────────────┐
    │                    9.3.12 Helm Chart                       │
    └───────────────────────────┬───────────────────────────────┘
                                │
    ┌───────────────────────────▼───────────────────────────────┐
    │                    9.3.13 GitOps/ArgoCD                    │
    └───────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────┐
    │              9.3.16 CLI Commands (parallel)                │
    └───────────────────────────────────────────────────────────┘
```

---

*This document is part of the 0xSCADA Containerization Epic (9.3)*
*Last Updated: February 2026*
