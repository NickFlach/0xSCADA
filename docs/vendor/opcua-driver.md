# OPC-UA Subscription & Polling Driver

> Issue #31 — [Gateway] OPC-UA Subscription & Polling Driver

## Overview

0xSCADA provides comprehensive OPC-UA support through five modules in `server/gateway/`:

| Module | Purpose |
|--------|---------|
| `opcua-connection-manager.ts` | Client session lifecycle |
| `opcua-subscription-manager.ts` | Subscription-based data acquisition |
| `opcua-read-write-service.ts` | On-demand read/write operations |
| `opcua-address-space-browser.ts` | Node discovery and browsing |
| `opcua-security-manager.ts` | Certificates and authentication |

## Subscription Mode

The subscription manager (`OpcUaSubscriptionManager`) uses OPC-UA's native Pub/Sub mechanism for efficient, event-driven data acquisition.

### How It Works

1. **Create a subscription** with a publishing interval (e.g., 1000ms)
2. **Add monitored items** — each item watches a specific OPC-UA node
3. **Receive data change events** when values change (filtered by deadband)
4. The OPC-UA server only sends data when changes occur, minimizing network traffic

### Usage

```typescript
import { OpcUaSubscriptionManager, DeadbandType } from "./opcua-subscription-manager";

const manager = new OpcUaSubscriptionManager();

// Create subscription (1s publishing interval)
const subId = await manager.createSubscription(session, {
  publishingInterval: 1000,
  maxKeepAliveCount: 10,
});

// Monitor a temperature tag with 0.5°C deadband
await manager.addMonitoredItem(subId, {
  nodeId: "ns=2;s=Reactor.Temperature",
  samplingInterval: 500,
  queueSize: 5,
  deadbandType: DeadbandType.Absolute,
  deadbandValue: 0.5,
});

// Listen for changes
manager.on("dataChange", (event) => {
  console.log(`${event.nodeId}: ${event.value} [${event.quality}]`);
});
```

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `publishingInterval` | 1000ms | How often the server checks for changes |
| `lifetimeCount` | 60 | Subscription lifetime in publishing intervals |
| `maxKeepAliveCount` | 10 | Keep-alive messages before timeout |
| `samplingInterval` | 1000ms | Per-item sampling rate |
| `queueSize` | 1 | Buffered values per item |
| `deadbandType` | None | Filter: None, Absolute, or Percent |
| `deadbandValue` | 0 | Deadband threshold |

### When to Use Subscriptions
- High-frequency data (>1 sample/sec)
- Many tags on one server
- Network bandwidth is limited
- You need immediate change notification

## Polling Mode

Polling mode uses periodic read requests instead of OPC-UA subscriptions. This is useful when:
- The OPC-UA server doesn't support subscriptions well
- You need exact control over read timing
- You want to read attributes other than Value
- Diagnostics or one-shot data collection

### Usage

```typescript
import { OpcUaPollingDriver } from "./opcua-polling-driver";

const poller = new OpcUaPollingDriver();

// Add tags to poll
poller.addTag({ nodeId: "ns=2;s=Reactor.Temperature", intervalMs: 1000 });
poller.addTag({ nodeId: "ns=2;s=Reactor.Pressure", intervalMs: 5000 });

// Start polling
await poller.start(session);

// Listen for data
poller.on("data", (nodeId, value, quality, timestamp) => {
  console.log(`${nodeId}: ${value}`);
});

// Stop polling
await poller.stop();
```

### Polling vs. Subscription Comparison

| Aspect | Subscription | Polling |
|--------|-------------|---------|
| Network efficiency | High (changes only) | Lower (periodic reads) |
| Latency | Low (server pushes) | Depends on interval |
| Server load | Lower | Higher (repeated reads) |
| Compatibility | Requires server support | Works everywhere |
| Timing control | Approximate | Exact intervals |
| Complexity | Higher | Simpler |

### Recommended Approach

Use **subscriptions by default** for production data acquisition. Fall back to **polling** when:
1. Server doesn't support subscriptions (older OPC-UA implementations)
2. You need exact-interval reads for regulatory compliance
3. Reading non-Value attributes (engineering units, access levels)
4. One-shot diagnostic reads

## Bulk Operations

Both modes support bulk operations:

```typescript
// Subscription: bulk add
const itemIds = await manager.addMonitoredItems(subId, [
  { nodeId: "ns=2;s=Tag1", samplingInterval: 1000 },
  { nodeId: "ns=2;s=Tag2", samplingInterval: 1000 },
  { nodeId: "ns=2;s=Tag3", samplingInterval: 5000 },
]);

// Subscription: bulk remove
await manager.removeMonitoredItems(subId, itemIds);

// Destroy all subscriptions
await manager.destroyAll();
```

## Events

The subscription manager emits:

| Event | Payload | Description |
|-------|---------|-------------|
| `dataChange` | `DataChangeEvent` | Value changed on a monitored item |
| `keepAlive` | `subscriptionId` | Subscription keep-alive received |
| `terminated` | `subscriptionId` | Subscription terminated by server |

## Error Handling

```typescript
manager.on("dataChange", (event) => {
  if (event.quality === "BAD") {
    console.warn(`Bad quality on ${event.nodeId}`);
    // Don't process bad-quality values
    return;
  }
  // Process good/uncertain values
});
```

## Integration with Cloud Telemetry

Forward OPC-UA data to Azure IoT Hub:

```typescript
manager.on("dataChange", (event) => {
  azureIoTClient.enqueueTelemetry({
    body: {
      nodeId: event.nodeId,
      value: event.value,
      quality: event.quality,
      sourceTimestamp: event.sourceTimestamp.toISOString(),
    },
  });
});
```

## Related

- [Azure IoT Integration](../optix/azure-iot-integration.md)
- [Edge & Gateway Integration](edge-gateway-integration.md)
- [ADR-0005: OPC-UA Protocol Driver](../decisions/ADR-0005-opcua-protocol-driver.md)
