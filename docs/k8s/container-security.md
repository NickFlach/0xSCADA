# Container Security Hardening

## Overview
Security policies, contexts, and runtime monitoring for 0xSCADA containers.

## Files
- `k8s/security/pod-security-policies.yaml` — Pod Security Standards
- `k8s/security/security-contexts.yaml` — Security context defaults per component
- `k8s/security/falco-rules.yaml` — Runtime security rules

## Security Measures
- **Pod Security Standards**: Restricted profile enforced via namespace labels
- **Non-root execution**: All containers run as non-root
- **Read-only filesystem**: Application containers use read-only root FS
- **Capability dropping**: All capabilities dropped, only necessary ones added
- **Seccomp profiles**: RuntimeDefault on all pods
- **Network policies**: Least-privilege pod-to-pod communication

## Falco Alerts
| Rule | Severity | Trigger |
|------|----------|---------|
| Unexpected process | WARNING | Unknown process in server container |
| Unauthorized DB access | CRITICAL | Non-server pod accessing PostgreSQL |
| Shell spawned | WARNING | Interactive shell in any container |
| Sensitive file access | CRITICAL | Reading /etc/shadow, /proc/self/environ |
