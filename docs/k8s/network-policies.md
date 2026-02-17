# Container Network Policies

## Overview
Network policies implementing least-privilege pod-to-pod communication.

## File
- `k8s/network/network-policies.yaml`

## Policy Matrix
| Source | Destination | Port | Allowed |
|--------|------------|------|---------|
| client | server | 5000 | ✅ |
| gateway | server | 5000 | ✅ |
| server | postgresql | 5432 | ✅ |
| protocols | server | 5000 | ✅ |
| ingress-nginx | client | 80 | ✅ |
| ingress-nginx | gateway | 8080 | ✅ |
| * | * | * | ❌ (default deny) |

## Deployment
```bash
kubectl apply -f k8s/network/
```
