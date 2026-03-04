/**
 * Proof Verification Client
 * 
 * Client that takes an event, generates/retrieves its Merkle inclusion proof,
 * and verifies it against the on-chain anchor. Provides cryptographic proof
 * that events are authentic and haven't been tampered with.
 * 
 * Part of the Dual-Time Control Plane (ADR-0021) - Requirement #294.
 */

import { ethers } from 'ethers';
import { MerkleTreeBuilder, MerkleProof } from './merkle.js';
import { HashedEvent, EventBatch } from './pipeline.js';

export interface VerificationRequest {
  eventId: string;
  eventHash?: string;
  batchId?: number;
}

export interface VerificationResult {
  valid: boolean;
  eventHash: string;
  proof?: MerkleProof;
  anchored: boolean;
  batchId?: number;
  blockNumber?: number;
  transactionHash?: string;
  error?: string;
  verifiedAt: number;
}

export interface ProofCache {
  eventId: string;
  eventHash: string;
  batchId: number;
  proof: MerkleProof;
  cached: number;
  ttl: number;
}

export interface VerifierConfig {
  // Blockchain connection
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  
  // Cache configuration
  proofCacheTtlMs: number;
  maxCacheSize: number;
  
  // Storage interfaces (implement based on your storage backend)
  eventStorage?: EventStorageInterface;
  batchStorage?: BatchStorageInterface;
}

export interface EventStorageInterface {
  getEvent(eventId: string): Promise<HashedEvent | null>;
  getEventsByBatch(batchId: number): Promise<HashedEvent[]>;
}

export interface BatchStorageInterface {
  getBatch(batchId: number): Promise<EventBatch | null>;
  getBatchForEvent(eventId: string): Promise<EventBatch | null>;
}

/**
 * Proof Verification Client
 * 
 * Handles end-to-end verification of event integrity using Merkle proofs
 * and blockchain anchoring.
 */
export class ProofVerificationClient {
  private config: VerifierConfig;
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private proofCache: Map<string, ProofCache> = new Map();
  
  // Event Anchor contract ABI (read-only functions)
  private static readonly CONTRACT_ABI = [
    'function verify(bytes32 merkleRoot) external view returns (bool exists, uint256 batchId)',
    'function getAnchor(uint256 batchId) external view returns (tuple(bytes32 merkleRoot, uint256 eventCount, uint256 timestamp, bool exists))',
    'function getCurrentBatchId() external view returns (uint256)',
    'event Anchored(uint256 indexed batchId, bytes32 merkleRoot, uint256 eventCount, uint256 timestamp)'
  ];

  constructor(config: VerifierConfig) {
    this.config = {
      proofCacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours default
      maxCacheSize: 10000, // 10k proofs max
      ...config
    };

    this.initializeBlockchainConnection();
    this.startCacheCleanup();
  }

  /**
   * Initialize blockchain connection and contract interface
   */
  private initializeBlockchainConnection(): void {
    this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    this.contract = new ethers.Contract(
      this.config.contractAddress,
      ProofVerificationClient.CONTRACT_ABI,
      this.provider
    );
  }

  /**
   * Verify an event's integrity using its Merkle proof and blockchain anchor
   */
  public async verifyEvent(
    eventHash: string,
    proof: MerkleProof,
    batchId: number
  ): Promise<VerificationResult> {
    const verifiedAt = Date.now();

    try {
      // Step 1: Verify the Merkle proof mathematically
      const proofValid = MerkleTreeBuilder.verifyProof(proof);
      if (!proofValid) {
        return {
          valid: false,
          eventHash,
          anchored: false,
          error: 'Invalid Merkle proof',
          verifiedAt
        };
      }

      // Step 2: Get the anchor data from blockchain
      const anchorData = await this.contract.getAnchor(batchId);
      if (!anchorData.exists) {
        return {
          valid: false,
          eventHash,
          anchored: false,
          batchId,
          error: 'Batch not anchored on blockchain',
          verifiedAt
        };
      }

      // Step 3: Verify the proof's root matches the anchored root
      const anchoredRoot = anchorData.merkleRoot;
      if (proof.root !== anchoredRoot) {
        return {
          valid: false,
          eventHash,
          anchored: true,
          batchId,
          error: 'Proof root does not match anchored root',
          verifiedAt
        };
      }

      // Step 4: Get transaction details for full verification context
      const { blockNumber, transactionHash } = await this.getAnchorTransactionDetails(batchId);

      return {
        valid: true,
        eventHash,
        proof,
        anchored: true,
        batchId,
        blockNumber,
        transactionHash,
        verifiedAt
      };

    } catch (error) {
      return {
        valid: false,
        eventHash,
        anchored: false,
        batchId,
        error: `Verification failed: ${(error as Error).message}`,
        verifiedAt
      };
    }
  }

  /**
   * Get a Merkle inclusion proof for a specific event
   */
  public async getProofForEvent(eventId: string): Promise<MerkleProof | null> {
    try {
      // Check cache first
      const cached = this.proofCache.get(eventId);
      if (cached && Date.now() - cached.cached < cached.ttl) {
        return cached.proof;
      }

      // Get event from storage
      if (!this.config.eventStorage) {
        throw new Error('Event storage interface not configured');
      }

      const event = await this.config.eventStorage.getEvent(eventId);
      if (!event) {
        throw new Error(`Event ${eventId} not found`);
      }

      // Get batch containing this event
      if (!this.config.batchStorage) {
        throw new Error('Batch storage interface not configured');
      }

      const batch = await this.config.batchStorage.getBatchForEvent(eventId);
      if (!batch) {
        throw new Error(`Batch for event ${eventId} not found`);
      }

      // Generate Merkle proof
      const proof = await this.generateProofForEventInBatch(event, batch);
      if (!proof) {
        throw new Error(`Could not generate proof for event ${eventId}`);
      }

      // Cache the proof
      this.cacheProof(eventId, event.hash, batch.id, proof);

      return proof;

    } catch (error) {
      console.error(`Failed to get proof for event ${eventId}:`, error);
      return null;
    }
  }

  /**
   * Generate Merkle proof for an event within its batch
   */
  private async generateProofForEventInBatch(
    event: HashedEvent,
    batch: EventBatch
  ): Promise<MerkleProof | null> {
    try {
      // Get all events in the batch ordered by the original sequence
      const eventHashes = batch.events.map(e => e.hash);
      
      // Build Merkle tree
      const treeResult = MerkleTreeBuilder.buildTree(eventHashes);
      
      // Find event index in the batch
      const eventIndex = batch.events.findIndex(e => e.id === event.id);
      if (eventIndex === -1) {
        throw new Error('Event not found in batch');
      }

      // Generate proof
      const proof = MerkleTreeBuilder.generateProof(treeResult.tree, eventIndex);
      if (!proof) {
        throw new Error('Failed to generate Merkle proof');
      }

      return proof;

    } catch (error) {
      console.error('Failed to generate proof for event in batch:', error);
      return null;
    }
  }

  /**
   * Get transaction details for an anchor by searching for the Anchored event
   */
  private async getAnchorTransactionDetails(batchId: number): Promise<{
    blockNumber?: number;
    transactionHash?: string;
  }> {
    try {
      // Search for Anchored events with this batchId
      const filter = this.contract.filters.Anchored(batchId);
      const events = await this.contract.queryFilter(filter);
      
      if (events.length > 0) {
        const event = events[0]; // Should only be one anchor per batch
        return {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash
        };
      }
    } catch (error) {
      console.warn(`Failed to get transaction details for batch ${batchId}:`, error);
    }

    return {};
  }

  /**
   * Verify multiple events in batch for efficiency
   */
  public async verifyEventBatch(
    verificationRequests: Array<{ eventHash: string; proof: MerkleProof; batchId: number }>
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    
    // Group by batch for efficient anchor retrieval
    const batchGroups = new Map<number, typeof verificationRequests>();
    
    for (const request of verificationRequests) {
      if (!batchGroups.has(request.batchId)) {
        batchGroups.set(request.batchId, []);
      }
      batchGroups.get(request.batchId)!.push(request);
    }

    // Process each batch group
    for (const [batchId, requests] of batchGroups) {
      try {
        // Get anchor data once per batch
        const anchorData = await this.contract.getAnchor(batchId);
        const { blockNumber, transactionHash } = await this.getAnchorTransactionDetails(batchId);

        // Verify each request in the batch
        for (const request of requests) {
          const result = await this.verifyEventWithAnchor(
            request.eventHash,
            request.proof,
            batchId,
            anchorData,
            blockNumber,
            transactionHash
          );
          results.push(result);
        }
      } catch (error) {
        // If batch anchor fails, mark all requests as failed
        for (const request of requests) {
          results.push({
            valid: false,
            eventHash: request.eventHash,
            anchored: false,
            batchId,
            error: `Batch verification failed: ${(error as Error).message}`,
            verifiedAt: Date.now()
          });
        }
      }
    }

    return results;
  }

  /**
   * Verify event with pre-fetched anchor data
   */
  private async verifyEventWithAnchor(
    eventHash: string,
    proof: MerkleProof,
    batchId: number,
    anchorData: any,
    blockNumber?: number,
    transactionHash?: string
  ): Promise<VerificationResult> {
    const verifiedAt = Date.now();

    // Verify Merkle proof
    const proofValid = MerkleTreeBuilder.verifyProof(proof);
    if (!proofValid) {
      return {
        valid: false,
        eventHash,
        anchored: false,
        batchId,
        error: 'Invalid Merkle proof',
        verifiedAt
      };
    }

    // Check if batch is anchored
    if (!anchorData.exists) {
      return {
        valid: false,
        eventHash,
        anchored: false,
        batchId,
        error: 'Batch not anchored on blockchain',
        verifiedAt
      };
    }

    // Verify proof root matches anchored root
    if (proof.root !== anchorData.merkleRoot) {
      return {
        valid: false,
        eventHash,
        anchored: true,
        batchId,
        error: 'Proof root does not match anchored root',
        verifiedAt
      };
    }

    return {
      valid: true,
      eventHash,
      proof,
      anchored: true,
      batchId,
      blockNumber,
      transactionHash,
      verifiedAt
    };
  }

  /**
   * Cache a proof with TTL
   */
  private cacheProof(eventId: string, eventHash: string, batchId: number, proof: MerkleProof): void {
    // Enforce cache size limit
    if (this.proofCache.size >= this.config.maxCacheSize) {
      this.cleanupCache(Math.floor(this.config.maxCacheSize * 0.1)); // Remove oldest 10%
    }

    this.proofCache.set(eventId, {
      eventId,
      eventHash,
      batchId,
      proof,
      cached: Date.now(),
      ttl: this.config.proofCacheTtlMs
    });
  }

  /**
   * Start periodic cache cleanup
   */
  private startCacheCleanup(): void {
    setInterval(() => {
      this.cleanupCache();
    }, 60 * 60 * 1000); // Cleanup every hour
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(maxToRemove?: number): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, cache] of this.proofCache) {
      if (now - cache.cached > cache.ttl) {
        toRemove.push(key);
      }
    }

    // If maxToRemove is specified, also remove oldest entries
    if (maxToRemove && toRemove.length < maxToRemove) {
      const remainingToRemove = maxToRemove - toRemove.length;
      const sortedEntries = Array.from(this.proofCache.entries())
        .filter(([key]) => !toRemove.includes(key))
        .sort(([,a], [,b]) => a.cached - b.cached);
      
      for (let i = 0; i < remainingToRemove && i < sortedEntries.length; i++) {
        toRemove.push(sortedEntries[i][0]);
      }
    }

    // Remove entries
    toRemove.forEach(key => this.proofCache.delete(key));

    if (toRemove.length > 0) {
      console.log(`Cleaned up ${toRemove.length} expired proof cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    size: number;
    maxSize: number;
    hitRate?: number;
    oldestEntry?: number;
  } {
    let oldestEntry: number | undefined;
    
    if (this.proofCache.size > 0) {
      oldestEntry = Math.min(...Array.from(this.proofCache.values()).map(c => c.cached));
    }

    return {
      size: this.proofCache.size,
      maxSize: this.config.maxCacheSize,
      oldestEntry
    };
  }

  /**
   * Clear all cached proofs
   */
  public clearCache(): void {
    this.proofCache.clear();
  }

  /**
   * Check blockchain connection health
   */
  public async getHealth(): Promise<{ connected: boolean; blockNumber?: number; error?: string }> {
    try {
      const blockNumber = await this.provider.getBlockNumber();
      return { connected: true, blockNumber };
    } catch (error) {
      return { connected: false, error: (error as Error).message };
    }
  }
}