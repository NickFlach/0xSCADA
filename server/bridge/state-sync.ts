/**
 * Bidirectional State Sync — Kernel ↔ L2
 *
 * Issue #156 — Bidirectional L2 state sync to kernel
 *
 * Two directions:
 * - Kernel → L2: Events are batched, Merkle-rooted, and anchored on-chain
 * - L2 → Kernel: State roots are imported, proofs verified, finality confirmed
 */

import { EventEmitter } from "events";
import * as crypto from "crypto";

// =============================================================================
// TYPES
// =============================================================================

export interface SyncConfig {
  /** Kernel → L2 */
  anchorBatchSize: number;
  anchorIntervalMs: number;
  anchorConfirmationBlocks: number;

  /** L2 → Kernel */
  stateImportIntervalMs: number;
  finalityDepth: number;
  maxPendingImports: number;

  /** General */
  l2RpcUrl: string;
  contractAddress: string;
}

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  anchorBatchSize: 256,
  anchorIntervalMs: 10_000,
  anchorConfirmationBlocks: 64,
  stateImportIntervalMs: 5_000,
  finalityDepth: 64,
  maxPendingImports: 100,
  l2RpcUrl: "http://localhost:8545",
  contractAddress: "0x0000000000000000000000000000000000000000",
};

export interface KernelEvent {
  id: string;
  type: string;
  timestamp: number;
  data: Uint8Array;
  hash: string;
}

export interface AnchorRecord {
  batchId: string;
  merkleRoot: string;
  eventCount: number;
  timestamp: number;
  status: "pending" | "submitted" | "confirmed" | "finalized" | "failed";
  txHash?: string;
  blockNumber?: number;
  retries: number;
}

export interface ImportedStateRoot {
  blockNumber: number;
  stateRoot: string;
  importedAt: number;
  verified: boolean;
  finalized: boolean;
  proofValid?: boolean;
}

export interface SyncStatus {
  direction: "kernel-to-l2" | "l2-to-kernel";
  lastSyncTimestamp: number;
  pendingCount: number;
  confirmedCount: number;
  failedCount: number;
  isRunning: boolean;
}

// =============================================================================
// KERNEL → L2: EVENT ANCHORING
// =============================================================================

export class EventAnchoringService extends EventEmitter {
  private config: SyncConfig;
  private eventBuffer: KernelEvent[] = [];
  private anchors: Map<string, AnchorRecord> = new Map();
  private anchorTimer: ReturnType<typeof setInterval> | null = null;
  private confirmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SyncConfig> = {}) {
    super();
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  start(): void {
    this.anchorTimer = setInterval(() => this.flushBatch(), this.config.anchorIntervalMs);
    this.confirmTimer = setInterval(() => this.checkConfirmations(), 15_000);
    this.emit("started", "kernel-to-l2");
  }

  stop(): void {
    if (this.anchorTimer) clearInterval(this.anchorTimer);
    if (this.confirmTimer) clearInterval(this.confirmTimer);
    this.flushBatch(); // flush remaining
    this.emit("stopped", "kernel-to-l2");
  }

  ingestEvent(event: KernelEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length >= this.config.anchorBatchSize) {
      this.flushBatch();
    }
  }

  getAnchor(batchId: string): AnchorRecord | undefined {
    return this.anchors.get(batchId);
  }

  getStatus(): SyncStatus {
    const records = Array.from(this.anchors.values());
    return {
      direction: "kernel-to-l2",
      lastSyncTimestamp: records.length > 0 ? Math.max(...records.map((r) => r.timestamp)) : 0,
      pendingCount: records.filter((r) => r.status === "pending" || r.status === "submitted").length,
      confirmedCount: records.filter((r) => r.status === "confirmed" || r.status === "finalized").length,
      failedCount: records.filter((r) => r.status === "failed").length,
      isRunning: this.anchorTimer !== null,
    };
  }

  private flushBatch(): void {
    if (this.eventBuffer.length === 0) return;

    const events = this.eventBuffer.splice(0, this.config.anchorBatchSize);
    const merkleRoot = this.computeMerkleRoot(events);
    const batchId = crypto.randomUUID();

    const record: AnchorRecord = {
      batchId,
      merkleRoot,
      eventCount: events.length,
      timestamp: Date.now(),
      status: "pending",
      retries: 0,
    };

    this.anchors.set(batchId, record);
    this.submitToL2(record);
    this.emit("batchCreated", record);
  }

  private async submitToL2(record: AnchorRecord): Promise<void> {
    try {
      // In production: call EventAnchor.submitBatch(merkleRoot, eventCount)
      record.status = "submitted";
      record.txHash = "0x" + crypto.randomBytes(32).toString("hex");
      this.emit("batchSubmitted", record);
    } catch (err) {
      record.retries++;
      if (record.retries >= 3) {
        record.status = "failed";
        this.emit("batchFailed", record, err);
      } else {
        // Retry on next interval
        record.status = "pending";
      }
    }
  }

  private checkConfirmations(): void {
    for (const [, record] of this.anchors) {
      if (record.status === "submitted") {
        // In production: check tx receipt, compare block depth
        // Stub: auto-confirm after 30s
        if (Date.now() - record.timestamp > 30_000) {
          record.status = "confirmed";
          record.blockNumber = Math.floor(Date.now() / 1000);
          this.emit("batchConfirmed", record);
        }
      }
      if (record.status === "confirmed") {
        // Check finality
        if (Date.now() - record.timestamp > 120_000) {
          record.status = "finalized";
          this.emit("batchFinalized", record);
        }
      }
    }
  }

  private computeMerkleRoot(events: KernelEvent[]): string {
    let hashes = events.map((e) => e.hash);
    while (hashes.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        next.push(crypto.createHash("sha256").update(left + right).digest("hex"));
      }
      hashes = next;
    }
    return hashes[0] || "0".repeat(64);
  }
}

// =============================================================================
// L2 → KERNEL: STATE ROOT IMPORT
// =============================================================================

export class StateImportService extends EventEmitter {
  private config: SyncConfig;
  private importedRoots: Map<number, ImportedStateRoot> = new Map();
  private importTimer: ReturnType<typeof setInterval> | null = null;
  private latestFinalizedBlock = 0;

  constructor(config: Partial<SyncConfig> = {}) {
    super();
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  start(): void {
    this.importTimer = setInterval(() => this.pollL2StateRoots(), this.config.stateImportIntervalMs);
    this.emit("started", "l2-to-kernel");
  }

  stop(): void {
    if (this.importTimer) clearInterval(this.importTimer);
    this.emit("stopped", "l2-to-kernel");
  }

  /**
   * Import a verified state root into the kernel store.
   */
  importStateRoot(blockNumber: number, stateRoot: string, proofValid: boolean): ImportedStateRoot {
    const imported: ImportedStateRoot = {
      blockNumber,
      stateRoot,
      importedAt: Date.now(),
      verified: proofValid,
      finalized: false,
      proofValid,
    };

    this.importedRoots.set(blockNumber, imported);
    this.emit("stateRootImported", imported);

    // Trim old entries
    if (this.importedRoots.size > this.config.maxPendingImports) {
      const oldest = Math.min(...this.importedRoots.keys());
      this.importedRoots.delete(oldest);
    }

    return imported;
  }

  /**
   * Confirm finality for a state root once enough blocks have passed.
   */
  confirmFinality(blockNumber: number, currentBlock: number): boolean {
    const root = this.importedRoots.get(blockNumber);
    if (!root || !root.verified) return false;

    if (currentBlock - blockNumber >= this.config.finalityDepth) {
      root.finalized = true;
      if (blockNumber > this.latestFinalizedBlock) {
        this.latestFinalizedBlock = blockNumber;
      }
      this.emit("stateRootFinalized", root);
      return true;
    }
    return false;
  }

  getStateRoot(blockNumber: number): ImportedStateRoot | undefined {
    return this.importedRoots.get(blockNumber);
  }

  getLatestFinalized(): ImportedStateRoot | undefined {
    return this.importedRoots.get(this.latestFinalizedBlock);
  }

  getStatus(): SyncStatus {
    const roots = Array.from(this.importedRoots.values());
    return {
      direction: "l2-to-kernel",
      lastSyncTimestamp: roots.length > 0 ? Math.max(...roots.map((r) => r.importedAt)) : 0,
      pendingCount: roots.filter((r) => !r.finalized).length,
      confirmedCount: roots.filter((r) => r.finalized).length,
      failedCount: roots.filter((r) => !r.verified).length,
      isRunning: this.importTimer !== null,
    };
  }

  private async pollL2StateRoots(): Promise<void> {
    // In production: fetch latest state root from L2 contract
    // Verify proof using ProofVerifier
    // Call importStateRoot if valid
    this.emit("polled");
  }
}

// =============================================================================
// BIDIRECTIONAL SYNC COORDINATOR
// =============================================================================

export class BidirectionalSync extends EventEmitter {
  readonly anchoring: EventAnchoringService;
  readonly stateImport: StateImportService;

  constructor(config: Partial<SyncConfig> = {}) {
    super();
    this.anchoring = new EventAnchoringService(config);
    this.stateImport = new StateImportService(config);
    this.wireEvents();
  }

  start(): void {
    this.anchoring.start();
    this.stateImport.start();
    this.emit("started");
  }

  stop(): void {
    this.anchoring.stop();
    this.stateImport.stop();
    this.emit("stopped");
  }

  getStatus(): { anchorStatus: SyncStatus; importStatus: SyncStatus } {
    return {
      anchorStatus: this.anchoring.getStatus(),
      importStatus: this.stateImport.getStatus(),
    };
  }

  private wireEvents(): void {
    this.anchoring.on("batchFinalized", (record: AnchorRecord) => {
      this.emit("anchorFinalized", record);
    });
    this.stateImport.on("stateRootFinalized", (root: ImportedStateRoot) => {
      this.emit("stateRootFinalized", root);
    });
  }
}
