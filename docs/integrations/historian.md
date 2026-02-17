# Time-Series Historian Database Connector

## Overview

The historian connector (`server/integrations/historian-connector.ts`) provides a unified interface for recording and querying time-series tag data, with support for TimescaleDB, InfluxDB, and an in-memory backend.

## Quick Start

```typescript
import { HistorianConnector } from '../server/integrations/historian-connector';

const historian = new HistorianConnector({
  backend: 'memory', // or 'timescaledb' or 'influxdb'
  flushIntervalMs: 5000,
  batchSize: 100,
  retentionPolicy: { maxAgeDays: 365 },
});

await historian.connect();

// Record values
historian.record('TANK_01.Level', 75.3);
historian.record('PUMP_01.Running', true, 'GOOD');

// Query
const result = await historian.query({
  tagNames: ['TANK_01.Level'],
  startTime: new Date('2026-01-01'),
  endTime: new Date(),
});

await historian.disconnect();
```

## Backends

### In-Memory (development/testing)
```typescript
{ backend: 'memory' }
```

### TimescaleDB
```typescript
{ backend: 'timescaledb', connectionString: 'postgresql://user:pass@host:5432/scada' }
```

### InfluxDB
```typescript
{ backend: 'influxdb', influxConfig: { url: 'http://localhost:8086', token: '...', org: 'scada', bucket: 'tags' } }
```

## Downsampling

Reduce storage for old data:
```typescript
await historian.downsample({
  sourceMaxAgeDays: 30,
  bucketSizeMs: 3600000, // 1 hour
  aggregation: 'avg',
});
```

## Retention

Automatic daily cleanup of data older than `maxAgeDays`.

## Buffered Writes

Writes are buffered and flushed either when the buffer reaches `batchSize` or every `flushIntervalMs`. This reduces database round-trips for high-frequency tag updates.
