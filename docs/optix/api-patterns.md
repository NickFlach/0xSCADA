# REST/WebSocket Server Patterns

> Issue #22 — [Optix/REST] Implement REST/WebSocket server patterns

## Architecture

```
┌───────────────────────────────────────────────┐
│                  Express App                   │
│                                                │
│  REST Endpoints          WebSocket Server      │
│  ├─ /api/sites           /ws/events            │
│  ├─ /api/assets                                │
│  ├─ /api/events          SSE Endpoint          │
│  ├─ /api/blueprints/*    /api/v2/events/stream │
│  ├─ /api/agents                                │
│  └─ /api/health                                │
└───────────────────────────────────────────────┘
```

---

## REST Patterns

### Resource CRUD

All resources follow the same pattern with Zod validation:

```typescript
app.post('/api/sites', async (req, res) => {
  const validation = insertSiteSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: fromZodError(validation.error).toString() });
  }
  const site = await storage.createSite(validation.data);
  res.status(201).json(site);
});
```

### Pagination

```typescript
app.get('/api/events', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const { data, total } = await storage.getEventAnchorsPaginated(page, limit);
  res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
});
```

### Modular Routes

```typescript
app.use('/api/agents', agentRoutes);
app.use('/api/v2/events', eventRoutes);
app.use('/api/batch', batchRoutes);
app.use('/api/aas', aasRouter);
app.use('/api/ubiquity', ubiquityRoutes);
app.use('/api/certifications', certificationRoutes);
app.use('/api/artifacts', artifactRoutes);
```

---

## WebSocket Event Stream

### Server (`server/websocket/event-stream.ts`)

The `EventStreamServer` singleton initializes on the HTTP server:

```typescript
eventStreamServer.initialize(httpServer, '/ws/events');
```

### Message Protocol

```typescript
interface WebSocketMessage {
  type: 'event' | 'ping' | 'pong' | 'subscribe' | 'unsubscribe' | 'error' | 'connected' | 'metrics';
  payload?: unknown;
  timestamp: string;
}
```

### Client Usage

```typescript
const ws = new WebSocket('ws://localhost:5000/ws/events?siteId=site-001&eventType=ALARM_ACTIVE');

ws.onmessage = (msg) => {
  const message = JSON.parse(msg.data);
  if (message.type === 'event') handleEvent(message.payload);
};

// Dynamic filter update
ws.send(JSON.stringify({
  type: 'subscribe',
  payload: { siteIds: ['site-001'], eventTypes: ['ALARM_ACTIVE', 'ALARM_CLEAR'] },
}));
```

### Monitoring

```
GET /api/ws/metrics   — Connection and event statistics
GET /api/ws/clients   — Connected clients and their filters
```

---

## Server-Sent Events (SSE)

Added at `GET /api/v2/events/stream` — simpler alternative to WebSocket for one-way streaming.

### Client Usage

```typescript
const source = new EventSource('/api/v2/events/stream?siteId=site-001&eventType=ALARM_ACTIVE');

source.addEventListener('ALARM_ACTIVE', (e) => {
  console.log('Alarm:', JSON.parse(e.data));
});
```

### WebSocket vs SSE

| Feature | WebSocket | SSE |
|---|---|---|
| Direction | Bidirectional | Server → Client |
| Reconnection | Manual | Automatic |
| Filter updates | Dynamic (send message) | Reconnect with new params |
| Proxy-friendly | Needs upgrade | Standard HTTP |

**WebSocket** for interactive dashboards, operator commands.
**SSE** for alarm panels, event logs, monitoring displays.

---

## API Summary

### Core Resources

| Endpoint | Methods | Description |
|---|---|---|
| `/api/health` | GET | System health check |
| `/api/sites` | GET, POST | Site management |
| `/api/assets` | GET, POST | Asset management |
| `/api/events` | GET, POST | Event anchors (paginated) |
| `/api/maintenance` | GET, POST | Maintenance records |

### Blueprints & Code Generation

| Endpoint | Methods | Description |
|---|---|---|
| `/api/blueprints/import` | POST | Import blueprint CSV package |
| `/api/blueprints/summary` | GET | Blueprint counts |
| `/api/generate/control-module/:id` | POST | Generate vendor code |
| `/api/generate/phase/:id` | POST | Generate phase code |
| `/api/generate/ladder-logic/*` | POST | Ladder logic generation |

### Real-Time

| Endpoint | Protocol | Description |
|---|---|---|
| `/ws/events` | WebSocket | Bidirectional event streaming |
| `/api/v2/events/stream` | SSE | One-way event streaming |
| `/api/ws/metrics` | GET | WebSocket server metrics |
| `/api/ws/clients` | GET | Connected client list |
