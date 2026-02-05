# Containerization Quick Reference

> Quick onboarding guide for agentic workers

## Issue Summary

| ID | Title | Track | Level | Blockers | Effort |
|----|-------|-------|-------|----------|--------|
| **Phase 1: Foundation** |||||
| 9.3.1 | K8s Cluster Bootstrap | D | 2 | - | 4-8h |
| 9.3.2 | Core Container Images | B | 1 | - | 2-4h |
| 9.3.3 | PostgreSQL StatefulSet | B | 2 | 9.3.1 | 4-6h |
| 9.3.4 | Application Deployment | B | 2 | 9.3.2, 9.3.3 | 4-6h |
| 9.3.5 | Ingress & TLS | B | 2 | 9.3.4 | 3-5h |
| **Phase 2: Integration** |||||
| 9.3.6 | Network Policies | D | 2 | 9.3.4 | 4-6h |
| 9.3.7 | Industrial I/O Plugin | D | 3 | 9.3.1 | 8-12h |
| 9.3.8 | Modbus Container | B+E | 3 | 9.3.6 | 6-8h |
| 9.3.9 | OPC-UA Container | B+E | 3 | 9.3.6 | 6-8h |
| 9.3.10 | Validator Container | C | 3 | 9.3.4 | 8-12h |
| **Phase 3: Advanced** |||||
| 9.3.11 | RT Scheduler | D | 4 | 9.3.7 | 12-16h |
| 9.3.12 | Helm Chart | B | 2 | 9.3.1-5 | 6-8h |
| 9.3.13 | GitOps/ArgoCD | B | 3 | 9.3.12 | 6-8h |
| 9.3.14 | Security Hardening | D+Q | 3 | 9.3.4 | 8-12h |
| 9.3.15 | Observability | B+Q | 2 | 9.3.4 | 6-8h |
| 9.3.16 | CLI Commands | B | 2 | 9.3.4 | 4-6h |

## Parallel Work Streams

```
Stream A (Infrastructure):  9.3.1 → 9.3.3 → 9.3.4 → [9.3.5, 9.3.6, 9.3.10, 9.3.14, 9.3.15, 9.3.16]
Stream B (Images):          9.3.2 → 9.3.4
Stream C (Industrial I/O):  9.3.1 → 9.3.7 → 9.3.11
Stream D (Protocols):       9.3.6 → [9.3.8, 9.3.9]
Stream E (Packaging):       9.3.5 → 9.3.12 → 9.3.13
```

## Ready to Start (No Blockers)

- **9.3.1** - K8s Cluster Bootstrap
- **9.3.2** - Core Container Images

## Key Technologies

| Component | Technology | Documentation |
|-----------|------------|---------------|
| Kubernetes | k3s | https://k3s.io/docs |
| Container Images | Alpine, multi-arch | Dockerfile best practices |
| Helm | v3 | https://helm.sh/docs |
| GitOps | ArgoCD | https://argo-cd.readthedocs.io |
| Monitoring | Prometheus/Grafana/Loki | kube-prometheus-stack |
| Security | Falco, Pod Security Standards | CIS Kubernetes Benchmark |

## File Structure After Completion

```
0xSCADA/
├── docker/
│   ├── Dockerfile.base          # 9.3.2
│   └── Dockerfile.server        # 9.3.2
├── k8s/
│   ├── cluster/
│   │   ├── k3s-config.yaml      # 9.3.1
│   │   └── rbac.yaml            # 9.3.1
│   ├── database/
│   │   ├── statefulset.yaml     # 9.3.3
│   │   ├── service.yaml         # 9.3.3
│   │   ├── configmap.yaml       # 9.3.3
│   │   ├── secret.yaml          # 9.3.3
│   │   └── backup-cronjob.yaml  # 9.3.3
│   ├── server/
│   │   ├── deployment.yaml      # 9.3.4
│   │   ├── service.yaml         # 9.3.4
│   │   ├── configmap.yaml       # 9.3.4
│   │   └── hpa.yaml             # 9.3.4
│   ├── ingress/
│   │   ├── ingress.yaml         # 9.3.5
│   │   ├── certificate.yaml     # 9.3.5
│   │   ├── cluster-issuer.yaml  # 9.3.5
│   │   └── middleware.yaml      # 9.3.5
│   ├── network/
│   │   ├── default-deny.yaml    # 9.3.6
│   │   ├── server-policies.yaml # 9.3.6
│   │   └── protocol-policies.yaml # 9.3.6
│   ├── device-plugins/
│   │   └── industrial-io/       # 9.3.7
│   │       ├── main.go
│   │       ├── Dockerfile
│   │       └── daemonset.yaml
│   ├── protocols/
│   │   ├── modbus/              # 9.3.8
│   │   │   ├── deployment.yaml
│   │   │   └── service.yaml
│   │   └── opcua/               # 9.3.9
│   │       ├── deployment.yaml
│   │       └── service.yaml
│   ├── blockchain/
│   │   ├── statefulset.yaml     # 9.3.10
│   │   ├── genesis-configmap.yaml # 9.3.10
│   │   └── validator-secrets.yaml # 9.3.10
│   ├── scheduler/
│   │   ├── priority-classes.yaml # 9.3.11
│   │   ├── scheduler-config.yaml # 9.3.11
│   │   └── rt-scheduler-plugin/ # 9.3.11
│   ├── security/
│   │   ├── pod-security-policy.yaml # 9.3.14
│   │   ├── seccomp-profiles/    # 9.3.14
│   │   └── falco/               # 9.3.14
│   └── monitoring/
│       ├── kube-prometheus-stack-values.yaml # 9.3.15
│       ├── servicemonitors/     # 9.3.15
│       ├── dashboards/          # 9.3.15
│       └── alerts/              # 9.3.15
├── charts/
│   └── oxscada/                 # 9.3.12
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-prod.yaml
│       └── templates/
├── argocd/
│   ├── projects/                # 9.3.13
│   │   └── oxscada.yaml
│   └── applications/            # 9.3.13
│       ├── oxscada-dev.yaml
│       └── oxscada-prod.yaml
├── services/
│   ├── modbus-driver/           # 9.3.8
│   │   ├── Dockerfile
│   │   └── proto/modbus.proto
│   ├── opcua-driver/            # 9.3.9
│   │   ├── Dockerfile
│   │   └── proto/opcua.proto
│   └── validator/               # 9.3.10
│       └── Dockerfile
├── cli/src/commands/
│   └── containers.ts            # 9.3.16
└── docs/
    ├── deployment/
    │   ├── kubernetes-setup.md  # 9.3.1
    │   ├── realtime-scheduling.md # 9.3.11
    │   └── gitops.md            # 9.3.13
    └── security/
        └── network-segmentation.md # 9.3.6
```

## Agent Onboarding Template

When starting any issue, use this context format:

```
## Issue 9.3.X: [Title]

### Context
- Current state: [What exists now]
- Related files: [Paths to examine]
- Dependencies: [What must be done first]

### Goal
[Clear statement of what needs to be accomplished]

### Constraints
- [Constraint 1]
- [Constraint 2]

### Verification
- [ ] Test command 1
- [ ] Test command 2
- [ ] Documentation updated
```

## Common Commands

```bash
# Verify k3s cluster
kubectl get nodes
kubectl get pods -A

# Test deployments
kubectl apply -f k8s/server/
kubectl get pods -n oxscada
kubectl logs -f deployment/oxscada-server

# Helm operations
helm lint charts/oxscada/
helm template oxscada charts/oxscada/
helm install oxscada charts/oxscada/ --dry-run

# Security scanning
trivy image ghcr.io/oxscada/server:1.0
kube-bench run --targets node
```

## Beads Integration

Issues are tracked in `.beads/issues.jsonl` with IDs `0xSCADA-930` through `0xSCADA-940`.

```bash
# List containerization issues
bd list --filter "title:9.3"

# Update issue status
bd update 0xSCADA-931 --status in_progress
bd update 0xSCADA-931 --status closed
```

---

*Last Updated: February 2026*
