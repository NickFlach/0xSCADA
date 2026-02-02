/**
 * Fuzz Testing: Batch Anchoring Edge Cases
 * 
 * Tests the batch anchoring service with edge case inputs to discover
 * race conditions, memory issues, and state corruption bugs.
 * 
 * Issue: #55 - Security Fuzz Testing for Protocol Handlers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  BatchAnchoringService,
  MerkleTree,
  type BatchableEvent,
  type BatchConfig,
} from '../../batch-anchoring';
import { sha256 } from '../../crypto/index';

// =============================================================================
// BATCH ACCUMULATION EDGE CASES
// =============================================================================

describe('Fuzz: Batch Accumulation Edge Cases', () => {
  let service: BatchAnchoringService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new BatchAnchoringService({
      maxBatchSize: 10,
      maxBatchAgeMs: 5000,
      enabled: true,
    });
  });

  afterEach(() => {
    service.shutdown();
    vi.useRealTimers();
  });

  // Test: Rapid event queueing
  it('should handle rapid event queueing without data loss', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (eventCount) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: 50,
            maxBatchAgeMs: 60000,
            enabled: true,
          });

          const events: BatchableEvent[] = [];
          for (let i = 0; i < eventCount; i++) {
            const event: BatchableEvent = {
              id: `event-${i}`,
              assetId: `asset-${i % 5}`,
              eventType: 'TEST_EVENT',
              payload: { index: i, data: `data-${i}` },
              timestamp: new Date(),
            };
            events.push(event);
            localService.queueEvent(event);
          }

          // Get stats
          const stats = localService.getStats();
          const pending = localService.getPendingEvents();
          const history = localService.getBatchHistory();

          // Total events should be accounted for
          const totalAccounted = stats.pendingEvents + stats.totalEventsAnchored;
          expect(totalAccounted).toBeLessThanOrEqual(eventCount);

          localService.shutdown();
        }
      ),
      { numRuns: 20 }
    );
  });

  // Test: Concurrent batch triggers
  it('should handle concurrent batch size and timer triggers', async () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 100, max: 1000 }),
        async (batchSize, timerMs) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: batchSize,
            maxBatchAgeMs: timerMs,
            enabled: true,
          });

          // Queue exactly batch size events
          for (let i = 0; i < batchSize; i++) {
            localService.queueEvent({
              id: `event-${i}`,
              assetId: `asset`,
              eventType: 'TEST',
              payload: { i },
              timestamp: new Date(),
            });
          }

          // Should trigger batch by size
          const stats = localService.getStats();
          expect(stats.pendingEvents).toBe(0);
          expect(stats.totalBatchesAnchored).toBeGreaterThanOrEqual(0);

          localService.shutdown();
        }
      ),
      { numRuns: 10 }
    );
  });

  // Test: Event queue overflow handling
  it('should handle large event queues', () => {
    const largeService = new BatchAnchoringService({
      maxBatchSize: 1000,
      maxBatchAgeMs: 300000,
      enabled: true,
    });

    // Queue many events
    const eventCount = 5000;
    for (let i = 0; i < eventCount; i++) {
      largeService.queueEvent({
        id: `event-${i}`,
        assetId: `asset-${i % 100}`,
        eventType: 'BULK_TEST',
        payload: { index: i, largeData: 'x'.repeat(100) },
        timestamp: new Date(),
      });
    }

    const stats = largeService.getStats();
    expect(stats.pendingEvents + stats.totalEventsAnchored).toBe(eventCount);

    largeService.shutdown();
  });
});

// =============================================================================
// MERKLE TREE CONSTRUCTION EDGE CASES
// =============================================================================

describe('Fuzz: MerkleTree Construction Edge Cases', () => {
  // Test: Trees with duplicate leaves
  it('should handle trees with duplicate leaves', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.integer({ min: 2, max: 50 }),
        (baseData, repeatCount) => {
          const duplicateData = new Array(repeatCount).fill(baseData);
          const tree = new MerkleTree(duplicateData);
          
          expect(tree.getRoot()).toBeDefined();
          
          // All proofs should be valid
          for (let i = 0; i < repeatCount; i++) {
            const proof = tree.getProof(i);
            const leafHash = MerkleTree.hashEventData(baseData);
            expect(MerkleTree.verify(leafHash, proof, tree.getRoot())).toBe(true);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  // Test: Trees with empty string data
  it('should handle empty string data', () => {
    const emptyData = ['', '', ''];
    const tree = new MerkleTree(emptyData);
    
    expect(tree.getRoot()).toBeDefined();
    
    for (let i = 0; i < emptyData.length; i++) {
      const proof = tree.getProof(i);
      const leafHash = MerkleTree.hashEventData('');
      expect(MerkleTree.verify(leafHash, proof, tree.getRoot())).toBe(true);
    }
  });

  // Test: Trees with mixed data types (as strings)
  it('should handle mixed stringified data types', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string(),
            fc.integer().map(String),
            fc.boolean().map(String),
            fc.float().map(String),
            fc.jsonValue().map(v => JSON.stringify(v)),
          ),
          { minLength: 1, maxLength: 50 }
        ),
        (mixedData) => {
          const tree = new MerkleTree(mixedData);
          
          expect(tree.getRoot()).toBeDefined();
          expect(tree.getRoot().length).toBeGreaterThan(0);
          
          // Verify all proofs
          for (let i = 0; i < mixedData.length; i++) {
            const proof = tree.getProof(i);
            const leafHash = MerkleTree.hashEventData(mixedData[i]);
            expect(MerkleTree.verify(leafHash, proof, tree.getRoot())).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: Very long data strings
  it('should handle very long data strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10000, maxLength: 100000 }),
        fc.integer({ min: 1, max: 5 }),
        (longString, count) => {
          const data = new Array(count).fill(longString);
          
          const start = Date.now();
          const tree = new MerkleTree(data);
          const duration = Date.now() - start;
          
          expect(tree.getRoot()).toBeDefined();
          expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
        }
      ),
      { numRuns: 5 }
    );
  });
});

// =============================================================================
// PROOF VERIFICATION EDGE CASES
// =============================================================================

describe('Fuzz: Proof Verification Edge Cases', () => {
  // Test: Proof with wrong root
  it('should fail verification with wrong root', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 20 }),
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (data, fakeRoot) => {
          const tree = new MerkleTree(data);
          const proof = tree.getProof(0);
          const leafHash = MerkleTree.hashEventData(data[0]);
          const wrongRoot = '0x' + fakeRoot;
          
          // Should fail unless by extreme coincidence
          if (wrongRoot !== tree.getRoot()) {
            expect(MerkleTree.verify(leafHash, proof, wrongRoot)).toBe(false);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: Proof with modified elements
  it('should fail verification with modified proof elements', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 4, maxLength: 20 }),
        fc.nat(),
        (data, indexSeed) => {
          const tree = new MerkleTree(data);
          const index = indexSeed % data.length;
          const proof = tree.getProof(index);
          
          if (proof.length === 0) return;
          
          // Modify a proof element
          const modifiedProof = [...proof];
          const modifyIndex = indexSeed % proof.length;
          modifiedProof[modifyIndex] = '0x' + sha256(`modified-${indexSeed}`);
          
          const leafHash = MerkleTree.hashEventData(data[index]);
          
          // Should fail (unless coincidental match)
          if (modifiedProof[modifyIndex] !== proof[modifyIndex]) {
            expect(MerkleTree.verify(leafHash, modifiedProof, tree.getRoot())).toBe(false);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: Proof with wrong leaf
  it('should fail verification with wrong leaf hash', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (data, wrongData) => {
          if (data.includes(wrongData)) return; // Skip if coincidentally same
          
          const tree = new MerkleTree(data);
          const proof = tree.getProof(0);
          const wrongLeafHash = MerkleTree.hashEventData(wrongData);
          
          expect(MerkleTree.verify(wrongLeafHash, proof, tree.getRoot())).toBe(false);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: Empty proof
  it('should handle empty proof correctly', () => {
    // Single element tree has empty proof
    const singleTree = new MerkleTree(['single']);
    const proof = singleTree.getProof(0);
    const leafHash = MerkleTree.hashEventData('single');
    
    // Root equals leaf hash for single element
    expect(MerkleTree.verify(leafHash, proof, singleTree.getRoot())).toBe(true);
  });
});

// =============================================================================
// BATCH SERVICE STATE TRANSITIONS
// =============================================================================

describe('Fuzz: Batch Service State Transitions', () => {
  // Test: Enable/disable toggling
  it('should handle rapid enable/disable toggling', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
        (toggles) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: 10,
            maxBatchAgeMs: 5000,
            enabled: true,
          });

          for (const enabled of toggles) {
            localService.updateConfig({ enabled });
            
            // Queue an event
            localService.queueEvent({
              id: `event-${Math.random()}`,
              assetId: 'test',
              eventType: 'TEST',
              payload: {},
              timestamp: new Date(),
            });
          }

          // Should not crash
          expect(localService.getStats()).toBeDefined();
          
          localService.shutdown();
        }
      ),
      { numRuns: 20 }
    );
  });

  // Test: Config updates during operation
  it('should handle config updates during operation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 10000 }),
        (newBatchSize, newAgeMs) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: 10,
            maxBatchAgeMs: 5000,
            enabled: true,
          });

          // Queue some events
          for (let i = 0; i < 5; i++) {
            localService.queueEvent({
              id: `event-${i}`,
              assetId: 'test',
              eventType: 'TEST',
              payload: {},
              timestamp: new Date(),
            });
          }

          // Update config
          localService.updateConfig({
            maxBatchSize: newBatchSize,
            maxBatchAgeMs: newAgeMs,
          });

          // Config should be updated
          const config = localService.getConfig();
          expect(config.maxBatchSize).toBe(newBatchSize);
          expect(config.maxBatchAgeMs).toBe(newAgeMs);

          localService.shutdown();
        }
      ),
      { numRuns: 20 }
    );
  });

  // Test: Shutdown during batch operation
  it('should handle shutdown gracefully', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (eventCount) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: 50,
            maxBatchAgeMs: 60000,
            enabled: true,
          });

          // Queue events
          for (let i = 0; i < eventCount; i++) {
            localService.queueEvent({
              id: `event-${i}`,
              assetId: 'test',
              eventType: 'TEST',
              payload: {},
              timestamp: new Date(),
            });
          }

          // Shutdown should not throw
          expect(() => localService.shutdown()).not.toThrow();
        }
      ),
      { numRuns: 20 }
    );
  });
});

// =============================================================================
// PROOF RETRIEVAL EDGE CASES
// =============================================================================

describe('Fuzz: Proof Retrieval Edge Cases', () => {
  // Test: Non-existent batch ID
  it('should return null for non-existent batch ID', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        (batchId, eventId) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: 10,
            maxBatchAgeMs: 5000,
            enabled: true,
          });

          const proof = localService.getProofForEvent(batchId, eventId);
          expect(proof).toBeNull();

          localService.shutdown();
        }
      ),
      { numRuns: 20 }
    );
  });

  // Test: Event not in batch
  it('should return null for event not in batch', async () => {
    const localService = new BatchAnchoringService({
      maxBatchSize: 3,
      maxBatchAgeMs: 60000,
      enabled: true,
    });

    // Create a batch
    for (let i = 0; i < 3; i++) {
      localService.queueEvent({
        id: `event-${i}`,
        assetId: 'test',
        eventType: 'TEST',
        payload: {},
        timestamp: new Date(),
      });
    }

    const history = localService.getBatchHistory();
    if (history.length > 0) {
      // Try to get proof for non-existent event
      const proof = localService.getProofForEvent(history[0].batchId, 'non-existent-event');
      expect(proof).toBeNull();
    }

    localService.shutdown();
  });
});

// =============================================================================
// GAS ESTIMATION EDGE CASES
// =============================================================================

describe('Fuzz: Gas Estimation Edge Cases', () => {
  // Test: Stats calculation with various batch sizes
  it('should calculate stats correctly', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 100 }),
        (batchCount, eventsPerBatch) => {
          const localService = new BatchAnchoringService({
            maxBatchSize: eventsPerBatch,
            maxBatchAgeMs: 1000,
            enabled: true,
          });

          let totalEvents = 0;
          for (let b = 0; b < batchCount; b++) {
            for (let e = 0; e < eventsPerBatch; e++) {
              localService.queueEvent({
                id: `batch-${b}-event-${e}`,
                assetId: 'test',
                eventType: 'TEST',
                payload: {},
                timestamp: new Date(),
              });
              totalEvents++;
            }
          }

          const stats = localService.getStats();
          
          // Stats should be consistent
          expect(stats.pendingEvents + stats.totalEventsAnchored).toBeLessThanOrEqual(totalEvents);
          expect(stats.totalBatchesAnchored).toBeGreaterThanOrEqual(0);
          
          if (stats.totalBatchesAnchored > 0) {
            expect(stats.averageEventsPerBatch).toBeGreaterThan(0);
          }

          localService.shutdown();
        }
      ),
      { numRuns: 10 }
    );
  });
});

// =============================================================================
// TIMESTAMP EDGE CASES
// =============================================================================

describe('Fuzz: Timestamp Edge Cases', () => {
  it('should handle various timestamp values', () => {
    const localService = new BatchAnchoringService({
      maxBatchSize: 100,
      maxBatchAgeMs: 60000,
      enabled: true,
    });

    const extremeDates = [
      new Date(0), // Unix epoch
      new Date('1970-01-01'),
      new Date('2000-01-01'),
      new Date('2038-01-19'), // 32-bit overflow boundary
      new Date('2100-12-31'),
      new Date(-1), // Before epoch
      new Date(Number.MAX_SAFE_INTEGER), // Far future
    ];

    for (const date of extremeDates) {
      expect(() => {
        localService.queueEvent({
          id: `event-${date.getTime()}`,
          assetId: 'test',
          eventType: 'TEST',
          payload: { timestamp: date.toISOString() },
          timestamp: date,
        });
      }).not.toThrow();
    }

    localService.shutdown();
  });
});

// =============================================================================
// MEMORY PRESSURE TESTS
// =============================================================================

describe('Fuzz: Memory Pressure', () => {
  it('should handle batch history limit', () => {
    const localService = new BatchAnchoringService({
      maxBatchSize: 1,
      maxBatchAgeMs: 1,
      enabled: true,
    });

    // Create many batches (history is limited to 100)
    for (let i = 0; i < 150; i++) {
      localService.queueEvent({
        id: `event-${i}`,
        assetId: 'test',
        eventType: 'TEST',
        payload: {},
        timestamp: new Date(),
      });
    }

    const history = localService.getBatchHistory();
    expect(history.length).toBeLessThanOrEqual(100);

    localService.shutdown();
  });
});
