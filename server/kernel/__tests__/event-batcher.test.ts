import { describe, it, expect, vi } from 'vitest';
import { EventBatcher } from '../event-batcher';
import type { AnchorableEvent } from '@shared/types/merkle';

function makeEvent(id: string): AnchorableEvent {
  return { id, timestamp: Date.now(), type: 'test', payload: `data-${id}`, source: 'test' };
}

describe('EventBatcher', () => {
  it('flushes when batch size reached', () => {
    const batcher = new EventBatcher({ maxBatchSize: 3, maxBatchAgeMs: 60000 });
    const onBatch = vi.fn();
    batcher.on('batch', onBatch);

    batcher.ingest(makeEvent('1'));
    batcher.ingest(makeEvent('2'));
    expect(onBatch).not.toHaveBeenCalled();

    batcher.ingest(makeEvent('3'));
    expect(onBatch).toHaveBeenCalledTimes(1);

    const batch = onBatch.mock.calls[0][0];
    expect(batch.events).toHaveLength(3);
    expect(batch.merkleRoot).toBeTruthy();
  });

  it('manual flush works', () => {
    const batcher = new EventBatcher({ maxBatchSize: 100, maxBatchAgeMs: 60000 });
    batcher.ingest(makeEvent('a'));
    const batch = batcher.flush();
    expect(batch).not.toBeNull();
    expect(batch!.events).toHaveLength(1);
  });

  it('flush with no events returns null', () => {
    const batcher = new EventBatcher();
    expect(batcher.flush()).toBeNull();
  });

  it('compresses and decompresses batches', () => {
    const batcher = new EventBatcher({ compress: true });
    batcher.ingest(makeEvent('x'));
    const batch = batcher.flush()!;
    const compressed = batcher.compressBatch(batch);
    const events = EventBatcher.decompressBatch(compressed, true);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('x');
  });

  it('tracks metrics', () => {
    const batcher = new EventBatcher({ maxBatchSize: 2, maxBatchAgeMs: 60000 });
    batcher.ingest(makeEvent('1'));
    batcher.ingest(makeEvent('2'));
    const metrics = batcher.getMetrics();
    expect(metrics.totalBatches).toBe(1);
    expect(metrics.totalEvents).toBe(2);
  });
});
