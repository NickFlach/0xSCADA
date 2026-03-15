/**
 * Failure Handling & Resilience Manager
 * 
 * Provides graceful degradation across the integrity pipeline with circuit breaker patterns,
 * fallback mechanisms, and health status reporting.
 * Part of ADR-0021 Security & Resilience Implementation.
 */

import { EventEmitter } from 'events';
import { MerkleRootSigner, HSMConfig, SignatureResult } from './hsm';
import { EventBatch } from './pipeline';

export interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening circuit
  timeoutMs: number; // Request timeout in milliseconds
  resetTimeoutMs: number; // Time before attempting to close circuit
  monitoringWindowMs: number; // Time window for failure counting
}

export interface ResilienceConfig {
  hsm: {
    enabled: boolean;
    fallbackToSoftware: boolean;
    config: HSMConfig;
  };
  blockchain: {
    enabled: boolean;
    retryAttempts: number;
    retryDelayMs: number;
    queueMaxSize: number;
  };
  merkle: {
    continueOnFailure: boolean;
    maxRetries: number;
  };
  circuitBreaker: CircuitBreakerConfig;
}

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  components: {
    hsm: ComponentHealth;
    blockchain: ComponentHealth;
    merkle: ComponentHealth;
    anchorQueue: ComponentHealth;
  };
  lastCheck: number;
  degradationReasons: string[];
}

export interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: number;
  errors: string[];
  metrics: {
    successRate: number;
    avgResponseTime: number;
    totalRequests: number;
    failedRequests: number;
  };
}

export interface AnchorRetryItem {
  batchId: string;
  merkleRoot: string;
  signature: SignatureResult;
  attempts: number;
  lastAttempt: number;
  nextAttempt: number;
}

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker extends EventEmitter {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private requests = 0;
  private successes = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    super();
    this.config = config;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.emit('state-changed', 'half-open');
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    this.requests++;
    
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Operation timeout')), this.config.timeoutMs)
        )
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.failures = 0;
    
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.emit('state-changed', 'closed');
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.emit('state-changed', 'open');
    }
  }

  getState(): string {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failures: this.failures,
      requests: this.requests,
      successes: this.successes,
      successRate: this.requests > 0 ? this.successes / this.requests : 0,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.requests = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
    this.emit('state-changed', 'closed');
  }
}

/**
 * Main Resilience Manager
 */
export class ResilienceManager extends EventEmitter {
  private config: ResilienceConfig;
  private primarySigner?: MerkleRootSigner;
  private fallbackSigner?: MerkleRootSigner;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private anchorQueue: AnchorRetryItem[] = [];
  private retryTimer?: NodeJS.Timeout;
  private healthStatus: HealthStatus;
  private componentMetrics: Map<string, any> = new Map();

  constructor(config: Partial<ResilienceConfig> = {}) {
    super();
    
    this.config = {
      hsm: {
        enabled: true,
        fallbackToSoftware: true,
        config: {
          mode: 'software',
          algorithm: 'RS256',
        },
        ...config.hsm,
      },
      blockchain: {
        enabled: true,
        retryAttempts: 3,
        retryDelayMs: 5000,
        queueMaxSize: 1000,
        ...config.blockchain,
      },
      merkle: {
        continueOnFailure: true,
        maxRetries: 2,
        ...config.merkle,
      },
      circuitBreaker: {
        failureThreshold: 5,
        timeoutMs: 10000,
        resetTimeoutMs: 60000,
        monitoringWindowMs: 300000,
        ...config.circuitBreaker,
      },
    };

    this.healthStatus = this.initializeHealthStatus();
    this.initializeCircuitBreakers();
  }

  /**
   * Initialize the resilience manager
   */
  async initialize(): Promise<void> {
    // Initialize primary signer (HSM or software)
    if (this.config.hsm.enabled) {
      try {
        this.primarySigner = new MerkleRootSigner(this.config.hsm.config);
        await this.primarySigner.initialize();
        this.updateComponentHealth('hsm', 'healthy');
      } catch (error) {
        this.updateComponentHealth('hsm', 'unhealthy', [`HSM initialization failed: ${error}`]);
        
        if (this.config.hsm.fallbackToSoftware) {
          await this.initializeFallbackSigner();
        }
      }
    } else {
      await this.initializeFallbackSigner();
    }

    // Start retry processing
    if (this.config.blockchain.enabled) {
      this.startRetryProcessing();
    }

    this.emit('initialized');
  }

  /**
   * Resilient Merkle root signing with fallback
   */
  async signMerkleRoot(merkleRoot: string): Promise<SignatureResult> {
    const circuitBreaker = this.circuitBreakers.get('signing');
    
    if (!circuitBreaker) {
      throw new Error('Signing circuit breaker not initialized');
    }

    try {
      return await circuitBreaker.execute(async () => {
        // Try primary signer first
        if (this.primarySigner) {
          try {
            const result = await this.primarySigner.signMerkleRoot(merkleRoot);
            this.recordSuccess('hsm');
            return result;
          } catch (error) {
            this.recordFailure('hsm', error);
            
            if (!this.config.hsm.fallbackToSoftware || !this.fallbackSigner) {
              throw error;
            }
          }
        }

        // Fallback to software signing
        if (this.fallbackSigner) {
          const result = await this.fallbackSigner.signMerkleRoot(merkleRoot);
          this.recordSuccess('hsm');
          this.emit('fallback-used', { component: 'signing', reason: 'Primary signer failed' });
          return result;
        }

        throw new Error('No available signers');
      });
    } catch (error) {
      this.recordFailure('hsm', error);
      throw error;
    }
  }

  /**
   * Resilient blockchain anchoring with retry queue
   */
  async anchorMerkleRoot(batchId: string, merkleRoot: string, signature: SignatureResult): Promise<boolean> {
    const circuitBreaker = this.circuitBreakers.get('blockchain');
    
    if (!circuitBreaker) {
      throw new Error('Blockchain circuit breaker not initialized');
    }

    try {
      return await circuitBreaker.execute(async () => {
        // Simulate blockchain anchoring (replace with actual implementation)
        const success = await this.performBlockchainAnchor(batchId, merkleRoot, signature);
        
        if (success) {
          this.recordSuccess('blockchain');
          return true;
        } else {
          throw new Error('Blockchain anchoring failed');
        }
      });
    } catch (error) {
      this.recordFailure('blockchain', error);
      
      // Add to retry queue if enabled
      if (this.config.blockchain.enabled && this.anchorQueue.length < this.config.blockchain.queueMaxSize) {
        this.queueForRetry(batchId, merkleRoot, signature);
        this.emit('queued-for-retry', { batchId, reason: (error as Error).message });
        return false; // Not immediately successful, but queued for retry
      }
      
      throw error;
    }
  }

  /**
   * Resilient Merkle tree building
   */
  async buildMerkleTree(eventBatch: EventBatch): Promise<{ success: boolean; merkleRoot?: string; error?: string }> {
    const maxRetries = this.config.merkle.maxRetries;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Simulate Merkle tree building (replace with actual implementation)
        const merkleRoot = this.buildMerkleTreeSync(eventBatch);
        this.recordSuccess('merkle');
        
        return {
          success: true,
          merkleRoot,
        };
      } catch (error) {
        lastError = error;
        this.recordFailure('merkle', error);
        
        if (attempt < maxRetries) {
          // Wait before retry
          await this.sleep(1000 * (attempt + 1));
        }
      }
    }

    if (this.config.merkle.continueOnFailure) {
      this.emit('merkle-failure-continued', { batchId: eventBatch.id, error: lastError.message });
      return {
        success: false,
        error: lastError.message,
      };
    } else {
      throw lastError;
    }
  }

  /**
   * Get comprehensive health status
   */
  getHealthStatus(): HealthStatus {
    this.updateOverallHealth();
    return { ...this.healthStatus };
  }

  /**
   * Get detailed component metrics
   */
  getComponentMetrics(): any {
    const metrics: any = {};
    
    for (const [component, data] of this.componentMetrics) {
      metrics[component] = { ...data };
    }

    // Add circuit breaker metrics
    for (const [name, breaker] of this.circuitBreakers) {
      metrics[`circuitBreaker_${name}`] = breaker.getMetrics();
    }

    return metrics;
  }

  /**
   * Manually trigger health check for all components
   */
  async performHealthCheck(): Promise<HealthStatus> {
    // Check HSM health
    if (this.primarySigner) {
      try {
        await this.primarySigner.listKeys();
        this.updateComponentHealth('hsm', 'healthy');
      } catch (error) {
        this.updateComponentHealth('hsm', 'unhealthy', [`Health check failed: ${error}`]);
      }
    }

    // Check anchor queue health
    const queueUsage = this.anchorQueue.length / this.config.blockchain.queueMaxSize;
    if (queueUsage > 0.8) {
      this.updateComponentHealth('anchorQueue', 'degraded', ['Queue nearly full']);
    } else if (queueUsage > 0.5) {
      this.updateComponentHealth('anchorQueue', 'degraded', ['Queue usage high']);
    } else {
      this.updateComponentHealth('anchorQueue', 'healthy');
    }

    return this.getHealthStatus();
  }

  /**
   * Reset all circuit breakers
   */
  resetCircuitBreakers(): void {
    this.circuitBreakers.forEach(breaker => breaker.reset());
    this.emit('circuit-breakers-reset');
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }

    if (this.primarySigner) {
      await this.primarySigner.cleanup();
    }

    if (this.fallbackSigner) {
      await this.fallbackSigner.cleanup();
    }

    this.emit('cleanup');
  }

  /**
   * Initialize fallback software signer
   */
  private async initializeFallbackSigner(): Promise<void> {
    const fallbackConfig: HSMConfig = {
      ...this.config.hsm.config,
      mode: 'software',
    };

    this.fallbackSigner = new MerkleRootSigner(fallbackConfig);
    await this.fallbackSigner.initialize();
    this.updateComponentHealth('hsm', 'degraded', ['Using software fallback']);
  }

  /**
   * Initialize circuit breakers for different components
   */
  private initializeCircuitBreakers(): void {
    this.circuitBreakers.set('signing', new CircuitBreaker(this.config.circuitBreaker));
    this.circuitBreakers.set('blockchain', new CircuitBreaker(this.config.circuitBreaker));
    this.circuitBreakers.set('merkle', new CircuitBreaker(this.config.circuitBreaker));

    // Listen for circuit breaker state changes
    this.circuitBreakers.forEach((breaker, name) => {
      breaker.on('state-changed', (state) => {
        this.emit('circuit-breaker-state-changed', { component: name, state });
      });
    });
  }

  /**
   * Queue failed anchor for retry
   */
  private queueForRetry(batchId: string, merkleRoot: string, signature: SignatureResult): void {
    const retryItem: AnchorRetryItem = {
      batchId,
      merkleRoot,
      signature,
      attempts: 0,
      lastAttempt: 0,
      nextAttempt: Date.now() + this.config.blockchain.retryDelayMs,
    };

    this.anchorQueue.push(retryItem);
  }

  /**
   * Start retry processing timer
   */
  private startRetryProcessing(): void {
    this.retryTimer = setInterval(() => {
      this.processRetryQueue();
    }, this.config.blockchain.retryDelayMs);
  }

  /**
   * Process items in the retry queue
   */
  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const itemsToRetry = this.anchorQueue.filter(item => item.nextAttempt <= now);

    for (const item of itemsToRetry) {
      if (item.attempts >= this.config.blockchain.retryAttempts) {
        // Remove failed items that exceeded max attempts
        this.anchorQueue = this.anchorQueue.filter(i => i !== item);
        this.emit('retry-exhausted', { batchId: item.batchId });
        continue;
      }

      try {
        const success = await this.performBlockchainAnchor(item.batchId, item.merkleRoot, item.signature);
        
        if (success) {
          // Remove successful items
          this.anchorQueue = this.anchorQueue.filter(i => i !== item);
          this.emit('retry-succeeded', { batchId: item.batchId, attempts: item.attempts + 1 });
        } else {
          // Schedule next retry
          item.attempts++;
          item.lastAttempt = now;
          item.nextAttempt = now + (this.config.blockchain.retryDelayMs * Math.pow(2, item.attempts)); // Exponential backoff
        }
      } catch (error) {
        // Schedule next retry
        item.attempts++;
        item.lastAttempt = now;
        item.nextAttempt = now + (this.config.blockchain.retryDelayMs * Math.pow(2, item.attempts));
        
        this.emit('retry-failed', { batchId: item.batchId, attempts: item.attempts, error: (error as Error).message });
      }
    }
  }

  /**
   * Perform blockchain anchor operation (placeholder)
   */
  private async performBlockchainAnchor(batchId: string, merkleRoot: string, signature: SignatureResult): Promise<boolean> {
    // Simulate blockchain anchoring
    // In real implementation, this would:
    // 1. Connect to blockchain node
    // 2. Submit anchoring transaction
    // 3. Wait for confirmation
    // 4. Return success/failure
    
    await this.sleep(100); // Simulate network delay
    return Math.random() > 0.1; // 90% success rate for simulation
  }

  /**
   * Simulate Merkle tree building (placeholder)
   */
  private buildMerkleTreeSync(eventBatch: EventBatch): string {
    // In real implementation, this would use the MerkleTreeBuilder
    return `merkle_root_${eventBatch.id}_${eventBatch.batchHash}`;
  }

  /**
   * Record successful operation
   */
  private recordSuccess(component: string): void {
    const metrics = this.componentMetrics.get(component) || { requests: 0, failures: 0, responseTimes: [] };
    metrics.requests++;
    metrics.responseTimes.push(Date.now());
    
    // Keep only recent response times (last 100)
    if (metrics.responseTimes.length > 100) {
      metrics.responseTimes = metrics.responseTimes.slice(-100);
    }
    
    this.componentMetrics.set(component, metrics);
  }

  /**
   * Record failed operation
   */
  private recordFailure(component: string, error: any): void {
    const metrics = this.componentMetrics.get(component) || { requests: 0, failures: 0, responseTimes: [], errors: [] };
    metrics.requests++;
    metrics.failures++;
    metrics.errors.push({
      message: error.message,
      timestamp: Date.now(),
    });
    
    // Keep only recent errors (last 50)
    if (metrics.errors.length > 50) {
      metrics.errors = metrics.errors.slice(-50);
    }
    
    this.componentMetrics.set(component, metrics);
  }

  /**
   * Update component health status
   */
  private updateComponentHealth(component: keyof HealthStatus['components'], status: ComponentHealth['status'], errors: string[] = []): void {
    const metrics = this.componentMetrics.get(component) || { requests: 0, failures: 0 };
    
    this.healthStatus.components[component] = {
      status,
      lastCheck: Date.now(),
      errors,
      metrics: {
        successRate: metrics.requests > 0 ? (metrics.requests - metrics.failures) / metrics.requests : 1,
        avgResponseTime: 0, // Calculate if needed
        totalRequests: metrics.requests,
        failedRequests: metrics.failures,
      },
    };
  }

  /**
   * Update overall health status
   */
  private updateOverallHealth(): void {
    const components = Object.values(this.healthStatus.components);
    const unhealthyCount = components.filter(c => c.status === 'unhealthy').length;
    const degradedCount = components.filter(c => c.status === 'degraded').length;

    if (unhealthyCount > 0) {
      this.healthStatus.overall = 'unhealthy';
    } else if (degradedCount > 0) {
      this.healthStatus.overall = 'degraded';
    } else {
      this.healthStatus.overall = 'healthy';
    }

    this.healthStatus.lastCheck = Date.now();
  }

  /**
   * Initialize health status structure
   */
  private initializeHealthStatus(): HealthStatus {
    return {
      overall: 'healthy',
      components: {
        hsm: {
          status: 'healthy',
          lastCheck: Date.now(),
          errors: [],
          metrics: { successRate: 1, avgResponseTime: 0, totalRequests: 0, failedRequests: 0 },
        },
        blockchain: {
          status: 'healthy',
          lastCheck: Date.now(),
          errors: [],
          metrics: { successRate: 1, avgResponseTime: 0, totalRequests: 0, failedRequests: 0 },
        },
        merkle: {
          status: 'healthy',
          lastCheck: Date.now(),
          errors: [],
          metrics: { successRate: 1, avgResponseTime: 0, totalRequests: 0, failedRequests: 0 },
        },
        anchorQueue: {
          status: 'healthy',
          lastCheck: Date.now(),
          errors: [],
          metrics: { successRate: 1, avgResponseTime: 0, totalRequests: 0, failedRequests: 0 },
        },
      },
      lastCheck: Date.now(),
      degradationReasons: [],
    };
  }

  /**
   * Utility: sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get manager status
   */
  getStatus() {
    return {
      config: this.config,
      anchorQueueSize: this.anchorQueue.length,
      circuitBreakers: Array.from(this.circuitBreakers.keys()).map(name => ({
        name,
        state: this.circuitBreakers.get(name)?.getState(),
      })),
      signers: {
        primary: !!this.primarySigner,
        fallback: !!this.fallbackSigner,
      },
    };
  }
}

export default ResilienceManager;