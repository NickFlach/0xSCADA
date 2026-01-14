/**
 * Event Anchor Service
 *
 * VS-1.6 - Vertical Slice: Event Blockchain Anchor
 *
 * Connects alarm and telemetry events to blockchain anchoring
 * via Merkle batch aggregation.
 */

import { blockchainService } from "../blockchain";
import { batchAnchoringService, type BatchResult } from "../batch-anchoring";
import { alarmService, type AlarmEvent } from "./alarm-service";
import { getEventService, type SignedEvent } from "../events";
import { EventEmitter } from "events";

// =============================================================================
// TYPES
// =============================================================================

export interface AnchorConfig {
  enabled: boolean;
  batchSize: number;
  batchMaxAgeMs: number;
  anchorAlarms: boolean;
  anchorTelemetry: boolean;
  anchorCommands: boolean;
}

export interface AnchorStats {
  totalEventsAnchored: number;
  totalBatchesAnchored: number;
  pendingEvents: number;
  lastAnchorTime: Date | null;
  lastBatchId: string | null;
  lastMerkleRoot: string | null;
  blockchainEnabled: boolean;
}

export interface AnchoredEvent {
  event: SignedEvent;
  batchId: string;
  merkleRoot: string;
  txHash: string | null;
  anchoredAt: Date;
}

// =============================================================================
// ANCHOR SERVICE
// =============================================================================

class AnchorService extends EventEmitter {
  private config: AnchorConfig;
  private stats: AnchorStats;
  private pendingEvents: SignedEvent[] = [];
  private batchInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();

    this.config = {
      enabled: true,
      batchSize: 100,
      batchMaxAgeMs: 60000, // 1 minute
      anchorAlarms: true,
      anchorTelemetry: false, // High volume - disable by default
      anchorCommands: true,
    };

    this.stats = {
      totalEventsAnchored: 0,
      totalBatchesAnchored: 0,
      pendingEvents: 0,
      lastAnchorTime: null,
      lastBatchId: null,
      lastMerkleRoot: null,
      blockchainEnabled: blockchainService.isEnabled(),
    };
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Start the anchor service
   */
  start(): void {
    console.log(`[AnchorService] Starting...`);

    // Subscribe to alarm events
    if (this.config.anchorAlarms) {
      alarmService.on("alarm", (alarmEvent: AlarmEvent) => {
        this.queueEvent(alarmEvent.signedEvent);
      });
      console.log(`[AnchorService] Subscribed to alarm events`);
    }

    // Subscribe to event service for other event types
    const eventService = getEventService();
    eventService.onEvent((event: SignedEvent) => {
      // Filter by event type based on config
      if (event.eventType === "COMMAND" && this.config.anchorCommands) {
        this.queueEvent(event);
      } else if (event.eventType === "TELEMETRY" && this.config.anchorTelemetry) {
        this.queueEvent(event);
      }
    });

    // Start batch timer
    this.batchInterval = setInterval(() => {
      if (this.pendingEvents.length > 0) {
        this.flushBatch();
      }
    }, this.config.batchMaxAgeMs);

    console.log(`[AnchorService] Started (blockchain: ${this.stats.blockchainEnabled ? "enabled" : "disabled"})`);
  }

  /**
   * Stop the anchor service
   */
  stop(): void {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }

    // Flush any remaining events
    if (this.pendingEvents.length > 0) {
      this.flushBatch();
    }

    console.log(`[AnchorService] Stopped`);
  }

  // ===========================================================================
  // EVENT PROCESSING
  // ===========================================================================

  /**
   * Queue an event for batch anchoring
   */
  queueEvent(event: SignedEvent): void {
    this.pendingEvents.push(event);
    this.stats.pendingEvents = this.pendingEvents.length;

    console.log(`[AnchorService] Queued event: ${event.eventType} (pending: ${this.pendingEvents.length})`);

    // Flush if batch is full
    if (this.pendingEvents.length >= this.config.batchSize) {
      this.flushBatch();
    }
  }

  /**
   * Flush pending events to a batch
   */
  async flushBatch(): Promise<BatchResult | null> {
    if (this.pendingEvents.length === 0) {
      return null;
    }

    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    this.stats.pendingEvents = 0;

    console.log(`[AnchorService] Flushing batch of ${events.length} events...`);

    try {
      // Create batch using batch anchoring service
      const batchId = `BATCH-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

      // Build Merkle tree from event hashes
      const eventHashes = events.map((e) => e.hash);
      const { MerkleTree } = await import("../batch-anchoring");
      const tree = new MerkleTree(eventHashes);
      const merkleRoot = tree.getRoot();

      // Anchor to blockchain if enabled
      let txHash: string | null = null;
      if (blockchainService.isEnabled()) {
        try {
          txHash = await blockchainService.anchorBatchRoot(batchId, merkleRoot, events.length);
          console.log(`[AnchorService] Anchored to blockchain: ${txHash}`);
        } catch (error) {
          console.error(`[AnchorService] Blockchain anchor failed:`, error);
        }
      }

      const result: BatchResult = {
        batchId,
        merkleRoot,
        eventCount: events.length,
        events: events.map((e) => ({
          id: e.hash,
          assetId: e.assetId || "",
          eventType: e.eventType,
          payload: e.payload,
          timestamp: e.sourceTimestamp,
        })),
        txHash,
        anchoredAt: new Date(),
      };

      // Update stats
      this.stats.totalEventsAnchored += events.length;
      this.stats.totalBatchesAnchored++;
      this.stats.lastAnchorTime = result.anchoredAt;
      this.stats.lastBatchId = batchId;
      this.stats.lastMerkleRoot = merkleRoot;

      console.log(`[AnchorService] Batch ${batchId} anchored:`);
      console.log(`   Events: ${events.length}`);
      console.log(`   Merkle Root: ${merkleRoot.substring(0, 18)}...`);
      console.log(`   TX Hash: ${txHash || "N/A (blockchain disabled)"}`);

      this.emit("batch:anchored", result);

      return result;
    } catch (error) {
      console.error(`[AnchorService] Batch failed:`, error);
      // Re-queue events on failure
      this.pendingEvents = [...events, ...this.pendingEvents];
      this.stats.pendingEvents = this.pendingEvents.length;
      return null;
    }
  }

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  /**
   * Update anchor configuration
   */
  configure(config: Partial<AnchorConfig>): void {
    this.config = { ...this.config, ...config };
    console.log(`[AnchorService] Configuration updated`);
  }

  /**
   * Enable/disable telemetry anchoring
   */
  setTelemetryAnchoring(enabled: boolean): void {
    this.config.anchorTelemetry = enabled;
    console.log(`[AnchorService] Telemetry anchoring: ${enabled ? "enabled" : "disabled"}`);
  }

  // ===========================================================================
  // QUERIES
  // ===========================================================================

  /**
   * Get anchor service stats
   */
  getStats(): AnchorStats {
    return { ...this.stats };
  }

  /**
   * Get configuration
   */
  getConfig(): AnchorConfig {
    return { ...this.config };
  }

  /**
   * Check if blockchain is available
   */
  isBlockchainEnabled(): boolean {
    return blockchainService.isEnabled();
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

export const anchorService = new AnchorService();

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize anchor service with configuration
 */
export function initAnchorService(config?: Partial<AnchorConfig>): void {
  if (config) {
    anchorService.configure(config);
  }
  anchorService.start();
}
