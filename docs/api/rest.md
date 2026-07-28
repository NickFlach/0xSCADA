# 0xSCADA REST API Documentation

## Base URL

```
http://localhost:5000/api
```

## Pagination

All list endpoints support standard pagination:

| Parameter    | Default | Description                     |
|-------------|---------|----------------------------------|
| `page`      | 1       | Page number (1-indexed)          |
| `limit`     | 25      | Items per page (max: 100)        |
| `sort_by`   | varies  | Field to sort by                 |
| `sort_order`| desc    | Sort direction: `asc` or `desc`  |

### Response Envelope

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 142,
    "totalPages": 6,
    "hasNext": true,
    "hasPrev": false
  },
  "_links": {
    "self": "/api/assets?page=1&limit=25",
    "first": "/api/assets?page=1&limit=25",
    "last": "/api/assets?page=6&limit=25",
    "next": "/api/assets?page=2&limit=25",
    "prev": null
  }
}
```

## Rate Limits

- **Read endpoints:** 100 requests/minute
- **Write endpoints:** 30 requests/minute
- **WebSocket connections:** 10 per client

---

## Assets

### List Assets

```
GET /api/assets?page=1&limit=10&status=OK&critical=true
```

**Filters:** `site_id`, `asset_type`, `status`, `critical`, `search` (partial name match)

### Get Asset

```
GET /api/assets/:id
```

### Create Asset

```
POST /api/assets
Content-Type: application/json

{
  "siteId": "site-uuid",
  "assetType": "PUMP",
  "nameOrTag": "P-101",
  "critical": true,
  "metadata": { "manufacturer": "ABB" }
}
```

### Update Asset

```
PATCH /api/assets/:id
Content-Type: application/json

{ "status": "WARNING" }
```

### Delete Asset

```
DELETE /api/assets/:id
```

---

## Tags

### List Tags

```
GET /api/tags?page=1&limit=10&search=TK-101&unit=%25
```

**Filters:** `search` (name match), `unit`, `has_value` (true/false)

### Get Tag Value

```
GET /api/tags/:name
```

### Tag Service Status

```
GET /api/tags/service/status
```

---

## Alarms

### Active Alarms

```
GET /api/alarms/active?severity=HIGH&state=ACTIVE&tag=TK-101
```

### Alarm History (Paginated)

```
GET /api/alarms/history?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z&severity=CRITICAL&page=1&limit=50
```

**Filters:** `from`, `to` (ISO timestamps), `severity`, `asset_id`, `site_id`

### Alarm Summary

```
GET /api/alarms/summary
```

Returns counts grouped by severity and state.

### Acknowledge Alarm

```
POST /api/alarms/:id/acknowledge
Content-Type: application/json

{ "user": "operator1" }
```

### Clear Alarm

```
POST /api/alarms/:id/clear
```

---

## Validator Attestation History

```
GET /api/nodes/attestation-history?window=24h
GET /api/nodes/attestation-history/demo?window=24h   # synthetic, opt-in
```

Read-only history behind the Slashing & Liveness Visualizer. Both routes require
an operator `X-API-Key`.

This build has **no live attestation feed**, so the live route fails closed with
`503 attestation_source_unavailable` and never substitutes generated records. The
`/demo` route serves clearly-labelled synthetic PRNG output and is disabled
unless the server runs with `SLASHING_DEMO_DATA=true`.

See [attestation-history.md](./attestation-history.md) for the full contract and
for how to register a real feed.

---

## Example Clients

### curl

```bash
# List assets with pagination
curl "http://localhost:5000/api/assets?page=1&limit=10&status=OK"

# Get active alarms
curl "http://localhost:5000/api/alarms/active?severity=CRITICAL"

# Acknowledge an alarm
curl -X POST "http://localhost:5000/api/alarms/ALM-1/acknowledge" \
  -H "Content-Type: application/json" \
  -d '{"user": "operator1"}'
```

### JavaScript (fetch)

```javascript
// Paginated asset list
const res = await fetch('/api/assets?page=1&limit=25&sort_by=nameOrTag&sort_order=asc');
const { data, pagination, _links } = await res.json();

console.log(`Page ${pagination.page} of ${pagination.totalPages}`);
for (const asset of data) {
  console.log(`${asset.nameOrTag} [${asset.status}]`);
}

// Follow next page
if (_links.next) {
  const next = await fetch(_links.next);
}
```

### Python (requests)

```python
import requests

base = "http://localhost:5000/api"

# List all critical assets
r = requests.get(f"{base}/assets", params={"critical": "true", "limit": 50})
result = r.json()

for asset in result["data"]:
    print(f"{asset['nameOrTag']} - {asset['status']}")

# Page through alarm history
page = 1
while True:
    r = requests.get(f"{base}/alarms/history", params={
        "page": page, "limit": 100,
        "from": "2026-01-01T00:00:00Z",
        "severity": "HIGH"
    })
    result = r.json()
    process_alarms(result["data"])
    if not result["pagination"]["hasNext"]:
        break
    page += 1
```

---

## Backwards Compatibility

- All new fields are additive (no removals)
- Pagination parameters have sensible defaults — omitting them returns page 1
- Filter parameters are optional and ignored if not provided
- Response envelope shape (`data`, `pagination`, `_links`) is stable
