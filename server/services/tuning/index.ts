/**
 * PID Tuning Service — human-gated auto-tuning with safety envelopes
 * Issue #215. ADR references, both under docs/decisions/:
 *   ADR-0013-autonomous-agent-architecture.md  — [13.4] PID auto-tuner, and
 *     "PID auto-tuning ... requires human approval before applying parameter
 *     changes"
 *   ADR-0009-measured-emergence-guardrails.md  — operational envelopes
 *
 * Composes the existing PID stack (issue #351: PIDController, relay feedback,
 * Ziegler-Nichols, Cohen-Coon) with:
 * - absolute gain envelopes (ADR-0009) via ./envelope
 * - RL-based tuning over a FOPDT simulation via ./rl-tuner
 * - a human approval gate (GateManager, issue #345) that actually holds
 * - a durable, append-only audit trail via ./audit-store
 *
 * The safety properties this module is responsible for, all fail-closed:
 *
 *  1. No gain reaches a live controller without a durable, validated approval
 *     record. `applyApproved` appends the audit row BEFORE calling
 *     `applyGains`, so a store failure aborts the plant write.
 *  2. Approver identity is a control-plane principal name passed in by the
 *     route from the authenticated API key. Nothing here reads a request body.
 *  3. The approval gate is never registered with an empty approver list —
 *     `registerApprovalGate` throws instead, because GateManager treats an
 *     empty list as "anyone may approve".
 *  4. Four-eyes: the principal that proposed a change cannot approve it.
 *  5. Recommendations outside the safety envelope are refused at proposal
 *     time. They are not clamped onto the envelope boundary: the boundary is
 *     the most aggressive legal tuning, not a safe substitute for a bad one.
 *  6. The envelope is re-checked against the live envelope at approval time,
 *     in case it was tightened after the proposal was raised.
 *
 * Known scope limit, stated plainly: loop registrations, envelopes and pending
 * proposals live in memory (alongside the PIDController objects they describe
 * in `optimizationService`) and are lost on restart. The AUDIT TRAIL is
 * durable. A restart therefore loses pending proposals — which is fail-closed,
 * since a lost proposal cannot be approved — but never loses the record of a
 * change that was applied.
 */

import { EventEmitter } from 'events';

export * from './approval-policy';
export * from './audit-store';
export * from './envelope';
export * from './process-sim';
export * from './rl-tuner';

import type {
  EnvelopeDecision,
  FOPDTModel,
  GainEnvelope,
  ProposalMethod,
  RLTunerConfig,
  RLTuningOutcome,
  TuningAuditAppend,
  TuningAuditDecision,
  TuningAuditRecord,
  TuningProposal,
} from '@shared/types/tuning';
import { optimizationService } from '../optimization';
import type { PIDController, PIDControllerConfig, PIDGains } from '../optimization/pid-controller';
import { GateManager } from '../governance/gate-manager';
import {
  denialMessage,
  denyApprovalReason,
  denyRejectionReason,
  EnvelopeViolationError,
  loadTuningApprovalPolicy,
  LoopAlreadyRegisteredError,
  TuningApprovalDeniedError,
  TuningAuditUnavailableError,
  TuningConfigurationError,
  type TuningApprovalPolicy,
} from './approval-policy';
import {
  tuningAuditStore,
  type TuningAuditFilter,
  type TuningAuditStore,
} from './audit-store';
import {
  DEFAULT_ENVELOPE,
  describeEnvelopeViolations,
  limitStepTowards,
  validateEnvelope,
} from './envelope';
import { relayIdentify, zieglerNicholsFromUltimate } from './process-sim';
import { runRLTuning } from './rl-tuner';

const GATE_DEFINITION_ID = 'pid-tuning-approval';
const MAX_PROPOSALS = 500;
const DEFAULT_RATE_LIMIT_FRACTION = 0.25;

/** Trusted identity, always derived from a control-plane principal. */
export interface TuningPrincipal {
  name: string;
}

export interface RegisterLoopInput extends PIDControllerConfig {
  envelope?: GainEnvelope;
}

export interface TuningServiceOptions {
  /** Durable audit sink. Defaults to the process-wide store. */
  auditStore?: TuningAuditStore;
  /** Policy source. Defaults to reading the environment on every decision. */
  loadPolicy?: () => TuningApprovalPolicy;
}

interface LoopRegistration {
  envelope: GainEnvelope;
  /** The controller's own per-step gain rate limit, mirrored so approved
   *  moves are truncated with the loop's real fraction rather than a
   *  hardcoded default that `applyGains` might then reject. */
  rateLimitFraction: number;
}

export class TuningService extends EventEmitter {
  readonly gates = new GateManager();

  private loops: Map<string, LoopRegistration> = new Map();
  private proposals: Map<string, TuningProposal> = new Map();
  private proposalCounter = 0;
  private readonly bootId = Date.now().toString(36);
  private initialized = false;
  private readonly auditStore: TuningAuditStore;
  private readonly loadPolicy: () => TuningApprovalPolicy;

  constructor(options: TuningServiceOptions = {}) {
    super();
    this.auditStore = options.auditStore ?? tuningAuditStore;
    this.loadPolicy = options.loadPolicy ?? (() => loadTuningApprovalPolicy());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await optimizationService.initialize();
    const policy = this.loadPolicy();
    try {
      await this.auditStore.ready();
    } catch (error) {
      // Surface the misconfiguration at boot. Proposals still fail closed at
      // runtime because every one of them appends to this store first.
      console.error(
        '[tuning] durable audit store unavailable — PID tuning proposals will be '
        + 'refused until it is reachable:',
        error instanceof Error ? error.message : error,
      );
    }
    console.log(
      `[tuning] approval gate: ${policy.approvers.length} configured approver(s), `
      + `gain writes ${policy.applyEnabled ? 'ENABLED' : 'disabled'}, `
      + `audit backend ${this.auditStore.backend()}`,
    );
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    await this.auditStore.close();
  }

  // ── Loop registry ────────────────────────────────────────────────────

  /**
   * Register a loop and its safety envelope. Initial gains must already be
   * inside the envelope — registering a loop is not a way to install gains
   * that a proposal would be refused for.
   *
   * Registration is CREATE-ONLY. `optimizationService.createController` keys
   * its registry by id, so re-registering an existing id would replace the
   * live controller and silently install brand-new gains — bypassing the
   * approval gate, the four-eyes check, the `PID_TUNING_APPLY_ENABLED` opt-in,
   * the per-step rate limit and the audit trail, using nothing but the
   * `tuning.write` scope. Refusing the duplicate is what keeps `decide()` the
   * only path to a live gain change.
   */
  registerLoop(input: RegisterLoopInput): { controller: PIDController; envelope: GainEnvelope } {
    if (optimizationService.getController(input.id)) {
      throw new LoopAlreadyRegisteredError(
        `Loop "${input.id}" is already registered. Registration is create-only: `
        + 'gains can only be changed through the approval gate.',
      );
    }
    const envelope = input.envelope ?? DEFAULT_ENVELOPE;
    const envelopeError = validateEnvelope(envelope);
    if (envelopeError) throw new EnvelopeViolationError(`Invalid envelope: ${envelopeError}`);

    const violations = describeEnvelopeViolations(input.gains, envelope);
    if (violations.length > 0) {
      throw new EnvelopeViolationError(
        `Initial gains are outside the safety envelope: ${violations.join('; ')}`,
      );
    }

    const controller = optimizationService.createController(input);
    this.loops.set(input.id, {
      envelope,
      rateLimitFraction: input.maxGainChangeFraction ?? DEFAULT_RATE_LIMIT_FRACTION,
    });
    return { controller, envelope };
  }

  getController(id: string): PIDController | undefined {
    return optimizationService.getController(id);
  }

  getEnvelope(id: string): GainEnvelope {
    return this.loops.get(id)?.envelope ?? DEFAULT_ENVELOPE;
  }

  /**
   * Tighten or widen a loop's envelope. Gains already installed outside the
   * new envelope are reported to the caller — the envelope is not silently
   * applied to a running controller, because writing gains is only ever done
   * through the approval gate.
   */
  setEnvelope(id: string, envelope: GainEnvelope): {
    envelope: GainEnvelope;
    currentGainsWithinEnvelope: boolean;
    violations: string[];
  } {
    const error = validateEnvelope(envelope);
    if (error) throw new EnvelopeViolationError(`Invalid envelope: ${error}`);

    const registration = this.loops.get(id);
    if (!registration) throw new Error(`Controller "${id}" not found`);

    const controller = this.requireController(id);
    registration.envelope = envelope;
    const violations = describeEnvelopeViolations(controller.getGains(), envelope);
    return {
      envelope,
      currentGainsWithinEnvelope: violations.length === 0,
      violations,
    };
  }

  // ── Tuning methods (all produce proposals, never direct application) ─

  /** Relay identification against a FOPDT model → Ziegler-Nichols gains */
  async tuneRelay(
    controllerId: string,
    model: FOPDTModel,
    principal: TuningPrincipal,
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
    return this.propose(controllerId, 'relay-feedback', gains, principal, {
      reason: `Relay identification: Ku=${identification.ku.toFixed(3)}, Tu=${identification.tu.toFixed(2)}s (${identification.cycles} cycles) → Ziegler-Nichols`,
      confidence: 0.85,
    });
  }

  /** Cohen-Coon from FOPDT model parameters via the existing autotuner math */
  async tuneCohenCoon(
    controllerId: string,
    model: FOPDTModel,
    principal: TuningPrincipal,
  ): Promise<TuningProposal> {
    this.requireController(controllerId);
    const tuner = optimizationService.createAutoTuner(controllerId);
    if (!tuner) throw new Error(`Controller "${controllerId}" not found`);
    const rec = tuner.cohenCoonTune(model.gain, model.timeConstantS, model.deadTimeS);
    return this.propose(controllerId, 'cohen-coon', rec.gains, principal, {
      reason: rec.reason,
      confidence: rec.confidence,
    });
  }

  /** RL tuning: Q-learning episodes in simulation, best gains proposed */
  async tuneRL(
    controllerId: string,
    model: FOPDTModel,
    principal: TuningPrincipal,
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
    const proposal = await this.propose(controllerId, 'rl', outcome.bestGains, principal, {
      reason:
        `RL tuning (${outcome.episodes.length} episodes in simulation): reward ` +
        `${outcome.initialReward.toFixed(2)} → ${outcome.bestReward.toFixed(2)}` +
        (outcome.improvedOverInitial ? '' : ' (no improvement — review before approving)'),
      confidence: outcome.improvedOverInitial ? 0.7 : 0.3,
    });
    return { proposal, outcome };
  }

  /**
   * Wrap a recommendation as a gated proposal.
   *
   * Refuses, in order: an unknown controller, an unconfigured approver
   * allowlist (a proposal nobody could ever approve is a misconfiguration, not
   * a pending item), and gains outside the safety envelope.
   */
  async propose(
    controllerId: string,
    method: ProposalMethod,
    rawGains: PIDGains,
    principal: TuningPrincipal,
    meta: { reason: string; confidence: number }
  ): Promise<TuningProposal> {
    const controller = this.requireController(controllerId);
    const envelope = this.getEnvelope(controllerId);
    const policy = this.loadPolicy();
    const currentGains = controller.getGains();

    // Registering the gate with the live allowlist. Throws when the allowlist
    // is empty rather than creating a gate that would accept any approver.
    this.registerApprovalGate(policy.approvers);

    const violations = describeEnvelopeViolations(rawGains, envelope);
    if (violations.length > 0) {
      // Auditing the refusal is best-effort: it must not convert a safety
      // refusal into a 500 that a caller could retry into an apply.
      await this.tryAppend({
        proposalId: `REFUSED-${this.bootId}-${++this.proposalCounter}`,
        controllerId,
        method,
        decision: 'envelope-rejected',
        proposedBy: principal.name,
        decidedBy: null,
        currentGains,
        proposedGains: { ...rawGains },
        appliedGains: null,
        envelope,
        envelopeDecision: 'outside-envelope',
        reasonCode: 'envelope-violation',
        detail: violations.join('; '),
      });
      throw new EnvelopeViolationError(
        `Recommended gains are outside the safety envelope: ${violations.join('; ')}`,
      );
    }

    const proposalId = `TUNE-${this.bootId}-${++this.proposalCounter}`;
    const gains: PIDGains = { ...rawGains };
    const createdAt = Date.now();

    // Durable first: a proposal that could not be recorded does not exist.
    try {
      await this.auditStore.append({
        proposalId,
        controllerId,
        method,
        decision: 'proposed',
        proposedBy: principal.name,
        decidedBy: null,
        currentGains,
        proposedGains: gains,
        appliedGains: null,
        envelope,
        envelopeDecision: 'within-envelope',
        reasonCode: null,
        detail: meta.reason,
      });
    } catch (error) {
      throw new TuningAuditUnavailableError(
        'Cannot raise a tuning proposal: the durable tuning audit trail is unavailable.',
        error,
      );
    }

    const gate = await this.gates.createInstance(
      GATE_DEFINITION_ID,
      {
        id: proposalId,
        type: 'pid-tuning-proposal',
        data: { controllerId, method, proposedGains: gains, proposedBy: principal.name, ...meta },
      },
      principal.name
    );

    const proposal: TuningProposal = {
      id: proposalId,
      controllerId,
      method,
      currentGains,
      proposedGains: gains,
      envelope,
      reason: meta.reason,
      confidence: meta.confidence,
      status: 'pending',
      gateInstanceId: gate.id,
      proposedBy: principal.name,
      createdAt,
      expiresAt: createdAt + policy.proposalTtlMs,
    };
    this.proposals.set(proposalId, proposal);
    this.evictOldProposals();
    this.emit('proposal', proposal);
    return proposal;
  }

  // ── Approval gate ────────────────────────────────────────────────────

  /**
   * Decide a pending proposal on behalf of an authenticated principal.
   *
   * `principal` is the control-plane identity bound by
   * `requireControlPlaneAccess`. There is deliberately no parameter through
   * which a caller could name a different approver.
   */
  async decide(
    proposalId: string,
    principal: TuningPrincipal,
    action: 'approve' | 'reject',
    comment?: string
  ): Promise<TuningProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found`);
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal "${proposalId}" already ${proposal.status}`);
    }

    const policy = this.loadPolicy();

    if (Date.now() > proposal.expiresAt) {
      proposal.status = 'expired';
      proposal.resolvedAt = Date.now();
      await this.tryAppend(this.auditFor(proposal, 'expired', principal.name, {
        reasonCode: 'proposal-expired',
        detail: denialMessage('proposal-expired'),
      }));
      this.emit('proposal-expired', proposal);
      throw new TuningApprovalDeniedError('proposal-expired', denialMessage('proposal-expired'));
    }

    const denial = action === 'approve'
      ? denyApprovalReason(policy, principal.name, proposal.proposedBy)
      : denyRejectionReason(policy, principal.name);
    if (denial) {
      await this.tryAppend(this.auditFor(proposal, 'denied', principal.name, {
        reasonCode: denial,
        detail: denialMessage(denial),
      }));
      this.emit('proposal-denied', { proposal, principal: principal.name, reason: denial });
      throw new TuningApprovalDeniedError(denial, denialMessage(denial));
    }

    // Re-register with the live allowlist so GateManager independently
    // validates the approver against the same non-empty list.
    this.registerApprovalGate(policy.approvers);

    const gate = await this.gates.submitDecision(
      proposal.gateInstanceId,
      principal.name,
      action,
      comment
    );

    if (gate.state === 'rejected') {
      proposal.status = 'rejected';
      proposal.resolvedAt = Date.now();
      proposal.decidedBy = principal.name;
      await this.tryAppend(this.auditFor(proposal, 'rejected', principal.name, {
        reasonCode: null,
        detail: comment ?? null,
      }));
      this.emit('proposal-rejected', proposal);
      return proposal;
    }

    if (gate.state !== 'approved') {
      // More approvals are still required; nothing is applied.
      return proposal;
    }

    // Belt and braces: re-derive the approval from the gate's own record
    // rather than trusting the local branch above.
    const recorded = gate.approvals.find(
      (approval) => approval.approver === principal.name && approval.action === 'approve',
    );
    if (!recorded) {
      throw new Error(
        `Gate instance "${gate.id}" reports approved without a recorded approval by `
        + `"${principal.name}"`,
      );
    }

    proposal.decidedBy = principal.name;
    await this.applyApproved(proposal, principal, comment);
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

  /** Read the durable audit trail. */
  getAuditTrail(filter?: TuningAuditFilter): Promise<TuningAuditRecord[]> {
    return this.auditStore.list(filter);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const policy = this.loadPolicy();
    const pending = this.getProposals({ status: 'pending' }).length;
    if (!this.initialized) {
      return { healthy: false, message: 'Tuning service not initialized' };
    }

    let auditHealthy = true;
    let auditDetail = `audit backend ${this.auditStore.backend()}`;
    try {
      await this.auditStore.ready();
      auditDetail = `audit backend ${this.auditStore.backend()}`;
    } catch (error) {
      auditHealthy = false;
      auditDetail = `audit store unavailable: ${error instanceof Error ? error.message : error}`;
    }

    // An unconfigured approver allowlist is not "healthy": the feature is
    // mounted but no gain change can ever be approved.
    const gateHealthy = policy.approvers.length > 0;
    return {
      healthy: auditHealthy && gateHealthy,
      message:
        `Tuning service running: ${this.loops.size} loops, ${pending} pending proposals, `
        + `${policy.approvers.length} approver(s), gain writes `
        + `${policy.applyEnabled ? 'enabled' : 'disabled'}, ${auditDetail}`,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * GateManager treats `approvers: []` as "any approver is acceptable", so an
   * empty list must never reach it. Refusing here is what makes a
   * misconfigured deployment fail closed instead of wide open.
   */
  private registerApprovalGate(approvers: readonly string[]): void {
    if (approvers.length === 0) {
      throw new TuningConfigurationError(
        denialMessage('approver-allowlist-empty')
        + ' Configure PID_TUNING_APPROVERS with the control-plane principal '
        + 'names permitted to approve gain changes.',
      );
    }
    this.gates.registerGate({
      id: GATE_DEFINITION_ID,
      name: 'PID tuning approval',
      description:
        'Human approval required before controller gains change (ADR-0013 [13.4])',
      type: 'manual',
      conditions: [],
      timeoutMs: 24 * 60 * 60 * 1000,
      approvers: [...approvers],
      requiredApprovals: 1,
      allowOverride: false,
    });
  }

  /**
   * Write the approved gains.
   *
   * Ordering is the safety property: the durable record of the approval —
   * including the exact gains that are about to be written — is appended
   * BEFORE `applyGains` is called. If the append throws, the plant write never
   * happens, and the caller sees the failure.
   */
  private async applyApproved(
    proposal: TuningProposal,
    principal: TuningPrincipal,
    comment?: string,
  ): Promise<void> {
    const controller = optimizationService.getController(proposal.controllerId);
    if (!controller) {
      await this.failProposal(proposal, principal, 'controller-missing',
        `Controller "${proposal.controllerId}" is no longer registered`);
      return;
    }

    // The envelope may have been tightened since the proposal was raised.
    const envelope = this.getEnvelope(proposal.controllerId);
    const violations = describeEnvelopeViolations(proposal.proposedGains, envelope);
    if (violations.length > 0) {
      await this.failProposal(proposal, principal, 'envelope-violation',
        `Envelope tightened since proposal: ${violations.join('; ')}`, 'outside-envelope');
      return;
    }

    // Truncate to the loop's own per-step rate limit so applyGains accepts.
    const current = controller.getGains();
    const fraction = this.loops.get(proposal.controllerId)?.rateLimitFraction
      ?? DEFAULT_RATE_LIMIT_FRACTION;
    const { gains: plannedGains, complete } = limitStepTowards(
      current,
      proposal.proposedGains,
      fraction,
    );

    // Durable approval record precedes the plant write. Not best-effort:
    // a store failure aborts the change and no gains are written.
    try {
      await this.auditStore.append({
        proposalId: proposal.id,
        controllerId: proposal.controllerId,
        method: proposal.method,
        decision: 'approved',
        proposedBy: proposal.proposedBy,
        decidedBy: principal.name,
        currentGains: current,
        proposedGains: proposal.proposedGains,
        appliedGains: plannedGains,
        envelope,
        envelopeDecision: 'within-envelope',
        reasonCode: null,
        detail: comment ?? null,
      });
    } catch (error) {
      await this.failProposal(proposal, principal, 'audit-unavailable',
        'Durable approval record could not be written; gains were not applied');
      throw new TuningAuditUnavailableError(
        'Cannot apply PID gains: the durable tuning audit trail is unavailable.',
        error,
      );
    }

    const applied = controller.applyGains(plannedGains);
    if (!applied) {
      await this.failProposal(proposal, principal, 'rate-limit-rejected',
        `Controller refused the rate-limited step (fraction ${fraction})`);
      return;
    }

    proposal.status = 'applied';
    proposal.resolvedAt = Date.now();
    proposal.appliedGains = controller.getGains();
    proposal.fullyApplied = complete;

    await this.tryAppend({
      proposalId: proposal.id,
      controllerId: proposal.controllerId,
      method: proposal.method,
      decision: 'applied',
      proposedBy: proposal.proposedBy,
      decidedBy: principal.name,
      currentGains: current,
      proposedGains: proposal.proposedGains,
      appliedGains: proposal.appliedGains,
      envelope,
      envelopeDecision: 'within-envelope',
      reasonCode: complete ? null : 'rate-limited-partial',
      detail: complete
        ? null
        : 'Move truncated by the per-step gain rate limit; a follow-up proposal '
          + 'is required to finish it.',
    });
    this.emit('proposal-applied', proposal);
  }

  private async failProposal(
    proposal: TuningProposal,
    principal: TuningPrincipal,
    reasonCode: string,
    detail: string,
    envelopeDecision: EnvelopeDecision = 'within-envelope',
  ): Promise<void> {
    proposal.status = 'failed';
    proposal.resolvedAt = Date.now();
    proposal.failureReason = detail;
    await this.tryAppend(this.auditFor(proposal, 'failed', principal.name, {
      reasonCode,
      detail,
      envelopeDecision,
    }));
    this.emit('proposal-failed', proposal);
  }

  private auditFor(
    proposal: TuningProposal,
    decision: TuningAuditDecision,
    decidedBy: string,
    extra: {
      reasonCode: string | null;
      detail: string | null;
      envelopeDecision?: EnvelopeDecision;
    },
  ): TuningAuditAppend {
    return {
      proposalId: proposal.id,
      controllerId: proposal.controllerId,
      method: proposal.method,
      decision,
      proposedBy: proposal.proposedBy,
      decidedBy,
      currentGains: proposal.currentGains,
      proposedGains: proposal.proposedGains,
      appliedGains: proposal.appliedGains ?? null,
      envelope: this.getEnvelope(proposal.controllerId),
      envelopeDecision: extra.envelopeDecision ?? 'within-envelope',
      reasonCode: extra.reasonCode,
      detail: extra.detail,
    };
  }

  /**
   * Append a record whose loss must not change the outcome (denials,
   * refusals, and post-write outcome rows). The pre-write approval record and
   * the proposal record are appended with `auditStore.append` directly so
   * their failure aborts the operation.
   */
  private async tryAppend(record: TuningAuditAppend): Promise<void> {
    try {
      await this.auditStore.append(record);
    } catch (error) {
      console.error(
        `[tuning] failed to append ${record.decision} audit record for `
        + `${record.proposalId}:`,
        error instanceof Error ? error.message : error,
      );
    }
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
