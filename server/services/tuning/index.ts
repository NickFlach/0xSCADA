/**
 * PID Tuning Service — human-gated auto-tuning with safety envelopes
 * ADR-0013 [13.4] — Issue #215
 *
 * Composes the existing PID stack (issue #351: PIDController, relay
 * feedback, Ziegler-Nichols, Cohen-Coon) with:
 * - absolute gain envelopes (ADR-0009) via ./envelope
 * - RL-based tuning over a FOPDT simulation via ./rl-tuner
 * - a mandatory human approval gate (GateManager, issue #345): every
 *   gain change becomes a TuningProposal; nothing applies automatically
 *
 * Application on approval is envelope-clamped AND rate-limited: the move
 * is truncated to the controller's maxGainChangeFraction when needed and
 * reported as partially applied.
 */

import { EventEmitter } from 'events';

export * from './envelope';
export * from './process-sim';
export * from './rl-tuner';

import type {
  FOPDTModel,
  GainEnvelope,
  ProposalMethod,
  RLTunerConfig,
  RLTuningOutcome,
  TuningProposal,
} from '@shared/types/tuning';
import { optimizationService } from '../optimization';
import type { PIDController, PIDControllerConfig, PIDGains } from '../optimization/pid-controller';
import { GateManager } from '../governance/gate-manager';
import { DEFAULT_ENVELOPE, clampToEnvelope, limitStepTowards, validateEnvelope } from './envelope';
import { relayIdentify, zieglerNicholsFromUltimate } from './process-sim';
import { runRLTuning } from './rl-tuner';

const GATE_DEFINITION_ID = 'pid-tuning-approval';
const MAX_PROPOSALS = 500;

export interface RegisterLoopInput extends PIDControllerConfig {
  envelope?: GainEnvelope;
}

export class TuningService extends EventEmitter {
  readonly gates = new GateManager();

  private envelopes: Map<string, GainEnvelope> = new Map();
  private proposals: Map<string, TuningProposal> = new Map();
  private proposalCounter = 0;
  private readonly bootId = Date.now().toString(36);
  private initialized = false;

  constructor() {
    super();
    this.gates.registerGate({
      id: GATE_DEFINITION_ID,
      name: 'PID tuning approval',
      description:
        'Human approval required before controller gains change (ADR-0013 [13.4])',
      type: 'manual',
      conditions: [],
      timeoutMs: 24 * 60 * 60 * 1000,
      approvers: [], // any authenticated approver; RBAC integration is follow-up
      requiredApprovals: 1,
      allowOverride: false,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await optimizationService.initialize();
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  // ── Loop registry ────────────────────────────────────────────────────

  registerLoop(input: RegisterLoopInput): { controller: PIDController; envelope: GainEnvelope } {
    const envelope = input.envelope ?? DEFAULT_ENVELOPE;
    const envelopeError = validateEnvelope(envelope);
    if (envelopeError) throw new Error(`Invalid envelope: ${envelopeError}`);
    const { gains } = clampToEnvelope(input.gains, envelope);
    const controller = optimizationService.createController({ ...input, gains });
    this.envelopes.set(input.id, envelope);
    return { controller, envelope };
  }

  getController(id: string): PIDController | undefined {
    return optimizationService.getController(id);
  }

  getEnvelope(id: string): GainEnvelope {
    return this.envelopes.get(id) ?? DEFAULT_ENVELOPE;
  }

  setEnvelope(id: string, envelope: GainEnvelope): GainEnvelope {
    const error = validateEnvelope(envelope);
    if (error) throw new Error(`Invalid envelope: ${error}`);
    this.envelopes.set(id, envelope);
    return envelope;
  }

  // ── Tuning methods (all produce proposals, never direct application) ─

  /** Relay identification against a FOPDT model → Ziegler-Nichols gains */
  async tuneRelay(
    controllerId: string,
    model: FOPDTModel,
    options: { relayAmplitude?: number; hysteresis?: number; minCycles?: number; dtS?: number } = {}
  ): Promise<TuningProposal> {
    const controller = this.requireController(controllerId);
    const identification = relayIdentify(model, {
      setpoint: controller.getSetpoint(),
      relayAmplitude: options.relayAmplitude ?? 5,
      hysteresis: options.hysteresis ?? 0.5,
      minCycles: options.minCycles ?? 4,
      dtS: options.dtS ?? 0.1,
    });
    if (!identification) {
      throw new Error('Relay identification failed: no sustained oscillation observed');
    }
    const gains = zieglerNicholsFromUltimate(identification.ku, identification.tu);
    return this.propose(controllerId, 'relay-feedback', gains, {
      reason: `Relay identification: Ku=${identification.ku.toFixed(3)}, Tu=${identification.tu.toFixed(2)}s (${identification.cycles} cycles) → Ziegler-Nichols`,
      confidence: 0.85,
    });
  }

  /** Cohen-Coon from FOPDT model parameters via the existing autotuner math */
  async tuneCohenCoon(controllerId: string, model: FOPDTModel): Promise<TuningProposal> {
    this.requireController(controllerId);
    const tuner = optimizationService.createAutoTuner(controllerId, 'suggest');
    if (!tuner) throw new Error(`Controller "${controllerId}" not found`);
    const rec = tuner.cohenCoonTune(model.gain, model.timeConstantS, model.deadTimeS);
    return this.propose(controllerId, 'cohen-coon', rec.gains, {
      reason: rec.reason,
      confidence: rec.confidence,
    });
  }

  /** RL tuning: Q-learning episodes in simulation, best gains proposed */
  async tuneRL(
    controllerId: string,
    model: FOPDTModel,
    config: Partial<RLTunerConfig> = {}
  ): Promise<{ proposal: TuningProposal; outcome: RLTuningOutcome }> {
    const controller = this.requireController(controllerId);
    const envelope = this.getEnvelope(controllerId);
    const outcome = runRLTuning(
      controller.getGains(),
      model,
      envelope,
      controller.getSetpoint(),
      config
    );
    const proposal = await this.propose(controllerId, 'rl', outcome.bestGains, {
      reason:
        `RL tuning (${outcome.episodes.length} episodes in simulation): reward ` +
        `${outcome.initialReward.toFixed(2)} → ${outcome.bestReward.toFixed(2)}` +
        (outcome.improvedOverInitial ? '' : ' (no improvement — review before approving)'),
      confidence: outcome.improvedOverInitial ? 0.7 : 0.3,
    });
    return { proposal, outcome };
  }

  /** Wrap any externally computed recommendation as a gated proposal */
  async propose(
    controllerId: string,
    method: ProposalMethod,
    rawGains: PIDGains,
    meta: { reason: string; confidence: number }
  ): Promise<TuningProposal> {
    const controller = this.requireController(controllerId);
    const envelope = this.getEnvelope(controllerId);
    const { gains, clamped } = clampToEnvelope(rawGains, envelope);

    const proposalId = `TUNE-${this.bootId}-${++this.proposalCounter}`;
    const gate = await this.gates.createInstance(
      GATE_DEFINITION_ID,
      {
        id: proposalId,
        type: 'pid-tuning-proposal',
        data: { controllerId, method, proposedGains: gains, ...meta },
      },
      'tuning-service'
    );

    const proposal: TuningProposal = {
      id: proposalId,
      controllerId,
      method,
      currentGains: controller.getGains(),
      proposedGains: gains,
      clampedByEnvelope: clamped,
      reason: meta.reason,
      confidence: meta.confidence,
      status: 'pending',
      gateInstanceId: gate.id,
      createdAt: Date.now(),
    };
    this.proposals.set(proposalId, proposal);
    this.evictOldProposals();
    this.emit('proposal', proposal);
    return proposal;
  }

  // ── Approval gate ────────────────────────────────────────────────────

  async decide(
    proposalId: string,
    approver: string,
    action: 'approve' | 'reject',
    comment?: string
  ): Promise<TuningProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found`);
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal "${proposalId}" already ${proposal.status}`);
    }

    const gate = await this.gates.submitDecision(
      proposal.gateInstanceId,
      approver,
      action,
      comment
    );

    if (gate.state === 'rejected') {
      proposal.status = 'rejected';
      proposal.resolvedAt = Date.now();
      proposal.decidedBy = approver;
      this.emit('proposal-rejected', proposal);
      return proposal;
    }

    if (gate.state === 'approved') {
      proposal.decidedBy = approver;
      this.applyApproved(proposal);
    }
    return proposal;
  }

  getProposals(filter?: { controllerId?: string; status?: TuningProposal['status'] }): TuningProposal[] {
    let list = Array.from(this.proposals.values());
    if (filter?.controllerId) list = list.filter((p) => p.controllerId === filter.controllerId);
    if (filter?.status) list = list.filter((p) => p.status === filter.status);
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  getProposal(id: string): TuningProposal | undefined {
    return this.proposals.get(id);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const pending = this.getProposals({ status: 'pending' }).length;
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Tuning service running: ${this.envelopes.size} loops, ${pending} pending proposals`
        : 'Tuning service not initialized',
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private applyApproved(proposal: TuningProposal): void {
    const controller = optimizationService.getController(proposal.controllerId);
    if (!controller) {
      proposal.status = 'failed';
      proposal.resolvedAt = Date.now();
      this.emit('proposal-failed', proposal);
      return;
    }

    // Envelope re-check against the live envelope at approval time
    const envelope = this.getEnvelope(proposal.controllerId);
    const { gains: target } = clampToEnvelope(proposal.proposedGains, envelope);

    // Truncate to the per-step rate limit so applyGains always accepts
    const current = controller.getGains();
    const { gains: stepGains, complete } = limitStepTowards(current, target, 0.25);
    const applied = controller.applyGains(stepGains);

    if (!applied) {
      proposal.status = 'failed';
      proposal.resolvedAt = Date.now();
      this.emit('proposal-failed', proposal);
      return;
    }

    proposal.status = 'applied';
    proposal.resolvedAt = Date.now();
    proposal.appliedGains = controller.getGains();
    proposal.fullyApplied = complete;
    this.emit('proposal-applied', proposal);
  }

  private requireController(id: string): PIDController {
    const controller = optimizationService.getController(id);
    if (!controller) throw new Error(`Controller "${id}" not found`);
    return controller;
  }

  private evictOldProposals(): void {
    if (this.proposals.size <= MAX_PROPOSALS) return;
    const resolvedOldest = Array.from(this.proposals.values())
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const proposal of resolvedOldest) {
      if (this.proposals.size <= MAX_PROPOSALS) return;
      this.proposals.delete(proposal.id);
    }
  }
}

export const tuningService = new TuningService();
