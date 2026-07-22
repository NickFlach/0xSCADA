/**
 * Tests for the resilience.ts fakes replaced in #489: buildMerkleTreeSync now
 * uses the real MerkleTreeBuilder, and performBlockchainAnchor delegates to an
 * injected anchor operation (failing closed instead of Math.random success).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { ResilienceManager } from '../resilience';
import { MerkleTreeBuilder } from '../merkle';
import type { EventBatch, HashedEvent } from '../pipeline';

function hashedEvent(i: number): HashedEvent {
  const e = { id: `e${i}`, timestamp: 1000 + i, type: 't', source: 's', data: { v: i } };
  const canonical = JSON.stringify({ id: e.id, timestamp: e.timestamp, type: e.type, source: e.source, data: e.data });
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { ...e, hash };
}

function batch(events: HashedEvent[]): EventBatch {
  return {
    id: 'batch_1',
    windowStart: 1000,
    windowEnd: 61000,
    events,
    batchHash: createHash('sha256').update(events.map(e => e.hash).join(''), 'utf8').digest('hex'),
    created: 1000,
  };
}

const managers: ResilienceManager[] = [];
afterEach(async () => {
  while (managers.length) await managers.pop()!.cleanup();
});

describe('ResilienceManager real Merkle tree (#489)', () => {
  it('buildMerkleTree returns the real MerkleTreeBuilder root, not a fake string', async () => {
    const mgr = new ResilienceManager();
    managers.push(mgr);
    await mgr.initialize();

    const events = [hashedEvent(0), hashedEvent(1), hashedEvent(2)];
    const result = await mgr.buildMerkleTree(batch(events));

    expect(result.success).toBe(true);
    const expected = MerkleTreeBuilder.buildFromEventHashes(events.map(e => e.hash)).root;
    expect(result.merkleRoot).toBe(expected);
    // The old fake was `merkle_root_batch_1_<batchHash>` — assert it's a hex root.
    expect(result.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(result.merkleRoot!.startsWith('merkle_root_')).toBe(false);
  });
});

describe('ResilienceManager anchor delegates / fails closed (#489)', () => {
  it('delegates to the injected anchor operation', async () => {
    const calls: Array<{ batchId: string; merkleRoot: string }> = [];
    const mgr = new ResilienceManager({
      blockchain: {
        enabled: true,
        retryAttempts: 1,
        retryDelayMs: 10,
        queueMaxSize: 100,
        anchor: async (batchId, merkleRoot) => { calls.push({ batchId, merkleRoot }); return true; },
      },
    });
    managers.push(mgr);
    await mgr.initialize();

    const sig = await mgr.signMerkleRoot('deadbeef');
    const ok = await mgr.anchorMerkleRoot('batch_1', 'deadbeef', sig);

    expect(ok).toBe(true);
    expect(calls).toEqual([{ batchId: 'batch_1', merkleRoot: 'deadbeef' }]);
  });

  it('fails closed (returns false, no fake success) when no anchor operation is configured', async () => {
    const mgr = new ResilienceManager({
      blockchain: { enabled: true, retryAttempts: 1, retryDelayMs: 10, queueMaxSize: 100 },
    });
    managers.push(mgr);
    await mgr.initialize();

    let warned = false;
    mgr.on('warning', () => { warned = true; });

    const sig = await mgr.signMerkleRoot('cafe');
    const ok = await mgr.anchorMerkleRoot('batch_2', 'cafe', sig);

    // The old code returned Math.random() > 0.1 (fake ~90% success). Now it must
    // deterministically fail closed and warn.
    expect(ok).toBe(false);
    expect(warned).toBe(true);
  });
});
