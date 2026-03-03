/**
 * Event Anchor Bridge
 * 
 * Bridges industrial events to blockchain for immutable audit trails.
 * Batches events and anchors them to the EventAnchor smart contract.
 * 
 * Issues: #280, #157 — Bridge modules integration
 */

import { EventEmitter } from 'events';
import { log, logError } from '../logger';

export interface AnchorableEvent {
  id: string;
  timestamp: Date;
  eventType: string;
  siteId: string;
  severity: 'info' | 'warning' | 'alarm' | 'critical';
  message: string;
  data?: Record<string, unknown>;
  hash?: string; // Computed hash for blockchain anchoring
}

export interface AnchorBatch {
  id: string;
  events: AnchorableEvent[];
  merkleRoot: string;
  timestamp: Date;
  blockchainTx?: string;
  status: 'pending' | 'anchored' | 'failed';
}

export interface EventAnchorConfig {
  batchSize: number; // Events per batch
  batchTimeout: number; // Max time to wait for full batch (ms)
  contractAddress?: string; // EventAnchor contract address
  enabled: boolean;
}

export class EventAnchorBridge extends EventEmitter {
  private pendingEvents: AnchorableEvent[] = [];
  private batchTimer?: NodeJS.Timeout;
  private config: EventAnchorConfig;
  private isInitialized = false;

  constructor(config?: Partial<EventAnchorConfig>) {
    super();
    this.config = {
      batchSize: 100,
      batchTimeout: 30000, // 30 seconds
      enabled: process.env.BLOCKCHAIN_ANCHORING !== 'false',
      ...config
    };
  }

  /**
   * Initialize the event anchor bridge
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing event anchor bridge');
    
    if (!this.config.enabled) {
      log('Event anchor bridge disabled via configuration');
      return;
    }

    // Try to get contract address from environment or blockchain service
    try {
      this.config.contractAddress = process.env.EVENT_ANCHOR_CONTRACT || 
                                   await this.getDeployedContractAddress();
    } catch (error) {
      logError('Failed to get EventAnchor contract address', error);
      this.config.enabled = false;
      return;
    }

    this.isInitialized = true;
    this.emit('initialized');
    log(`Event anchor bridge initialized with contract: ${this.config.contractAddress}`);
  }

  /**
   * Submit an event for blockchain anchoring
   */
  async anchor(event: Omit<AnchorableEvent, 'hash'>): Promise<void> {
    if (!this.config.enabled || !this.isInitialized) {
      return;
    }

    const anchorableEvent: AnchorableEvent = {
      ...event,
      hash: await this.computeEventHash(event)
    };

    this.pendingEvents.push(anchorableEvent);
    
    // Check if we should create a batch
    if (this.pendingEvents.length >= this.config.batchSize) {
      await this.createBatch();
    } else if (!this.batchTimer) {
      // Start timeout timer
      this.batchTimer = setTimeout(() => {
        this.createBatch();
      }, this.config.batchTimeout);
    }
  }

  /**
   * Get anchoring status
   */
  getStatus(): { 
    enabled: boolean; 
    pendingEvents: number; 
    contractAddress?: string; 
    isHealthy: boolean;
  } {
    return {
      enabled: this.config.enabled,
      pendingEvents: this.pendingEvents.length,
      contractAddress: this.config.contractAddress,
      isHealthy: this.config.enabled && this.isInitialized
    };
  }

  /**
   * Health check for the anchor bridge
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.config.enabled) {
      return {
        healthy: true, // Not enabled is considered healthy
        message: 'Event anchoring disabled'
      };
    }

    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'Event anchor bridge not initialized'
      };
    }

    const pendingCount = this.pendingEvents.length;
    if (pendingCount > this.config.batchSize * 2) {
      return {
        healthy: false,
        message: `Too many pending events for anchoring: ${pendingCount}`
      };
    }

    return {
      healthy: true,
      message: `Event anchor bridge healthy: ${pendingCount} pending events`
    };
  }

  /**
   * Force create a batch from pending events
   */
  async forceBatch(): Promise<AnchorBatch | null> {
    if (this.pendingEvents.length === 0) {
      return null;
    }
    return this.createBatch();
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Create and submit a batch of events to the blockchain
   */
  private async createBatch(): Promise<AnchorBatch> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }

    const events = this.pendingEvents.splice(0, this.config.batchSize);
    const batch: AnchorBatch = {
      id: `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      events,
      merkleRoot: await this.computeMerkleRoot(events),
      timestamp: new Date(),
      status: 'pending'
    };

    try {
      // Submit to blockchain
      batch.blockchainTx = await this.submitToBlockchain(batch);
      batch.status = 'anchored';
      
      log(`Event batch ${batch.id} anchored to blockchain: ${batch.blockchainTx}`);
      this.emit('batch-anchored', batch);
      
    } catch (error) {
      batch.status = 'failed';
      logError(`Failed to anchor event batch ${batch.id}`, error);
      this.emit('batch-failed', batch, error);
    }

    return batch;
  }

  /**
   * Compute hash for a single event
   */
  private async computeEventHash(event: Omit<AnchorableEvent, 'hash'>): Promise<string> {
    const dataString = JSON.stringify({
      id: event.id,
      timestamp: event.timestamp.toISOString(),
      eventType: event.eventType,
      siteId: event.siteId,
      severity: event.severity,
      message: event.message,
      data: event.data
    });
    
    // Simple hash for now - in production would use proper cryptographic hash
    return Buffer.from(dataString).toString('base64').substring(0, 32);
  }

  /**
   * Compute Merkle root for a batch of events
   */
  private async computeMerkleRoot(events: AnchorableEvent[]): Promise<string> {
    if (events.length === 0) return '';
    if (events.length === 1) return events[0].hash || '';

    // Simple implementation - in production would use proper Merkle tree
    const hashes = events.map(e => e.hash || '').sort();
    const combined = hashes.join('');
    return Buffer.from(combined).toString('base64').substring(0, 32);
  }

  /**
   * Submit batch to EventAnchor smart contract
   */
  private async submitToBlockchain(batch: AnchorBatch): Promise<string> {
    // Simulate blockchain interaction
    // In production, this would use ethers.js to call the EventAnchor contract
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate network delay
    
    if (Math.random() < 0.1) {
      throw new Error('Simulated blockchain failure');
    }
    
    return `0x${Math.random().toString(16).substring(2, 18)}...${batch.id.slice(-6)}`;
  }

  /**
   * Get deployed EventAnchor contract address
   */
  private async getDeployedContractAddress(): Promise<string> {
    // In production, this would read from deployment artifacts or registry
    return `0x${Math.random().toString(16).substring(2, 42)}`;
  }
}

// Singleton instance
export const eventAnchorBridge = new EventAnchorBridge();