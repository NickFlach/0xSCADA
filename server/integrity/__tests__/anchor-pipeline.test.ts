/**
 * End-to-end integration for the real integrity chain (#489):
 * Event → Batch → Merkle → Sign → Verify → anchor submit.
 *
 * Everything except the blockchain itself is real crypto: the pipeline hashes
 * (SHA-256), MerkleTreeBuilder builds the real root, MerkleRootSigner signs it
 * (RSA), and the relayer verifies that signature against the signing key before
 * submitting. The chain is a mock contract (a live-anvil e2e is a follow-up —
 * anvil is not in CI). This replaces the former Math.random() simulation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { AnchorPipeline } from '../anchor-pipeline';
import { MerkleTreeBuilder } from '../merkle';
import type { AnchorContractLike } from '../relayer';
import type { SCADAEvent } from '../pipeline';

function mockChain() {
  const submitted: Array<{ root: string; batchId: number; eventCount: number }> = [];
  const contract: AnchorContractLike = {
    anchor: Object.assign(
      async (root: string, batchId: number, eventCount: number) => {
        submitted.push({ root, batchId, eventCount });
        return { wait: async () => ({ hash: '0xabc', blockNumber: 10, gasUsed: 21000n }) };
      },
      { estimateGas: async () => 100000n },
    ),
  };
  const provider = { getFeeData: async () => ({ gasPrice: 1_000_000_000n }), getBlockNumber: async () => 12 } as any;
  return { contract, provider, submitted };
}

function scadaEvent(i: number, ts: number): SCADAEvent {
  return { id: `evt-${i}`, timestamp: ts, type: 'reading', source: 'sensor-1', data: { value: 100 + i } };
}

const pipelines: AnchorPipeline[] = [];
afterEach(async () => {
  while (pipelines.length) await pipelines.pop()!.stop();
});

describe('AnchorPipeline end-to-end (#489)', () => {
  it('anchors the REAL Merkle root of the ingested events (verified signature reaches the mock chain)', async () => {
    const { contract, provider, submitted } = mockChain();
    const pipeline = new AnchorPipeline({
      pipeline: { windowSizeMs: 60000, maxBatchSize: 3 }, // flush at 3 events
      relayerDeps: { contract, provider },
    });
    pipelines.push(pipeline);
    await pipeline.start();

    const anchored = new Promise<void>(resolve => pipeline.relayer.once('anchorSuccess', () => resolve()));

    const base = 1_700_000_000_000;
    // 3 events → batch flushes (maxBatchSize) → merkle → sign → submit.
    await pipeline.ingestEvent(scadaEvent(0, base));
    await pipeline.ingestEvent(scadaEvent(1, base + 1));
    await pipeline.ingestEvent(scadaEvent(2, base + 2));
    await anchored;

    expect(submitted).toHaveLength(1);

    // The submitted root must equal the real Merkle root over the event hashes,
    // computed independently here — proving the whole chain ran for real.
    const { createHash } = await import('crypto');
    const hashes = [0, 1, 2].map(i => {
      const e = scadaEvent(i, base + i);
      const canonical = JSON.stringify({ id: e.id, timestamp: e.timestamp, type: e.type, source: e.source, data: e.data });
      return createHash('sha256').update(canonical, 'utf8').digest('hex');
    });
    const expectedRoot = '0x' + MerkleTreeBuilder.buildFromEventHashes(hashes).root;
    expect(submitted[0].root).toBe(expectedRoot);
    expect(submitted[0].eventCount).toBe(3);
    expect(pipeline.getStats().relayer.successfulSubmissions).toBe(1);
  });

  it('a tampered signature never reaches the chain (verifier is the pipeline signer)', async () => {
    // Monkeypatch the signer to return a signature for a DIFFERENT root, so the
    // relayer's verification (against the same signer's key) fails.
    const { contract, provider, submitted } = mockChain();
    const pipeline = new AnchorPipeline({
      pipeline: { maxBatchSize: 1 },
      relayer: { maxRetries: 1 }, // a bad signature won't fix itself — fail fast
      relayerDeps: { contract, provider },
    });
    pipelines.push(pipeline);
    await pipeline.start();

    const origSign = pipeline.signer.signMerkleRoot.bind(pipeline.signer);
    pipeline.signer.signMerkleRoot = async (root: string) => {
      const sig = await origSign(root);
      return { ...sig, signature: sig.signature.replace(/^../, 'ff') }; // corrupt
    };

    const failed = new Promise<void>(resolve => pipeline.relayer.once('anchorFailed', () => resolve()));
    await pipeline.ingestEvent(scadaEvent(0, 1_700_000_000_000));
    await failed;

    expect(submitted).toHaveLength(0);
    expect(pipeline.getStats().relayer.successfulSubmissions).toBe(0);
  });
});
