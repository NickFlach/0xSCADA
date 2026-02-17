# Real-Time Scheduler Extension

## Overview
Custom Kubernetes scheduler optimized for real-time SCADA workloads with priority classes.

## File
- `k8s/scheduler/scheduler-config.yaml`

## Priority Classes
| Class | Priority | Preemption | Use Case |
|-------|----------|-----------|----------|
| `oxscada-realtime-critical` | 1,000,000 | Yes | Data acquisition pods |
| `oxscada-realtime-high` | 500,000 | Yes | Protocol processing |
| `oxscada-standard` | 100,000 | Yes | Application pods |
| `oxscada-batch` | 10,000 | No | Analytics, batch jobs |

## Usage
```yaml
spec:
  schedulerName: oxscada-realtime-scheduler
  priorityClassName: oxscada-realtime-critical
```

## Scheduling Strategy
Uses `MostAllocated` scoring to pack pods tightly for better cache locality on real-time nodes.
