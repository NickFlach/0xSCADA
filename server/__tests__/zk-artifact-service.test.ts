import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import {
  ZKArtifactService,
  type ZKArtifactServiceConfig,
  type StoredZKArtifact,
} from '../services/zk-artifact-service';
import {
  ArtifactStorageService,
} from '../services/artifact-storage';
import {
  type OnChainAnchorInterface,
  type AnchorRequest,
  type AnchorResult,
  type ContentHash,
  ZKArtifactType,
} from '@shared/zk-artifact';

// =============================================================================
// MOCK ANCHOR INTERFACE
// =============================================================================

class MockAnchorInterface implements OnChainAnchorInterface {
  public anchored: Map<string, { txHash: string; blockNumber: number }> = new Map();
  public batchCount = 0;
  public shouldFail = false;

  async anchorArtifact(request: AnchorRequest): Promise<AnchorResult> {
    if (this.shouldFail) {
      return { success: false, error: 'Mock failure' };
    }

    const txHash = `0x${createHash('sha256').update(request.contentHash).digest('hex').slice(0, 64)}`;
    const blockNumber = 12345 + this.anchored.size;

    this.anchored.set(request.contentHash, { txHash, blockNumber });

    return {
      success: true,
      txHash,
      blockNumber,
      anchoredAt: new Date(),
    };
  }

  async anchorBatch(
    merkleRoot: string,
    artifactHashes: ContentHash[],
    artifactType: string
  ): Promise<AnchorResult> {
    if (this.shouldFail) {
      return { success: false, error: 'Mock batch failure' };
    }

    this.batchCount++;
    const txHash = `0x${createHash('sha256').update(merkleRoot).digest('hex').slice(0, 64)}`;
    const blockNumber = 12345 + this.batchCount;

    for (const hash of artifactHashes) {
      this.anchored.set(hash, { txHash, blockNumber });
    }

    return {
      success: true,
      txHash,
      blockNumber,
      anchoredAt: new Date(),
    };
  }

  async verifyAnchor(contentHash: ContentHash): Promise<{ anchored: boolean; blockNumber?: number; txHash?: string }> {
    const anchor = this.anchored.get(contentHash);
    if (anchor) {
      return { anchored: true, ...anchor };
    }
    return { anchored: false };
  }

  isEnabled(): boolean {
    return true;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function computeHash(content: string | Buffer): ContentHash {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  return createHash('sha256').update(buffer).digest('hex') as ContentHash;
}

// =============================================================================
// TESTS: ZKArtifactService
// =============================================================================

describe('ZKArtifactService', () => {
  let service: ZKArtifactService;
  let storage: ArtifactStorageService;
  let mockAnchor: MockAnchorInterface;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp storage
    tempDir = `./test-artifacts-${Date.now()}`;
    storage = new ArtifactStorageService({
      lfsDir: tempDir,
      enableIndex: true,
      enableDeduplication: false,
    });
    await storage.initialize();

    // Create mock anchor
    mockAnchor = new MockAnchorInterface();

    // Create service with test config
    service = new ZKArtifactService(
      {
        enableLocalVerification: true,
        enableAnchoring: true,
        anchorBatchSize: 3,
        anchorBatchMaxAgeMs: 60000,
        anchorInterface: mockAnchor,
      },
      storage
    );
  });

  afterEach(async () => {
    await service.shutdown();
    // Cleanup would happen here in real tests
  });

  // ===========================================================================
  // WITNESS STORAGE TESTS
  // ===========================================================================

  describe('storeWitness', () => {
    it('should store a ZK witness', async () => {
      const result = await service.storeWitness({
        circuitId: 'test-circuit-v1',
        publicInputs: ['0x123', '0x456'],
        privateInputs: JSON.stringify({ secret: 'value' }),
        blockNumber: 1000,
        blockHash: '0xabc123',
      });

      expect(result).toBeDefined();
      expect(result.zkMetadata.type).toBe('zk-witness');
      expect(result.zkMetadata.witness.circuitId).toBe('test-circuit-v1');
      expect(result.zkMetadata.witness.publicInputs).toEqual(['0x123', '0x456']);
      expect(result.zkMetadata.witness.witnessId).toMatch(/^WIT-/);
      expect(result.anchored).toBe(false);
    });

    it('should compute correct private inputs hash', async () => {
      const privateInputs = JSON.stringify({ secret: 'data', value: 42 });
      const expectedHash = computeHash(privateInputs);

      const result = await service.storeWitness({
        circuitId: 'test-circuit',
        publicInputs: ['0x1'],
        privateInputs,
      });

      expect(result.zkMetadata.witness.privateInputsHash).toBe(expectedHash);
    });

    it('should store witness with Buffer input', async () => {
      const privateInputsBuffer = Buffer.from('binary witness data');

      const result = await service.storeWitness({
        circuitId: 'test-circuit',
        publicInputs: ['0x1'],
        privateInputs: privateInputsBuffer,
      });

      expect(result.zkMetadata.witness.privateInputsHash).toBe(computeHash(privateInputsBuffer));
    });

    it('should emit witness:stored event', async () => {
      const listener = vi.fn();
      service.on('witness:stored', listener);

      await service.storeWitness({
        circuitId: 'test-circuit',
        publicInputs: [],
        privateInputs: 'data',
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].zkMetadata.type).toBe('zk-witness');
    });
  });

  // ===========================================================================
  // ORACLE SNAPSHOT TESTS
  // ===========================================================================

  describe('storeOracleSnapshot', () => {
    it('should store an oracle snapshot', async () => {
      const result = await service.storeOracleSnapshot({
        source: {
          provider: 'chainlink',
          feedId: 'ETH/USD',
          chainId: 1,
        },
        value: 2500.50,
        oracleTimestamp: new Date().toISOString(),
        blockNumber: 15000000,
        roundId: '18446744073709551900',
      });

      expect(result).toBeDefined();
      expect(result.zkMetadata.type).toBe('oracle-snapshot');
      expect(result.zkMetadata.snapshot.source.provider).toBe('chainlink');
      expect(result.zkMetadata.snapshot.value).toBe(2500.50);
      expect(result.zkMetadata.snapshot.snapshotId).toMatch(/^ORACLE-/);
    });

    it('should store raw response when provided', async () => {
      const rawResponse = JSON.stringify({ answer: 250050000000, updatedAt: Date.now() });

      const result = await service.storeOracleSnapshot({
        source: {
          provider: 'custom',
          feedId: 'TEMP-001',
        },
        value: '25.5',
        oracleTimestamp: new Date().toISOString(),
        rawResponse,
      });

      expect(result.zkMetadata.snapshot.rawResponseHash).toBeDefined();
      expect(result.zkMetadata.snapshot.rawResponseHash).toBe(computeHash(rawResponse));
    });
  });

  // ===========================================================================
  // MERKLE STATE DIFF TESTS
  // ===========================================================================

  describe('storeStateDiff', () => {
    it('should store a Merkle state diff', async () => {
      const changes = [
        { key: '0x1', previousValue: null, newValue: '0xff', changeType: 'create' as const },
        { key: '0x2', previousValue: '0xaa', newValue: '0xbb', changeType: 'update' as const },
      ];

      const result = await service.storeStateDiff({
        previousRoot: '0x' + '0'.repeat(64),
        newRoot: '0x' + 'f'.repeat(64),
        fromBlock: 1000,
        toBlock: 1100,
        changes,
      });

      expect(result).toBeDefined();
      expect(result.zkMetadata.type).toBe('merkle-state-diff');
      expect(result.zkMetadata.diff.changeCount).toBe(2);
      expect(result.zkMetadata.diff.fromBlock).toBe(1000);
      expect(result.zkMetadata.diff.toBlock).toBe(1100);
      expect(result.zkMetadata.diff.diffId).toMatch(/^DIFF-/);
    });

    it('should limit changeSummary to 100 entries', async () => {
      const changes = Array.from({ length: 150 }, (_, i) => ({
        key: `0x${i}`,
        previousValue: null,
        newValue: `0x${i}`,
        changeType: 'create' as const,
      }));

      const result = await service.storeStateDiff({
        previousRoot: '0x' + '0'.repeat(64),
        newRoot: '0x' + 'f'.repeat(64),
        fromBlock: 1000,
        toBlock: 1100,
        changes,
      });

      expect(result.zkMetadata.diff.changeCount).toBe(150);
      expect(result.zkMetadata.diff.changeSummary?.length).toBe(100);
    });
  });

  // ===========================================================================
  // CONTRACT TRACE TESTS
  // ===========================================================================

  describe('storeContractTrace', () => {
    it('should store a contract execution trace', async () => {
      const result = await service.storeContractTrace({
        txHash: '0x' + 'a'.repeat(64),
        blockNumber: 15000000,
        contractAddress: '0x' + 'b'.repeat(40),
        from: '0x' + 'c'.repeat(40),
        functionSelector: '0xa9059cbb',
        functionName: 'transfer',
        value: '0',
        input: '0xa9059cbb000000000000000000000000...',
        output: '0x0000000000000000000000000000000000000000000000000000000000000001',
        gasUsed: 50000,
        status: 'success',
        fullTrace: JSON.stringify({ steps: [] }),
      });

      expect(result).toBeDefined();
      expect(result.zkMetadata.type).toBe('contract-trace');
      expect(result.zkMetadata.trace.functionName).toBe('transfer');
      expect(result.zkMetadata.trace.status).toBe('success');
      expect(result.zkMetadata.trace.traceId).toMatch(/^TRACE-/);
    });

    it('should store trace with revert reason', async () => {
      const result = await service.storeContractTrace({
        txHash: '0x' + 'a'.repeat(64),
        blockNumber: 15000000,
        contractAddress: '0x' + 'b'.repeat(40),
        from: '0x' + 'c'.repeat(40),
        input: '0x',
        gasUsed: 21000,
        status: 'revert',
        revertReason: 'ERC20: transfer amount exceeds balance',
        fullTrace: '{}',
      });

      expect(result.zkMetadata.trace.status).toBe('revert');
      expect(result.zkMetadata.trace.revertReason).toBe('ERC20: transfer amount exceeds balance');
    });

    it('should process internal calls', async () => {
      const result = await service.storeContractTrace({
        txHash: '0x' + 'a'.repeat(64),
        blockNumber: 15000000,
        contractAddress: '0x' + 'b'.repeat(40),
        from: '0x' + 'c'.repeat(40),
        input: '0x',
        gasUsed: 100000,
        status: 'success',
        fullTrace: '{}',
        internalCalls: [
          { type: 'call', to: '0x' + 'd'.repeat(40), value: '1000', gasUsed: 30000, success: true },
          { type: 'delegatecall', to: '0x' + 'e'.repeat(40), gasUsed: 20000, success: true },
        ],
      });

      expect(result.zkMetadata.trace.internalCalls).toHaveLength(2);
      expect(result.zkMetadata.trace.internalCalls?.[0].type).toBe('call');
    });
  });

  // ===========================================================================
  // ZK PROOF TESTS
  // ===========================================================================

  describe('storeProof', () => {
    let witnessHash: ContentHash;

    beforeEach(async () => {
      // First store a witness
      const witnessResult = await service.storeWitness({
        circuitId: 'test-circuit-v1',
        publicInputs: ['0x123', '0x456'],
        privateInputs: 'secret data',
      });
      witnessHash = witnessResult.artifact.id;
    });

    it('should store a ZK proof', async () => {
      const result = await service.storeProof({
        circuitId: 'test-circuit-v1',
        proofSystem: 'groth16',
        witnessId: 'WIT-test',
        witnessHash,
        publicInputs: ['0x123', '0x456'],
        proof: 'proof bytes...',
        verificationKey: 'vk bytes...',
        generationTimeMs: 5000,
      });

      expect(result).toBeDefined();
      expect(result.zkMetadata.type).toBe('zk-proof');
      expect(result.zkMetadata.proof.circuitId).toBe('test-circuit-v1');
      expect(result.zkMetadata.proof.proofSystem).toBe('groth16');
      expect(result.zkMetadata.proof.proofId).toMatch(/^PROOF-/);
    });

    it('should link proof to witness', async () => {
      await service.storeProof({
        circuitId: 'test-circuit-v1',
        proofSystem: 'plonk',
        witnessId: 'WIT-test',
        witnessHash,
        publicInputs: ['0x123', '0x456'],
        proof: 'proof data',
        verificationKey: 'vk data',
      });

      const proofs = await service.getProofsForWitness(witnessHash);
      expect(proofs).toHaveLength(1);
      expect(proofs[0].zkMetadata.proof.witnessHash).toBe(witnessHash);
    });

    it('should store multiple proofs for same witness', async () => {
      await service.storeProof({
        circuitId: 'test-circuit-v1',
        proofSystem: 'groth16',
        witnessId: 'WIT-test',
        witnessHash,
        publicInputs: ['0x123', '0x456'],
        proof: 'proof 1',
        verificationKey: 'vk 1',
      });

      await service.storeProof({
        circuitId: 'test-circuit-v1',
        proofSystem: 'plonk',
        witnessId: 'WIT-test',
        witnessHash,
        publicInputs: ['0x123', '0x456'],
        proof: 'proof 2',
        verificationKey: 'vk 2',
      });

      const proofs = await service.getProofsForWitness(witnessHash);
      expect(proofs).toHaveLength(2);
    });
  });

  // ===========================================================================
  // RETRIEVAL TESTS
  // ===========================================================================

  describe('get', () => {
    it('should retrieve stored artifact by hash', async () => {
      const stored = await service.storeWitness({
        circuitId: 'test-circuit',
        publicInputs: ['0x1'],
        privateInputs: 'data',
      });

      const retrieved = await service.get(stored.artifact.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.artifact.id).toBe(stored.artifact.id);
      expect(retrieved?.zkMetadata.type).toBe('zk-witness');
    });

    it('should return null for non-existent artifact', async () => {
      const result = await service.get('0'.repeat(64) as ContentHash);
      expect(result).toBeNull();
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Store various artifacts
      await service.storeWitness({
        circuitId: 'circuit-a',
        publicInputs: [],
        privateInputs: 'w1',
      });
      await service.storeWitness({
        circuitId: 'circuit-b',
        publicInputs: [],
        privateInputs: 'w2',
      });
      await service.storeOracleSnapshot({
        source: { provider: 'test', feedId: 'feed-1' },
        value: 100,
        oracleTimestamp: new Date().toISOString(),
      });
    });

    it('should filter by type', async () => {
      const witnesses = await service.query({ type: ZKArtifactType.WITNESS });
      expect(witnesses).toHaveLength(2);
      expect(witnesses.every(a => a.zkMetadata.type === 'zk-witness')).toBe(true);
    });

    it('should filter by circuitId', async () => {
      const results = await service.query({ circuitId: 'circuit-a' });
      expect(results).toHaveLength(1);
      expect((results[0].zkMetadata as any).witness.circuitId).toBe('circuit-a');
    });

    it('should apply limit', async () => {
      const results = await service.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('should sort by timestamp descending', async () => {
      const results = await service.query({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].artifact.timestamp >= results[i].artifact.timestamp).toBe(true);
      }
    });
  });

  // ===========================================================================
  // VERIFICATION TESTS
  // ===========================================================================

  describe('verifyProofAgainstWitness', () => {
    let witnessHash: ContentHash;

    beforeEach(async () => {
      const witness = await service.storeWitness({
        circuitId: 'verify-circuit',
        publicInputs: ['0xaaa', '0xbbb'],
        privateInputs: 'secret',
      });
      witnessHash = witness.artifact.id;
    });

    it('should verify valid proof against witness', async () => {
      const proof = await service.storeProof({
        circuitId: 'verify-circuit',
        proofSystem: 'groth16',
        witnessId: 'test',
        witnessHash,
        publicInputs: ['0xaaa', '0xbbb'],
        proof: 'proof data',
        verificationKey: 'vk',
      });

      const result = await service.verifyProofAgainstWitness(proof.artifact.id);

      expect(result.valid).toBe(true);
      expect(result.circuitMatch).toBe(true);
      expect(result.publicInputsMatch).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect circuit mismatch', async () => {
      const proof = await service.storeProof({
        circuitId: 'different-circuit', // Mismatched circuit
        proofSystem: 'groth16',
        witnessId: 'test',
        witnessHash,
        publicInputs: ['0xaaa', '0xbbb'],
        proof: 'proof data',
        verificationKey: 'vk',
      });

      const result = await service.verifyProofAgainstWitness(proof.artifact.id);

      expect(result.valid).toBe(false);
      expect(result.circuitMatch).toBe(false);
      expect(result.errors).toContain(expect.stringContaining('Circuit mismatch'));
    });

    it('should detect public inputs mismatch', async () => {
      const proof = await service.storeProof({
        circuitId: 'verify-circuit',
        proofSystem: 'groth16',
        witnessId: 'test',
        witnessHash,
        publicInputs: ['0xaaa', '0xccc'], // Mismatched inputs
        proof: 'proof data',
        verificationKey: 'vk',
      });

      const result = await service.verifyProofAgainstWitness(proof.artifact.id);

      expect(result.valid).toBe(false);
      expect(result.publicInputsMatch).toBe(false);
    });

    it('should handle missing proof', async () => {
      const result = await service.verifyProofAgainstWitness('0'.repeat(64) as ContentHash);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Proof not found or invalid type');
    });
  });

  describe('verifyWitnessIntegrity', () => {
    it('should verify valid witness integrity', async () => {
      const witness = await service.storeWitness({
        circuitId: 'test-circuit',
        publicInputs: ['0x1'],
        privateInputs: 'data',
      });

      const result = await service.verifyWitnessIntegrity(witness.artifact.id);

      expect(result.valid).toBe(true);
      expect(result.witnessId).toMatch(/^WIT-/);
      expect(result.circuitId).toBe('test-circuit');
    });

    it('should handle missing witness', async () => {
      const result = await service.verifyWitnessIntegrity('0'.repeat(64) as ContentHash);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Witness not found');
    });
  });

  // ===========================================================================
  // ANCHORING TESTS
  // ===========================================================================

  describe('anchoring', () => {
    it('should batch anchor artifacts when batch size reached', async () => {
      // Store 3 witnesses (batch size)
      await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      await service.storeWitness({ circuitId: 'c3', publicInputs: [], privateInputs: 'w3' });

      // Batch should have been triggered
      expect(mockAnchor.batchCount).toBe(1);
      expect(mockAnchor.anchored.size).toBe(3);
    });

    it('should mark artifacts as anchored after batch', async () => {
      const w1 = await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      const w2 = await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      const w3 = await service.storeWitness({ circuitId: 'c3', publicInputs: [], privateInputs: 'w3' });

      // Re-fetch to check anchored status
      const stored1 = await service.get(w1.artifact.id);
      const stored2 = await service.get(w2.artifact.id);
      const stored3 = await service.get(w3.artifact.id);

      expect(stored1?.anchored).toBe(true);
      expect(stored2?.anchored).toBe(true);
      expect(stored3?.anchored).toBe(true);
    });

    it('should emit batch:anchored event', async () => {
      const listener = vi.fn();
      service.on('batch:anchored', listener);

      await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      await service.storeWitness({ circuitId: 'c3', publicInputs: [], privateInputs: 'w3' });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].hashes).toHaveLength(3);
      expect(listener.mock.calls[0][0].txHash).toBeDefined();
    });

    it('should handle anchor failure and re-queue', async () => {
      mockAnchor.shouldFail = true;

      await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      await service.storeWitness({ circuitId: 'c3', publicInputs: [], privateInputs: 'w3' });

      // Should have tried to anchor
      expect(mockAnchor.batchCount).toBe(0); // Failed, so no successful batches

      // Check stats show pending
      const stats = service.getStats();
      expect(stats.pendingAnchorCount).toBe(3);
    });

    it('should manually anchor a single artifact', async () => {
      // Disable batch anchoring for this test
      const manualService = new ZKArtifactService(
        {
          enableAnchoring: false,
          anchorInterface: mockAnchor,
        },
        storage
      );

      const witness = await manualService.storeWitness({
        circuitId: 'manual',
        publicInputs: [],
        privateInputs: 'data',
      });

      const result = await manualService.anchorArtifact(witness.artifact.id);

      expect(result.success).toBe(true);
      expect(result.txHash).toBeDefined();

      await manualService.shutdown();
    });
  });

  // ===========================================================================
  // MERKLE PROOF TESTS
  // ===========================================================================

  describe('Merkle proofs', () => {
    it('should generate valid Merkle proof', () => {
      const hashes = [
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        'd'.repeat(64),
      ] as ContentHash[];

      const proof = service.getMerkleProof(hashes, hashes[1]);

      expect(proof).not.toBeNull();
      expect(proof?.length).toBeGreaterThan(0);
    });

    it('should return null for non-existent hash in batch', () => {
      const hashes = ['a'.repeat(64), 'b'.repeat(64)] as ContentHash[];

      const proof = service.getMerkleProof(hashes, 'c'.repeat(64) as ContentHash);

      expect(proof).toBeNull();
    });

    it('should verify valid Merkle proof', () => {
      const hashes = [
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
        'd'.repeat(64),
      ] as ContentHash[];

      const proof = service.getMerkleProof(hashes, hashes[2])!;
      
      // Need to compute root the same way
      const { keccak256, toUtf8Bytes, getBytes, concat } = require('ethers');
      
      function hashPair(a: string, b: string): string {
        const aN = a.startsWith('0x') ? a : `0x${a}`;
        const bN = b.startsWith('0x') ? b : `0x${b}`;
        const aBytes = getBytes(aN);
        const bBytes = getBytes(bN);
        if (aN.toLowerCase() < bN.toLowerCase()) {
          return keccak256(concat([aBytes, bBytes]));
        }
        return keccak256(concat([bBytes, aBytes]));
      }

      // Build root manually to verify
      const layer1 = [hashPair(`0x${hashes[0]}`, `0x${hashes[1]}`), hashPair(`0x${hashes[2]}`, `0x${hashes[3]}`)];
      const root = hashPair(layer1[0], layer1[1]);

      const isValid = service.verifyMerkleProof(hashes[2], proof, root);
      expect(isValid).toBe(true);
    });
  });

  // ===========================================================================
  // STATISTICS TESTS
  // ===========================================================================

  describe('getStats', () => {
    it('should return accurate statistics', async () => {
      await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      await service.storeOracleSnapshot({
        source: { provider: 'test', feedId: 'f1' },
        value: 100,
        oracleTimestamp: new Date().toISOString(),
      });

      const stats = service.getStats();

      expect(stats.totalArtifacts).toBe(3);
      expect(stats.byType['zk-witness']).toBe(2);
      expect(stats.byType['oracle-snapshot']).toBe(1);
    });

    it('should track anchor status in stats', async () => {
      // Store 3 to trigger anchor
      await service.storeWitness({ circuitId: 'c1', publicInputs: [], privateInputs: 'w1' });
      await service.storeWitness({ circuitId: 'c2', publicInputs: [], privateInputs: 'w2' });
      await service.storeWitness({ circuitId: 'c3', publicInputs: [], privateInputs: 'w3' });

      const stats = service.getStats();

      expect(stats.anchoredCount).toBe(3);
    });
  });

  // ===========================================================================
  // SERVICE CONFIGURATION TESTS
  // ===========================================================================

  describe('configuration', () => {
    it('should respect disabled anchoring', async () => {
      const noAnchorService = new ZKArtifactService(
        { enableAnchoring: false },
        storage
      );

      await noAnchorService.storeWitness({
        circuitId: 'test',
        publicInputs: [],
        privateInputs: 'data',
      });

      expect(noAnchorService.isAnchoringEnabled()).toBe(false);
      expect(noAnchorService.getStats().pendingAnchorCount).toBe(0);

      await noAnchorService.shutdown();
    });

    it('should report anchoring status correctly', () => {
      expect(service.isAnchoringEnabled()).toBe(true);

      const disabledService = new ZKArtifactService(
        { enableAnchoring: false },
        storage
      );
      expect(disabledService.isAnchoringEnabled()).toBe(false);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('ZKArtifactService Integration', () => {
  let service: ZKArtifactService;
  let storage: ArtifactStorageService;
  let mockAnchor: MockAnchorInterface;

  beforeEach(async () => {
    storage = new ArtifactStorageService({
      lfsDir: `./test-integration-${Date.now()}`,
      enableIndex: true,
    });
    await storage.initialize();

    mockAnchor = new MockAnchorInterface();
    service = new ZKArtifactService(
      {
        enableAnchoring: true,
        anchorBatchSize: 100, // High to prevent auto-batching
        anchorInterface: mockAnchor,
      },
      storage
    );
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('should support full proof lifecycle: witness -> proof -> verify', async () => {
    // 1. Store witness
    const witness = await service.storeWitness({
      circuitId: 'transfer-circuit',
      publicInputs: ['0xfrom', '0xto', '0xamount'],
      privateInputs: JSON.stringify({
        fromBalance: 1000,
        signature: 'sig123',
      }),
      blockNumber: 15000000,
    });

    expect(witness.zkMetadata.type).toBe('zk-witness');

    // 2. Store proof
    const proof = await service.storeProof({
      circuitId: 'transfer-circuit',
      proofSystem: 'groth16',
      witnessId: witness.zkMetadata.witness.witnessId,
      witnessHash: witness.artifact.id,
      publicInputs: ['0xfrom', '0xto', '0xamount'],
      proof: 'groth16 proof bytes...',
      verificationKey: 'verification key...',
      generationTimeMs: 3500,
    });

    expect(proof.zkMetadata.type).toBe('zk-proof');
    expect(proof.zkMetadata.proof.witnessHash).toBe(witness.artifact.id);

    // 3. Verify proof against witness
    const verification = await service.verifyProofAgainstWitness(proof.artifact.id);

    expect(verification.valid).toBe(true);
    expect(verification.circuitMatch).toBe(true);
    expect(verification.publicInputsMatch).toBe(true);

    // 4. Query proofs for witness
    const proofs = await service.getProofsForWitness(witness.artifact.id);
    expect(proofs).toHaveLength(1);
    expect(proofs[0].artifact.id).toBe(proof.artifact.id);
  });

  it('should handle oracle-backed proof workflow', async () => {
    // 1. Store oracle data
    const oracle = await service.storeOracleSnapshot({
      source: { provider: 'chainlink', feedId: 'ETH/USD', chainId: 1 },
      value: 2500,
      oracleTimestamp: new Date().toISOString(),
      blockNumber: 15000000,
    });

    // 2. Store witness referencing oracle
    const witness = await service.storeWitness({
      circuitId: 'price-verify-circuit',
      publicInputs: [oracle.artifact.id, '2500'], // Reference oracle
      privateInputs: JSON.stringify({ threshold: 2000 }),
      metadata: { oracleRef: oracle.artifact.id },
    });

    // 3. Verify witness integrity
    const witnessIntegrity = await service.verifyWitnessIntegrity(witness.artifact.id);
    expect(witnessIntegrity.valid).toBe(true);

    // 4. Check artifacts are linked correctly
    const allWitnesses = await service.query({ type: ZKArtifactType.WITNESS });
    const allOracles = await service.query({ type: ZKArtifactType.ORACLE_SNAPSHOT });

    expect(allWitnesses).toHaveLength(1);
    expect(allOracles).toHaveLength(1);
  });
});
