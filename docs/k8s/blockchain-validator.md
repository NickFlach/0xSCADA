# Blockchain Validator Container

## Overview
StatefulSet deployment for 0xSCADA blockchain validator nodes with persistent chain data.

## Files
- `k8s/blockchain/validator-statefulset.yaml` — StatefulSet (3 replicas)
- `k8s/blockchain/validator-service.yaml` — ClusterIP + headless services
- `docker/validator/Dockerfile` — Container image

## Ports
| Port | Protocol | Purpose |
|------|----------|---------|
| 8545 | HTTP | JSON-RPC |
| 30303 | TCP/UDP | P2P |

## Deployment
```bash
kubectl apply -f k8s/blockchain/ -n oxscada-blockchain
```

## Storage
Each validator gets a 20Gi PVC for chain data, mounted at `/data`.

## Scaling
```bash
kubectl scale statefulset blockchain-validator --replicas=5 -n oxscada-blockchain
```
