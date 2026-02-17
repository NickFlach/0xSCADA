# Runtime NetLogic — Event Generation Study

> Issue #16 — [Optix/Foundation] Study Runtime NetLogic for event generation

## Overview

FT Optix **Runtime NetLogic** is C# code that executes while the HMI application runs. It handles real-time tasks: polling values, generating events, responding to operator actions, and orchestrating process logic. This document studies those patterns and maps them to 0xSCADA's TypeScript architecture.

---

## How Runtime NetLogic Works in Optix

### Lifecycle

```
Application Start → NetLogic.Start() → [runs continuously] → NetLogic.Stop() → Application Stop
```

A Runtime NetLogic is a C# class inheriting `BaseNetLogic` with `Start()` and `Stop()` lifecycle methods. Key characteristics:

| Aspect | Behavior |
|---|---|
| Execution context | Runs in the HMI runtime process |
| Threading | Each `PeriodicTask` runs on a thread pool thread |
| Lifecycle | Tied to the owning UI object's visibility/existence |
| Variable access | Direct in-memory access to the Optix information model |
| Event generation | Via OPC-UA Alarms & Conditions or custom event types |

---

## 0xSCADA Event Generation Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  OPC-UA Gateway  │────▶│   Event Service   │────▶│   WebSocket      │
│  (subscriptions) │     │   (processing)    │     │   (streaming)    │
└──────────────────┘     └────────┬─────────┘     └──────────────────┘
                                  │
                         ┌────────▼─────────┐
                         │   PostgreSQL      │
                         │   + Blockchain    │
                         └──────────────────┘
```

### Event Flow

1. **OPC-UA Subscription** detects a data change
2. **Gateway logic** evaluates conditions (alarm limits, state changes)
3. **EventService** creates a signed, timestamped event
4. **Storage** persists to PostgreSQL
5. **WebSocket** broadcasts to connected clients
6. **Blockchain** (optional) anchors event hash for tamper-proof audit

---

## TypeScript Equivalents

### Pattern 1: Monitor + React (VariableChange equivalent)

```typescript
import { OpcUaSubscriptionManager, DeadbandType } from '../server/gateway/opcua-subscription-manager';
import { getEventService } from '../server/events';

class MotorMonitor {
  private subId: string | null = null;

  async start(session: any, subscriptionManager: OpcUaSubscriptionManager) {
    this.subId = await subscriptionManager.createSubscription(session, {
      publishingInterval: 500,
    });

    await subscriptionManager.addMonitoredItem(this.subId, {
      nodeId: 'ns=2;s=Motor1.Fault',
      samplingInterval: 250,
    });

    await subscriptionManager.addMonitoredItem(this.subId, {
      nodeId: 'ns=2;s=Motor1.Speed',
      samplingInterval: 500,
      deadbandType: DeadbandType.Absolute,
      deadbandValue: 1.0,
    });

    subscriptionManager.on('dataChange', (event) => {
      if (event.nodeId.includes('Fault') && event.value === true) {
        this.generateAlarm('MOTOR_FAULT', 900, event);
      }
      if (event.nodeId.includes('Speed') && event.value > 1800) {
        this.generateAlarm('OVERSPEED', 700, event);
      }
    });
  }

  private generateAlarm(type: string, severity: number, trigger: any) {
    const eventService = getEventService();
    eventService.emit({
      eventType: `ALARM_${type}`,
      siteId: 'site-001',
      assetId: 'motor-001',
      originType: 'gateway',
      originId: 'motor-monitor',
      payload: { severity, value: trigger.value, quality: trigger.quality },
      details: `${type} alarm: value=${trigger.value}`,
    });
  }
}
```

### Pattern 2: State Machine (Sequence/Phase logic)

```typescript
type MotorState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'FAULTED';

class MotorStateMachine {
  private state: MotorState = 'STOPPED';

  transition(command: string, assetId: string) {
    const prev = this.state;
    const transitions: Record<string, Record<string, MotorState>> = {
      STOPPED:  { START: 'STARTING' },
      STARTING: { RUN_CONFIRMED: 'RUNNING', FAULT: 'FAULTED' },
      RUNNING:  { STOP: 'STOPPING', FAULT: 'FAULTED' },
      STOPPING: { STOP_CONFIRMED: 'STOPPED' },
      FAULTED:  { RESET: 'STOPPED' },
    };

    const next = transitions[this.state]?.[command];
    if (next) {
      this.state = next;
      getEventService().emit({
        eventType: 'STATE_CHANGE',
        siteId: 'site-001',
        assetId,
        originType: 'logic',
        originId: 'motor-state-machine',
        payload: { from: prev, to: this.state, command },
        details: `${prev} → ${this.state}`,
      });
    }
  }
}
```

### Pattern 3: Operator Action Handler (ExportMethod equivalent)

```typescript
import { Router } from 'express';

const operatorRouter = Router();

operatorRouter.post('/motor/:assetId/command', async (req, res) => {
  const { assetId } = req.params;
  const { command, operator } = req.body;

  await readWriteService.writeValue(
    `ns=2;s=${assetId}.Command`, command === 'START' ? 1 : 0, 'Int32'
  );

  getEventService().emit({
    eventType: 'OPERATOR_COMMAND',
    siteId: 'site-001',
    assetId,
    originType: 'hmi',
    originId: `operator-${operator}`,
    payload: { command, operator },
    details: `${operator} issued ${command} to ${assetId}`,
  });

  res.json({ success: true });
});
```

---

## Comparison: Optix Runtime vs 0xSCADA

| Feature | Optix Runtime NetLogic | 0xSCADA |
|---|---|---|
| Language | C# | TypeScript |
| Execution | In-process (HMI runtime) | Distributed (Node.js server) |
| Variable access | Direct memory | OPC-UA over network |
| Event generation | OPC-UA A&C | EventService → WebSocket + DB |
| Timer/Polling | `PeriodicTask` | `setInterval` / subscriptions |
| State machines | Manual C# | Same pattern, TypeScript |
| Operator methods | `[ExportMethod]` | REST/WebSocket endpoints |
| Persistence | Optix Store (SQLite/ODBC) | PostgreSQL + blockchain |
| Scalability | Single HMI instance | Horizontally scalable |

---

## Recommendations

1. **Prefer subscriptions over polling** — `OpcUaSubscriptionManager` with deadband filtering is more efficient than periodic reads
2. **Use EventService for all event generation** — ensures consistent signing, storage, and distribution
3. **Implement per-asset-type monitors** (MotorMonitor, ValveMonitor, etc.) that encapsulate condition logic
4. **Leverage WebSocket streaming** for real-time UI updates instead of client-side polling
