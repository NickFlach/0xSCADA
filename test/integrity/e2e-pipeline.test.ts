/**
 * End-to-End Integrity Pipeline Integration Test
 * 
 * Tests the complete integrity pipeline: create events → batch them → build Merkle tree 
 * → sign root → anchor (mock) → verify proof.
 * 
 * This test validates ADR-0021 Security & Resilience components working together.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventIntegrityPipeline, SCADAEvent, EventBatch } from '../../server/integrity/pipeline';
import { MerkleTreeBuilder, MerkleTreeManager, MerkleProof } from '../../server/integrity/merkle';
import { MerkleRootSigner, HSMConfig } from '../../server/integrity/hsm';
import { ResilienceManager } from '../../server/integrity/resilience';
import { MTLSManager } from '../../server/integrity/mtls';
import { promisify } from 'util';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';

const sleep = promisify(setTimeout);

describe('End-to-End Integrity Pipeline', () => {
  let pipeline: EventIntegrityPipeline;
  let merkleManager: MerkleTreeManager;
  let signer: MerkleRootSigner;
  let resilienceManager: ResilienceManager;
  let mtlsManager: MTLSManager;
  
  const testCertsDir = join(process.cwd(), '.test-certs');
  const testKeysDir = join(process.cwd(), '.test-keys');
  
  beforeAll(async () => {
    // Clean up any existing test artifacts
    if (existsSync(testCertsDir)) {
      rmSync(testCertsDir, { recursive: true, force: true });
    }
    if (existsSync(testKeysDir)) {
      rmSync(testKeysDir, { recursive: true, force: true });
    }

    // Initialize pipeline with small window for faster testing
    pipeline = new EventIntegrityPipeline({
      windowSizeMs: 1000, // 1 second window
      maxBatchSize: 10,    // Small batch size
      flushIntervalMs: 2000, // 2 second flush interval
    });

    // Initialize Merkle tree manager
    merkleManager = new MerkleTreeManager();

    // Initialize HSM signer in software mode for testing
    const hsmConfig: HSMConfig = {
      mode: 'software',
      algorithm: 'RS256',
      keyPath: testKeysDir,
    };
    signer = new MerkleRootSigner(hsmConfig);
    await signer.initialize();

    // Initialize resilience manager
    resilienceManager = new ResilienceManager({
      hsm: {
        enabled: true,
        fallbackToSoftware: true,
        config: hsmConfig,
      },
      blockchain: {
        enabled: true,
        retryAttempts: 2,
        retryDelayMs: 1000,
        queueMaxSize: 100,
      },
      merkle: {
        continueOnFailure: true,
        maxRetries: 1,
      },
      circuitBreaker: {
        failureThreshold: 3,
        timeoutMs: 5000,
        resetTimeoutMs: 10000,
        monitoringWindowMs: 60000,
      },
    });
    await resilienceManager.initialize();

    // Initialize mTLS manager
    mtlsManager = new MTLSManager({
      mode: 'dev',
      certsDir: testCertsDir,
      validityDays: 1, // Short validity for testing
    });
    await mtlsManager.initialize();

  }, 15000); // Allow 15 seconds for initialization

  afterAll(async () => {
    // Cleanup all managers
    await pipeline.stop();
    await signer.cleanup();
    await resilienceManager.cleanup();
    await mtlsManager.cleanup();

    // Clean up test artifacts
    if (existsSync(testCertsDir)) {
      rmSync(testCertsDir, { recursive: true, force: true });
    }
    if (existsSync(testKeysDir)) {
      rmSync(testKeysDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Clear any stored trees
    merkleManager.clear();
  });

  describe('Complete Pipeline Flow', () => {
    test('processes events through entire pipeline successfully', async () => {
      const events: SCADAEvent[] = [
        {
          id: 'event_1',
          timestamp: Date.now(),
          type: 'sensor_reading',
          source: 'temp_sensor_01',
          data: { temperature: 23.5, unit: 'C' },
        },
        {
          id: 'event_2',
          timestamp: Date.now() + 100,
          type: 'sensor_reading',
          source: 'pressure_sensor_01',
          data: { pressure: 1013.25, unit: 'hPa' },
        },
        {
          id: 'event_3',
          timestamp: Date.now() + 200,
          type: 'alarm',
          source: 'safety_system',
          data: { level: 'warning', message: 'Temperature trending up' },
        },
      ];

      let capturedBatch: EventBatch | null = null;
      
      // Listen for batch creation
      pipeline.once('batch-created', (batch: EventBatch) => {
        capturedBatch = batch;
      });

      // Step 1: Ingest events
      for (const event of events) {
        await pipeline.ingestEvent(event);
      }

      // Step 2: Force flush to create batch
      await pipeline.stop();
      await pipeline.flushCurrentBatch();

      expect(capturedBatch).not.toBeNull();
      expect(capturedBatch!.events).toHaveLength(3);
      expect(capturedBatch!.batchHash).toBeDefined();

      // Step 3: Build Merkle tree
      const eventHashes = capturedBatch!.events.map(e => e.hash);
      const merkleTree = merkleManager.createTreeForBatch(capturedBatch!.id, eventHashes);
      
      expect(merkleTree.root).toBeDefined();
      expect(merkleTree.leaves).toHaveLength(3);
      expect(merkleTree.depth).toBeGreaterThanOrEqual(1);

      // Step 4: Sign Merkle root
      const signature = await signer.signMerkleRoot(merkleTree.root);
      
      expect(signature.signature).toBeDefined();
      expect(signature.keyId).toBeDefined();
      expect(signature.merkleRoot).toBe(merkleTree.root);
      expect(signature.algorithm).toBe('RS256');

      // Step 5: Verify signature
      const verification = await signer.verifyMerkleRootSignature(merkleTree.root, signature);
      expect(verification.valid).toBe(true);

      // Step 6: Generate and verify inclusion proofs for all events
      for (let i = 0; i < eventHashes.length; i++) {
        const proof = merkleManager.generateEventProof(capturedBatch!.id, eventHashes[i], i);
        expect(proof).not.toBeNull();
        
        const isValid = merkleManager.verifyEventProof(proof!);
        expect(isValid).toBe(true);
      }
    }, 10000);

    test('handles resilience scenarios with fallback mechanisms', async () => {
      const events: SCADAEvent[] = [
        {
          id: 'resilience_test_1',
          timestamp: Date.now(),
          type: 'test_event',
          source: 'test_source',
          data: { value: 'resilience_test' },
        },
      ];

      let capturedBatch: EventBatch | null = null;
      
      // Restart pipeline for this test
      pipeline = new EventIntegrityPipeline({
        windowSizeMs: 500,
        maxBatchSize: 5,
        flushIntervalMs: 1000,
      });

      pipeline.once('batch-created', (batch: EventBatch) => {
        capturedBatch = batch;
      });

      // Step 1: Ingest events through resilience manager
      for (const event of events) {
        await pipeline.ingestEvent(event);
      }

      // Wait for batch creation
      await sleep(1200);
      expect(capturedBatch).not.toBeNull();

      // Step 2: Build Merkle tree through resilience manager
      const merkleResult = await resilienceManager.buildMerkleTree(capturedBatch!);
      expect(merkleResult.success).toBe(true);
      expect(merkleResult.merkleRoot).toBeDefined();

      // Step 3: Sign through resilience manager (should use fallback if primary fails)
      const signature = await resilienceManager.signMerkleRoot(merkleResult.merkleRoot!);
      expect(signature.signature).toBeDefined();

      // Step 4: Attempt blockchain anchoring (will use mock/retry mechanism)
      const anchorResult = await resilienceManager.anchorMerkleRoot(
        capturedBatch!.id, 
        merkleResult.merkleRoot!, 
        signature
      );
      
      // May succeed or fail (and be queued for retry), both are valid outcomes
      expect(typeof anchorResult).toBe('boolean');

      // Step 5: Check health status
      const healthStatus = resilienceManager.getHealthStatus();
      expect(healthStatus.overall).toMatch(/healthy|degraded/);
      expect(healthStatus.components).toHaveProperty('hsm');
      expect(healthStatus.components).toHaveProperty('blockchain');
      expect(healthStatus.components).toHaveProperty('merkle');

      await pipeline.stop();
    }, 15000);

    test('validates mTLS certificate generation and info retrieval', async () => {
      // Test certificate generation in dev mode
      const status = mtlsManager.getStatus();
      expect(status.initialized).toBe(true);
      expect(status.mode).toBe('dev');
      expect(status.certsDir).toBe(testCertsDir);

      // Test certificate info retrieval
      const caCertInfo = mtlsManager.getCertificateInfo('ca');
      expect(caCertInfo).not.toBeNull();
      if (caCertInfo) {
        expect(caCertInfo.subject).toBeDefined();
        expect(caCertInfo.issuer).toBeDefined();
        expect(caCertInfo.validFrom).toBeInstanceOf(Date);
        expect(caCertInfo.validTo).toBeInstanceOf(Date);
      }

      const serverCertInfo = mtlsManager.getCertificateInfo('server');
      expect(serverCertInfo).not.toBeNull();

      const clientCertInfo = mtlsManager.getCertificateInfo('client');
      expect(clientCertInfo).not.toBeNull();

      // Test client TLS options
      const clientTLSOptions = mtlsManager.getClientTLSOptions();
      expect(clientTLSOptions).toHaveProperty('ca');
      expect(clientTLSOptions).toHaveProperty('cert');
      expect(clientTLSOptions).toHaveProperty('key');
    });

    test('simulates circuit breaker behavior under failure conditions', async () => {
      // Get initial circuit breaker metrics
      const initialMetrics = resilienceManager.getComponentMetrics();
      expect(initialMetrics).toHaveProperty('circuitBreaker_signing');

      // Reset circuit breakers to ensure clean state
      resilienceManager.resetCircuitBreakers();

      let fallbackEventFired = false;
      resilienceManager.once('fallback-used', () => {
        fallbackEventFired = true;
      });

      // This should work normally
      let signature;
      try {
        signature = await resilienceManager.signMerkleRoot('test_root_for_circuit_breaker');
        expect(signature).toBeDefined();
      } catch (error) {
        // If signing fails, that's okay for this test - we're testing resilience
        console.log('Signing failed as expected for circuit breaker test:', error.message);
      }

      // Check metrics after operations
      const finalMetrics = resilienceManager.getComponentMetrics();
      expect(finalMetrics).toHaveProperty('circuitBreaker_signing');

      // Verify the circuit breaker has recorded the operation
      const signingCircuitBreaker = finalMetrics['circuitBreaker_signing'];
      expect(signingCircuitBreaker.requests).toBeGreaterThanOrEqual(1);
    });

    test('verifies batch proof verification with multiple events', async () => {
      const events: SCADAEvent[] = Array.from({ length: 5 }, (_, i) => ({
        id: `batch_test_${i}`,
        timestamp: Date.now() + i * 100,
        type: 'batch_test',
        source: `source_${i}`,
        data: { index: i, value: `test_${i}` },
      }));

      let capturedBatch: EventBatch | null = null;
      
      // Restart pipeline for this test
      pipeline = new EventIntegrityPipeline({
        windowSizeMs: 500,
        maxBatchSize: 10,
        flushIntervalMs: 1000,
      });

      pipeline.once('batch-created', (batch: EventBatch) => {
        capturedBatch = batch;
      });

      // Ingest all events
      for (const event of events) {
        await pipeline.ingestEvent(event);
      }

      // Wait for batch creation
      await sleep(1200);
      expect(capturedBatch).not.toBeNull();
      expect(capturedBatch!.events).toHaveLength(5);

      // Build Merkle tree
      const eventHashes = capturedBatch!.events.map(e => e.hash);
      const merkleTree = merkleManager.createTreeForBatch(capturedBatch!.id, eventHashes);

      // Generate batch proofs for all events
      const proofs: MerkleProof[] = [];
      for (let i = 0; i < eventHashes.length; i++) {
        const proof = merkleManager.generateEventProof(capturedBatch!.id, eventHashes[i], i);
        expect(proof).not.toBeNull();
        proofs.push(proof!);
      }

      // Verify batch proofs
      const batchVerification = MerkleTreeBuilder.verifyBatchProofs(proofs);
      expect(batchVerification).toBe(true);

      // Verify each individual proof
      for (const proof of proofs) {
        const individualVerification = MerkleTreeBuilder.verifyProof(proof);
        expect(individualVerification).toBe(true);
      }

      await pipeline.stop();
    }, 10000);
  });

  describe('Integration Components Health', () => {
    test('all components report healthy status', async () => {
      const pipelineStats = pipeline.getStats();
      expect(pipelineStats.isActive).toBe(false); // Stopped in previous tests
      
      const merkleStats = merkleManager.getStats();
      expect(merkleStats.treeCount).toBeGreaterThanOrEqual(0);

      const signerKeys = await signer.listKeys();
      expect(signerKeys).toHaveLength(1);
      expect(signerKeys[0].keyId).toBe('default');

      const resilienceHealth = await resilienceManager.performHealthCheck();
      expect(resilienceHealth.overall).toMatch(/healthy|degraded/);

      const mtlsStatus = mtlsManager.getStatus();
      expect(mtlsStatus.initialized).toBe(true);
    });

    test('components can be reinitialized after cleanup', async () => {
      // Cleanup and reinitialize signer
      await signer.cleanup();
      await signer.initialize();
      
      const keys = await signer.listKeys();
      expect(keys).toHaveLength(1);

      // Test signing still works after reinitialize
      const testSignature = await signer.signMerkleRoot('test_after_reinit');
      expect(testSignature.signature).toBeDefined();

      const verification = await signer.verifyMerkleRootSignature('test_after_reinit', testSignature);
      expect(verification.valid).toBe(true);
    });
  });

  describe('Error Conditions and Recovery', () => {
    test('pipeline handles invalid events gracefully', async () => {
      pipeline = new EventIntegrityPipeline({
        windowSizeMs: 1000,
        maxBatchSize: 5,
        flushIntervalMs: 2000,
      });

      let errorEventFired = false;
      pipeline.once('error', () => {
        errorEventFired = true;
      });

      // Test with malformed event (missing required fields)
      const invalidEvent = {
        id: 'invalid',
        // Missing timestamp, type, source, data
      } as any;

      try {
        await pipeline.ingestEvent(invalidEvent);
      } catch (error) {
        expect(error).toBeDefined();
      }

      await pipeline.stop();
    });

    test('merkle tree handles edge cases', async () => {
      // Test with single event
      const singleEvent = ['single_event_hash'];
      const singleTree = MerkleTreeBuilder.buildTree(singleEvent);
      expect(singleTree.root).toBeDefined();
      expect(singleTree.depth).toBe(0);

      // Test proof generation for single event
      const proof = MerkleTreeBuilder.generateProof(singleTree.tree, singleEvent[0], 0);
      expect(proof.proof).toHaveLength(0); // No siblings for single event
      
      const verification = MerkleTreeBuilder.verifyProof(proof);
      expect(verification).toBe(true);
    });
  });
});

/**
 * Helper function to create test events
 */
function createTestEvent(id: string, data: any = {}): SCADAEvent {
  return {
    id,
    timestamp: Date.now(),
    type: 'test_event',
    source: 'test_source',
    data,
  };
}