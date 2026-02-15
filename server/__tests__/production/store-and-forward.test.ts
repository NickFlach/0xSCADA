import { describe, it, expect } from 'vitest';
import { StoreAndForwardEngine } from '../../edge/store-and-forward';

describe('StoreAndForwardEngine', () => {
  it('should enqueue and track events', () => {
    const engine = new StoreAndForwardEngine();
    engine.enqueue('tag-update', { tagId: 't1', value: 42 });
    expect(engine.getQueueDepth()).toBe(1);
  });

  it('should prioritize events', () => {
    const engine = new StoreAndForwardEngine();
    engine.enqueue('low', { v: 1 }, 'low');
    engine.enqueue('critical', { v: 2 }, 'critical');
    expect(engine.getQueueDepth()).toBe(2);
  });

  it('should sync events successfully', async () => {
    const engine = new StoreAndForwardEngine();
    engine.enqueue('test', { v: 1 });
    engine.enqueue('test', { v: 2 });

    const result = await engine.sync(async () => true);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(engine.getQueueDepth()).toBe(0);
  });

  it('should handle sync failure with backoff', async () => {
    const engine = new StoreAndForwardEngine({ backoffBaseMs: 100 });
    engine.enqueue('test', { v: 1 });

    const result = await engine.sync(async () => false);
    expect(result.failed).toBe(1);

    const state = engine.getState();
    expect(state.status).toBe('offline');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.currentBackoffMs).toBe(200); // 100 * 2^1
  });

  it('should verify integrity via Merkle tree', () => {
    const engine = new StoreAndForwardEngine();
    engine.enqueue('test', { v: 1 });
    engine.enqueue('test', { v: 2 });

    expect(engine.verifyIntegrity()).toBe(true);
    expect(engine.getState().integrityVerified).toBe(true);
  });

  it('should resolve conflicts with last-writer-wins', () => {
    const engine = new StoreAndForwardEngine();
    engine.setConflictRule('config', 'last-writer-wins');

    const result = engine.resolveConflict('config', { a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });

  it('should merge conflicts when strategy is merge', () => {
    const engine = new StoreAndForwardEngine();
    engine.setConflictRule('config', 'merge');

    const result = engine.resolveConflict('config', { a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should generate health report', () => {
    const engine = new StoreAndForwardEngine();
    engine.enqueue('test', { v: 1 });
    const report = engine.getHealthReport('site-1');
    expect(report.siteId).toBe('site-1');
    expect(report.syncState.queueDepth).toBe(1);
    expect(report.uptimeSeconds).toBeGreaterThan(0);
  });
});
