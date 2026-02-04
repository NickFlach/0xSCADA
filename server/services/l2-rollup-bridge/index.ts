/**
 * L2 Rollup Bridge Service
 *
 * Main service for high-throughput event anchoring via L2 rollups.
 *
 * Features:
 * - Event batching with configurable size and timing
 * - State commitment generation
 * - Merkle proof generation for events
 * - Support for optimistic and ZK rollup modes
 * - L1 bridge for state submission and finalization
 *
 * Architecture:
 * ┌────────────────────────────────────────────────────────┐
 * │                    L2 Rollup Bridge                    │
 * ├────────────────────────────────────────────────────────┤
 * │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
 * │  │    Event     │  │    State     │  │    Proof     │ │
 * │  │   Batcher    │─▶│   Manager    │─▶│  Generator   │ │
 * │  └──────────────┘  └──────────────┘  └──────────────┘ │
 * │          │                                     │      │
 * │          ▼                                     ▼      │
 * │  ┌──────────────────────────────────────────────────┐ │
 * │  │                   L1 Bridge                       │ │
 * │  └──────────────────────────────────────────────────┘ │
 * └────────────────────────────────────────────────────────┘
 *                            │
 *                            ▼
 *               ┌──────────────────────┐
 *               │     L1 Contract      │
 *               │  (State Commitments) │
 *               └──────────────────────┘
 */

import { EventEmitter } from 'events';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  L2RollupConfig,
  DEFAULT_L2_ROLLUP_CONFIG,
  RollupEvent,
  RollupBatch,
  RollupStats,
  StateCommitment,
  InclusionProof,
  FraudProof,
  ValidityProof,
  BatchStatus,
  RollupError,
  RollupErrorCode,
} from './types';
import { L2StateManager } from './state-manager';
import { ProofService } from './proof-generator';
import { L1BridgeService } from './l1-bridge';

// Re-export types
export * from './types';
export { L2StateManager, StateTree } from './state-manager';
export {
  ProofService,
  FraudProofGenerator,
  ValidityProofGenerator,
  InclusionProofGenerator,
} from './proof-generator';
export { L1BridgeService } from './l1-bridge';

// =============================================================================
// L2 ROLLUP BRIDGE SERVICE
// =============================================================================

/**
 * Main L2 Rollup Bridge Service
 */
export class L2RollupBridgeService extends EventEmitter {
  private config: L2RollupConfig;
  private stateManager: L2StateManager;
  private proofService: ProofService;
  private l1Bridge: L1BridgeService;

  // Event batching
  private eventQueue: RollupEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;

  // Finalization tracking
  private finalizationTimer: NodeJS.Timeout | null = null;
  private pendingFinalizations: Map<number, NodeJS.Timeout> = new Map();

  // Statistics
  private stats: RollupStats;

  constructor(config: Partial<L2RollupConfig> = {}) {
    super();
    this.config = { ...DEFAULT_L2_ROLLUP_CONFIG, ...config };
    this.stateManager = new L2StateManager();
    this.proofService = new ProofService(
      this.stateManager,
      this.config.mode,
      this.config.proverEndpoint
    );
    this.l1Bridge = new L1BridgeService(this.config);

    this.stats = this.initializeStats();
  }

  private initializeStats(): RollupStats {
    return {
      totalBatches: 0,
      pendingBatches: 0,
      finalizedBatches: 0,
      rejectedBatches: 0,
      totalEventsProcessed: 0,
      pendingEvents: 0,
      totalL1Transactions: 0,
      totalGasUsed: BigInt(0),
      averageGasPerBatch: BigInt(0),
      totalChallenges: 0,
      successfulChallenges: 0,
      averageBatchTime: 0,
      averageFinalizationTime: 0,
      lastBatchTimestamp: null,
      lastL1SubmissionTimestamp: null,
      currentStateRoot: this.stateManager.getCurrentStateRoot(),
      currentBatchIndex: 0,
    };
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Start the rollup bridge service
   */
  async start(): Promise<void> {
    console.log('[L2RollupBridge] Starting...');
    console.log(`  Mode: ${this.config.mode}`);
    console.log(`  Max batch size: ${this.config.maxBatchSize}`);
    console.log(`  Max batch age: ${this.config.maxBatchAgeMs}ms`);

    // Initialize L1 bridge
    if (this.config.enabled) {
      await this.l1Bridge.initialize();

      // Set up L1 event handlers
      this.l1Bridge.on('batchFinalized', (data) => {
        this.handleBatchFinalized(data.batchIndex, data.stateRoot);
      });

      this.l1Bridge.on('batchChallenged', (data) => {
        this.handleBatchChallenged(data.batchIndex, data.challenger);
      });
    }

    // Start batch timer
    this.startBatchTimer();

    console.log('[L2RollupBridge] Started');
    this.emit('started');
  }

  /**
   * Stop the rollup bridge service
   */
  async stop(): Promise<void> {
    console.log('[L2RollupBridge] Stopping...');

    // Stop timers
    this.stopBatchTimer();
    this.stopFinalizationTimers();

    // Flush remaining events
    if (this.eventQueue.length > 0) {
      console.log(`[L2RollupBridge] Flushing ${this.eventQueue.length} pending events`);
      await this.createBatch('shutdown');
    }

    // Shutdown L1 bridge
    await this.l1Bridge.shutdown();

    console.log('[L2RollupBridge] Stopped');
    this.emit('stopped');
  }

  // ===========================================================================
  // EVENT BATCHING
  // ===========================================================================

  /**
   * Queue an event for batching
   */
  queueEvent(event: RollupEvent): {
    queued: boolean;
    position: number;
    batchTriggered: boolean;
  } {
    if (!this.config.enabled) {
      return { queued: false, position: -1, batchTriggered: false };
    }

    this.eventQueue.push(event);
    this.stats.pendingEvents = this.eventQueue.length;

    const position = this.eventQueue.length;
    let batchTriggered = false;

    // Check if we should create a batch
    if (this.eventQueue.length >= this.config.maxBatchSize) {
      this.createBatch('size');
      batchTriggered = true;
    }

    this.emit('eventQueued', { event, position });
    return { queued: true, position, batchTriggered };
  }

  /**
   * Queue multiple events
   */
  queueEvents(events: RollupEvent[]): {
    queued: number;
    batchesTriggered: number;
  } {
    let queued = 0;
    let batchesTriggered = 0;

    for (const event of events) {
      const result = this.queueEvent(event);
      if (result.queued) {
        queued++;
        if (result.batchTriggered) {
          batchesTriggered++;
        }
      }
    }

    return { queued, batchesTriggered };
  }

  /**
   * Start the batch timer
   */
  private startBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }

    this.batchTimer = setInterval(() => {
      if (this.eventQueue.length >= this.config.minBatchSize) {
        this.createBatch('timer');
      }
    }, this.config.maxBatchAgeMs);
  }

  /**
   * Stop the batch timer
   */
  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Create a batch from queued events
   */
  async createBatch(
    trigger: 'size' | 'timer' | 'manual' | 'shutdown'
  ): Promise<RollupBatch | null> {
    if (this.eventQueue.length === 0) {
      return null;
    }

    const events = [...this.eventQueue];
    this.eventQueue = [];
    this.stats.pendingEvents = 0;

    console.log(`[L2RollupBridge] Creating batch (trigger: ${trigger}): ${events.length} events`);

    // Get previous state root
    const prevStateRoot = this.stateManager.getCurrentStateRoot();

    // Create batch with state commitment
    const batch = this.stateManager.createBatch(events);

    // Update statistics
    this.stats.totalBatches++;
    this.stats.pendingBatches++;
    this.stats.totalEventsProcessed += events.length;
    this.stats.lastBatchTimestamp = Date.now();
    this.stats.currentStateRoot = batch.stateCommitment.stateRoot;
    this.stats.currentBatchIndex = batch.stateCommitment.batchIndex;

    console.log(`[L2RollupBridge] Batch ${batch.batchId} created:`);
    console.log(`  Events: ${events.length}`);
    console.log(`  State root: ${batch.stateCommitment.stateRoot.slice(0, 18)}...`);

    // Submit to L1 if enabled
    if (this.l1Bridge.isEnabled()) {
      try {
        // For ZK mode, generate validity proof first
        if (this.config.mode === 'ZK') {
          const validityProof = await this.proofService.generateBatchProof(
            batch.stateCommitment.batchIndex,
            events,
            prevStateRoot,
            batch.stateCommitment.stateRoot
          ) as ValidityProof;

          if (validityProof) {
            await this.l1Bridge.submitValidityProof(validityProof);
          }
        }

        // Submit state commitment
        const receipt = await this.l1Bridge.submitStateCommitment(batch.stateCommitment);
        if (receipt) {
          this.stateManager.updateBatchStatus(batch.batchId, 'SUBMITTED', {
            l1TxHash: receipt.txHash,
            l1BlockNumber: receipt.blockNumber,
            submittedAt: new Date(),
          });

          this.stats.totalL1Transactions++;
          this.stats.totalGasUsed += receipt.gasUsed;
          this.stats.averageGasPerBatch = this.stats.totalGasUsed / BigInt(this.stats.totalL1Transactions);
          this.stats.lastL1SubmissionTimestamp = Date.now();

          // Schedule finalization for optimistic mode
          if (this.config.mode === 'OPTIMISTIC') {
            this.scheduleFinalization(batch.stateCommitment.batchIndex);
          }
        }
      } catch (error) {
        console.error('[L2RollupBridge] L1 submission failed:', error);
      }
    }

    this.emit('batchCreated', batch);
    return batch;
  }

  /**
   * Force creation of a batch
   */
  async forceBatch(): Promise<RollupBatch | null> {
    return this.createBatch('manual');
  }

  // ===========================================================================
  // FINALIZATION
  // ===========================================================================

  /**
   * Schedule finalization after challenge period
   */
  private scheduleFinalization(batchIndex: number): void {
    const timer = setTimeout(async () => {
      await this.finalizeBatch(batchIndex);
      this.pendingFinalizations.delete(batchIndex);
    }, this.config.challengePeriodMs);

    this.pendingFinalizations.set(batchIndex, timer);
  }

  /**
   * Stop all finalization timers
   */
  private stopFinalizationTimers(): void {
    for (const timer of this.pendingFinalizations.values()) {
      clearTimeout(timer);
    }
    this.pendingFinalizations.clear();
  }

  /**
   * Finalize a batch
   */
  async finalizeBatch(batchIndex: number): Promise<boolean> {
    console.log(`[L2RollupBridge] Finalizing batch ${batchIndex}`);

    // Find the batch
    const batches = this.stateManager.getAllBatches();
    const batch = batches.find(b => b.stateCommitment.batchIndex === batchIndex);
    if (!batch) {
      console.error(`[L2RollupBridge] Batch ${batchIndex} not found`);
      return false;
    }

    // Check if already challenged
    if (batch.status === 'CHALLENGED') {
      console.warn(`[L2RollupBridge] Batch ${batchIndex} is under challenge`);
      return false;
    }

    try {
      // Call L1 finalization if available
      if (this.l1Bridge.isEnabled()) {
        const receipt = await this.l1Bridge.finalizeBatch(batchIndex);
        if (receipt) {
          this.stats.totalL1Transactions++;
          this.stats.totalGasUsed += receipt.gasUsed;
        }
      }

      // Update batch status
      this.stateManager.updateBatchStatus(batch.batchId, 'FINALIZED', {
        finalizedAt: new Date(),
      });

      this.stats.pendingBatches--;
      this.stats.finalizedBatches++;

      console.log(`[L2RollupBridge] Batch ${batchIndex} finalized`);
      this.emit('batchFinalized', { batchIndex, batch });

      return true;
    } catch (error) {
      console.error(`[L2RollupBridge] Finalization failed for batch ${batchIndex}:`, error);
      return false;
    }
  }

  /**
   * Handle batch finalized event from L1
   */
  private handleBatchFinalized(batchIndex: number, stateRoot: string): void {
    const batches = this.stateManager.getAllBatches();
    const batch = batches.find(b => b.stateCommitment.batchIndex === batchIndex);
    if (batch && batch.status !== 'FINALIZED') {
      this.stateManager.updateBatchStatus(batch.batchId, 'FINALIZED', {
        finalizedAt: new Date(),
      });
      this.stats.pendingBatches--;
      this.stats.finalizedBatches++;
    }
  }

  /**
   * Handle batch challenged event from L1
   */
  private handleBatchChallenged(batchIndex: number, challenger: string): void {
    console.warn(`[L2RollupBridge] Batch ${batchIndex} challenged by ${challenger}`);

    const batches = this.stateManager.getAllBatches();
    const batch = batches.find(b => b.stateCommitment.batchIndex === batchIndex);
    if (batch) {
      this.stateManager.updateBatchStatus(batch.batchId, 'CHALLENGED');
      this.stats.totalChallenges++;
    }

    // Cancel pending finalization
    const timer = this.pendingFinalizations.get(batchIndex);
    if (timer) {
      clearTimeout(timer);
      this.pendingFinalizations.delete(batchIndex);
    }

    this.emit('batchChallenged', { batchIndex, challenger });
  }

  // ===========================================================================
  // PROOFS
  // ===========================================================================

  /**
   * Generate an inclusion proof for an event
   */
  getInclusionProof(eventId: string, batchId: string): InclusionProof | null {
    return this.proofService.generateInclusionProof(eventId, batchId);
  }

  /**
   * Verify an inclusion proof
   */
  verifyInclusionProof(proof: InclusionProof): boolean {
    return this.proofService.verifyInclusionProof(proof);
  }

  /**
   * Generate a fraud proof (for challenging invalid state)
   */
  generateFraudProof(
    batchIndex: number,
    invalidEventIndex: number,
    challenger: string
  ): FraudProof | null {
    return this.proofService.generateFraudProof(batchIndex, invalidEventIndex, challenger);
  }

  /**
   * Submit a fraud proof to L1
   */
  async submitFraudProof(fraudProof: FraudProof): Promise<boolean> {
    if (!this.l1Bridge.isEnabled()) {
      console.warn('[L2RollupBridge] L1 bridge not enabled');
      return false;
    }

    // Verify fraud proof locally first
    const verification = this.proofService.verifyFraudProof(fraudProof);
    if (!verification.valid) {
      console.error('[L2RollupBridge] Invalid fraud proof:', verification.reason);
      return false;
    }

    try {
      const receipt = await this.l1Bridge.submitFraudProof(fraudProof);
      return receipt !== null;
    } catch (error) {
      console.error('[L2RollupBridge] Failed to submit fraud proof:', error);
      return false;
    }
  }

  // ===========================================================================
  // QUERIES
  // ===========================================================================

  /**
   * Get current statistics
   */
  getStats(): RollupStats {
    return {
      ...this.stats,
      currentStateRoot: this.stateManager.getCurrentStateRoot(),
      currentBatchIndex: this.stateManager.getCurrentBatchIndex(),
    };
  }

  /**
   * Get configuration
   */
  getConfig(): L2RollupConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<L2RollupConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart batch timer if timing changed
    if (config.maxBatchAgeMs !== undefined) {
      this.startBatchTimer();
    }

    console.log('[L2RollupBridge] Configuration updated');
    this.emit('configUpdated', this.config);
  }

  /**
   * Get pending events
   */
  getPendingEvents(): RollupEvent[] {
    return [...this.eventQueue];
  }

  /**
   * Get a batch by ID
   */
  getBatch(batchId: string): RollupBatch | undefined {
    return this.stateManager.getBatch(batchId);
  }

  /**
   * Get all batches
   */
  getAllBatches(): RollupBatch[] {
    return this.stateManager.getAllBatches();
  }

  /**
   * Get batches by status
   */
  getBatchesByStatus(status: BatchStatus): RollupBatch[] {
    return this.stateManager.getBatchesByStatus(status);
  }

  /**
   * Get state commitment for a batch
   */
  getStateCommitment(batchIndex: number): StateCommitment | undefined {
    return this.stateManager.getStateCommitment(batchIndex);
  }

  /**
   * Get current state root
   */
  getCurrentStateRoot(): string {
    return this.stateManager.getCurrentStateRoot();
  }

  /**
   * Get current batch index
   */
  getCurrentBatchIndex(): number {
    return this.stateManager.getCurrentBatchIndex();
  }

  /**
   * Check if L1 bridge is enabled
   */
  isL1BridgeEnabled(): boolean {
    return this.l1Bridge.isEnabled();
  }

  /**
   * Check if service is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get rollup mode
   */
  getMode(): string {
    return this.config.mode;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

/**
 * Create the default L2 rollup bridge service instance
 */
export function createL2RollupBridgeService(
  config?: Partial<L2RollupConfig>
): L2RollupBridgeService {
  return new L2RollupBridgeService({
    enabled: process.env.L2_ROLLUP_ENABLED !== 'false',
    mode: (process.env.L2_ROLLUP_MODE as 'OPTIMISTIC' | 'ZK') || 'OPTIMISTIC',
    maxBatchSize: parseInt(process.env.L2_BATCH_SIZE || '1000'),
    maxBatchAgeMs: parseInt(process.env.L2_BATCH_AGE_MS || '60000'),
    l1RpcUrl: process.env.L1_RPC_URL || process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:8545',
    l1BridgeAddress: process.env.L1_BRIDGE_ADDRESS || '',
    ...config,
  });
}

// Default singleton instance (lazy initialization)
let _l2RollupBridge: L2RollupBridgeService | null = null;

/**
 * Get the singleton L2 rollup bridge service
 */
export function getL2RollupBridgeService(): L2RollupBridgeService {
  if (!_l2RollupBridge) {
    _l2RollupBridge = createL2RollupBridgeService();
  }
  return _l2RollupBridge;
}

/**
 * Initialize and start the L2 rollup bridge
 */
export async function initL2RollupBridge(
  config?: Partial<L2RollupConfig>
): Promise<L2RollupBridgeService> {
  const service = createL2RollupBridgeService(config);
  await service.start();
  _l2RollupBridge = service;
  return service;
}
