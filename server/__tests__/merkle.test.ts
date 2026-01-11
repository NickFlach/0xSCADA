import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EventAccumulator,
  BatchManager,
  DEFAULT_BATCH_CONFIG,
  type BatchConfig,
  type BatchResult,
  type StoredBatch,
} from '../merkle/index';
import { sha256 } from '../crypto/index';

// ============================================================================
// UNIT TESTS: EventAccumulator
// ============================================================================

describe('EventAccumulator', () => {
  let accumulator: EventAccumulator;

  beforeEach(() => {
    vi.useFakeTimers();
    accumulator = new EventAccumulator();
  });

  afterEach(() => {
    accumulator.clear();
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      const acc = new EventAccumulator();
      expect(acc.getPendingCount()).toBe(0);
    });

    it('should accept custom config', () => {
      const customConfig: Partial<BatchConfig> = {
        maxBatchSize: 50,
        maxBatchAge: 30000,
        minBatchSize: 5,
      };
      const acc = new EventAccumulator(customConfig);
      expect(acc.getPendingCount()).toBe(0);
    });
  });

  describe('addEvent', () => {
    it('should add event to pending list', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      expect(accumulator.getPendingCount()).toBe(1);
    });

    it('should add multiple events', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.addEvent('event-2', sha256('event-2'));
      accumulator.addEvent('event-3', sha256('event-3'));
      expect(accumulator.getPendingCount()).toBe(3);
    });

    it('should trigger batch creation when maxBatchSize reached', () => {
      const smallBatchAcc = new EventAccumulator({ maxBatchSize: 3 });
      let batchCreated = false;
      smallBatchAcc.setOnBatchReady(() => {
        batchCreated = true;
      });

      smallBatchAcc.addEvent('1', sha256('1'));
      smallBatchAcc.addEvent('2', sha256('2'));
      expect(batchCreated).toBe(false);

      smallBatchAcc.addEvent('3', sha256('3'));
      expect(batchCreated).toBe(true);
    });
  });

  describe('createBatch', () => {
    it('should return null when pending count below minBatchSize', () => {
      const result = accumulator.createBatch();
      expect(result).toBeNull();
    });

    it('should create batch with correct structure', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      const batch = accumulator.createBatch();

      expect(batch).not.toBeNull();
      expect(batch?.batchId).toBeDefined();
      expect(batch?.merkleRoot).toBeDefined();
      expect(batch?.eventCount).toBe(1);
      expect(batch?.eventIds).toContain('event-1');
      expect(batch?.merkleTree).toBeDefined();
      expect(batch?.createdAt).toBeInstanceOf(Date);
    });

    it('should clear pending events after batch creation', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.addEvent('event-2', sha256('event-2'));
      accumulator.createBatch();

      expect(accumulator.getPendingCount()).toBe(0);
    });

    it('should invoke callback when batch is ready', () => {
      let receivedBatch: BatchResult | null = null;
      accumulator.setOnBatchReady((batch) => {
        receivedBatch = batch;
      });

      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.createBatch();

      expect(receivedBatch).not.toBeNull();
      expect(receivedBatch?.eventCount).toBe(1);
    });

    it('should compute correct merkle root', () => {
      const hash1 = sha256('event-1');
      const hash2 = sha256('event-2');

      accumulator.addEvent('event-1', hash1);
      accumulator.addEvent('event-2', hash2);
      const batch = accumulator.createBatch();

      expect(batch?.merkleRoot).toBe(sha256(hash1 + hash2));
    });
  });

  describe('timer-based batching', () => {
    it('should create batch after maxBatchAge', () => {
      let batchCreated = false;
      accumulator.setOnBatchReady(() => {
        batchCreated = true;
      });

      accumulator.addEvent('event-1', sha256('event-1'));
      expect(batchCreated).toBe(false);

      vi.advanceTimersByTime(DEFAULT_BATCH_CONFIG.maxBatchAge);
      expect(batchCreated).toBe(true);
    });

    it('should reset timer after batch creation', () => {
      let batchCount = 0;
      accumulator.setOnBatchReady(() => {
        batchCount++;
      });

      accumulator.addEvent('event-1', sha256('event-1'));
      vi.advanceTimersByTime(DEFAULT_BATCH_CONFIG.maxBatchAge);
      expect(batchCount).toBe(1);

      // Add new event and wait again
      accumulator.addEvent('event-2', sha256('event-2'));
      vi.advanceTimersByTime(DEFAULT_BATCH_CONFIG.maxBatchAge);
      expect(batchCount).toBe(2);
    });
  });

  describe('flush', () => {
    it('should create batch from pending events', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.addEvent('event-2', sha256('event-2'));

      const batch = accumulator.flush();

      expect(batch).not.toBeNull();
      expect(batch?.eventCount).toBe(2);
      expect(accumulator.getPendingCount()).toBe(0);
    });

    it('should return null when no pending events', () => {
      const batch = accumulator.flush();
      expect(batch).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all pending events', () => {
      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.addEvent('event-2', sha256('event-2'));

      accumulator.clear();

      expect(accumulator.getPendingCount()).toBe(0);
    });

    it('should cancel pending timer', () => {
      let batchCreated = false;
      accumulator.setOnBatchReady(() => {
        batchCreated = true;
      });

      accumulator.addEvent('event-1', sha256('event-1'));
      accumulator.clear();

      vi.advanceTimersByTime(DEFAULT_BATCH_CONFIG.maxBatchAge);
      expect(batchCreated).toBe(false);
    });
  });
});

// ============================================================================
// UNIT TESTS: BatchManager
// ============================================================================

describe('BatchManager', () => {
  let manager: BatchManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new BatchManager({ maxBatchSize: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with empty batch list', () => {
      expect(manager.getAllBatches()).toHaveLength(0);
    });

    it('should accept custom batch config', () => {
      const customManager = new BatchManager({ maxBatchSize: 10 });
      expect(customManager.getAllBatches()).toHaveLength(0);
    });
  });

  describe('addEvent', () => {
    it('should accumulate events', () => {
      manager.addEvent('event-1', sha256('event-1'));
      const stats = manager.getStats();
      expect(stats.pendingEvents).toBe(1);
    });

    it('should create batch when threshold reached', async () => {
      manager.setAnchorCallback(async () => null);

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      // Allow async handling
      await vi.runAllTimersAsync();

      expect(manager.getAllBatches()).toHaveLength(1);
    });
  });

  describe('anchorBatch', () => {
    it('should return false for non-existent batch', async () => {
      const result = await manager.anchorBatch('non-existent');
      expect(result).toBe(false);
    });

    it('should mark batch as ANCHORED on success', async () => {
      manager.setAnchorCallback(async () => ({
        txHash: '0x123',
        blockNumber: 100,
      }));

      // Add events to create a batch
      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      expect(batches[0].status).toBe('ANCHORED');
      expect(batches[0].txHash).toBe('0x123');
      expect(batches[0].blockNumber).toBe(100);
    });

    it('should mark batch as FAILED when callback returns null', async () => {
      manager.setAnchorCallback(async () => null);

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      expect(batches[0].status).toBe('FAILED');
      expect(batches[0].retryCount).toBe(1);
    });

    it('should mark batch as FAILED on callback error', async () => {
      manager.setAnchorCallback(async () => {
        throw new Error('Network error');
      });

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      expect(batches[0].status).toBe('FAILED');
      expect(batches[0].error).toBe('Network error');
    });

    it('should remain PENDING when no callback set', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      expect(batches[0].status).toBe('PENDING');

      consoleSpy.mockRestore();
    });
  });

  describe('getBatch', () => {
    it('should return undefined for non-existent batch', () => {
      expect(manager.getBatch('non-existent')).toBeUndefined();
    });

    it('should return batch by id', async () => {
      manager.setAnchorCallback(async () => ({ txHash: '0x1', blockNumber: 1 }));

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }

      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      const batch = manager.getBatch(batches[0].batchId);
      expect(batch).toBeDefined();
      expect(batch?.batchId).toBe(batches[0].batchId);
    });
  });

  describe('getPendingBatches', () => {
    it('should return empty array when no pending batches', () => {
      expect(manager.getPendingBatches()).toHaveLength(0);
    });

    it('should return only PENDING and FAILED batches', async () => {
      // First batch - will be anchored
      manager.setAnchorCallback(async () => ({ txHash: '0x1', blockNumber: 1 }));
      for (let i = 0; i < 5; i++) {
        manager.addEvent(`a-${i}`, sha256(`a-${i}`));
      }
      await vi.runAllTimersAsync();

      // Second batch - will fail
      manager.setAnchorCallback(async () => null);
      for (let i = 0; i < 5; i++) {
        manager.addEvent(`b-${i}`, sha256(`b-${i}`));
      }
      await vi.runAllTimersAsync();

      const pending = manager.getPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('FAILED');
    });
  });

  describe('getEventProof', () => {
    it('should return null for non-existent batch', () => {
      expect(manager.getEventProof('non-existent', sha256('event'))).toBeNull();
    });

    it('should return null for event not in batch', async () => {
      manager.setAnchorCallback(async () => ({ txHash: '0x1', blockNumber: 1 }));

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }
      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      const result = manager.getEventProof(batches[0].batchId, sha256('not-in-batch'));
      expect(result).toBeNull();
    });

    it('should return valid proof for event in batch', async () => {
      manager.setAnchorCallback(async () => ({ txHash: '0x1', blockNumber: 1 }));

      const eventHash = sha256('event-0');
      manager.addEvent('event-0', eventHash);
      for (let i = 1; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }
      await vi.runAllTimersAsync();

      const batches = manager.getAllBatches();
      const result = manager.getEventProof(batches[0].batchId, eventHash);

      expect(result).not.toBeNull();
      expect(result?.index).toBe(0);
      expect(result?.proof).toBeDefined();
      expect(Array.isArray(result?.proof)).toBe(true);
    });
  });

  describe('flush', () => {
    it('should create batch from pending events', () => {
      manager.addEvent('event-1', sha256('event-1'));
      manager.addEvent('event-2', sha256('event-2'));

      const batch = manager.flush();

      expect(batch).not.toBeNull();
      expect(batch?.eventCount).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const stats = manager.getStats();
      expect(stats.pendingEvents).toBe(0);
      expect(stats.totalBatches).toBe(0);
      expect(stats.anchoredBatches).toBe(0);
      expect(stats.failedBatches).toBe(0);
    });

    it('should track anchored batches', async () => {
      manager.setAnchorCallback(async () => ({ txHash: '0x1', blockNumber: 1 }));

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }
      await vi.runAllTimersAsync();

      const stats = manager.getStats();
      expect(stats.totalBatches).toBe(1);
      expect(stats.anchoredBatches).toBe(1);
      expect(stats.failedBatches).toBe(0);
    });

    it('should track failed batches', async () => {
      manager.setAnchorCallback(async () => null);

      for (let i = 0; i < 5; i++) {
        manager.addEvent(`event-${i}`, sha256(`event-${i}`));
      }
      await vi.runAllTimersAsync();

      const stats = manager.getStats();
      expect(stats.totalBatches).toBe(1);
      expect(stats.anchoredBatches).toBe(0);
      expect(stats.failedBatches).toBe(1);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS: End-to-End Batch Flow
// ============================================================================

describe('Batch Flow Integration', () => {
  it('should process events from addition to anchoring', async () => {
    vi.useFakeTimers();

    const manager = new BatchManager({ maxBatchSize: 3 });
    const anchoredBatches: StoredBatch[] = [];

    manager.setAnchorCallback(async (batch) => {
      anchoredBatches.push(batch);
      return {
        txHash: `0x${sha256(batch.batchId).slice(0, 8)}`,
        blockNumber: Date.now() % 1000,
      };
    });

    // Add events
    manager.addEvent('tx-1', sha256('data-1'));
    manager.addEvent('tx-2', sha256('data-2'));
    manager.addEvent('tx-3', sha256('data-3'));

    await vi.runAllTimersAsync();

    // Verify batch was created and anchored
    expect(anchoredBatches).toHaveLength(1);
    expect(anchoredBatches[0].eventCount).toBe(3);

    const stats = manager.getStats();
    expect(stats.totalBatches).toBe(1);
    expect(stats.anchoredBatches).toBe(1);

    vi.useRealTimers();
  });

  it('should provide verifiable merkle proofs', async () => {
    vi.useFakeTimers();

    const manager = new BatchManager({ maxBatchSize: 4 });
    manager.setAnchorCallback(async () => ({
      txHash: '0xabc',
      blockNumber: 123,
    }));

    // Add events with known hashes
    const eventHashes = [
      sha256('event-a'),
      sha256('event-b'),
      sha256('event-c'),
      sha256('event-d'),
    ];

    eventHashes.forEach((hash, i) => {
      manager.addEvent(`event-${i}`, hash);
    });

    await vi.runAllTimersAsync();

    const batches = manager.getAllBatches();
    const batch = batches[0];

    // Verify each event's proof
    for (let i = 0; i < eventHashes.length; i++) {
      const proofResult = manager.getEventProof(batch.batchId, eventHashes[i]);
      expect(proofResult).not.toBeNull();
      expect(proofResult?.index).toBe(i);
    }

    vi.useRealTimers();
  });
});
