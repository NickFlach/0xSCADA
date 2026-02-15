# Industrial I/O Device Plugin

## Overview
Kubernetes device plugin that exposes industrial I/O devices (serial ports, GPIO, SPI, I2C) as schedulable resources.

## File
- `k8s/plugins/device-plugin.yaml` — DaemonSet + ConfigMap

## Exposed Resources
| Resource | Device Pattern |
|----------|---------------|
| `oxscada.io/serial-port` | `/dev/ttyS*`, `/dev/ttyUSB*`, `/dev/ttyACM*` |
| `oxscada.io/gpio` | `/dev/gpiochip*` |
| `oxscada.io/spi` | `/dev/spidev*` |
| `oxscada.io/i2c` | `/dev/i2c-*` |

## Usage in Pod Spec
```yaml
resources:
  limits:
    oxscada.io/serial-port: "1"
```

## Node Requirements
Nodes must be labeled with `oxscada.io/role: protocol` to receive the device plugin DaemonSet.

```bash
kubectl label node <node-name> oxscada.io/role=protocol
```
