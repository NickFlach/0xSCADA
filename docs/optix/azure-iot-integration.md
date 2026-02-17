# Azure IoT Hub Integration

> Issue #20 — [Optix/IoT] Integrate Azure IoT Operations for cloud telemetry

## Overview

The Azure IoT integration (`server/integrations/azure-iot.ts`) provides a TypeScript client for connecting 0xSCADA edge nodes to Azure IoT Hub. It supports:

- **Device-to-Cloud (D2C) telemetry** — batched or immediate message sending
- **Cloud-to-Device (C2D) commands** — direct method invocation from the cloud
- **Device Twin** — read/update reported properties, react to desired property changes
- **Auto-reconnect** — resilient connection management

## Architecture

```
┌─────────────┐        MQTT/AMQP        ┌──────────────┐
│  0xSCADA    │ ◄─────────────────────► │  Azure IoT   │
│  Edge Node  │   D2C telemetry         │  Hub         │
│             │   C2D commands          │              │
│  azure-iot  │   Device twin sync      │  ┌─────────┐ │
│  .ts client │                         │  │ Twin    │ │
└─────────────┘                         │  │ Store   │ │
                                        └──┴─────────┴─┘
```

## Setup

### 1. Install Dependencies

```bash
npm install azure-iot-device azure-iot-device-mqtt
```

### 2. Configure Connection String

Get your device connection string from Azure Portal → IoT Hub → Devices → your device → Primary Connection String.

```env
AZURE_IOT_CONNECTION_STRING=HostName=your-hub.azure-devices.net;DeviceId=edge-001;SharedAccessKey=...
```

### 3. Initialize Client

```typescript
import { createAzureIoTClient } from "../server/integrations/azure-iot";

const client = await createAzureIoTClient({
  connectionString: process.env.AZURE_IOT_CONNECTION_STRING!,
  protocol: "mqtt",
  batchFlushIntervalMs: 5000,
  maxBatchSize: 50,
});
```

## Usage

### Sending Telemetry

```typescript
// Immediate send
await client.sendTelemetry({
  body: { temperature: 72.5, pressure: 14.7, timestamp: Date.now() },
  properties: { source: "reactor-01", unit: "psi" },
});

// Batched (queued, flushed every 5s or when batch is full)
client.enqueueTelemetry({
  body: { vibration: 0.03, rpm: 1750 },
});
```

### Handling Cloud-to-Device Commands

```typescript
// Register a direct method handler
client.onMethod("setpoint", async (payload) => {
  const { tag, value } = payload as { tag: string; value: number };
  await writeToPlc(tag, value);
  return { status: 200, payload: { success: true } };
});

// Generic command listener
client.on("command", (cmd) => {
  console.log(`Method: ${cmd.methodName}, Payload:`, cmd.payload);
  cmd.respond(200, { ack: true });
});
```

### Device Twin

```typescript
// Read twin
const { reported, desired } = await client.getTwinProperties();

// Update reported properties
await client.updateReportedProperties({
  firmwareVersion: "2.1.0",
  lastBoot: new Date().toISOString(),
});

// React to desired property changes
client.on("desiredProperties", (delta) => {
  if (delta.samplingRate) {
    setSamplingRate(delta.samplingRate);
    client.updateReportedProperties({ samplingRate: delta.samplingRate });
  }
});
```

### Connection Events

```typescript
client.on("connected", () => console.log("Connected to IoT Hub"));
client.on("disconnected", () => console.log("Disconnected"));
client.on("error", (err) => console.error("IoT error:", err));
client.on("stateChange", (state) => console.log("State:", state));
```

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | string | required | Device connection string |
| `protocol` | `mqtt` \| `amqp` \| `http` | `mqtt` | Transport protocol |
| `autoReconnect` | boolean | `true` | Auto-reconnect on disconnect |
| `batchFlushIntervalMs` | number | `5000` | Batch flush interval (ms) |
| `maxBatchSize` | number | `50` | Max batch size before forced flush |
| `modelId` | string | `""` | IoT Plug and Play model ID |

## Integration with 0xSCADA Gateway

The Azure IoT client is designed to sit alongside the gateway drivers (OPC-UA, Modbus, DNP3). A typical pattern:

1. Gateway subscription manager receives data change events
2. Events are transformed and enqueued as telemetry
3. Cloud commands are routed back to the appropriate gateway driver

```typescript
import { OpcUaSubscriptionManager } from "../server/gateway/opcua-subscription-manager";

subscriptionManager.on("dataChange", (event) => {
  azureClient.enqueueTelemetry({
    body: {
      nodeId: event.nodeId,
      value: event.value,
      quality: event.quality,
      timestamp: event.sourceTimestamp.toISOString(),
    },
    properties: { source: "opcua" },
  });
});
```

## Security Notes

- Connection strings should be stored in environment variables or a secure vault, never in code
- For production, consider using X.509 certificates or DPS (Device Provisioning Service)
- The MQTT transport uses TLS by default
- Device twin properties are persisted in Azure — don't store secrets there
