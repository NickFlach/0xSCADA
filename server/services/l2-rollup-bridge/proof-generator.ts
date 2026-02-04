/**
 * L2 Rollup Proof Generator
 *
 * Generates and verifies proofs for L2 rollup:
 * - Fraud proofs (optimistic rollups)
 * - Validity proofs (ZK rollups - stub)
 * - Inclusion proofs
 */

import { keccak256, toUtf8Bytes, concat, getBytes, hexlify } from 'ethers';
import {
  FraudProof,
  ValidityProof,
  InclusionProof,
  StateCommitment,
  RollupEvent,
  RollupMode,
  RollupError,
  RollupErrorCode,
} from './types';
import { L2StateManager, StateTree } from './state-manager';

// =============================================================================
// FRAUD PROOF GENERATOR (OPTIMISTIC)
// =============================================================================

/**
 * Generates fraud proofs for optimistic rollups
 */
export class FraudProofGenerator {
  private stateManager: L2StateManager;

  constructor(stateManager: L2StateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Generate a fraud proof for an invalid state transition
   */
  generateFraudProof(
    batchIndex: number,
    invalidEventIndex: number,
    challenger: string
  ): FraudProof | null {
    const commitment = this.stateManager.getStateCommitment(batchIndex);
    if (!commitment) {
      return null;
    }

    const events = this.stateManager.getEventsForBatch(batchIndex);
    if (invalidEventIndex >= events.length) {
      return null;
    }

    // Recompute expected state
    const expectedStateRoot = this.recomputeStateRoot(
      batchIndex,
      events.slice(0, invalidEventIndex + 1)
    );

    // Generate Merkle proof for the invalid event
    const proof = this.generateEventProof(batchIndex, invalidEventIndex);

    return {
      batchIndex,
      challenger,
      invalidEventIndex,
      expectedStateRoot,
      actualStateRoot: commitment.stateRoot,
      proof,
      timestamp: Date.now(),
    };
  }

  /**
   * Verify a fraud proof
   */
  verifyFraudProof(fraudProof: FraudProof): {
    valid: boolean;
    reason?: string;
  } {
    const commitment = this.stateManager.getStateCommitment(fraudProof.batchIndex);
    if (!commitment) {
      return { valid: false, reason: 'Batch commitment not found' };
    }

    // Verify the expected and actual roots differ
    if (fraudProof.expectedStateRoot === fraudProof.actualStateRoot) {
      return { valid: false, reason: 'State roots match - no fraud detected' };
    }

    // Get events and recompute
    const events = this.stateManager.getEventsForBatch(fraudProof.batchIndex);
    const recomputed = this.recomputeStateRoot(
      fraudProof.batchIndex,
      events.slice(0, fraudProof.invalidEventIndex + 1)
    );

    // The recomputed root should match the expected root
    if (recomputed.toLowerCase() !== fraudProof.expectedStateRoot.toLowerCase()) {
      return { valid: false, reason: 'Recomputed state root does not match expected' };
    }

    // The actual root should differ (proving fraud)
    if (recomputed.toLowerCase() === fraudProof.actualStateRoot.toLowerCase()) {
      return { valid: false, reason: 'No state mismatch found' };
    }

    return { valid: true };
  }

  /**
   * Recompute state root from events
   */
  private recomputeStateRoot(batchIndex: number, events: RollupEvent[]): string {
    const tree = new StateTree();
    for (const event of events) {
      tree.set(`event:${event.id}`, event.hash);
    }
    return tree.getRoot();
  }

  /**
   * Generate Merkle proof for an event at index
   */
  private generateEventProof(batchIndex: number, eventIndex: number): string[] {
    const events = this.stateManager.getEventsForBatch(batchIndex);
    if (eventIndex >= events.length) {
      return [];
    }

    const hashes = events.map(e => e.hash);
    return this.buildMerkleProof(hashes, eventIndex);
  }

  /**
   * Build Merkle proof for an element at index
   */
  private buildMerkleProof(hashes: string[], index: number): string[] {
    if (hashes.length <= 1) {
      return [];
    }

    const proof: string[] = [];
    let currentLevel = hashes.map(h => h.startsWith('0x') ? h : `0x${h}`);
    let currentIndex = index;

    while (currentLevel.length > 1) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < currentLevel.length) {
        proof.push(currentLevel[siblingIndex]);
      }

      // Build next level
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        const combined = this.hashPair(left, right);
        nextLevel.push(combined);
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Hash two values together (sorted)
   */
  private hashPair(a: string, b: string): string {
    const aBytes = getBytes(a);
    const bBytes = getBytes(b);
    if (a.toLowerCase() < b.toLowerCase()) {
      return keccak256(concat([aBytes, bBytes]));
    }
    return keccak256(concat([bBytes, aBytes]));
  }
}

// =============================================================================
// VALIDITY PROOF GENERATOR (ZK)
// =============================================================================

/**
 * Generates validity proofs for ZK rollups
 * Note: This is a stub implementation. Real ZK proofs require
 * a proper circuit and prover setup (e.g., snarkjs, circom).
 */
export class ValidityProofGenerator {
  private proverEndpoint?: string;

  constructor(proverEndpoint?: string) {
    this.proverEndpoint = proverEndpoint;
  }

  /**
   * Generate a validity proof for a batch
   * This is a placeholder - real implementation would:
   * 1. Serialize batch data to circuit inputs
   * 2. Call ZK prover (local or remote)
   * 3. Return SNARK/STARK proof
   */
  async generateValidityProof(
    batchIndex: number,
    events: RollupEvent[],
    prevStateRoot: string,
    newStateRoot: string
  ): Promise<ValidityProof> {
    // Stub implementation - generates a mock proof
    const publicInputs = [
      prevStateRoot,
      newStateRoot,
      keccak256(toUtf8Bytes(events.map(e => e.hash).join(''))),
      hexlify(batchIndex),
    ];

    // In a real implementation, this would call the ZK prover
    const proof = await this.generateMockProof(publicInputs);

    return {
      batchIndex,
      proof,
      publicInputs,
      verifier: '0x0000000000000000000000000000000000000000', // Placeholder
    };
  }

  /**
   * Generate a mock proof (for testing)
   */
  private async generateMockProof(publicInputs: string[]): Promise<string> {
    // Simulate proof generation time
    await new Promise(resolve => setTimeout(resolve, 100));

    // Generate deterministic mock proof from inputs
    const inputHash = keccak256(toUtf8Bytes(publicInputs.join(':')));
    return `0xMOCK_ZK_PROOF_${inputHash.slice(2, 34)}`;
  }

  /**
   * Verify a validity proof (stub)
   */
  verifyValidityProof(proof: ValidityProof): {
    valid: boolean;
    reason?: string;
  } {
    // In real implementation, this would verify the ZK proof
    // using the verifier contract or local verification

    if (!proof.proof.startsWith('0xMOCK_ZK_PROOF_')) {
      return { valid: false, reason: 'Invalid proof format' };
    }

    if (proof.publicInputs.length < 4) {
      return { valid: false, reason: 'Missing public inputs' };
    }

    return { valid: true };
  }
}

// =============================================================================
// INCLUSION PROOF GENERATOR
// =============================================================================

/**
 * Generates inclusion proofs for events
 */
export class InclusionProofGenerator {
  private stateManager: L2StateManager;

  constructor(stateManager: L2StateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Generate an inclusion proof for an event
   */
  generateInclusionProof(
    eventId: string,
    batchId: string
  ): InclusionProof | null {
    const batch = this.stateManager.getBatch(batchId);
    if (!batch) {
      return null;
    }

    const eventIndex = batch.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) {
      return null;
    }

    const event = batch.events[eventIndex];
    const eventHashes = batch.events.map(e => e.hash);
    const proof = this.buildMerkleProof(eventHashes, eventIndex);

    return {
      eventHash: event.hash,
      batchId,
      stateRoot: batch.stateCommitment.stateRoot,
      proof,
      index: eventIndex,
    };
  }

  /**
   * Verify an inclusion proof
   */
  verifyInclusionProof(inclusionProof: InclusionProof): boolean {
    // Validate proof structure
    if (!inclusionProof.eventHash || !inclusionProof.batchId || !inclusionProof.stateRoot) {
      return false;
    }
    if (inclusionProof.index < 0 || !Array.isArray(inclusionProof.proof)) {
      return false;
    }

    let hash = inclusionProof.eventHash;
    let index = inclusionProof.index;

    // Traverse up the Merkle tree using the proof
    for (const sibling of inclusionProof.proof) {
      if (!sibling || typeof sibling !== 'string') {
        return false;
      }
      const isRight = index % 2 === 1;
      if (isRight) {
        hash = this.hashPair(sibling, hash);
      } else {
        hash = this.hashPair(hash, sibling);
      }
      index = Math.floor(index / 2);
    }

    // Verify the computed Merkle root matches the batch's event root
    // The events Merkle root should be derivable from the state root
    const batch = this.stateManager.getBatch(inclusionProof.batchId);
    if (!batch) {
      return false;
    }

    // Recompute the expected event Merkle root from batch events
    const eventHashes = batch.events.map(e => e.hash);
    const expectedRoot = this.computeMerkleRoot(eventHashes);

    // The computed hash should match the expected Merkle root
    return hash.toLowerCase() === expectedRoot.toLowerCase();
  }

  /**
   * Compute Merkle root from an array of hashes
   */
  private computeMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) {
      return keccak256(toUtf8Bytes('EMPTY_TREE'));
    }
    if (hashes.length === 1) {
      return hashes[0].startsWith('0x') ? hashes[0] : `0x${hashes[0]}`;
    }

    let currentLevel = hashes.map(h => h.startsWith('0x') ? h : `0x${h}`);

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        nextLevel.push(this.hashPair(left, right));
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  /**
   * Build Merkle proof for an element at index
   */
  private buildMerkleProof(hashes: string[], index: number): string[] {
    if (hashes.length <= 1) {
      return [];
    }

    const proof: string[] = [];
    let currentLevel = [...hashes];
    let currentIndex = index;

    while (currentLevel.length > 1) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < currentLevel.length) {
        proof.push(currentLevel[siblingIndex]);
      }

      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        nextLevel.push(this.hashPair(left, right));
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Hash two values together (sorted)
   */
  private hashPair(a: string, b: string): string {
    const aClean = a.startsWith('0x') ? a : `0x${a}`;
    const bClean = b.startsWith('0x') ? b : `0x${b}`;
    const aBytes = getBytes(aClean);
    const bBytes = getBytes(bClean);
    if (aClean.toLowerCase() < bClean.toLowerCase()) {
      return keccak256(concat([aBytes, bBytes]));
    }
    return keccak256(concat([bBytes, aBytes]));
  }
}

// =============================================================================
// UNIFIED PROOF SERVICE
// =============================================================================

/**
 * Unified proof service that handles both optimistic and ZK proofs
 */
export class ProofService {
  private mode: RollupMode;
  private fraudProofGenerator: FraudProofGenerator;
  private validityProofGenerator: ValidityProofGenerator;
  private inclusionProofGenerator: InclusionProofGenerator;

  constructor(
    stateManager: L2StateManager,
    mode: RollupMode,
    proverEndpoint?: string
  ) {
    this.mode = mode;
    this.fraudProofGenerator = new FraudProofGenerator(stateManager);
    this.validityProofGenerator = new ValidityProofGenerator(proverEndpoint);
    this.inclusionProofGenerator = new InclusionProofGenerator(stateManager);
  }

  /**
   * Get the rollup mode
   */
  getMode(): RollupMode {
    return this.mode;
  }

  /**
   * Generate batch proof based on mode
   */
  async generateBatchProof(
    batchIndex: number,
    events: RollupEvent[],
    prevStateRoot: string,
    newStateRoot: string
  ): Promise<FraudProof | ValidityProof | null> {
    if (this.mode === 'ZK') {
      return this.validityProofGenerator.generateValidityProof(
        batchIndex,
        events,
        prevStateRoot,
        newStateRoot
      );
    }

    // Optimistic mode doesn't generate proofs upfront
    // Fraud proofs are only generated when challenging
    return null;
  }

  /**
   * Generate a fraud proof (optimistic mode only)
   */
  generateFraudProof(
    batchIndex: number,
    invalidEventIndex: number,
    challenger: string
  ): FraudProof | null {
    if (this.mode !== 'OPTIMISTIC') {
      throw new RollupError(
        RollupErrorCode.CONFIG_ERROR,
        'Fraud proofs only available in optimistic mode'
      );
    }
    return this.fraudProofGenerator.generateFraudProof(
      batchIndex,
      invalidEventIndex,
      challenger
    );
  }

  /**
   * Verify a fraud proof
   */
  verifyFraudProof(proof: FraudProof): { valid: boolean; reason?: string } {
    return this.fraudProofGenerator.verifyFraudProof(proof);
  }

  /**
   * Verify a validity proof
   */
  verifyValidityProof(proof: ValidityProof): { valid: boolean; reason?: string } {
    return this.validityProofGenerator.verifyValidityProof(proof);
  }

  /**
   * Generate an inclusion proof for an event
   */
  generateInclusionProof(eventId: string, batchId: string): InclusionProof | null {
    return this.inclusionProofGenerator.generateInclusionProof(eventId, batchId);
  }

  /**
   * Verify an inclusion proof
   */
  verifyInclusionProof(proof: InclusionProof): boolean {
    return this.inclusionProofGenerator.verifyInclusionProof(proof);
  }
}
