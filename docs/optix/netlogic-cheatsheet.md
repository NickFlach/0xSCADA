# NetLogic CheatSheet — 0xSCADA Patterns

> Issue #15 — [Optix/Foundation] Implement NetLogic CheatSheet patterns

This document maps FT Optix NetLogic patterns to their 0xSCADA TypeScript equivalents. NetLogic is Optix's C# scripting layer; 0xSCADA achieves the same capabilities through its gateway services, event system, and WebSocket infrastructure.

---

## Table of Contents

1. [Variable Access](#1-variable-access)
2. [Alarm Handling](#2-alarm-handling)
3. [Event Logging](#3-event-logging)
4. [Timer Management](#4-timer-management)
5. [UI Binding](#5-ui-binding)
6. [OPC-UA Integration](#6-opc-ua-integration)
7. [Database Access](#7-database-access)

---

## 1. Variable Access

### Optix (C# NetLogic)

```csharp
// Read a variable
var tag = Project.Current.GetVariable("Model/Motor1/Speed");
double speed = tag.Value;

// Write a variable
tag.Value = 1750.0;

// Subscribe to changes
tag.VariableChange += (sender, e) => {
    Log.Info($"Speed changed to {e.NewValue}");
};
```

### 0xSCADA (TypeScript)

```typescript
import { OpcUaReadWriteService } from '../server/gateway/opcua-read-write-service';

// Read a single value
const result = await readWriteService.readValue('ns=2;s=Motor1.Speed');
console.log(`Speed: ${result.value}, Quality: ${result.quality}`);

// Read multiple values (auto-batched)
const results = await readWriteService.readValues([
  'ns=2;s=Motor1.Speed',
  'ns=2;s=Motor1.Running',
  'ns=2;s=Motor1.Fault',
]);

// Write with type validation
await readWriteService.writeValue('ns=2;s=Motor1.SpeedSetpoint', 1750.0, 'Double');

// Subscribe to changes via SubscriptionManager
const subId = await subscriptionManager.createSubscription(session);
await subscriptionManager.addMonitoredItem(subId, {
  nodeId: 'ns=2;s=Motor1.Speed',
  samplingInterval: 500,
  deadbandType: DeadbandType.Absolute,
  deadbandValue: 0.5,
});

subscriptionManager.on('dataChange', (event) => {
  console.log(`${event.nodeId} = ${event.value} [${event.quality}]`);
});
```

---

## 2. Alarm Handling

### Optix (C# NetLogic)

```csharp
var alarm = InformationModel.MakeObject<DigitalAlarm>("HighTempAlarm");
alarm.InputValueVariable.Value = temperatureTag;
alarm.Severity = 800;
alarm.Message = "Temperature exceeded limit";
alarm.Enabled = true;
alarm.Acknowledge();
```

### 0xSCADA (TypeScript)

```typescript
import { getEventService } from '../server/events';

const eventService = getEventService();

eventService.emit({
  eventType: 'ALARM_HIGH',
  siteId: 'site-001',
  assetId: 'motor-001',
  originType: 'gateway',
  originId: 'opcua-monitor',
  payload: {
    variable: 'Motor1.Temperature',
    value: 95.2,
    limit: 90.0,
    severity: 800,
  },
  details: 'Temperature exceeded high limit',
});

// Client subscribes via WebSocket
const ws = new WebSocket('ws://localhost:5000/ws/events?eventType=ALARM_HIGH');
ws.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  console.log('Alarm:', event.payload);
};
```

---

## 3. Event Logging

### Optix (C# NetLogic)

```csharp
Log.Info("Motor started by operator");
Log.Warning("Speed setpoint out of range");
Log.Error("Communication failure on Channel1");
```

### 0xSCADA (TypeScript)

```typescript
// Structured event logging with blockchain anchoring
eventService.emit({
  eventType: 'OPERATOR_ACTION',
  siteId: 'site-001',
  assetId: 'motor-001',
  originType: 'hmi',
  originId: 'operator-panel-1',
  payload: { action: 'START', operator: 'jsmith' },
  details: 'Motor started by operator jsmith',
});

// Events are automatically:
// 1. Stored in PostgreSQL
// 2. Broadcast via WebSocket to connected clients
// 3. Optionally anchored to blockchain for tamper-proof audit
```

---

## 4. Timer Management

### Optix (C# NetLogic)

```csharp
private PeriodicTask pollingTask;

public override void Start() {
    pollingTask = new PeriodicTask(PollValues, 1000, LogicObject);
    pollingTask.Start();
}

public override void Stop() {
    pollingTask?.Dispose();
}
```

### 0xSCADA (TypeScript)

```typescript
// Polling pattern with cleanup
class PollingService {
  private interval: NodeJS.Timeout | null = null;

  start(periodMs: number = 1000) {
    this.interval = setInterval(async () => {
      const results = await readWriteService.readValues(this.watchedNodes);
      for (const r of results) {
        if (r.quality === 'GOOD') this.processValue(r);
      }
    }, periodMs);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

// Prefer subscription-based approach (no polling needed):
subscriptionManager.on('dataChange', (event) => {
  // React to changes in real-time — no timer overhead
});
```

---

## 5. UI Binding

### Optix (C# NetLogic)

```csharp
var speedLabel = Owner.Get<Label>("SpeedLabel");
speedLabel.TextVariable.Value = Project.Current.GetVariable("Model/Motor1/Speed");

[ExportMethod]
public void OnStartButtonClick() {
    var motor = Project.Current.GetVariable("Model/Motor1/Command");
    motor.Value = 1;
}
```

### 0xSCADA (TypeScript — React Frontend)

```tsx
import { useWebSocket } from '../hooks/useWebSocket';

function MotorPanel({ assetId }: { assetId: string }) {
  const { lastEvent } = useWebSocket({ url: `/ws/events?assetId=${assetId}` });
  const speed = lastEvent?.payload?.speed ?? 0;

  const handleStart = async () => {
    await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'COMMAND', assetId,
        payload: { command: 'START' },
      }),
    });
  };

  return (
    <div>
      <span>Speed: {speed} RPM</span>
      <button onClick={handleStart}>Start Motor</button>
    </div>
  );
}
```

---

## 6. OPC-UA Integration

0xSCADA provides a full gateway services layer:

| Service | File | Purpose |
|---|---|---|
| `OpcUaConnectionManager` | `server/gateway/opcua-connection-manager.ts` | Session lifecycle |
| `OpcUaReadWriteService` | `server/gateway/opcua-read-write-service.ts` | Read/write values |
| `OpcUaSubscriptionManager` | `server/gateway/opcua-subscription-manager.ts` | Data subscriptions |
| `OpcUaSecurityManager` | `server/gateway/opcua-security-manager.ts` | Certificate & auth |
| `OpcUaAddressSpaceBrowser` | `server/gateway/opcua-address-space-browser.ts` | Browse nodes |

See `opcua-read-patterns.md` and `opcua-alarms-events.md` for detailed usage.

---

## 7. Database Access

### Optix

```csharp
var store = Project.Current.Get<Store>("DataStores/PostgreSQL");
store.Query("SELECT * FROM events WHERE asset_id = @assetId", ...);
```

### 0xSCADA

```typescript
import { db } from '../server/db';
import { eventAnchors } from '@shared/schema';
import { eq } from 'drizzle-orm';

const events = await db.select().from(eventAnchors)
  .where(eq(eventAnchors.assetId, 'motor-001'));
```

See `postgresql-patterns.md` for connection pooling and migration details.

---

## Pattern Comparison Summary

| Capability | Optix NetLogic | 0xSCADA Equivalent |
|---|---|---|
| Variable read/write | `Project.Current.GetVariable()` | `OpcUaReadWriteService` |
| Subscriptions | `VariableChange` event | `OpcUaSubscriptionManager` |
| Alarms | `DigitalAlarm` / `AnalogAlarm` | EventService + WebSocket |
| Event logging | `Log.*` + Store | EventService → PostgreSQL + blockchain |
| Timers | `PeriodicTask` | `setInterval` / subscriptions |
| UI binding | XAML data binding | React + WebSocket hooks |
| OPC-UA | Built-in server/client | Gateway services layer |
| Database | `Store.Query()` | Drizzle ORM + `pg` Pool |
