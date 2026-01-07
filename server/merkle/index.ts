/**
 * 0xSCADA Merkle Batching System
 * 
 * PRD Section 6.2 & 7.2:
 * - Event batching + Merkle root creation
 * - Ethereum L1 anchoring
 * - Store-and-forward buffering
 */

import { 
  buildMerkleTree, 
  getMerkleProof, 
  sha256,
  type MerkleTree 
} from "../crypto";

// =============================================================================
// BATCH CONFIGURATION
// =============================================================================

export interface BatchConfig {
  // Maximum events per batch
  maxBatchSize: number;
  // Maximum time to wait before creating a batch (ms)
  maxBatchAge: number;
  // Minimum events to create a batch
  minBatchSize: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxBatchSize: 100,
  maxBatchAge: 60000, // 1 minute
  minBatchSize: 1,
};

// =============================================================================
// EVENT ACCUMULATOR
// =============================================================================

export interface PendingEvent {
  id: string;
  hash: string;
  receivedAt: Date;
}

export interface BatchResult {
  batchId: string;
  merkleRoot: string;
  eventCount: number;
  eventIds: string[];
  eventHashes: string[];
  merkleTree: MerkleTree;
  createdAt: Date;
}

/**
 * Event Accumulator
 * Collects events and creates batches for anchoring
 */
export class EventAccumulator {
  private pendingEvents: PendingEvent[] = [];
  private config: BatchConfig;
  private batchTimer: NodeJS.Timeout | null = null;
  private onBatchReady: ((batch: BatchResult) => void) | null = null;

  constructor(config: Partial<BatchConfig> = {}) {
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
  }

  /**
   * Set callback for when a batch is ready
   */
  setOnBatchReady(callback: (batch: BatchResult) => void): void {
    this.onBatchReady = callback;
  }

  /**
   * Add an event to the accumulator
   */
  addEvent(id: string, hash: string): void {
    this.pendingEvents.push({
      id,
      hash,
      receivedAt: new Date(),
    });

    // Check if we should create a batch immediately
    if (this.pendingEvents.length >= this.config.maxBatchSize) {
      this.createBatch();
    } else if (!this.batchTimer) {
      // Start timer for max age
      this.batchTimer = setTimeout(() => {
        this.createBatch();
      }, this.config.maxBatchAge);
    }
  }

  /**
   * Force creation of a batch with current events
   */
  createBatch(): BatchResult | null {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.pendingEvents.length < this.config.minBatchSize) {
      return null;
    }

    const events = [...this.pendingEvents];
    this.pendingEvents = [];

    const eventIds = events.map(e => e.id);
    const eventHashes = events.map(e => e.hash);
    const merkleTree = buildMerkleTree(eventHashes);

    const batch: BatchResult = {
      batchId: sha256(merkleTree.root + Date.now().toString()),
      merkleRoot: merkleTree.root,
      eventCount: events.length,
      eventIds,
      eventHashes,
      merkleTree,
      createdAt: new Date(),
    };

    if (this.onBatchReady) {
      this.onBatchReady(batch);
    }

    return batch;
  }

  /**
   * Get pending event count
   */
  getPendingCount(): number {
    return this.pendingEvents.length;
  }

  /**
   * Flush all pending events (for shutdown)
   */
  flush(): BatchResult | null {
    return this.createBatch();
  }

  /**
   * Clear all pending events without creating a batch
   */
  clear(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pendingEvents = [];
  }
}

// =============================================================================
// BATCH MANAGER
// =============================================================================

export interface StoredBatch extends BatchResult {
  status: "PENDING" | "ANCHORING" | "ANCHORED" | "FAILED";
  txHash?: string;
  blockNumber?: number;
  anchoredAt?: Date;
  error?: string;
  retryCount: number;
}

/**
 * Batch Manager
 * Manages batch lifecycle and anchoring
 */
export class BatchManager {
  private batches: Map<string, StoredBatch> = new Map();
  private accumulator: EventAccumulator;
  private anchorCallback: ((batch: StoredBatch) => Promise<{ txHash: string; blockNumber: number } | null>) | null = null;

  constructor(config: Partial<BatchConfig> = {}) {
    this.accumulator = new EventAccumulator(config);
    this.accumulator.setOnBatchReady(this.handleBatchReady.bind(this));
  }

  /**
   * Set the anchoring callback
   */
  setAnchorCallback(
    callback: (batch: StoredBatch) => Promise<{ txHash: string; blockNumber: number } | null>
  ): void {
    this.anchorCallback = callback;
  }

  /**
   * Add an event to be batched
   */
  addEvent(id: string, hash: string): void {
    this.accumulator.addEvent(id, hash);
  }

  /**
   * Handle a batch that's ready for anchoring
   */
  private async handleBatchReady(batch: BatchResult): Promise<void> {
    const storedBatch: StoredBatch = {
      ...batch,
      status: "PENDING",
      retryCount: 0,
    };

    this.batches.set(batch.batchId, storedBatch);
    await this.anchorBatch(batch.batchId);
  }

  /**
   * Anchor a batch to the blockchain
   */
  async anchorBatch(batchId: string): Promise<boolean> {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return false;
    }

    if (!this.anchorCallback) {
      console.warn("No anchor callback set, batch will remain pending");
      return false;
    }

    batch.status = "ANCHORING";
    this.batches.set(batchId, batch);

    try {
      const result = await this.anchorCallback(batch);
      
      if (result) {
        batch.status = "ANCHORED";
        batch.txHash = result.txHash;
        batch.blockNumber = result.blockNumber;
        batch.anchoredAt = new Date();
        this.batches.set(batchId, batch);
        console.log(`✅ Batch ${batchId} anchored: ${result.txHash}`);
        return true;
      } else {
        batch.status = "FAILED";
        batch.error = "Anchoring returned null";
        batch.retryCount++;
        this.batches.set(batchId, batch);
        return false;
      }
    } catch (error) {
      batch.status = "FAILED";
      batch.error = error instanceof Error ? error.message : "Unknown error";
      batch.retryCount++;
      this.batches.set(batchId, batch);
      console.error(`❌ Batch ${batchId} anchoring failed:`, error);
      return false;
    }
  }

  /**
   * Get batch by ID
   */
  getBatch(batchId: string): StoredBatch | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Get all batches
   */
  getAllBatches(): StoredBatch[] {
    return Array.from(this.batches.values());
  }

  /**
   * Get pending batches
   */
  getPendingBatches(): StoredBatch[] {
    return this.getAllBatches().filter(b => b.status === "PENDING" || b.status === "FAILED");
  }

  /**
   * Get Merkle proof for an event in a batch
   */
  getEventProof(batchId: string, eventHash: string): { proof: string[]; index: number } | null {
    const batch = this.batches.get(batchId);
    if (!batch) {
      return null;
    }

    const index = batch.eventHashes.indexOf(eventHash);
    if (index === -1) {
      return null;
    }

    const proof = getMerkleProof(batch.merkleTree, index);
    return { proof, index };
  }

  /**
   * Force flush pending events
   */
  flush(): BatchResult | null {
    return this.accumulator.flush();
  }

  /**
   * Get accumulator stats
   */
  getStats(): {
    pendingEvents: number;
    totalBatches: number;
    anchoredBatches: number;
    failedBatches: number;
  } {
    const batches = this.getAllBatches();
    return {
      pendingEvents: this.accumulator.getPendingCount(),
      totalBatches: batches.length,
      anchoredBatches: batches.filter(b => b.status === "ANCHORED").length,
      failedBatches: batches.filter(b => b.status === "FAILED").length,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const batchManager = new BatchManager();
