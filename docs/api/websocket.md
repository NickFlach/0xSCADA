# WebSocket Event Streaming API

> Issue #43: [API] WebSocket / Event Streaming API

Real-time event streaming over WebSocket for 0xSCADA industrial events.

## Quick Start

### Connect
```javascript
const ws = new WebSocket('ws://localhost:5000/ws/events');

ws.onopen = () => {
  console.log('Connected to event stream');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};
```

### Connect with Filters
```javascript
// Filter by site
const ws = new WebSocket('ws://localhost:5000/ws/events?siteId=site-001');

// Filter by event type
const ws = new WebSocket('ws://localhost:5000/ws/events?eventType=ALARM');

// Multiple filters
const ws = new WebSocket('ws://localhost:5000/ws/events?siteId=site-001&eventType=TELEMETRY&eventType=ALARM');
```

---

## Endpoint

```
ws://[host]:[port]/ws/events
wss://[host]:[port]/ws/events  (TLS)
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `siteId` | string | Filter events by site ID. Can be repeated for multiple sites. |
| `assetId` | string | Filter events by asset ID. Can be repeated for multiple assets. |
| `eventType` | string | Filter events by type. Can be repeated for multiple types. |

---

## Message Types

### Server → Client Messages

#### `connected`
Sent immediately after connection is established.

```json
{
  "type": "connected",
  "payload": {
    "clientId": "client_1706828400000_abc123",
    "filter": {
      "siteIds": ["site-001"],
      "eventTypes": ["TELEMETRY", "ALARM"]
    },
    "serverTime": "2024-02-02T12:00:00.000Z"
  },
  "timestamp": "2024-02-02T12:00:00.000Z"
}
```

#### `event`
Sent when a new event matches the client's filter.

```json
{
  "type": "event",
  "payload": {
    "eventType": "TELEMETRY",
    "siteId": "site-001",
    "assetId": "pump-001",
    "sourceTimestamp": "2024-02-02T12:00:01.234Z",
    "originType": "GATEWAY",
    "originId": "gateway-001",
    "payload": {
      "tag": "temperature",
      "value": 75.5,
      "unit": "°F",
      "quality": "GOOD"
    },
    "hash": "a1b2c3d4e5f6...",
    "details": "temperature = 75.5 °F"
  },
  "timestamp": "2024-02-02T12:00:01.250Z"
}
```

#### `subscribe`
Acknowledgement of subscription update.

```json
{
  "type": "subscribe",
  "payload": {
    "filter": {
      "siteIds": ["site-001"],
      "eventTypes": ["ALARM"]
    },
    "status": "ok"
  },
  "timestamp": "2024-02-02T12:00:02.000Z"
}
```

#### `unsubscribe`
Acknowledgement of filter clear.

```json
{
  "type": "unsubscribe",
  "payload": {
    "status": "ok"
  },
  "timestamp": "2024-02-02T12:00:03.000Z"
}
```

#### `pong`
Response to client ping (heartbeat).

```json
{
  "type": "pong",
  "timestamp": "2024-02-02T12:00:04.000Z"
}
```

#### `metrics`
Server metrics (sent on request).

```json
{
  "type": "metrics",
  "payload": {
    "totalConnections": 150,
    "activeConnections": 42,
    "totalMessagesSent": 125000,
    "totalEventsStreamed": 98000,
    "uptime": 3600000
  },
  "timestamp": "2024-02-02T12:00:05.000Z"
}
```

#### `error`
Error notification.

```json
{
  "type": "error",
  "payload": {
    "message": "Invalid message format"
  },
  "timestamp": "2024-02-02T12:00:06.000Z"
}
```

### Client → Server Messages

#### `subscribe`
Update the event filter.

```json
{
  "type": "subscribe",
  "payload": {
    "siteIds": ["site-002"],
    "assetIds": ["pump-001", "pump-002"],
    "eventTypes": ["ALARM", "COMMAND"]
  },
  "timestamp": "2024-02-02T12:00:07.000Z"
}
```

#### `unsubscribe`
Clear all filters (receive all events).

```json
{
  "type": "unsubscribe",
  "timestamp": "2024-02-02T12:00:08.000Z"
}
```

#### `ping`
Heartbeat request.

```json
{
  "type": "ping",
  "timestamp": "2024-02-02T12:00:09.000Z"
}
```

#### `metrics`
Request server metrics.

```json
{
  "type": "metrics",
  "timestamp": "2024-02-02T12:00:10.000Z"
}
```

---

## Event Schema

### Event Types

| Type | Description |
|------|-------------|
| `TELEMETRY` | Process variable readings (temperature, pressure, flow) |
| `ALARM` | Alarm state changes (triggered, cleared, acknowledged) |
| `COMMAND` | Operator commands (setpoints, mode changes) |
| `ACKNOWLEDGEMENT` | Alarm acknowledgements |
| `MAINTENANCE` | Maintenance activities |
| `BLUEPRINT_CHANGE` | Control module definition changes |
| `CODE_GENERATION` | PLC code generation events |
| `DEPLOYMENT_INTENT` | Deployment proposals and approvals |

### Event Payload Structure

```typescript
interface StreamEvent {
  eventType: string;      // Event type (see table above)
  siteId: string;         // Site identifier
  assetId?: string;       // Asset identifier (optional)
  sourceTimestamp: string; // ISO 8601 timestamp from source
  originType: string;     // GATEWAY | USER | AGENT | SYSTEM
  originId: string;       // Origin identifier
  payload: object;        // Event-specific data
  hash: string;           // SHA-256 hash of event
  details?: string;       // Human-readable description
}
```

### Type-Specific Payloads

#### TELEMETRY
```json
{
  "tag": "temperature",
  "value": 75.5,
  "unit": "°F",
  "quality": "GOOD"
}
```

#### ALARM
```json
{
  "alarmId": "ALM-001",
  "alarmType": "HIGH",
  "severity": "CRITICAL",
  "state": "ACTIVE",
  "message": "Temperature high limit exceeded",
  "value": 185.5,
  "limit": 180
}
```

#### COMMAND
```json
{
  "commandType": "SETPOINT",
  "target": "temperature_sp",
  "value": 72,
  "previousValue": 68,
  "reason": "Operator adjustment"
}
```

---

## Connection Lifecycle

### Connection Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Connection Lifecycle                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Client                                    Server            │
│    │                                          │              │
│    │  ── WebSocket Connect ──────────────►   │              │
│    │                                          │              │
│    │  ◄─────────── "connected" ────────────  │              │
│    │                                          │              │
│    │  ── "subscribe" (optional) ──────────►  │              │
│    │  ◄─────────── "subscribe" ────────────  │              │
│    │                                          │              │
│    │  ◄─────────── "event" ────────────────  │ (streaming)  │
│    │  ◄─────────── "event" ────────────────  │              │
│    │                                          │              │
│    │  ── "ping" ────────────────────────────► │ (heartbeat) │
│    │  ◄─────────── "pong" ─────────────────  │              │
│    │                                          │              │
│    │  ◄────────── WebSocket Ping ──────────  │ (server)     │
│    │  ── WebSocket Pong ────────────────────► │              │
│    │                                          │              │
│    │  ── WebSocket Close ───────────────────► │              │
│    │                                          │              │
└──────────────────────────────────────────────────────────────┘
```

### Heartbeat Mechanism

The server sends WebSocket ping frames every 30 seconds. Clients must respond with pong frames. Clients that fail to respond within 10 seconds are disconnected.

For application-level heartbeat, clients can send `ping` messages and receive `pong` responses.

### Reconnection Strategy

Recommended reconnection strategy with exponential backoff:

```javascript
class ReconnectingWebSocket {
  constructor(url) {
    this.url = url;
    this.maxAttempts = 10;
    this.baseDelay = 1000;
    this.maxDelay = 30000;
    this.attempts = 0;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      this.attempts = 0; // Reset on successful connect
    };
    
    this.ws.onclose = () => {
      if (this.attempts < this.maxAttempts) {
        const delay = Math.min(
          this.baseDelay * Math.pow(2, this.attempts),
          this.maxDelay
        );
        this.attempts++;
        setTimeout(() => this.connect(), delay);
      }
    };
  }
}
```

---

## Backpressure Handling

### Server-Side

- Events are buffered per client with a configurable limit
- If buffer fills, oldest events may be dropped for that client
- Connection metrics track dropped events
- Slow clients receive `warning` messages before drops

### Client-Side Best Practices

1. **Process messages asynchronously** - Don't block the message handler
2. **Use message queues** - Buffer received events for processing
3. **Monitor lag** - Track time between `sourceTimestamp` and receipt
4. **Handle reconnection** - May miss events during disconnection

---

## REST API Endpoints

### WebSocket Metrics

```
GET /api/ws/metrics
```

Response:
```json
{
  "totalConnections": 150,
  "activeConnections": 42,
  "totalMessagesSent": 125000,
  "totalEventsStreamed": 98000,
  "uptime": 3600000
}
```

### Connected Clients

```
GET /api/ws/clients
```

Response:
```json
[
  {
    "id": "client_1706828400000_abc123",
    "filter": {
      "siteIds": ["site-001"]
    },
    "connectedAt": "2024-02-02T11:00:00.000Z",
    "messagesSent": 1523
  }
]
```

---

## Example Consumers

### Node.js / TypeScript

```typescript
import WebSocket from 'ws';

interface EventMessage {
  type: string;
  payload?: unknown;
  timestamp: string;
}

const ws = new WebSocket('ws://localhost:5000/ws/events?siteId=site-001');

ws.on('open', () => {
  console.log('Connected to 0xSCADA event stream');
  
  // Update subscription
  ws.send(JSON.stringify({
    type: 'subscribe',
    payload: { eventTypes: ['ALARM', 'TELEMETRY'] },
    timestamp: new Date().toISOString()
  }));
});

ws.on('message', (data: Buffer) => {
  const message: EventMessage = JSON.parse(data.toString());
  
  switch (message.type) {
    case 'event':
      handleEvent(message.payload);
      break;
    case 'connected':
      console.log('Connection established:', message.payload);
      break;
    case 'pong':
      // Heartbeat acknowledged
      break;
  }
});

ws.on('close', () => {
  console.log('Connection closed, reconnecting...');
  // Implement reconnection logic
});

// Heartbeat
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() }));
  }
}, 25000);

function handleEvent(payload: unknown) {
  console.log('Event received:', payload);
  // Process event...
}
```

### Python

```python
import asyncio
import json
import websockets

async def consume_events():
    uri = "ws://localhost:5000/ws/events?siteId=site-001"
    
    async with websockets.connect(uri) as ws:
        # Subscribe to specific event types
        await ws.send(json.dumps({
            "type": "subscribe",
            "payload": {"eventTypes": ["ALARM", "TELEMETRY"]},
            "timestamp": "2024-02-02T12:00:00Z"
        }))
        
        async for message in ws:
            data = json.loads(message)
            
            if data["type"] == "event":
                print(f"Event: {data['payload']}")
            elif data["type"] == "connected":
                print(f"Connected: {data['payload']['clientId']}")

asyncio.run(consume_events())
```

### Browser (React Hook)

See `client/src/hooks/use-event-stream.ts` for a complete React implementation.

```tsx
import { useEventStream } from '@/hooks/use-event-stream';

function EventMonitor() {
  const { events, status, setFilter } = useEventStream({
    filter: { eventTypes: ['ALARM'] },
    maxEvents: 100,
  });

  return (
    <div>
      <span>Status: {status}</span>
      <ul>
        {events.map(event => (
          <li key={event.id}>
            [{event.eventType}] {event.details}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Security Considerations

1. **Authentication**: Implement token-based authentication for production
2. **TLS**: Always use `wss://` in production
3. **Rate Limiting**: Consider rate limiting subscription changes
4. **Input Validation**: All client messages are validated server-side

---

## References

- [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)
- [Event Types](../server/events/index.ts)
- [EventStream Component](../client/src/components/ui/event-stream.tsx)
- [useEventStream Hook](../client/src/hooks/use-event-stream.ts)
