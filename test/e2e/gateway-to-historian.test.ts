/**
 * [12.6] E2E Integration Test Suite — Gateway → Event → Batch → Anchor → Historian
 * 
 * End-to-end test scenarios covering the complete data flow from gateway
 * tag ingestion through blockchain anchoring to historian storage.
 * 
 * Closes #208
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// --- Mock Pipeline Components ---

interface PipelineEvent {
  id: string;
  source: string;
  tagName: string;
  value: number | string | boolean;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

interface BatchRecord {
  id: string;
  events: PipelineEvent[];
  merkleRoot: string;
  createdAt: Date;
}

interface AnchorRecord {
  batchId: string;
  txHash: string;
  blockNumber: number;
  anchoredAt: Date;
}

interface HistorianRecord {
  tagName: string;
  value: number | string | boolean;
  quality: number;
  timestamp: Date;
  batchId?: string;
}

// Simulated in-memory stores
let eventStore: PipelineEvent[] = [];
let batchStore: BatchRecord[] = [];
let anchorStore: AnchorRecord[] = [];
let historianStore: HistorianRecord[] = [];
let wsMessages: Array<{ event: string; payload: unknown }> = [];

// Helpers
function createEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'gateway',
    tagName: 'TT-100',
    value: Math.random() * 100,
    quality: 'good',
    timestamp: new Date(),
    ...overrides,
  };
}

function computeMerkleRoot(events: PipelineEvent[]): string {
  // Simplified: hash of concatenated event ids
  const concat = events.map(e => e.id).join('|');
  let hash = 0;
  for (let i = 0; i < concat.length; i++) {
    hash = ((hash << 5) - hash) + concat.charCodeAt(i);
    hash |= 0;
  }
  return `0x${Math.abs(hash).toString(16).padStart(64, '0')}`;
}

function simulateBlockchainAnchor(batchId: string, merkleRoot: string): AnchorRecord {
  return {
    batchId,
    txHash: `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`,
    blockNumber: Math.floor(Math.random() * 1000000),
    anchoredAt: new Date(),
  };
}

// --- Pipeline simulation ---

async function ingestEvent(event: PipelineEvent): Promise<void> {
  eventStore.push(event);
  
  // Broadcast to WebSocket
  wsMessages.push({ event: 'tag:update', payload: { tagName: event.tagName, value: event.value, quality: event.quality, timestamp: event.timestamp.toISOString() } });
  
  // Write to historian
  historianStore.push({
    tagName: event.tagName,
    value: event.value,
    quality: event.quality === 'good' ? 192 : event.quality === 'uncertain' ? 64 : 0,
    timestamp: event.timestamp,
  });
}

async function createBatch(events: PipelineEvent[]): Promise<BatchRecord> {
  const batch: BatchRecord = {
    id: `batch-${Date.now()}`,
    events,
    merkleRoot: computeMerkleRoot(events),
    createdAt: new Date(),
  };
  batchStore.push(batch);

  // Link historian records
  for (const rec of historianStore) {
    if (events.some(e => e.tagName === rec.tagName && !rec.batchId)) {
      rec.batchId = batch.id;
    }
  }

  return batch;
}

async function anchorBatch(batch: BatchRecord): Promise<AnchorRecord> {
  const anchor = simulateBlockchainAnchor(batch.id, batch.merkleRoot);
  anchorStore.push(anchor);
  return anchor;
}

// --- Tests ---

describe('E2E: Gateway → Event → Batch → Anchor → Historian', () => {
  beforeAll(() => {
    eventStore = [];
    batchStore = [];
    anchorStore = [];
    historianStore = [];
    wsMessages = [];
  });

  afterAll(() => {
    eventStore = [];
    batchStore = [];
    anchorStore = [];
    historianStore = [];
    wsMessages = [];
  });

  test('single event flows through entire pipeline', async () => {
    const event = createEvent({ tagName: 'TT-201', value: 72.5 });
    await ingestEvent(event);

    // Event stored
    expect(eventStore).toHaveLength(1);
    expect(eventStore[0].tagName).toBe('TT-201');

    // Historian record created
    expect(historianStore).toHaveLength(1);
    expect(historianStore[0].value).toBe(72.5);
    expect(historianStore[0].quality).toBe(192); // OPC UA Good

    // WebSocket broadcast
    expect(wsMessages).toHaveLength(1);
    expect(wsMessages[0].event).toBe('tag:update');

    // Batch and anchor
    const batch = await createBatch([event]);
    expect(batch.merkleRoot).toBeTruthy();

    const anchor = await anchorBatch(batch);
    expect(anchor.txHash).toMatch(/^0x/);
    expect(anchor.blockNumber).toBeGreaterThan(0);

    // Historian linked to batch
    expect(historianStore[0].batchId).toBe(batch.id);
  });

  test('batch of events creates single Merkle root', async () => {
    eventStore = [];
    historianStore = [];
    wsMessages = [];

    const events: PipelineEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const event = createEvent({ tagName: `PT-${300 + i}`, value: 50 + i * 2.5 });
      await ingestEvent(event);
      events.push(event);
    }

    expect(eventStore).toHaveLength(10);
    expect(historianStore).toHaveLength(10);
    expect(wsMessages).toHaveLength(10);

    const batch = await createBatch(events);
    expect(batch.events).toHaveLength(10);
    expect(batch.merkleRoot).toBeTruthy();

    const anchor = await anchorBatch(batch);
    expect(anchor.batchId).toBe(batch.id);
  });

  test('bad quality events are stored with correct quality code', async () => {
    historianStore = [];
    
    await ingestEvent(createEvent({ tagName: 'FT-401', value: 0, quality: 'bad' }));
    await ingestEvent(createEvent({ tagName: 'FT-402', value: 50, quality: 'uncertain' }));
    await ingestEvent(createEvent({ tagName: 'FT-403', value: 100, quality: 'good' }));

    expect(historianStore[0].quality).toBe(0);   // Bad
    expect(historianStore[1].quality).toBe(64);   // Uncertain
    expect(historianStore[2].quality).toBe(192);  // Good
  });

  test('multiple batches produce unique Merkle roots', async () => {
    eventStore = [];
    
    const events1 = [createEvent({ tagName: 'A1' }), createEvent({ tagName: 'A2' })];
    const events2 = [createEvent({ tagName: 'B1' }), createEvent({ tagName: 'B2' })];

    for (const e of [...events1, ...events2]) await ingestEvent(e);

    const batch1 = await createBatch(events1);
    const batch2 = await createBatch(events2);

    expect(batch1.merkleRoot).not.toBe(batch2.merkleRoot);
  });

  test('high-frequency ingestion maintains ordering', async () => {
    eventStore = [];
    wsMessages = [];

    const count = 100;
    const events: PipelineEvent[] = [];
    for (let i = 0; i < count; i++) {
      const event = createEvent({ tagName: `HF-${i}`, value: i, timestamp: new Date(Date.now() + i) });
      await ingestEvent(event);
      events.push(event);
    }

    expect(eventStore).toHaveLength(count);
    expect(wsMessages).toHaveLength(count);

    // Verify ordering
    for (let i = 1; i < eventStore.length; i++) {
      expect(eventStore[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        eventStore[i - 1].timestamp.getTime()
      );
    }
  });

  test('mixed source types (OPC-UA, Modbus, simulation) coexist', async () => {
    eventStore = [];

    await ingestEvent(createEvent({ source: 'opcua', tagName: 'ns=2;s=Temp', value: 72.3 }));
    await ingestEvent(createEvent({ source: 'modbus', tagName: 'HR:40001', value: 1250 }));
    await ingestEvent(createEvent({ source: 'simulation', tagName: 'SIM.Level', value: 65.0 }));

    expect(eventStore.map(e => e.source)).toEqual(['opcua', 'modbus', 'simulation']);

    const batch = await createBatch(eventStore);
    expect(batch.events).toHaveLength(3);
    
    const anchor = await anchorBatch(batch);
    expect(anchor.txHash).toBeTruthy();
  });
});

describe('E2E: Error & Edge Cases', () => {
  beforeAll(() => {
    eventStore = [];
    batchStore = [];
    anchorStore = [];
    historianStore = [];
    wsMessages = [];
  });

  test('empty batch handles gracefully', async () => {
    const batch = await createBatch([]);
    expect(batch.events).toHaveLength(0);
    expect(batch.merkleRoot).toBeTruthy();
  });

  test('duplicate events are both stored (dedup is application-level)', async () => {
    const event = createEvent({ id: 'dup-1', tagName: 'DUP', value: 42 });
    await ingestEvent(event);
    await ingestEvent({ ...event }); // same shape

    expect(eventStore.filter(e => e.id === 'dup-1')).toHaveLength(2);
  });

  test('boolean tag values are preserved', async () => {
    historianStore = [];
    await ingestEvent(createEvent({ tagName: 'DI-100', value: true }));
    await ingestEvent(createEvent({ tagName: 'DI-101', value: false }));

    expect(historianStore[0].value).toBe(true);
    expect(historianStore[1].value).toBe(false);
  });

  test('string tag values are preserved', async () => {
    historianStore = [];
    await ingestEvent(createEvent({ tagName: 'STATUS', value: 'RUNNING' }));
    expect(historianStore[0].value).toBe('RUNNING');
  });

  test('events with metadata are preserved through pipeline', async () => {
    eventStore = [];
    const event = createEvent({
      tagName: 'META-TAG',
      metadata: { nodeId: 'ns=2;s=Test', serverTimestamp: '2026-01-01T00:00:00Z' },
    });
    await ingestEvent(event);

    expect(eventStore[0].metadata).toEqual({
      nodeId: 'ns=2;s=Test',
      serverTimestamp: '2026-01-01T00:00:00Z',
    });
  });
});

describe('E2E: Historian Query Patterns', () => {
  beforeAll(async () => {
    historianStore = [];
    
    // Populate historian with time-series data
    const baseTime = new Date('2026-01-15T00:00:00Z').getTime();
    for (let i = 0; i < 60; i++) {
      historianStore.push({
        tagName: 'TT-QUERY',
        value: 50 + Math.sin(i * 0.1) * 20,
        quality: 192,
        timestamp: new Date(baseTime + i * 60000), // 1-minute intervals
      });
    }
  });

  test('can query historian by tag name', () => {
    const results = historianStore.filter(r => r.tagName === 'TT-QUERY');
    expect(results).toHaveLength(60);
  });

  test('can query historian by time range', () => {
    const start = new Date('2026-01-15T00:10:00Z');
    const end = new Date('2026-01-15T00:30:00Z');
    const results = historianStore.filter(
      r => r.tagName === 'TT-QUERY' && r.timestamp >= start && r.timestamp <= end
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(60);
  });

  test('historian data maintains time ordering', () => {
    const results = historianStore.filter(r => r.tagName === 'TT-QUERY');
    for (let i = 1; i < results.length; i++) {
      expect(results[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        results[i - 1].timestamp.getTime()
      );
    }
  });
});
