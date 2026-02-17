# Protocol Container — OPC-UA

## Overview
Containerized OPC-UA client driver with security mode support.

## Files
- `k8s/protocols/opcua/deployment.yaml` — Deployment
- `k8s/protocols/opcua/service.yaml` — ClusterIP service
- `k8s/protocols/opcua/configmap.yaml` — Configuration
- `services/opcua-driver/Dockerfile` — Container image

## Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `OPCUA_ENDPOINT` | opc.tcp://localhost:4840 | OPC-UA server endpoint |
| `OPCUA_SECURITY_MODE` | SignAndEncrypt | Security mode |
| `OPCUA_SECURITY_POLICY` | Basic256Sha256 | Security policy |
| `OPCUA_SUBSCRIPTION_INTERVAL_MS` | 500 | Subscription interval |

## Deployment
```bash
kubectl apply -f k8s/protocols/opcua/ -n oxscada-protocols
```
