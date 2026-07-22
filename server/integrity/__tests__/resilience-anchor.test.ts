/**
 * Tests for the resilience.ts fakes replaced in #489: buildMerkleTreeSync now
 * uses the real MerkleTreeBuilder, and performBlockchainAnchor delegates to an
 * injected anchor operation (failing closed instead of Math.random success).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { ResilienceManager } from '../resilience';
import { MerkleTreeBuilder } from '../merkle';
import { InMemoryPkcs11Provider } from '../pkcs11-provider';
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
    // bytes32 (0x-prefixed) — the SAME normalization the anchor pipeline uses,
    // so the same batch can't produce two different root strings (#489).
    const expected = '0x' + MerkleTreeBuilder.buildFromEventHashes(events.map(e => e.hash)).root;
    expect(result.merkleRoot).toBe(expected);
    expect(result.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
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

  it('signs via a primary PKCS#11 signer when configured (#482)', async () => {
    const emu = new InMemoryPkcs11Provider();
    emu.setPin('1234');
    emu.addKey('resilience-key');
    const mgr = new ResilienceManager(
      {
        hsm: {
          enabled: true,
          fallbackToSoftware: true,
          config: { mode: 'pkcs11', algorithm: 'RS256', pkcs11Library: '/emu.so', slot: 0, pin: '1234', keyId: 'resilience-key' },
        },
        blockchain: { enabled: true, retryAttempts: 1, retryDelayMs: 10, queueMaxSize: 100, anchor: async () => true },
      },
      { pkcs11Provider: emu },
    );
    managers.push(mgr);
    await mgr.initialize();

    const sig = await mgr.signMerkleRoot('0x' + 'ab'.repeat(32));
    expect(sig.signature).toMatch(/^[0-9a-f]+$/);
    // Signed by the PKCS#11 token, not the software fallback.
    expect(sig.keyId).toBe('resilience-key');
  });

  it('falls back to the software signer when the primary PKCS#11 signer fails to initialize (#482)', async () => {
    const emu = new InMemoryPkcs11Provider();
    emu.setPin('1234'); // token expects 1234
    emu.addKey('resilience-key');
    const mgr = new ResilienceManager(
      {
        hsm: {
          enabled: true,
          fallbackToSoftware: true,
          // Wrong PIN → primary init throws → software fallback engages.
          config: { mode: 'pkcs11', algorithm: 'RS256', pkcs11Library: '/emu.so', slot: 0, pin: 'wrong', keyId: 'resilience-key', keyPath: undefined },
        },
        blockchain: { enabled: true, retryAttempts: 1, retryDelayMs: 10, queueMaxSize: 100, anchor: async () => true },
      },
      { pkcs11Provider: emu },
    );
    managers.push(mgr);
    await mgr.initialize();

    // Still signs — via the software fallback (a real RSA signature).
    const sig = await mgr.signMerkleRoot('0x' + 'cd'.repeat(32));
    expect(sig.signature).toMatch(/^[0-9a-f]+$/);
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
