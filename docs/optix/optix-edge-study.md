# OptixEdge Module Study

> Issue #27 — [Optix/Edge] Study OptixEdge module source for edge integration

## What is OptixEdge?

OptixEdge (from AVEVA / Schneider Electric) is an edge runtime for industrial data acquisition. It acts as a protocol gateway that:

1. **Connects to OT devices** via OPC-UA, Modbus, DNP3, etc.
2. **Buffers and stores** data locally (store-and-forward)
3. **Publishes data** to cloud platforms (MQTT, AVEVA Connect, custom endpoints)
4. **Runs on constrained hardware** — Linux ARM/x64, Windows IoT, Docker containers

## Core Architecture Patterns

### 1. Driver Layer (Protocol Abstraction)
OptixEdge uses a pluggable driver architecture where each protocol is isolated:

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ OPC-UA   │  │ Modbus   │  │ DNP3     │
│ Driver   │  │ Driver   │  │ Driver   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     └──────┬──────┴─────────────┘
            │
     ┌──────▼──────┐
     │  Unified    │
     │  Tag Model  │
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │  Store &    │
     │  Forward    │
     └─────────────┘
```

**0xSCADA equivalent:** `server/gateway/` — already has OPC-UA, Modbus, DNP3, IEC 61850 drivers.

### 2. Store-and-Forward Buffer
OptixEdge queues data locally when the upstream connection is unavailable, then replays when connectivity returns. This is critical for:
- Unreliable WAN links
- Scheduled cloud sync windows
- Bandwidth-constrained sites

**0xSCADA gap:** No store-and-forward buffer exists yet. Recommended implementation:
- SQLite or file-based local queue
- Configurable retention (time-based and size-based)
- Ordered replay with deduplication

### 3. Tag-Based Data Model
Every data point is a "tag" with:
- **Address** — protocol-specific path (e.g., OPC-UA NodeId)
- **Data type** — numeric, boolean, string, array
- **Quality** — GOOD / BAD / UNCERTAIN (OPC-UA StatusCode)
- **Timestamp** — source and server timestamps
- **Metadata** — engineering units, description, limits

**0xSCADA equivalent:** The `DataChangeEvent` type in `opcua-subscription-manager.ts` follows this pattern.

### 4. Edge Compute / Rule Engine
OptixEdge supports lightweight rule evaluation at the edge:
- Threshold alarms
- Rate-of-change detection
- Simple math (scaling, unit conversion)
- Data aggregation (min/max/avg over windows)

**0xSCADA opportunity:** The agent framework (`server/agents/`) could host edge compute rules.

### 5. Configuration Management
OptixEdge uses a declarative JSON/YAML configuration:
```yaml
drivers:
  - type: opcua
    endpoint: opc.tcp://plc:4840
    tags:
      - name: reactor_temp
        nodeId: ns=2;s=Reactor.Temperature
        samplingMs: 1000
publishers:
  - type: mqtt
    broker: mqtt://cloud:1883
    topic: site/edge-001/telemetry
```

## How 0xSCADA Can Integrate These Patterns

### Already Implemented
| Pattern | 0xSCADA Component | Status |
|---------|-------------------|--------|
| Protocol drivers | `server/gateway/*.ts` | ✅ OPC-UA, Modbus, DNP3, IEC 61850 |
| Subscription model | `opcua-subscription-manager.ts` | ✅ Full subscription + deadband |
| Security | `opcua-security-manager.ts` | ✅ Certificate management |
| Address space browsing | `opcua-address-space-browser.ts` | ✅ Node discovery |

### Gaps to Fill
| Pattern | Priority | Recommendation |
|---------|----------|----------------|
| Store-and-forward buffer | High | Add local queue with SQLite or file-based persistence |
| Declarative tag config | Medium | YAML/JSON config for tag definitions and driver setup |
| Edge compute rules | Medium | Leverage agent framework for threshold/rate-of-change rules |
| Fleet management | Low | Integrate with Azure IoT Edge or Portainer for multi-device |
| Data aggregation | Low | Time-window aggregation before cloud publish |

### Recommended Next Steps

1. **Store-and-forward** — Create `server/gateway/store-forward-buffer.ts` with SQLite backing
2. **Config-driven setup** — Support loading gateway config from `config/gateway.yaml`
3. **Edge rules engine** — Simple rule evaluator in `server/agents/edge-rules.ts`
4. **Cloud publisher** — The Azure IoT client (`server/integrations/azure-iot.ts`) covers this

## References

- [AVEVA OptixEdge documentation](https://www.aveva.com/en/products/edge/)
- [Azure IoT Edge modules](https://learn.microsoft.com/en-us/azure/iot-edge/)
- [OPC-UA Pub/Sub (Part 14)](https://opcfoundation.org/developer-tools/documents/view/165)
- 0xSCADA gateway code: `server/gateway/`
