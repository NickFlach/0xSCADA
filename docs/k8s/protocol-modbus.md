# Protocol Container — Modbus

## Overview
Containerized Modbus TCP/RTU driver for industrial device communication.

## Files
- `k8s/protocols/modbus/deployment.yaml` — Deployment
- `k8s/protocols/modbus/service.yaml` — ClusterIP service
- `k8s/protocols/modbus/configmap.yaml` — Configuration
- `services/modbus-driver/Dockerfile` — Container image

## Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `MODBUS_MODE` | tcp | `tcp` or `rtu` |
| `MODBUS_DEFAULT_PORT` | 502 | Default Modbus TCP port |
| `MODBUS_POLL_INTERVAL_MS` | 1000 | Polling interval |
| `MODBUS_TIMEOUT_MS` | 5000 | Connection timeout |
| `MODBUS_RETRIES` | 3 | Retry count |

## Deployment
```bash
kubectl apply -f k8s/protocols/modbus/ -n oxscada-protocols
```
