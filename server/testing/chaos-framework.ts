/**
 * Chaos Engineering Framework
 * 
 * Issue #49 — Chaos primitives for testing SCADA system resilience.
 * Inject faults: network delays, service failures, resource exhaustion,
 * connection drops.
 */

import { EventEmitter } from 'events';

// =============================================================================
// TYPES
// =============================================================================

export type ChaosExperimentType =
  | 'network-delay'
  | 'service-failure'
  | 'resource-exhaustion'
  | 'connection-drop'
  | 'clock-skew'
  | 'packet-loss';

export interface ChaosExperiment {
  id: string;
  type: ChaosExperimentType;
  target: string;
  config: Record<string, unknown>;
  startedAt?: Date;
  stoppedAt?: Date;
  active: boolean;
}

export interface NetworkDelayConfig {
  delayMs: number;
  jitterMs?: number;
  /** Percentage of requests to delay (0-100) */
  percentage?: number;
}

export interface ServiceFailureConfig {
  /** HTTP status code to return */
  statusCode: number;
  /** Percentage of requests to fail */
  percentage: number;
  /** Error message */
  message?: string;
}

export interface ResourceExhaustionConfig {
  /** Type: memory, cpu, fd (file descriptors) */
  resource: 'memory' | 'cpu' | 'connections';
  /** Intensity 0-100 */
  intensity: number;
  /** Duration in ms */
  durationMs: number;
}

export interface ConnectionDropConfig {
  /** Drop every Nth connection */
  dropEvery: number;
  /** Or drop percentage */
  percentage?: number;
}

// =============================================================================
// CHAOS FRAMEWORK
// =============================================================================

export class ChaosFramework extends EventEmitter {
  private experiments: Map<string, ChaosExperiment> = new Map();
  private interceptors: Map<string, (req: any, res: any, next: () => void) => void> = new Map();
  private connectionCounter = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private enabled: boolean = false) {
    super();
  }

  // ===========================================================================
  // EXPERIMENT LIFECYCLE
  // ===========================================================================

  /**
   * Start a chaos experiment.
   */
  startExperiment(
    type: ChaosExperimentType,
    target: string,
    config: Record<string, unknown>
  ): ChaosExperiment {
    if (!this.enabled) {
      throw new Error('Chaos framework is disabled. Enable it before starting experiments.');
    }

    const id = `chaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const experiment: ChaosExperiment = {
      id,
      type,
      target,
      config,
      startedAt: new Date(),
      active: true,
    };

    this.experiments.set(id, experiment);
    this.applyExperiment(experiment);
    this.emit('experiment:started', experiment);

    console.log(`[Chaos] Started ${type} experiment on ${target} (id: ${id})`);
    return experiment;
  }

  /**
   * Stop a running experiment.
   */
  stopExperiment(id: string): boolean {
    const exp = this.experiments.get(id);
    if (!exp || !exp.active) return false;

    exp.active = false;
    exp.stoppedAt = new Date();
    this.removeExperiment(exp);
    this.emit('experiment:stopped', exp);

    console.log(`[Chaos] Stopped experiment ${id}`);
    return true;
  }

  /**
   * Stop all running experiments.
   */
  stopAll(): void {
    for (const [id, exp] of this.experiments) {
      if (exp.active) this.stopExperiment(id);
    }
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  /**
   * List experiments.
   */
  listExperiments(activeOnly: boolean = false): ChaosExperiment[] {
    const all = Array.from(this.experiments.values());
    return activeOnly ? all.filter((e) => e.active) : all;
  }

  // ===========================================================================
  // NETWORK DELAY INJECTION
  // ===========================================================================

  injectNetworkDelay(target: string, config: NetworkDelayConfig): ChaosExperiment {
    return this.startExperiment('network-delay', target, config as any);
  }

  /**
   * Create Express middleware that applies active network delay experiments.
   */
  networkDelayMiddleware() {
    return (req: any, res: any, next: () => void) => {
      const delayExperiments = this.getActiveByType('network-delay');
      if (delayExperiments.length === 0) return next();

      for (const exp of delayExperiments) {
        const cfg = exp.config as unknown as NetworkDelayConfig;
        const pct = cfg.percentage ?? 100;
        if (Math.random() * 100 > pct) continue;

        const jitter = cfg.jitterMs ? (Math.random() - 0.5) * 2 * cfg.jitterMs : 0;
        const delay = Math.max(0, cfg.delayMs + jitter);

        setTimeout(next, delay);
        return;
      }
      next();
    };
  }

  // ===========================================================================
  // SERVICE FAILURE INJECTION
  // ===========================================================================

  injectServiceFailure(target: string, config: ServiceFailureConfig): ChaosExperiment {
    return this.startExperiment('service-failure', target, config as any);
  }

  /**
   * Create Express middleware that injects service failures.
   */
  serviceFailureMiddleware() {
    return (req: any, res: any, next: () => void) => {
      const failExperiments = this.getActiveByType('service-failure');
      if (failExperiments.length === 0) return next();

      for (const exp of failExperiments) {
        const cfg = exp.config as unknown as ServiceFailureConfig;
        if (Math.random() * 100 <= cfg.percentage) {
          res.status(cfg.statusCode).json({
            error: cfg.message || 'Chaos: Injected failure',
            chaosExperimentId: exp.id,
          });
          return;
        }
      }
      next();
    };
  }

  // ===========================================================================
  // RESOURCE EXHAUSTION
  // ===========================================================================

  injectResourceExhaustion(config: ResourceExhaustionConfig): ChaosExperiment {
    return this.startExperiment('resource-exhaustion', config.resource, config as any);
  }

  // ===========================================================================
  // CONNECTION DROP
  // ===========================================================================

  injectConnectionDrop(target: string, config: ConnectionDropConfig): ChaosExperiment {
    return this.startExperiment('connection-drop', target, config as any);
  }

  /**
   * Check if a connection should be dropped.
   */
  shouldDropConnection(): boolean {
    const dropExperiments = this.getActiveByType('connection-drop');
    if (dropExperiments.length === 0) return false;

    this.connectionCounter++;
    for (const exp of dropExperiments) {
      const cfg = exp.config as unknown as ConnectionDropConfig;
      if (cfg.dropEvery && this.connectionCounter % cfg.dropEvery === 0) return true;
      if (cfg.percentage && Math.random() * 100 <= cfg.percentage) return true;
    }
    return false;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  enable(): void {
    this.enabled = true;
    console.log('[Chaos] Framework enabled');
  }

  disable(): void {
    this.stopAll();
    this.enabled = false;
    console.log('[Chaos] Framework disabled');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private getActiveByType(type: ChaosExperimentType): ChaosExperiment[] {
    return Array.from(this.experiments.values()).filter(
      (e) => e.active && e.type === type
    );
  }

  private applyExperiment(_experiment: ChaosExperiment): void {
    // Experiments are applied via middleware or shouldDropConnection checks
  }

  private removeExperiment(_experiment: ChaosExperiment): void {
    // Cleanup is handled by stopExperiment
  }

  dispose(): void {
    this.stopAll();
    this.removeAllListeners();
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let instance: ChaosFramework | null = null;

export function getChaosFramework(): ChaosFramework {
  if (!instance) {
    instance = new ChaosFramework(false);
  }
  return instance;
}
