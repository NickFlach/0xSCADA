# Vendor Learning Tract: External Integration

A guide for vendors integrating external systems with the 0xSCADA API — covering authentication, data models, webhooks, event subscriptions, and best practices.

---

## 1. Getting Started

### 1.1 API Overview

0xSCADA exposes a RESTful API at the configured `OXSCADA_API_URL` (default: `http://localhost:5000`).

**Base URL:** `https://<your-instance>/api`

**Key resources:**
- `/api/sites` — Site management
- `/api/assets` — Asset registry
- `/api/tags` — Process variable (tag) operations
- `/api/gateways` — Gateway connections
- `/api/alarms` — Alarm management
- `/api/events` — Event log and anchoring
- `/api/blueprints` — Digital twin blueprints
- `/api/health` — System health check

### 1.2 Authentication

All API requests require authentication via API key or JWT bearer token.

**API Key (header):**
```http
GET /api/sites
Authorization: Bearer <your-api-key>
```

**API Key (query parameter):**
```
GET /api/sites?apiKey=<your-api-key>
```

**Obtaining an API key:**
1. Log in to the 0xSCADA web UI
2. Navigate to Settings → API Keys
3. Generate a new key with appropriate scopes
4. Or via CLI: `0xscada auth login --key <key>`

**Scopes:**
| Scope | Description |
|---|---|
| `read:sites` | Read site data |
| `write:sites` | Create/update sites |
| `read:tags` | Read tag values and history |
| `write:tags` | Write tag values |
| `read:alarms` | View alarms |
| `write:alarms` | Acknowledge/clear alarms |
| `read:events` | Read event log |
| `admin` | Full administrative access |

### 1.3 Rate Limiting

- Default: 1000 requests/minute per API key
- Tag read endpoints: 5000 requests/minute
- Bulk endpoints: 100 requests/minute
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## 2. Data Models

### 2.1 Site

```json
{
  "id": "site-001",
  "name": "North Plant",
  "location": { "lat": 40.7128, "lng": -74.0060 },
  "status": "online",
  "gateways": ["gw-001", "gw-002"],
  "metadata": {},
  "createdAt": "2026-01-15T10:00:00Z",
  "updatedAt": "2026-02-14T08:30:00Z"
}
```

### 2.2 Tag (Process Variable)

```json
{
  "id": "TANK1_LEVEL",
  "name": "Tank 1 Level",
  "siteId": "site-001",
  "gatewayId": "gw-001",
  "value": 72.5,
  "unit": "%",
  "quality": "Good",
  "dataType": "float64",
  "timestamp": "2026-02-14T22:15:00Z",
  "limits": { "low": 10, "lowLow": 5, "high": 90, "highHigh": 95 },
  "description": "Primary tank level sensor"
}
```

### 2.3 Alarm

```json
{
  "id": "alm-12345",
  "tagId": "TANK1_LEVEL",
  "siteId": "site-001",
  "severity": "high",
  "state": "active",
  "message": "Tank 1 level high (90.2%)",
  "triggeredAt": "2026-02-14T22:10:00Z",
  "acknowledgedAt": null,
  "clearedAt": null
}
```

### 2.4 Event

```json
{
  "id": "evt-67890",
  "type": "alarm.triggered",
  "siteId": "site-001",
  "payload": { "alarmId": "alm-12345", "severity": "high" },
  "timestamp": "2026-02-14T22:10:00Z",
  "anchored": true,
  "anchorTxHash": "0xabc123..."
}
```

---

## 3. Webhooks

### 3.1 Configuring Webhooks

Register a webhook endpoint to receive real-time event notifications:

```http
POST /api/webhooks
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "url": "https://your-system.com/0xscada/webhook",
  "events": ["alarm.triggered", "alarm.cleared", "tag.updated", "anchor.created"],
  "secret": "your-webhook-secret",
  "active": true
}
```

### 3.2 Webhook Payload

```json
{
  "id": "wh-delivery-001",
  "event": "alarm.triggered",
  "timestamp": "2026-02-14T22:10:00Z",
  "data": {
    "alarmId": "alm-12345",
    "tagId": "TANK1_LEVEL",
    "severity": "high",
    "message": "Tank 1 level high (90.2%)"
  }
}
```

### 3.3 Signature Verification

Webhooks include an HMAC-SHA256 signature in the `X-0xSCADA-Signature` header:

```
X-0xSCADA-Signature: sha256=<hex-encoded-hmac>
```

**Verification (Node.js):**
```typescript
import crypto from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### 3.4 Retry Policy

- Failed deliveries (non-2xx) are retried with exponential backoff
- Retry schedule: 1m, 5m, 30m, 2h, 12h
- Webhooks disabled after 5 consecutive failures
- Monitor delivery status: `GET /api/webhooks/<id>/deliveries`

---

## 4. Event Subscriptions (WebSocket)

### 4.1 Connecting

```javascript
const ws = new WebSocket('wss://<your-instance>/api/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['tags:TANK1_LEVEL', 'alarms:site-001', 'events:*'],
    token: '<api-key>'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.channel, data.payload);
};
```

### 4.2 Channel Patterns

| Pattern | Description |
|---|---|
| `tags:<tagId>` | Real-time tag value updates |
| `tags:site:<siteId>` | All tags for a site |
| `alarms:<siteId>` | Alarm state changes |
| `alarms:*` | All alarm events |
| `events:*` | All system events |
| `gateways:<id>` | Gateway status changes |

### 4.3 Heartbeat

The server sends a `ping` every 30 seconds. Respond with `pong` to keep the connection alive. Connections are closed after 90 seconds without a pong.

---

## 5. Common Integration Patterns

### 5.1 Polling vs. Push

| Approach | Use Case | Recommendation |
|---|---|---|
| REST polling | Low-frequency data, simple integrations | Good for < 1 req/min |
| Webhooks | Event-driven reactions | Best for alarm/event notifications |
| WebSocket | Real-time dashboards, HMI | Best for live tag values |

### 5.2 Batch Tag Reading

```http
POST /api/tags/batch
Content-Type: application/json

{
  "tagIds": ["TANK1_LEVEL", "TANK1_TEMP", "PUMP1_STATUS"]
}
```

Response:
```json
{
  "tags": [
    { "id": "TANK1_LEVEL", "value": 72.5, "quality": "Good", "timestamp": "..." },
    { "id": "TANK1_TEMP", "value": 45.2, "quality": "Good", "timestamp": "..." },
    { "id": "PUMP1_STATUS", "value": 1, "quality": "Good", "timestamp": "..." }
  ]
}
```

### 5.3 Historical Data Export

```http
GET /api/tags/TANK1_LEVEL/history?from=2026-02-01&to=2026-02-14&interval=1h&format=csv
```

### 5.4 Error Handling

All errors follow a consistent format:

```json
{
  "error": {
    "code": "TAG_NOT_FOUND",
    "message": "Tag 'INVALID_TAG' not found",
    "status": 404
  }
}
```

| Status | Meaning |
|---|---|
| 400 | Bad request (validation error) |
| 401 | Unauthorized (invalid/missing key) |
| 403 | Forbidden (insufficient scope) |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Internal server error |

---

## 6. SDK & Tools

- **CLI:** `npm install -g 0xscada-cli` — see [CLI Guide](../devex/cli-guide.md)
- **TypeScript SDK:** `import { createClient } from '0xscada-sdk'`
- **OpenAPI spec:** Available at `/api/docs` or `docs/openapi.yaml`
- **Postman collection:** Import from `/api/postman`

---

## 7. Security Checklist

- [ ] Store API keys in environment variables, never in code
- [ ] Use HTTPS for all API communication
- [ ] Verify webhook signatures
- [ ] Use minimum-required scopes for API keys
- [ ] Rotate API keys periodically
- [ ] Implement rate limit handling with backoff
- [ ] Log all API interactions for audit
