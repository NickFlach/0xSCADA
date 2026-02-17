# OPC-UA Alarms & Events Subscription

> Issue #19 — [Optix/OPC-UA] Implement OPC UA Alarms & Events subscription

## Service Location

`server/gateway/opcua-subscription-manager.ts`

## Current Capabilities

| Feature | Status |
|---|---|
| Create/delete subscriptions | ✅ |
| Add/remove monitored items | ✅ |
| Data change notifications | ✅ |
| Deadband filtering (Absolute, Percent) | ✅ |
| Configurable sampling interval | ✅ |
| Queue size management | ✅ |
| Keep-alive detection | ✅ |
| Bulk subscribe/unsubscribe | ✅ |
| EventEmitter-based notifications | ✅ |

### Events Emitted

| Event | Payload | Description |
|---|---|---|
| `dataChange` | `DataChangeEvent` | Value changed on a monitored item |
| `keepAlive` | `subscriptionId` | Subscription alive, no data changes |
| `terminated` | `subscriptionId` | Subscription terminated by server |

---

## Alarm Subscription Patterns

OPC-UA supports two monitoring modes:
1. **Data Change** — Monitor variable value changes (already implemented)
2. **Event** — Monitor event notifications from alarm/condition objects

### Pattern 1: Alarm Tag Monitoring via Data Changes

Most PLC alarm systems expose alarm states as Boolean tags. Monitor them directly:

```typescript
const alarmTags = [
  { nodeId: 'ns=2;s=Motor1.Alarm_OverSpeed', samplingInterval: 250 },
  { nodeId: 'ns=2;s=Motor1.Alarm_OverTemp', samplingInterval: 250 },
  { nodeId: 'ns=2;s=Motor1.Alarm_Fault', samplingInterval: 250 },
  { nodeId: 'ns=2;s=Tank1.Alarm_HighLevel', samplingInterval: 250 },
];

const itemIds = await manager.addMonitoredItems(subId, alarmTags);

manager.on('dataChange', (event) => {
  if (event.nodeId.includes('Alarm_') && event.value === true) {
    const alarmName = event.nodeId.split('.').pop()!;
    eventService.emit({
      eventType: 'ALARM_ACTIVE',
      siteId: 'site-001',
      assetId: extractAssetId(event.nodeId),
      originType: 'opcua',
      originId: event.subscriptionId,
      payload: {
        alarmTag: event.nodeId,
        alarmName,
        active: true,
        quality: event.quality,
        sourceTimestamp: event.sourceTimestamp,
      },
      details: `Alarm activated: ${alarmName}`,
    });
  }
});
```

### Pattern 2: Analog Alarm with Limit Detection

```typescript
interface AnalogAlarmConfig {
  nodeId: string;
  assetId: string;
  tagName: string;
  hihi?: number;
  hi?: number;
  lo?: number;
  lolo?: number;
}

class AnalogAlarmMonitor {
  private activeAlarms = new Map<string, Set<string>>();
  private configs = new Map<string, AnalogAlarmConfig>();

  constructor(
    private manager: OpcUaSubscriptionManager,
    private eventService: any,
  ) {
    manager.on('dataChange', (event) => this.evaluate(event));
  }

  registerAlarm(config: AnalogAlarmConfig) {
    this.configs.set(config.nodeId, config);
    this.activeAlarms.set(config.nodeId, new Set());
  }

  private evaluate(event: DataChangeEvent) {
    const config = this.configs.get(event.nodeId);
    if (!config || event.quality !== 'GOOD') return;

    const value = event.value as number;
    const active = this.activeAlarms.get(event.nodeId)!;

    this.check(config, 'HIHI', value, config.hihi, (v, l) => v >= l, active, event);
    this.check(config, 'HI', value, config.hi, (v, l) => v >= l, active, event);
    this.check(config, 'LO', value, config.lo, (v, l) => v <= l, active, event);
    this.check(config, 'LOLO', value, config.lolo, (v, l) => v <= l, active, event);
  }

  private check(
    config: AnalogAlarmConfig, level: string, value: number,
    limit: number | undefined, test: (v: number, l: number) => boolean,
    active: Set<string>, event: DataChangeEvent,
  ) {
    if (limit === undefined) return;
    const isTripped = test(value, limit);
    const wasActive = active.has(level);

    if (isTripped && !wasActive) {
      active.add(level);
      this.emitAlarm(config, level, value, limit, true);
    } else if (!isTripped && wasActive) {
      active.delete(level);
      this.emitAlarm(config, level, value, limit, false);
    }
  }

  private emitAlarm(
    config: AnalogAlarmConfig, level: string,
    value: number, limit: number, activated: boolean,
  ) {
    const severity = level.length === 4 ? 900 : 500; // HIHI/LOLO=900, HI/LO=500
    this.eventService.emit({
      eventType: activated ? 'ALARM_ACTIVE' : 'ALARM_CLEAR',
      siteId: 'site-001',
      assetId: config.assetId,
      originType: 'alarm-monitor',
      originId: 'analog-alarm',
      payload: { tag: config.tagName, level, value, limit, severity, activated },
      details: `${config.tagName} ${level} alarm ${activated ? 'activated' : 'cleared'}: ${value} (limit: ${limit})`,
    });
  }
}

// Usage
const monitor = new AnalogAlarmMonitor(subscriptionManager, eventService);
monitor.registerAlarm({
  nodeId: 'ns=2;s=Tank1.Temperature',
  assetId: 'tank-001',
  tagName: 'Tank1.Temperature',
  hihi: 100, hi: 90, lo: 10, lolo: 5,
});
```

---

## Integration with 0xSCADA Event Pipeline

```
OPC-UA Server (PLC)
    │ monitored items
    ▼
SubscriptionManager (dataChange events)
    │
    ▼
Alarm Evaluator (limit check, state tracking, debounce)
    │
    ▼
EventService (sign, hash, store to PostgreSQL, blockchain anchor)
    │
    ▼
WebSocket EventStream (broadcast to clients)
```

### Client-Side Alarm Subscription

```typescript
// WebSocket
const ws = new WebSocket('ws://localhost:5000/ws/events?eventType=ALARM_ACTIVE&eventType=ALARM_CLEAR');

// Or SSE
const source = new EventSource('/api/v2/events/stream?eventType=ALARM_ACTIVE&eventType=ALARM_CLEAR');
source.addEventListener('ALARM_ACTIVE', (e) => {
  console.log('Alarm:', JSON.parse(e.data));
});
```

---

## Best Practices

| Practice | Recommendation |
|---|---|
| Sampling interval | 250ms for alarms, 500-1000ms for trends |
| Deadband | Absolute for engineering values, Percent for normalized |
| Queue size | 1 for displays, 10+ for logging |
| Publishing interval | 500-1000ms balances load vs responsiveness |
| Cleanup | Always call `destroyAll()` on shutdown |
