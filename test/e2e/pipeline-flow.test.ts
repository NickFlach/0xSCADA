/**
 * [12.6] E2E Integration Test Suite
 * 
 * Tests the full pipeline flow: event ingestion → batching → anchoring → historian → WebSocket
 */

import { EventPipeline, PipelineEvent } from '../../server/pipeline/event-pipeline';

describe('E2E: Event Pipeline Flow', () => {
  let pipeline: EventPipeline;

  beforeEach(async () => {
    pipeline = new EventPipeline({
      batchSize: 5,
      batchIntervalMs: 500,
      enableBlockchainAnchor: true,
      enableHistorian: true,
      healthCheckIntervalMs: 60000,
    });
    await pipeline.start();
  });

  afterEach(async () => {
    await pipeline.shutdown();
  });

  function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      source: 'simulation',
      tagName: 'TT-100',
      value: Math.random() * 100,
      quality: 'good',
      timestamp: new Date(),
      ...overrides,
    };
  }

  test('should process a single event through the pipeline', async () => {
    await pipeline.ingest(makeEvent());
    const health = pipeline.health();
    expect(health.eventsProcessed).toBe(1);
    expect(health.eventsDropped).toBe(0);
  });

  test('should batch events and process together', async () => {
    for (let i = 0; i < 10; i++) {
      await pipeline.ingest(makeEvent({ tagName: `TT-${i}` }));
    }
    const health = pipeline.health();
    expect(health.eventsProcessed).toBe(10);
  });

  test('should report healthy status when running', () => {
    const health = pipeline.health();
    expect(health.status).toBe('healthy');
    expect(health.stages.batcher.status).toBe('healthy');
  });

  test('should broadcast events via WebSocket callback', async () => {
    const received: unknown[] = [];
    pipeline.setWebSocketBroadcast((event, data) => {
      received.push({ event, data });
    });

    // Ingest enough to trigger batch
    for (let i = 0; i < 5; i++) {
      await pipeline.ingest(makeEvent());
    }

    // Wait for batch processing
    await new Promise((r) => setTimeout(r, 100));
    expect(received.length).toBeGreaterThan(0);
  });

  test('should handle backpressure when queue is full', async () => {
    const smallPipeline = new EventPipeline({
      maxQueueDepth: 5,
      backpressureThreshold: 0.5,
      batchSize: 100, // Large batch = slow drain
      batchIntervalMs: 60000,
      enableBlockchainAnchor: false,
      enableHistorian: false,
      healthCheckIntervalMs: 60000,
    });
    await smallPipeline.start();

    let backpressureEmitted = false;
    smallPipeline.on('backpressure', () => { backpressureEmitted = true; });

    for (let i = 0; i < 10; i++) {
      await smallPipeline.ingest(makeEvent());
    }

    expect(smallPipeline.health().eventsDropped).toBeGreaterThan(0);
    await smallPipeline.shutdown();
  });

  test('should gracefully shutdown and flush remaining events', async () => {
    for (let i = 0; i < 3; i++) {
      await pipeline.ingest(makeEvent());
    }
    await pipeline.shutdown();
    // Should not throw
  });
});

describe('E2E: Gateway → Event → Anchor Flow', () => {
  test('should simulate OPC-UA tag change through full pipeline', async () => {
    const pipeline = new EventPipeline({
      batchSize: 1,
      batchIntervalMs: 100,
      enableBlockchainAnchor: true,
      enableHistorian: true,
      healthCheckIntervalMs: 60000,
    });
    await pipeline.start();

    // Simulate OPC-UA subscription event
    await pipeline.ingest({
      id: 'opcua-1',
      source: 'opcua',
      tagName: 'ns=2;s=Reactor.Temperature',
      value: 72.5,
      quality: 'good',
      timestamp: new Date(),
      metadata: { nodeId: 'ns=2;s=Reactor.Temperature', serverTimestamp: new Date().toISOString() },
    });

    await new Promise((r) => setTimeout(r, 200));
    const health = pipeline.health();
    expect(health.eventsProcessed).toBe(1);
    expect(health.status).toBe('healthy');

    await pipeline.shutdown();
  });

  test('should simulate Modbus register read through full pipeline', async () => {
    const pipeline = new EventPipeline({
      batchSize: 1,
      batchIntervalMs: 100,
      enableBlockchainAnchor: true,
      enableHistorian: true,
      healthCheckIntervalMs: 60000,
    });
    await pipeline.start();

    await pipeline.ingest({
      id: 'modbus-1',
      source: 'modbus',
      tagName: 'HR:40001',
      value: 1250,
      quality: 'good',
      timestamp: new Date(),
      metadata: { register: 40001, slaveId: 1 },
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(pipeline.health().eventsProcessed).toBe(1);

    await pipeline.shutdown();
  });
});
