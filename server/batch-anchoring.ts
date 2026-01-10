import { createHash } from "crypto";
import { keccak256, getBytes, hexlify, concat, toUtf8Bytes } from "ethers";
import { blockchainService } from "./blockchain";

export interface BatchableEvent {
  id: string;
  assetId: string;
  eventType: string;
  payload: any;
  timestamp: Date;
}

export interface BatchConfig {
  maxBatchSize: number;
  maxBatchAgeMs: number;
  enabled: boolean;
}

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: BatchableEvent;
}

export interface BatchResult {
  batchId: string;
  merkleRoot: string;
  eventCount: number;
  events: BatchableEvent[];
  txHash: string | null;
  anchoredAt: Date;
  gasUsed?: bigint;
  gasPrice?: bigint;
}

export interface BatchStats {
  pendingEvents: number;
  totalBatchesAnchored: number;
  totalEventsAnchored: number;
  lastBatchTime: Date | null;
  averageEventsPerBatch: number;
  estimatedGasSavings: number;
}

export class MerkleTree {
  private leaves: string[];
  private root: string;
  private layers: string[][];

  constructor(data: string[]) {
    this.leaves = data.map(d => this.hashLeaf(d));
    this.layers = [this.leaves];
    this.root = this.buildTree();
  }

  private hashLeaf(data: string): string {
    return keccak256(toUtf8Bytes(data));
  }

  private hashPair(a: string, b: string): string {
    const aBytes = getBytes(a);
    const bBytes = getBytes(b);
    if (a.toLowerCase() < b.toLowerCase()) {
      return keccak256(concat([aBytes, bBytes]));
    } else {
      return keccak256(concat([bBytes, aBytes]));
    }
  }

  private buildTree(): string {
    if (this.leaves.length === 0) {
      return keccak256(toUtf8Bytes(""));
    }

    let currentLayer = this.leaves;

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = currentLayer[i + 1] || left;
        nextLayer.push(this.hashPair(left, right));
      }
      
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    return currentLayer[0];
  }

  getRoot(): string {
    return this.root;
  }

  getProof(index: number): string[] {
    const proof: string[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  static verify(leafHash: string, proof: string[], root: string): boolean {
    let computedHash = leafHash;

    for (const sibling of proof) {
      const aBytes = getBytes(computedHash);
      const bBytes = getBytes(sibling);
      if (computedHash.toLowerCase() < sibling.toLowerCase()) {
        computedHash = keccak256(concat([aBytes, bBytes]));
      } else {
        computedHash = keccak256(concat([bBytes, aBytes]));
      }
    }

    return computedHash.toLowerCase() === root.toLowerCase();
  }

  static hashEventData(eventData: string): string {
    return keccak256(toUtf8Bytes(eventData));
  }
}

export class BatchAnchoringService {
  private eventQueue: BatchableEvent[] = [];
  private config: BatchConfig;
  private batchTimer: NodeJS.Timeout | null = null;
  private stats: BatchStats;
  private batchHistory: BatchResult[] = [];

  constructor(config: Partial<BatchConfig> = {}) {
    this.config = {
      maxBatchSize: config.maxBatchSize ?? 100,
      maxBatchAgeMs: config.maxBatchAgeMs ?? 5 * 60 * 1000,
      enabled: config.enabled ?? true,
    };

    this.stats = {
      pendingEvents: 0,
      totalBatchesAnchored: 0,
      totalEventsAnchored: 0,
      lastBatchTime: null,
      averageEventsPerBatch: 0,
      estimatedGasSavings: 0,
    };

    if (this.config.enabled) {
      this.startBatchTimer();
    }

    console.log("📦 BatchAnchoringService initialized");
    console.log(`   Max batch size: ${this.config.maxBatchSize}`);
    console.log(`   Max batch age: ${this.config.maxBatchAgeMs}ms`);
  }

  private startBatchTimer() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.batchTimer = setInterval(() => {
      if (this.eventQueue.length > 0) {
        this.flushBatch("timer");
      }
    }, this.config.maxBatchAgeMs);
  }

  updateConfig(config: Partial<BatchConfig>) {
    this.config = { ...this.config, ...config };
    
    if (this.config.enabled) {
      this.startBatchTimer();
    } else if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  getConfig(): BatchConfig {
    return { ...this.config };
  }

  queueEvent(event: BatchableEvent): { queued: boolean; position: number } {
    if (!this.config.enabled) {
      return { queued: false, position: -1 };
    }

    this.eventQueue.push(event);
    this.stats.pendingEvents = this.eventQueue.length;

    const position = this.eventQueue.length;

    if (this.eventQueue.length >= this.config.maxBatchSize) {
      this.flushBatch("size");
    }

    return { queued: true, position };
  }

  private async flushBatch(trigger: "timer" | "size" | "manual"): Promise<BatchResult | null> {
    if (this.eventQueue.length === 0) {
      return null;
    }

    const eventsToAnchor = [...this.eventQueue];
    this.eventQueue = [];
    this.stats.pendingEvents = 0;

    console.log(`🔗 Flushing batch (trigger: ${trigger}): ${eventsToAnchor.length} events`);

    const eventHashes = eventsToAnchor.map(e => 
      JSON.stringify({
        id: e.id,
        assetId: e.assetId,
        eventType: e.eventType,
        payload: e.payload,
        timestamp: e.timestamp.toISOString(),
      })
    );

    const merkleTree = new MerkleTree(eventHashes);
    const merkleRoot = merkleTree.getRoot();

    const batchId = keccak256(toUtf8Bytes(merkleRoot + Date.now().toString())).slice(2, 18);

    let txHash: string | null = null;
    let gasUsed: bigint | undefined;
    let gasPrice: bigint | undefined;

    if (blockchainService.isEnabled()) {
      try {
        txHash = await blockchainService.anchorBatchRoot(
          batchId,
          merkleRoot,
          eventsToAnchor.length
        );
      } catch (error) {
        console.error("Failed to anchor batch root:", error);
      }
    }

    const result: BatchResult = {
      batchId,
      merkleRoot,
      eventCount: eventsToAnchor.length,
      events: eventsToAnchor,
      txHash,
      anchoredAt: new Date(),
      gasUsed,
      gasPrice,
    };

    this.batchHistory.push(result);
    if (this.batchHistory.length > 100) {
      this.batchHistory.shift();
    }

    this.stats.totalBatchesAnchored++;
    this.stats.totalEventsAnchored += eventsToAnchor.length;
    this.stats.lastBatchTime = new Date();
    this.stats.averageEventsPerBatch = 
      this.stats.totalEventsAnchored / this.stats.totalBatchesAnchored;

    const individualGasCost = 50000;
    const batchGasCost = 70000;
    this.stats.estimatedGasSavings += 
      (eventsToAnchor.length * individualGasCost) - batchGasCost;

    console.log(`✅ Batch ${batchId} anchored: ${eventsToAnchor.length} events`);
    console.log(`   Merkle root: ${merkleRoot}`);
    if (txHash) {
      console.log(`   TX hash: ${txHash}`);
    }

    return result;
  }

  async forceBatch(): Promise<BatchResult | null> {
    return this.flushBatch("manual");
  }

  getStats(): BatchStats {
    return { ...this.stats };
  }

  getBatchHistory(): BatchResult[] {
    return [...this.batchHistory];
  }

  getPendingEvents(): BatchableEvent[] {
    return [...this.eventQueue];
  }

  getProofForEvent(batchId: string, eventId: string): { proof: string[]; root: string; eventHash: string } | null {
    const batch = this.batchHistory.find(b => b.batchId === batchId);
    if (!batch) return null;

    const eventIndex = batch.events.findIndex(e => e.id === eventId);
    if (eventIndex === -1) return null;

    const eventHashes = batch.events.map(e => 
      JSON.stringify({
        id: e.id,
        assetId: e.assetId,
        eventType: e.eventType,
        payload: e.payload,
        timestamp: e.timestamp.toISOString(),
      })
    );

    const merkleTree = new MerkleTree(eventHashes);
    const proof = merkleTree.getProof(eventIndex);
    const eventHash = MerkleTree.hashEventData(eventHashes[eventIndex]);

    return {
      proof,
      root: batch.merkleRoot,
      eventHash,
    };
  }

  shutdown() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.eventQueue.length > 0) {
      console.log(`⚠️  ${this.eventQueue.length} events pending - forcing final batch`);
      this.flushBatch("manual");
    }
  }
}

export const batchAnchoringService = new BatchAnchoringService({
  maxBatchSize: parseInt(process.env.BATCH_MAX_SIZE || "100"),
  maxBatchAgeMs: parseInt(process.env.BATCH_MAX_AGE_MS || "300000"),
  enabled: process.env.BATCH_ENABLED !== "false",
});
