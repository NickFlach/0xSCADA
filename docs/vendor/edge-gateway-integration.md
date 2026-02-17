# Vendor Learning Tract: Edge & Gateway Integration

> Issue #29 — [Edge] Vendor Learning Tract Edge & Gateway Integration

## Introduction

This learning tract guides vendors and integrators through 0xSCADA's edge and gateway architecture. By the end, you'll understand how to:

1. Connect to industrial devices via protocol drivers
2. Deploy 0xSCADA at the edge in containers
3. Bridge edge data to the cloud
4. Extend the gateway with custom drivers

## Module 1: Gateway Architecture

The gateway layer (`server/gateway/`) connects 0xSCADA to OT equipment.

### Available Drivers

| Driver | File | Protocols |
|--------|------|-----------|
| OPC-UA | `opcua-*.ts` (5 files) | OPC-UA subscription, read/write, browsing, security |
| Modbus | `modbus-driver.ts` | Modbus TCP/RTU |
| DNP3 | `dnp3-driver.ts` | DNP3 serial/TCP |
| IEC 61850 | `iec61850-driver.ts` | MMS, GOOSE |

### Data Flow

```
PLC/RTU/DCS                         0xSCADA
    │                                  │
    │◄── OPC-UA / Modbus / DNP3 ──►   │ Gateway Drivers
    │                                  │
    │    Data Change Events            │ Subscription Manager
    │                                  │
    │                                  │ ──► Database (PostgreSQL)
    │                                  │ ──► Cloud (Azure IoT Hub)
    │                                  │ ──► Blockchain (anchoring)
    │                                  │ ──► WebSocket (UI)
```

## Module 2: OPC-UA Deep Dive

OPC-UA is the primary protocol. 0xSCADA provides five specialized modules:

### Connection Manager (`opcua-connection-manager.ts`)
- Manages OPC-UA client sessions
- Auto-reconnect with backoff
- Certificate-based authentication

### Subscription Manager (`opcua-subscription-manager.ts`)
- Create subscriptions with configurable publishing intervals
- Monitor items with deadband filtering
- Bulk subscribe/unsubscribe
- See [OPC-UA Driver Documentation](opcua-driver.md)

### Read/Write Service (`opcua-read-write-service.ts`)
- Single and batch read/write operations
- Attribute-level access (value, data type, access level)

### Address Space Browser (`opcua-address-space-browser.ts`)
- Discover nodes and their relationships
- Browse hierarchical and non-hierarchical references

### Security Manager (`opcua-security-manager.ts`)
- Certificate generation and management
- Security policy selection (Basic256Sha256, etc.)
- User token authentication

## Module 3: Edge Deployment

### Containerized Deployment
See [Containerized Edge Runtime](containerized-edge.md) for Docker patterns.

Key points:
- Multi-stage Docker builds for minimal image size
- Resource constraints for embedded hardware
- Store-and-forward for unreliable connectivity
- Offline/air-gapped deployment support

### Edge vs. Cloud

| Aspect | Edge | Cloud |
|--------|------|-------|
| Latency | <10ms to devices | 50-500ms |
| Availability | Runs during WAN outage | Depends on connectivity |
| Compute | Limited (1-4 cores, 512MB-2GB) | Elastic |
| Data | Raw, high-frequency | Aggregated, historical |
| Security | OT network, isolated | IT network, exposed |

### Recommended Architecture

```
┌────────────────┐     ┌────────────────┐     ┌──────────────┐
│  Plant Floor   │     │  Edge Device   │     │  Cloud       │
│                │     │                │     │              │
│  PLCs, RTUs    │◄──► │  0xSCADA Edge  │◄──► │  Azure IoT   │
│  Sensors       │     │  (Docker)      │     │  Hub         │
│  Actuators     │     │                │     │              │
│                │     │  - Gateway     │     │  - Dashboard │
│                │     │  - Local DB    │     │  - Analytics │
│                │     │  - Rules       │     │  - History   │
└────────────────┘     └────────────────┘     └──────────────┘
```

## Module 4: Writing a Custom Driver

To add a new protocol driver:

### 1. Create the Driver File

```typescript
// server/gateway/my-protocol-driver.ts
import { EventEmitter } from "events";

export interface MyProtocolConfig {
  host: string;
  port: number;
}

export class MyProtocolDriver extends EventEmitter {
  private connected = false;

  constructor(private config: MyProtocolConfig) {
    super();
  }

  async connect(): Promise<void> {
    // Connect to device
    this.connected = true;
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit("disconnected");
  }

  async read(address: string): Promise<{ value: any; quality: string; timestamp: Date }> {
    // Read a value from the device
    throw new Error("Not implemented");
  }

  async write(address: string, value: any): Promise<void> {
    // Write a value to the device
    throw new Error("Not implemented");
  }

  async subscribe(addresses: string[], intervalMs: number): Promise<void> {
    // Set up polling or native subscriptions
    // Emit "dataChange" events
  }
}
```

### 2. Register in Gateway Index

Add your driver to `server/gateway/index.ts`.

### 3. Add Documentation

Create `docs/vendor/my-protocol-driver.md` documenting configuration and usage.

## Module 5: Cloud Integration

### Azure IoT Hub
See [Azure IoT Integration](../optix/azure-iot-integration.md) for:
- Device-to-cloud telemetry
- Cloud-to-device commands
- Device twin management

### Data Pipeline

```
Gateway ──► Transform ──► Batch ──► Cloud Publish
              │                        │
              ├── Tag mapping          ├── Azure IoT Hub
              ├── Unit conversion      ├── MQTT broker
              └── Quality filtering    └── HTTP webhook
```

## Exercises

1. **Connect to a simulated OPC-UA server** — Use `server/simulator.ts` to generate test data, then subscribe via the subscription manager
2. **Deploy edge container** — Build and run the Docker edge image locally
3. **Add a custom driver** — Implement a simple driver that reads from a REST API
4. **Bridge to cloud** — Configure Azure IoT client to forward gateway telemetry

## References

- [Architecture Onboarding](architecture-onboarding.md)
- [OPC-UA Driver Documentation](opcua-driver.md)
- [Docker Edge Deployment](../optix/docker-edge-deployment.md)
- [Containerized Edge Runtime](containerized-edge.md)
