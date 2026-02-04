/**
 * L2 Rollup State Manager
 *
 * Manages L2 state including:
 * - State root computation
 * - State transitions
 * - State commitment generation
 * - State history tracking
 */

import { keccak256, toUtf8Bytes, concat, getBytes } from 'ethers';
import {
  StateCommitment,
  RollupEvent,
  RollupBatch,
  BatchStatus,
  RollupError,
  RollupErrorCode,
} from './types';

// =============================================================================
// STATE TREE
// =============================================================================

/**
 * Sparse Merkle Tree for L2 state
 */
export class StateTree {
  private leaves: Map<string, string> = new Map();
  private root: string;

  constructor() {
    this.root = this.computeEmptyRoot();
  }

  private computeEmptyRoot(): string {
    return keccak256(toUtf8Bytes('0xSCADA_L2_EMPTY_STATE'));
  }

  /**
   * Hash a leaf node
   */
  private hashLeaf(key: string, value: string): string {
    return keccak256(concat([toUtf8Bytes(key), toUtf8Bytes(value)]));
  }

  /**
   * Hash two nodes together (sorted for consistency)
   */
  private hashPair(a: string, b: string): string {
    const aBytes = getBytes(a);
    const bBytes = getBytes(b);
    if (a.toLowerCase() < b.toLowerCase()) {
      return keccak256(concat([aBytes, bBytes]));
    }
    return keccak256(concat([bBytes, aBytes]));
  }

  /**
   * Insert or update a key-value pair
   */
  set(key: string, value: string): void {
    const leafHash = this.hashLeaf(key, value);
    this.leaves.set(key, leafHash);
    this.root = this.computeRoot();
  }

  /**
   * Get the current state root
   */
  getRoot(): string {
    return this.root;
  }

  /**
   * Compute the root from all leaves
   */
  private computeRoot(): string {
    if (this.leaves.size === 0) {
      return this.computeEmptyRoot();
    }

    const hashes = Array.from(this.leaves.values()).sort();

    // Build tree bottom-up
    let currentLevel = hashes;
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
   * Get a Merkle proof for a key
   */
  getProof(key: string): string[] {
    const sortedKeys = Array.from(this.leaves.keys()).sort();
    const index = sortedKeys.indexOf(key);
    if (index === -1) {
      return [];
    }

    const sortedHashes = sortedKeys.map(k => this.leaves.get(k)!);
    const proof: string[] = [];

    let currentLevel = sortedHashes;
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
   * Verify a Merkle proof
   */
  static verifyProof(
    key: string,
    value: string,
    proof: string[],
    root: string
  ): boolean {
    let hash = keccak256(concat([toUtf8Bytes(key), toUtf8Bytes(value)]));

    for (const sibling of proof) {
      const aBytes = getBytes(hash);
      const bBytes = getBytes(sibling);
      if (hash.toLowerCase() < sibling.toLowerCase()) {
        hash = keccak256(concat([aBytes, bBytes]));
      } else {
        hash = keccak256(concat([bBytes, aBytes]));
      }
    }

    return hash.toLowerCase() === root.toLowerCase();
  }

  /**
   * Get total leaf count
   */
  getLeafCount(): number {
    return this.leaves.size;
  }

  /**
   * Clear the tree
   */
  clear(): void {
    this.leaves.clear();
    this.root = this.computeEmptyRoot();
  }

  /**
   * Clone the tree
   */
  clone(): StateTree {
    const newTree = new StateTree();
    this.leaves.forEach((value, key) => {
      newTree.leaves.set(key, value);
    });
    newTree.root = this.root;
    return newTree;
  }
}

// =============================================================================
// STATE MANAGER
// =============================================================================

/**
 * Manages L2 state transitions and commitments
 */
export class L2StateManager {
  private stateTree: StateTree;
  private batchIndex: number = 0;
  private stateHistory: Map<number, StateCommitment> = new Map();
  private eventsByBatch: Map<number, RollupEvent[]> = new Map();
  private batches: Map<string, RollupBatch> = new Map();

  constructor() {
    this.stateTree = new StateTree();
  }

  /**
   * Get current state root
   */
  getCurrentStateRoot(): string {
    return this.stateTree.getRoot();
  }

  /**
   * Get current batch index
   */
  getCurrentBatchIndex(): number {
    return this.batchIndex;
  }

  /**
   * Apply an event to the state
   */
  applyEvent(event: RollupEvent): void {
    // Store event hash in state tree
    const key = `event:${event.id}`;
    const value = event.hash;
    this.stateTree.set(key, value);

    // Track event in current batch
    const currentEvents = this.eventsByBatch.get(this.batchIndex) || [];
    currentEvents.push(event);
    this.eventsByBatch.set(this.batchIndex, currentEvents);
  }

  /**
   * Create a state commitment for the current batch
   */
  createStateCommitment(events: RollupEvent[]): StateCommitment {
    const prevStateRoot = this.batchIndex > 0
      ? this.stateHistory.get(this.batchIndex - 1)?.stateRoot || this.getGenesisRoot()
      : this.getGenesisRoot();

    // Apply all events to state
    events.forEach(event => this.applyEvent(event));

    const stateRoot = this.stateTree.getRoot();
    const timestamp = Date.now();

    // Compute data hash from event hashes
    const eventHashes = events.map(e => e.hash).join('');
    const dataHash = keccak256(toUtf8Bytes(eventHashes || 'empty'));

    const commitment: StateCommitment = {
      stateRoot,
      batchIndex: this.batchIndex,
      timestamp,
      eventCount: events.length,
      prevStateRoot,
      dataHash,
    };

    this.stateHistory.set(this.batchIndex, commitment);
    this.batchIndex++;

    return commitment;
  }

  /**
   * Get genesis state root
   */
  private getGenesisRoot(): string {
    return keccak256(toUtf8Bytes('0xSCADA_L2_GENESIS'));
  }

  /**
   * Validate a state transition
   */
  validateStateTransition(
    prevRoot: string,
    newRoot: string,
    events: RollupEvent[]
  ): boolean {
    // Clone current state and reset to previous
    const testTree = new StateTree();

    // Replay events
    for (const event of events) {
      const key = `event:${event.id}`;
      testTree.set(key, event.hash);
    }

    // Check if resulting root matches
    return testTree.getRoot().toLowerCase() === newRoot.toLowerCase();
  }

  /**
   * Get state commitment by batch index
   */
  getStateCommitment(batchIndex: number): StateCommitment | undefined {
    return this.stateHistory.get(batchIndex);
  }

  /**
   * Get all state commitments
   */
  getAllStateCommitments(): StateCommitment[] {
    return Array.from(this.stateHistory.values());
  }

  /**
   * Get events for a batch
   */
  getEventsForBatch(batchIndex: number): RollupEvent[] {
    return this.eventsByBatch.get(batchIndex) || [];
  }

  /**
   * Generate inclusion proof for an event
   */
  getEventInclusionProof(eventId: string): {
    proof: string[];
    root: string;
    found: boolean;
  } {
    const key = `event:${eventId}`;
    const proof = this.stateTree.getProof(key);
    return {
      proof,
      root: this.stateTree.getRoot(),
      found: proof.length > 0,
    };
  }

  /**
   * Create a new batch
   */
  createBatch(events: RollupEvent[]): RollupBatch {
    const commitment = this.createStateCommitment(events);
    const batchId = this.generateBatchId(commitment);

    const batch: RollupBatch = {
      batchId,
      events,
      stateCommitment: commitment,
      status: 'COMMITTED',
      createdAt: new Date(),
    };

    this.batches.set(batchId, batch);
    return batch;
  }

  /**
   * Generate unique batch ID
   */
  private generateBatchId(commitment: StateCommitment): string {
    const data = `${commitment.stateRoot}:${commitment.batchIndex}:${commitment.timestamp}`;
    return keccak256(toUtf8Bytes(data)).slice(2, 18);
  }

  /**
   * Get batch by ID
   */
  getBatch(batchId: string): RollupBatch | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Update batch status
   */
  updateBatchStatus(batchId: string, status: BatchStatus, details?: {
    l1TxHash?: string;
    l1BlockNumber?: number;
    submittedAt?: Date;
    finalizedAt?: Date;
  }): void {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new RollupError(
        RollupErrorCode.BATCH_NOT_FOUND,
        `Batch ${batchId} not found`
      );
    }

    batch.status = status;
    if (details) {
      if (details.l1TxHash) batch.l1TxHash = details.l1TxHash;
      if (details.l1BlockNumber) batch.l1BlockNumber = details.l1BlockNumber;
      if (details.submittedAt) batch.submittedAt = details.submittedAt;
      if (details.finalizedAt) batch.finalizedAt = details.finalizedAt;
    }

    this.batches.set(batchId, batch);
  }

  /**
   * Get all batches
   */
  getAllBatches(): RollupBatch[] {
    return Array.from(this.batches.values());
  }

  /**
   * Get batches by status
   */
  getBatchesByStatus(status: BatchStatus): RollupBatch[] {
    return Array.from(this.batches.values()).filter(b => b.status === status);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalBatches: number;
    totalEvents: number;
    currentStateRoot: string;
    currentBatchIndex: number;
    batchesByStatus: Record<BatchStatus, number>;
  } {
    const batchesByStatus: Record<BatchStatus, number> = {
      PENDING: 0,
      COMMITTED: 0,
      SUBMITTED: 0,
      CHALLENGED: 0,
      FINALIZED: 0,
      REJECTED: 0,
    };

    let totalEvents = 0;
    for (const batch of this.batches.values()) {
      batchesByStatus[batch.status]++;
      totalEvents += batch.events.length;
    }

    return {
      totalBatches: this.batches.size,
      totalEvents,
      currentStateRoot: this.getCurrentStateRoot(),
      currentBatchIndex: this.batchIndex,
      batchesByStatus,
    };
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.stateTree = new StateTree();
    this.batchIndex = 0;
    this.stateHistory.clear();
    this.eventsByBatch.clear();
    this.batches.clear();
  }
}
