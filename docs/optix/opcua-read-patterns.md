# OPC-UA Read/Write Patterns

> Issue #18 — [Optix/OPC-UA] Implement arbitrary OPC UA read

## Service Location

`server/gateway/opcua-read-write-service.ts`

## Architecture

The `OpcUaReadWriteService` wraps an OPC-UA session with type-safe read/write operations, automatic batching, and data type validation.

---

## API Reference

### Single Read

```typescript
const result = await service.readValue('ns=2;s=Motor1.Speed');
// → { nodeId, value: 1725.5, dataType: 'Double', quality: 'GOOD', sourceTimestamp, serverTimestamp }
```

### Read with Options

```typescript
const result = await service.readValueWithOptions({
  nodeId: 'ns=2;s=Motor1.Speed',
  maxAge: 500,       // Max cache age in ms (0 = force fresh)
  attributeId: 13,   // OPC-UA attribute (13 = Value)
});
```

### Batch Read (auto-splits)

```typescript
const results = await service.readValues([
  'ns=2;s=Motor1.Speed',
  'ns=2;s=Motor1.Current',
  'ns=2;s=Motor1.Fault',
], { batchSize: 50 });

const goodValues = results.filter(r => r.quality === 'GOOD');
```

### Write with Validation

```typescript
await service.writeValue('ns=2;s=Motor1.SpeedSetpoint', 1750.0, 'Double');
await service.writeValue('ns=2;s=Motor1.Enable', true, 'Boolean');
```

### Batch Write (validates all before sending any)

```typescript
await service.writeValues([
  { nodeId: 'ns=2;s=Motor1.SpeedSetpoint', value: 1750.0, dataType: 'Double' },
  { nodeId: 'ns=2;s=Motor1.Enable', value: true, dataType: 'Boolean' },
]);
```

---

## Supported Data Types

| Type | TypeScript | Range |
|---|---|---|
| `Boolean` | `boolean` | true/false |
| `Byte` | `number` | 0–255 |
| `Int16` | `number` | -32,768 – 32,767 |
| `UInt16` | `number` | 0 – 65,535 |
| `Int32` | `number` | ±2^31 |
| `UInt32` | `number` | 0 – 2^32 |
| `Int64` / `UInt64` | `number \| bigint` | Full 64-bit |
| `Float` / `Double` | `number` | IEEE 754 |
| `String` | `string` | UTF-8 |
| `DateTime` | `Date \| string` | ISO 8601 |
| `ByteString` | `Uint8Array \| Buffer` | Raw bytes |
| `Null` | `null \| undefined` | — |

## Quality Mapping

```
0x00000000 – 0x3FFFFFFF  →  GOOD
0x40000000 – 0x7FFFFFFF  →  UNCERTAIN
0x80000000 – 0xFFFFFFFF  →  BAD
```

Always check quality before using a value.

---

## Usage Patterns

### Dashboard Data Fetch

```typescript
app.get('/api/dashboard/:assetId', async (req, res) => {
  const prefix = `ns=2;s=${req.params.assetId}`;
  const results = await service.readValues([
    `${prefix}.Speed`, `${prefix}.Current`, `${prefix}.Temperature`,
    `${prefix}.Running`, `${prefix}.Fault`,
  ]);
  const data: Record<string, any> = {};
  for (const r of results) {
    const tag = r.nodeId.split('.').pop()!;
    data[tag] = { value: r.value, quality: r.quality, timestamp: r.sourceTimestamp };
  }
  res.json(data);
});
```

### Operator Write with Audit

```typescript
app.post('/api/command/:assetId', async (req, res) => {
  const { tag, value, dataType, operator } = req.body;
  const nodeId = `ns=2;s=${req.params.assetId}.${tag}`;

  const before = await service.readValue(nodeId);
  const result = await service.writeValue(nodeId, value, dataType);

  if (result.success) {
    eventService.emit({
      eventType: 'OPERATOR_WRITE',
      siteId: 'site-001', assetId: req.params.assetId,
      originType: 'hmi', originId: `operator-${operator}`,
      payload: { nodeId, before: before.value, after: value, dataType },
      details: `${operator} wrote ${tag}: ${before.value} → ${value}`,
    });
  }
  res.json({ success: result.success, statusCode: result.statusCode });
});
```

---

## Integration with Other Services

```
AddressSpaceBrowser  → Discover nodes
ReadWriteService     → Read/write on-demand
SubscriptionManager  → Monitor continuously
EventStreamServer    → Broadcast to clients
```

Use **reads** for dashboards, operator actions, bulk collection, pre-write verification.
Use **subscriptions** for real-time monitoring, alarm detection, trend data.
