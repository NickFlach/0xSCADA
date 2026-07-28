import { EventEmitter } from "events";
import { GhostOSBridge } from "./bridge";
import { denyAllCapabilities } from "./capabilities";
import {
  DEFAULT_OPERATIONAL_ENVELOPE,
  systemClock,
  type ActionExecutor,
  type AuthenticatedPrincipal,
  type CapabilityAuthorizer,
  type Clock,
  type EmergentAction,
  type EmergentActionKind,
  type EmergentDecision,
  type EnvelopeCheck,
  type GhostAuditEvent,
  type HumanApproval,
  type OperationalEnvelope,
  type PipelineEventLike,
  type PipelineEventSource,
  type PipelineSignalMapper,
  type Signal,
} from "./types";

export interface GhostOSOrchestratorOptions {
  bridge?: GhostOSBridge;
  clock?: Clock;
  capabilityAuthorizer?: CapabilityAuthorizer;
  executor?: ActionExecutor;
  defaultEnvelope?: OperationalEnvelope;
  maxDecisions?: number;
  maxAuditEvents?: number;
}

export interface AgentRegistration {
  agentId: string;
  naturalFrequency: number;
  couplingStrength?: number;
  amplitude?: number;
  initialPhase?: number;
  envelope?: OperationalEnvelope;
}

export interface DecisionProposal {
  patternId: string;
  agentId: string;
  action: EmergentAction;
  confidence: number;
}

/**
 * Emergence layer and agent orchestrator.
 *
 * Recommendations, approvals and execution are separate capability checks.
 * The executor is optional and absent by default, making an unconfigured
 * service incapable of touching a plant output.
 */
export class GhostOSOrchestrator extends EventEmitter {
  readonly bridge: GhostOSBridge;
  private readonly clock: Clock;
  private readonly authorizer: CapabilityAuthorizer;
  private readonly executor?: ActionExecutor;
  private readonly defaultEnvelope: OperationalEnvelope;
  private readonly maxDecisions: number;
  private readonly maxAuditEvents: number;
  private readonly envelopes = new Map<string, OperationalEnvelope>();
  private readonly decisions = new Map<string, EmergentDecision>();
  private readonly audit: GhostAuditEvent[] = [];
  private readonly executionHistory = new Map<string, number[]>();
  private readonly decisionOperations = new Map<string, Promise<void>>();
  private readonly agentExecutionOperations = new Map<string, Promise<void>>();
  private decisionCounter = 0;
  private auditCounter = 0;

  constructor(options: GhostOSOrchestratorOptions = {}) {
    super();
    this.clock = options.clock ?? systemClock;
    this.bridge = options.bridge ?? new GhostOSBridge({ clock: this.clock });
    this.authorizer = options.capabilityAuthorizer ?? denyAllCapabilities;
    this.executor = options.executor;
    this.defaultEnvelope = cloneAndValidateEnvelope(
      options.defaultEnvelope ?? DEFAULT_OPERATIONAL_ENVELOPE,
    );
    this.maxDecisions = positiveInteger(options.maxDecisions ?? 1_000, "maxDecisions");
    this.maxAuditEvents = positiveInteger(
      options.maxAuditEvents ?? 5_000,
      "maxAuditEvents",
    );

    this.bridge.on("signal", (signal: Signal) => {
      this.record("signal.accepted", { signalId: signal.id, source: signal.source });
    });
    this.bridge.on(
      "signal-rejected",
      (details: { signalId: string; reason: string }) => {
        this.record("signal.rejected", details);
      },
    );
    this.bridge.on("resonance", (pattern: { id: string; strength: number }) => {
      this.record("resonance.detected", {
        patternId: pattern.id,
        strength: pattern.strength,
      });
    });
  }

  registerAgent(registration: AgentRegistration): void {
    const envelope = cloneAndValidateEnvelope(
      registration.envelope ?? this.defaultEnvelope,
    );
    this.bridge.registerAgent(registration);
    this.envelopes.set(registration.agentId, envelope);
    this.record(
      "agent.registered",
      {
        allowedActionKinds: [...envelope.allowedActionKinds],
        requiredApprovals: envelope.requiredApprovals,
      },
      registration.agentId,
    );
  }

  updateEnvelope(agentId: string, envelope: OperationalEnvelope): void {
    if (!this.bridge.hasAgent(agentId)) {
      throw new Error(`Agent ${agentId} is not registered`);
    }
    this.envelopes.set(agentId, cloneAndValidateEnvelope(envelope));
  }

  stepCoordination(dtSeconds = 0.1): ReturnType<GhostOSBridge["stepSynchronization"]> {
    const state = this.bridge.stepSynchronization(dtSeconds, this.clock.now());
    this.record("coordination.stepped", {
      coherence: state.orderParameter.r,
      meanPhase: state.orderParameter.psi,
      agents: state.oscillators.length,
    });
    return state;
  }

  ingestSignal(signal: Signal, resonanceWindowMs = 10_000): boolean {
    const accepted = this.bridge.ingestSignal(signal);
    if (accepted) {
      this.bridge.detectResonance(resonanceWindowMs, this.clock.now());
    }
    return accepted;
  }

  ingestPipelineEvent(
    event: PipelineEventLike,
    mapper: PipelineSignalMapper = defaultPipelineSignalMapper,
    resonanceWindowMs = 10_000,
  ): boolean {
    const signal = mapper(event);
    if (!signal) {
      this.record("signal.rejected", {
        source: event.source_id,
        sequence: event.sequence_number,
        reason: "event-had-no-finite-numeric-value",
      });
      return false;
    }
    return this.ingestSignal(signal, resonanceWindowMs);
  }

  /**
   * Subscribe to the canonical EventPipeline's successful processing event.
   * The returned disposer must be called during server shutdown.
   */
  attachPipeline(
    pipeline: PipelineEventSource,
    mapper: PipelineSignalMapper = defaultPipelineSignalMapper,
    resonanceWindowMs = 10_000,
  ): () => void {
    const listener = (event: PipelineEventLike): void => {
      this.ingestPipelineEvent(event, mapper, resonanceWindowMs);
    };
    pipeline.on("event:processed", listener);
    return () => {
      pipeline.off("event:processed", listener);
    };
  }

  async proposeDecision(proposal: DecisionProposal): Promise<EmergentDecision> {
    const now = this.clock.now();
    if (!this.bridge.getPattern(proposal.patternId)) {
      throw new Error(`Resonance pattern ${proposal.patternId} not found`);
    }
    if (!this.bridge.hasAgent(proposal.agentId)) {
      throw new Error(`Agent ${proposal.agentId} is not registered`);
    }
    validateAction(proposal.action);
    if (
      !Number.isFinite(proposal.confidence) ||
      proposal.confidence < 0 ||
      proposal.confidence > 1
    ) {
      throw new Error("Decision confidence must be between 0 and 1");
    }

    const authorization = await this.authorizer.authorize({
      subjectId: proposal.agentId,
      capability: `recommend:${proposal.action.kind}`,
      target: proposal.action.target,
      at: now,
    });
    const envelope = this.envelopes.get(proposal.agentId) ?? this.defaultEnvelope;
    const envelopeCheck = evaluateEnvelope(
      envelope,
      proposal.action,
      proposal.confidence,
      this.bridge.getSynchronizationState().r,
      now,
    );
    const reasons = [...envelopeCheck.reasons];
    if (!authorization.authorized) {
      reasons.push(authorization.reason ?? "Recommendation capability denied");
    }
    const permitted = reasons.length === 0;
    const autonomousNotification =
      proposal.action.kind === "notify" &&
      envelope.allowAutonomousNotifications &&
      envelope.requiredApprovals === 0;
    const requiredApprovals = autonomousNotification
      ? 0
      : Math.max(1, envelope.requiredApprovals);

    const decision: EmergentDecision = {
      id: `ED-${String(++this.decisionCounter).padStart(6, "0")}`,
      patternId: proposal.patternId,
      agentId: proposal.agentId,
      action: cloneAction(proposal.action),
      confidence: proposal.confidence,
      createdAt: now,
      status: !permitted
        ? "blocked"
        : requiredApprovals === 0
          ? "approved"
          : "pending-approval",
      requiredApprovals,
      approvals: [],
      envelopeCheck: {
        ...envelopeCheck,
        permitted,
        reasons,
      },
      recommendationGrantId: authorization.grantId,
    };
    this.storeDecision(decision);
    this.record(
      permitted ? "decision.proposed" : "decision.blocked",
      {
        patternId: proposal.patternId,
        actionKind: proposal.action.kind,
        target: proposal.action.target,
        reasons,
        requiredApprovals,
      },
      proposal.agentId,
      decision.id,
    );
    this.emit("decision", cloneDecision(decision));
    return cloneDecision(decision);
  }

  async approveDecision(
    decisionId: string,
    principal: AuthenticatedPrincipal,
    comment?: string,
  ): Promise<EmergentDecision> {
    assertAuthenticated(principal);
    return this.withDecisionLock(decisionId, async () => {
    const decision = this.requireDecision(decisionId);
    if (
      decision.status !== "pending-approval" &&
      decision.status !== "approved"
    ) {
      throw new Error(`Decision ${decisionId} cannot be approved from ${decision.status}`);
    }
    if (decision.agentId === principal.id) {
      this.recordApprovalDenial(decision, principal.id, "separation-of-duties");
      throw new Error("An agent may not approve its own recommendation");
    }
    if (decision.approvals.some((approval) => approval.principalId === principal.id)) {
      throw new Error(`Principal ${principal.id} already approved ${decisionId}`);
    }
    const now = this.clock.now();
    if (isExpired(decision, this.envelopeFor(decision.agentId), now)) {
      decision.status = "expired";
      this.record(
        "decision.expired",
        { phase: "approval" },
        decision.agentId,
        decision.id,
      );
      this.emit("decision", cloneDecision(decision));
      throw new Error(`Decision ${decisionId} has expired`);
    }

    const authorization = await this.authorizer.authorize({
      subjectId: principal.id,
      capability: `approve:${decision.action.kind}`,
      target: decision.action.target,
      at: now,
    });
    if (!authorization.authorized || !authorization.grantId) {
      this.recordApprovalDenial(
        decision,
        principal.id,
        authorization.reason ?? "Approval capability denied",
      );
      throw new Error(authorization.reason ?? "Approval capability denied");
    }

    const approval: HumanApproval = {
      principalId: principal.id,
      approvedAt: now,
      ...(comment ? { comment } : {}),
      capabilityGrantId: authorization.grantId,
    };
    decision.approvals = [...decision.approvals, approval];
    if (decision.approvals.length >= decision.requiredApprovals) {
      decision.status = "approved";
    }
    this.record(
      "decision.approved",
      {
        principalId: principal.id,
        approvals: decision.approvals.length,
        requiredApprovals: decision.requiredApprovals,
      },
      decision.agentId,
      decision.id,
    );
    this.emit("decision", cloneDecision(decision));
    return cloneDecision(decision);
    });
  }

  async rejectDecision(
    decisionId: string,
    principal: AuthenticatedPrincipal,
    reason: string,
  ): Promise<EmergentDecision> {
    assertAuthenticated(principal);
    if (!reason.trim()) throw new Error("A rejection reason is required");
    return this.withDecisionLock(decisionId, async () => {
    const decision = this.requireDecision(decisionId);
    if (
      decision.status !== "pending-approval" &&
      decision.status !== "approved"
    ) {
      throw new Error(`Decision ${decisionId} cannot be rejected from ${decision.status}`);
    }
    const now = this.clock.now();
    const authorization = await this.authorizer.authorize({
      subjectId: principal.id,
      capability: `approve:${decision.action.kind}`,
      target: decision.action.target,
      at: now,
    });
    if (!authorization.authorized) {
      this.recordApprovalDenial(
        decision,
        principal.id,
        authorization.reason ?? "Rejection capability denied",
      );
      throw new Error(authorization.reason ?? "Rejection capability denied");
    }
    decision.status = "rejected";
    decision.rejection = {
      principalId: principal.id,
      rejectedAt: now,
      reason: reason.trim(),
    };
    this.record(
      "decision.rejected",
      { principalId: principal.id, reason: reason.trim() },
      decision.agentId,
      decision.id,
    );
    this.emit("decision", cloneDecision(decision));
    return cloneDecision(decision);
    });
  }

  async executeDecision(decisionId: string): Promise<EmergentDecision> {
    return this.withDecisionLock(decisionId, async () => {
    const decision = this.requireDecision(decisionId);
    return this.withAgentExecutionLock(decision.agentId, async () => {
    if (decision.status !== "approved") {
      throw new Error(`Decision ${decisionId} is not approved`);
    }
    const now = this.clock.now();
    const envelope = this.envelopeFor(decision.agentId);
    if (isExpired(decision, envelope, now)) {
      decision.status = "expired";
      this.record(
        "decision.expired",
        { phase: "execution" },
        decision.agentId,
        decision.id,
      );
      this.emit("decision", cloneDecision(decision));
      throw new Error(`Decision ${decisionId} has expired`);
    }
    const recentExecutionHistory = (
      this.executionHistory.get(decision.agentId) ?? []
    ).filter((timestamp) => timestamp > now - 60_000);
    this.executionHistory.set(decision.agentId, recentExecutionHistory);
    const executionReasons = evaluateExecutionEnvelope(
      envelope,
      decision,
      this.bridge.getSynchronizationState().r,
      recentExecutionHistory,
      now,
    );
    if (executionReasons.length > 0) {
      this.failDecision(decision, executionReasons.join("; "));
      throw new Error(executionReasons.join("; "));
    }

    const authorization = await this.authorizer.authorize({
      subjectId: decision.agentId,
      capability: executionCapability(decision.action.kind),
      target: decision.action.target,
      at: now,
    });
    if (!authorization.authorized || !authorization.grantId) {
      const error = authorization.reason ?? "Execution capability denied";
      this.failDecision(decision, error);
      throw new Error(error);
    }
    if (!this.executor) {
      const error = "Action executor not configured; execution denied";
      this.failDecision(decision, error);
      throw new Error(error);
    }

    decision.status = "executing";
    decision.executionGrantId = authorization.grantId;
    this.record(
      "decision.executing",
      { target: decision.action.target },
      decision.agentId,
      decision.id,
    );
    try {
      const result = await this.executor.execute(cloneDecision(decision));
      decision.status = "executed";
      decision.executedAt = this.clock.now();
      decision.result = result;
      recentExecutionHistory.push(decision.executedAt);
      this.executionHistory.set(decision.agentId, recentExecutionHistory);
      this.record(
        "decision.executed",
        { target: decision.action.target },
        decision.agentId,
        decision.id,
      );
      this.emit("decision", cloneDecision(decision));
      return cloneDecision(decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failDecision(decision, message);
      throw error;
    }
    });
    });
  }

  getDecision(decisionId: string): EmergentDecision | undefined {
    const decision = this.decisions.get(decisionId);
    return decision ? cloneDecision(decision) : undefined;
  }

  getDecisions(filter?: {
    agentId?: string;
    status?: EmergentDecision["status"];
  }): EmergentDecision[] {
    return [...this.decisions.values()]
      .filter(
        (decision) =>
          (!filter?.agentId || decision.agentId === filter.agentId) &&
          (!filter?.status || decision.status === filter.status),
      )
      .map(cloneDecision);
  }

  getAuditTrail(): GhostAuditEvent[] {
    return this.audit.map((event) => ({
      ...event,
      details: { ...event.details },
    }));
  }

  getStatus(): {
    signals: number;
    patterns: number;
    agents: number;
    coherence: number;
    decisions: Record<EmergentDecision["status"], number>;
    auditEvents: number;
    executionConfigured: boolean;
  } {
    const decisions: Record<EmergentDecision["status"], number> = {
      blocked: 0,
      "pending-approval": 0,
      approved: 0,
      executing: 0,
      executed: 0,
      rejected: 0,
      failed: 0,
      expired: 0,
    };
    for (const decision of this.decisions.values()) decisions[decision.status] += 1;
    return {
      signals: this.bridge.getSignals().length,
      patterns: this.bridge.getPatterns().length,
      agents: this.bridge.getOscillators().length,
      coherence: this.bridge.getSynchronizationState().r,
      decisions,
      auditEvents: this.audit.length,
      executionConfigured: this.executor !== undefined,
    };
  }

  private envelopeFor(agentId: string): OperationalEnvelope {
    return this.envelopes.get(agentId) ?? this.defaultEnvelope;
  }

  private requireDecision(decisionId: string): EmergentDecision {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new Error(`Decision ${decisionId} not found`);
    return decision;
  }

  private storeDecision(decision: EmergentDecision): void {
    this.decisions.set(decision.id, decision);
    while (this.decisions.size > this.maxDecisions) {
      const candidate = [...this.decisions.values()].find((item) =>
        ["blocked", "executed", "rejected", "failed", "expired"].includes(
          item.status,
        ),
      );
      if (!candidate) {
        this.decisions.delete(decision.id);
        throw new Error(
          "Decision capacity reached while all retained decisions require operator action",
        );
      }
      this.decisions.delete(candidate.id);
    }
  }

  private failDecision(decision: EmergentDecision, error: string): void {
    decision.status = "failed";
    decision.error = error;
    this.record(
      "decision.failed",
      { error },
      decision.agentId,
      decision.id,
    );
    this.emit("decision", cloneDecision(decision));
  }

  private recordApprovalDenial(
    decision: EmergentDecision,
    principalId: string,
    reason: string,
  ): void {
    this.record(
      "decision.approval-denied",
      { principalId, reason },
      decision.agentId,
      decision.id,
    );
  }

  private withDecisionLock<T>(
    decisionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return serializeByKey(this.decisionOperations, decisionId, work);
  }

  private withAgentExecutionLock<T>(
    agentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return serializeByKey(this.agentExecutionOperations, agentId, work);
  }

  private record(
    type: GhostAuditEvent["type"],
    details: Record<string, unknown>,
    agentId?: string,
    decisionId?: string,
  ): void {
    const safeDetails = deepFreeze(structuredClone(details));
    const event: GhostAuditEvent = Object.freeze({
      sequence: ++this.auditCounter,
      timestamp: this.clock.now(),
      type,
      ...(agentId ? { agentId } : {}),
      ...(decisionId ? { decisionId } : {}),
      details: safeDetails,
    });
    this.audit.push(event);
    if (this.audit.length > this.maxAuditEvents) {
      this.audit.splice(0, this.audit.length - this.maxAuditEvents);
    }
    this.emit("audit", event);
  }
}

export function defaultPipelineSignalMapper(
  event: PipelineEventLike,
): Signal | null {
  const timestamp = new Date(event.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const candidates = [
    event.payload,
    payload?.value,
    payload?.tagValue,
    payload?.reading,
  ];
  let value: number | undefined;
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      value = candidate;
      break;
    }
    if (
      typeof candidate === "string" &&
      candidate.trim() !== "" &&
      Number.isFinite(Number(candidate))
    ) {
      value = Number(candidate);
      break;
    }
  }
  if (value === undefined) return null;
  return {
    id: `${event.source_id}:${event.sequence_number}`,
    source: event.source_id,
    type: event.event_type.toLowerCase().includes("alarm") ? "alarm" : "sensor",
    value,
    timestamp,
    metadata: {
      eventType: event.event_type,
      sequenceNumber: event.sequence_number,
      ...(event.metadata ?? {}),
    },
  };
}

function evaluateEnvelope(
  envelope: OperationalEnvelope,
  action: EmergentAction,
  confidence: number,
  coherence: number,
  at: number,
): EnvelopeCheck {
  const reasons: string[] = [];
  if (!envelope.allowedActionKinds.includes(action.kind)) {
    reasons.push(`Action kind ${action.kind} is outside the operational envelope`);
  }
  if (envelope.forbiddenTargets.some((scope) => targetMatches(scope, action.target))) {
    reasons.push(`Target ${action.target} is forbidden`);
  }
  if (!envelope.allowedTargets.some((scope) => targetMatches(scope, action.target))) {
    reasons.push(`Target ${action.target} is not allowlisted`);
  }
  if (confidence < envelope.minConfidence) {
    reasons.push(
      `Confidence ${confidence.toFixed(3)} is below ${envelope.minConfidence.toFixed(3)}`,
    );
  }
  if (coherence < envelope.minCoherence) {
    reasons.push(
      `Coherence ${coherence.toFixed(3)} is below ${envelope.minCoherence.toFixed(3)}`,
    );
  }
  if (action.kind === "control") {
    if (action.setpointDeltaPercent === undefined) {
      reasons.push("Control recommendation must declare setpointDeltaPercent");
    } else if (
      Math.abs(action.setpointDeltaPercent) > envelope.maxSetpointDeltaPercent
    ) {
      reasons.push(
        `Setpoint delta ${action.setpointDeltaPercent}% exceeds ${envelope.maxSetpointDeltaPercent}%`,
      );
    }
  }
  return { permitted: reasons.length === 0, reasons, evaluatedAt: at, coherence };
}

function evaluateExecutionEnvelope(
  envelope: OperationalEnvelope,
  decision: EmergentDecision,
  coherence: number,
  history: readonly number[],
  at: number,
): string[] {
  const check = evaluateEnvelope(
    envelope,
    decision.action,
    decision.confidence,
    coherence,
    at,
  );
  const reasons = [...check.reasons];
  const recent = history.filter((timestamp) => timestamp > at - 60_000);
  if (recent.length >= envelope.maxExecutionsPerMinute) {
    reasons.push(
      `Execution rate limit ${envelope.maxExecutionsPerMinute}/minute reached`,
    );
  }
  const autonomousNotification =
    decision.action.kind === "notify" &&
    envelope.allowAutonomousNotifications &&
    envelope.requiredApprovals === 0;
  const requiredApprovals = autonomousNotification
    ? 0
    : Math.max(1, envelope.requiredApprovals, decision.requiredApprovals);
  if (decision.approvals.length < requiredApprovals) {
    reasons.push("Required human approvals are missing");
  }
  return reasons;
}

function isExpired(
  decision: EmergentDecision,
  envelope: OperationalEnvelope,
  at: number,
): boolean {
  return at - decision.createdAt > envelope.maxDecisionAgeMs;
}

function executionCapability(kind: EmergentActionKind): string {
  return kind === "control" || kind === "configuration"
    ? `actuate:${kind}`
    : `execute:${kind}`;
}

function cloneAndValidateEnvelope(
  envelope: OperationalEnvelope,
): OperationalEnvelope {
  const numeric: Array<[string, number]> = [
    ["minConfidence", envelope.minConfidence],
    ["minCoherence", envelope.minCoherence],
    ["maxSetpointDeltaPercent", envelope.maxSetpointDeltaPercent],
    ["maxDecisionAgeMs", envelope.maxDecisionAgeMs],
    ["maxExecutionsPerMinute", envelope.maxExecutionsPerMinute],
    ["requiredApprovals", envelope.requiredApprovals],
  ];
  for (const [name, value] of numeric) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Envelope ${name} must be finite and non-negative`);
    }
  }
  if (envelope.minConfidence > 1 || envelope.minCoherence > 1) {
    throw new Error("Envelope confidence and coherence thresholds cannot exceed 1");
  }
  if (
    !Number.isInteger(envelope.maxExecutionsPerMinute) ||
    !Number.isInteger(envelope.requiredApprovals)
  ) {
    throw new Error("Envelope execution and approval limits must be integers");
  }
  return {
    ...envelope,
    allowedActionKinds: [...envelope.allowedActionKinds],
    allowedTargets: [...envelope.allowedTargets],
    forbiddenTargets: [...envelope.forbiddenTargets],
  };
}

function validateAction(action: EmergentAction): void {
  if (!action.target || !action.summary) {
    throw new Error("Decision action target and summary are required");
  }
  if (
    action.setpointDeltaPercent !== undefined &&
    !Number.isFinite(action.setpointDeltaPercent)
  ) {
    throw new Error("setpointDeltaPercent must be finite");
  }
}

function assertAuthenticated(principal: AuthenticatedPrincipal): void {
  if (!principal || principal.authenticated !== true || !principal.id) {
    throw new Error("Authenticated principal is required");
  }
}

function cloneAction(action: EmergentAction): EmergentAction {
  return structuredClone(action);
}

function cloneDecision(decision: EmergentDecision): EmergentDecision {
  return {
    ...decision,
    action: cloneAction(decision.action),
    approvals: decision.approvals.map((approval) => ({ ...approval })),
    envelopeCheck: {
      ...decision.envelopeCheck,
      reasons: [...decision.envelopeCheck.reasons],
    },
    rejection: decision.rejection ? { ...decision.rejection } : undefined,
    result:
      decision.result === undefined
        ? undefined
        : structuredClone(decision.result),
  };
}

async function serializeByKey<T>(
  operations: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  operations.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (operations.get(key) === tail) {
      operations.delete(key);
    }
  }
}

function targetMatches(scope: string, target: string): boolean {
  if (scope === "*") return true;
  if (scope.endsWith("*")) return target.startsWith(scope.slice(0, -1));
  return scope === target;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
