/**
 * Integrity Service — composition root for paradox resolution (#492)
 *
 * Wires the three previously-disconnected integrity components into one flow:
 *
 *   ScadaEvent → ParadoxResolver (detect)
 *              → EvolutionaryResolver (evolved strategy, SafetyGuard-gated)
 *              → governance gate + explainability audit (CFR 21 Part 11)
 *              → commit to ParadoxResolver → `resolved` / `resolved_event`
 *
 * Before this, ParadoxResolver.ingestEvent was never called from production,
 * and the entire evolutionary/ subsystem had no importer. This module is the
 * mountable entry point a live event pipeline (#489) hooks into.
 *
 * The base resolver is created with auto-resolve OFF: the EvolutionaryResolver
 * owns the resolve step (it internally falls back to the base resolver's static
 * strategies when SafetyGuard or the governance gate blocks an evolved one).
 *
 * @see ADR-0023, ADR-0024, ADR-0025
 * @closes #492
 */

import { EventEmitter } from 'events';
import {
  ParadoxResolver,
  type ScadaEvent,
  type ConflictDetection,
  type Resolution,
  type ParadoxResolverConfig,
} from './paradox-resolver';
import { EvolutionaryResolver, type EvolutionaryResolverConfig } from './evolutionary/evolutionary-resolver';
import { ExplainabilityMonitor, type GovernanceGate } from './explainability-monitor';

export interface IntegrityServiceConfig {
  /** ParadoxResolver overrides. `autoResolveLowSeverity` is forced false. */
  resolver?: Partial<Omit<ParadoxResolverConfig, 'autoResolveLowSeverity'>>;
  /** EvolutionaryResolver overrides (evolution/safety/governanceAction, …) */
  evolutionary?: Partial<EvolutionaryResolverConfig>;
  /**
   * Governance gate applied to every evolved resolution. Omit to use the
   * default (block evolved resolutions below 0.6 confidence). Pass `null` to
   * register no gate.
   */
  governanceGate?: GovernanceGate | null;
}

const DEFAULT_GOVERNANCE_GATE: GovernanceGate = {
  id: 'evolved_resolution_gate',
  name: 'Evolved Resolution Approval',
  description: 'Blocks evolved resolution strategies whose confidence is below the production threshold.',
  actionPatterns: ['evolved_resolution'],
  requiredApproval: 'none', // automated; no electronic signature required
  minConfidence: 0.6,
  enforcement: 'block',
};

export interface IngestOutcome {
  conflict: ConflictDetection | null;
  resolution: Resolution | null;
  usedEvolved: boolean;
}

export class IntegrityService extends EventEmitter {
  readonly resolver: ParadoxResolver;
  readonly evolutionary: EvolutionaryResolver;
  readonly monitor: ExplainabilityMonitor;

  constructor(config: IntegrityServiceConfig = {}) {
    super();

    // Auto-resolve OFF: the evolutionary resolver owns resolution.
    this.resolver = new ParadoxResolver({
      ...config.resolver,
      autoResolveLowSeverity: false,
    });

    this.monitor = new ExplainabilityMonitor();
    const gate = config.governanceGate === undefined ? DEFAULT_GOVERNANCE_GATE : config.governanceGate;
    if (gate) this.monitor.registerGovernanceGate(gate);

    this.evolutionary = new EvolutionaryResolver(this.resolver, config.evolutionary, this.monitor);

    // Re-emit downstream signals for ADR-0024/0025 consumers.
    this.resolver.on('resolved', r => this.emit('resolved', r));
    this.resolver.on('resolved_event', e => this.emit('resolved_event', e));
    this.resolver.on('conflict', c => this.emit('conflict', c));
    this.evolutionary.on('evolutionary_resolution', e => this.emit('evolutionary_resolution', e));
    this.evolutionary.on('governance_blocked', e => this.emit('governance_blocked', e));
    this.evolutionary.on('safety_blocked', e => this.emit('safety_blocked', e));
  }

  /**
   * Ingest a SCADA event: detect a conflict and, if one is found, resolve it
   * through the evolutionary resolver (evolved-or-static, gated + audited).
   */
  async ingestEvent(event: ScadaEvent): Promise<IngestOutcome> {
    const conflict = await this.resolver.ingestEvent(event);
    if (!conflict) {
      return { conflict: null, resolution: null, usedEvolved: false };
    }
    const outcome = await this.evolutionary.resolveConflict(conflict);
    return {
      conflict,
      resolution: outcome.resolution,
      usedEvolved: outcome.usedEvolved,
    };
  }

  /** Register per-process-area resolution rules on the base resolver. */
  registerProcessAreaRules(...args: Parameters<ParadoxResolver['registerProcessAreaRules']>): void {
    this.resolver.registerProcessAreaRules(...args);
  }

  getStatus() {
    return {
      resolver: this.resolver.getStatus(),
      evolutionary: this.evolutionary.getStatus(),
      explainability: this.monitor.getStatus(),
    };
  }
}

/** Shared singleton for the default integrity pipeline. */
export const integrityService = new IntegrityService();
