/**
 * First tests for AnchorRelayerService (#489). The relayer previously could not
 * even be constructed (ethers.Wallet('') throws) so it had no coverage. These
 * exercise the real HSM-signature verification and the submit/queue path
 * against an injected mock chain.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnchorRelayerService, type AnchorContractLike, type SignatureVerifier } from '../relayer';
import { MerkleRootSigner, type SignatureResult } from '../hsm';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function mockChain(record?: { anchorArgs?: any[] }) {
  const contract: AnchorContractLike = {
    anchor: Object.assign(
      async (root: string, batchId: number, eventCount: number) => {
        if (record) record.anchorArgs = [root, batchId, eventCount];
        return { wait: async () => ({ hash: '0xdeadbeef', blockNumber: 10, gasUsed: 21000n }) };
      },
      { estimateGas: async () => 100000n },
    ),
  };
  const provider = {
    getFeeData: async () => ({ gasPrice: 1_000_000_000n }), // 1 gwei
    getBlockNumber: async () => 12, // blockNumber 10 + 2 confirmations satisfied
  } as any;
  return { contract, provider };
}

/** Resolve when the relayer finishes a submission (success or terminal fail). */
function awaitOutcome(relayer: AnchorRelayerService): Promise<'success' | 'failed'> {
  return new Promise(resolve => {
    relayer.once('anchorSuccess', () => resolve('success'));
    relayer.once('anchorFailed', () => resolve('failed'));
  });
}

const relayers: AnchorRelayerService[] = [];
function makeRelayer(opts: { record?: { anchorArgs?: any[] } }, verifier?: SignatureVerifier) {
  const { contract, provider } = mockChain(opts.record);
  const r = new AnchorRelayerService(
    { maxRetries: 1, confirmationBlocks: 2, batchWindowMs: 999999 },
    { contract, provider, signatureVerifier: verifier },
  );
  relayers.push(r);
  return r;
}

afterEach(async () => {
  while (relayers.length) await relayers.pop()!.shutdown();
  vi.restoreAllMocks();
});

describe('AnchorRelayerService signature verification (#489)', () => {
  let signer: MerkleRootSigner;
  let keyDir: string;

  async function sign(root: string): Promise<SignatureResult> {
    if (!signer) {
      keyDir = mkdtempSync(join(tmpdir(), 'relayer-hsm-'));
      signer = new MerkleRootSigner({ mode: 'software', algorithm: 'RS256', keyPath: keyDir });
      await signer.initialize();
    }
    return signer.signMerkleRoot(root);
  }

  afterEach(() => {
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    signer = undefined as any;
  });

  it('anchors a validly-signed root (real signature verified against the HSM key)', async () => {
    const record: { anchorArgs?: any[] } = {};
    const r = makeRelayer({ record }, signerVerifier(() => signer));
    const root = '0x' + 'ab'.repeat(32);
    const sig = await sign(root);

    const outcome = awaitOutcome(r);
    await r.submitAnchor(root, 1, 5, sig, 'urgent');
    expect(await outcome).toBe('success');
    expect(record.anchorArgs).toEqual([root, 1, 5]);
    expect(r.getStats().successfulSubmissions).toBe(1);
  });

  it('rejects a cryptographically-invalid signature (tampered signature bytes)', async () => {
    const r = makeRelayer({}, signerVerifier(() => signer));
    const root = '0x' + 'cd'.repeat(32);
    const sig = await sign(root);
    const tampered: SignatureResult = { ...sig, signature: sig.signature.replace(/^../, 'ff') };

    const outcome = awaitOutcome(r);
    await r.submitAnchor(root, 2, 3, tampered, 'urgent');
    expect(await outcome).toBe('failed');
    expect(r.getStats().successfulSubmissions).toBe(0);
  });

  it('rejects a signature bound to a DIFFERENT root (structural check, before crypto)', async () => {
    const r = makeRelayer({}, signerVerifier(() => signer));
    const sig = await sign('0x' + '11'.repeat(32));
    const outcome = awaitOutcome(r);
    // Submit a different root than the one the signature commits to.
    await r.submitAnchor('0x' + '22'.repeat(32), 3, 1, sig, 'urgent');
    expect(await outcome).toBe('failed');
  });

  it('does NOT retry a permanent signature failure even with retries available', async () => {
    const { contract, provider } = mockChain();
    const r = new AnchorRelayerService(
      { maxRetries: 5, baseDelayMs: 10, confirmationBlocks: 2, batchWindowMs: 999999 },
      { contract, provider, signatureVerifier: signerVerifier(() => signer) },
    );
    relayers.push(r);
    const root = '0x' + '44'.repeat(32);
    const sig = await sign(root);
    const tampered: SignatureResult = { ...sig, signature: sig.signature.replace(/^../, 'ff') };

    const outcome = awaitOutcome(r);
    await r.submitAnchor(root, 5, 1, tampered, 'urgent');
    expect(await outcome).toBe('failed');
    // Exactly one failed submission — no retry loop despite maxRetries=5.
    expect(r.getStats().failedSubmissions).toBe(1);
  });

  it('fails closed when the verifier itself throws', async () => {
    const throwingVerifier: SignatureVerifier = { verifyMerkleRootSignature: async () => { throw new Error('hsm down'); } };
    const r = makeRelayer({}, throwingVerifier);
    const root = '0x' + '33'.repeat(32);
    const sig = await sign(root);
    const outcome = awaitOutcome(r);
    await r.submitAnchor(root, 4, 1, sig, 'urgent');
    expect(await outcome).toBe('failed');
  });
});

describe('AnchorRelayerService construction (#489)', () => {
  it('constructs without a private key (lazy connection) — previously impossible', () => {
    expect(() => new AnchorRelayerService({ privateKey: '', contractAddress: '' })).not.toThrow();
  });
});

describe('AnchorRelayerService fail-closed default (#489)', () => {
  it('with NO verifier configured, refuses to anchor (fail closed)', async () => {
    const { contract, provider } = mockChain();
    const r = new AnchorRelayerService(
      { maxRetries: 1, confirmationBlocks: 2, batchWindowMs: 999999 },
      { contract, provider }, // no signatureVerifier, no allowUnverified
    );
    relayers.push(r);
    const outcome = awaitOutcome(r);
    // A well-formed-but-unverified signature must NOT be anchored.
    await r.submitAnchor('0x' + 'aa'.repeat(32), 1, 1, { signature: 'x', merkleRoot: '0x' + 'aa'.repeat(32), timestamp: 1, algorithm: 'RS256', keyId: 'k' } as SignatureResult, 'urgent');
    expect(await outcome).toBe('failed');
  });

  it('allowUnverified:true permits the structural-check-only path', async () => {
    const record: { anchorArgs?: any[] } = {};
    const { contract, provider } = mockChain(record);
    const r = new AnchorRelayerService(
      { maxRetries: 1, confirmationBlocks: 2, batchWindowMs: 999999 },
      { contract, provider, allowUnverified: true },
    );
    relayers.push(r);
    const root = '0x' + 'bb'.repeat(32);
    const outcome = awaitOutcome(r);
    await r.submitAnchor(root, 1, 1, { signature: 'x', merkleRoot: root, timestamp: 1, algorithm: 'RS256', keyId: 'k' } as SignatureResult, 'urgent');
    expect(await outcome).toBe('success');
  });
});

/** Wrap a lazily-resolved MerkleRootSigner as a SignatureVerifier. */
function signerVerifier(get: () => MerkleRootSigner): SignatureVerifier {
  return { verifyMerkleRootSignature: (root, sig) => get().verifyMerkleRootSignature(root, sig) };
}
