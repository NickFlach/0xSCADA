/**
 * Production SRE primitives (ADR-0014, issue #226).
 *
 * This module provides executable SLO/error-budget evaluation and a guarded
 * remediation engine.  System I/O is injected through adapters: tests and
 * operators can therefore exercise the complete safety flow without embedding
 * shell commands or cloud credentials in the service.
 */
import { createHash } from 'node:crypto';

export type SloStatus = 'healthy' | 'warning' | 'breached' | 'no-data';

export interface SloDefinition {
  id: string;
  name: string;
  criticalPath: string;
  description: string;
  sli: {
    metric: string;
    goodEvent: string;
    unit: 'ratio';
  };
  /** Fraction of good events required over the rolling window. */
  objective: number;
  windowDays: number;
  warningBurnRate: number;
  criticalBurnRate: number;
  owner: string;
  runbook: string;
}

export interface SliObservation {
  timestamp: string;
  goodEvents: number;
  totalEvents: number;
}

export interface SloEvaluation {
  sloId: string;
  status: SloStatus;
  windowStart: string;
  windowEnd: string;
  objective: number;
  sli: number | null;
  goodEvents: number;
  totalEvents: number;
  badEvents: number;
  allowedBadEvents: number;
  errorBudgetConsumed: number;
  errorBudgetRemaining: number;
  burnRate: number;
}

/**
 * Critical-path objectives.  `goodEvent` is intentionally precise enough to
 * turn every row into a Prometheus recording rule or an event counter.
 */
export const CRITICAL_PATH_SLOS: readonly SloDefinition[] = Object.freeze([
  {
    id: 'tag-ingest-freshness',
    name: 'Tag ingestion freshness',
    criticalPath: 'device → gateway → event pipeline',
    description: 'Accepted, good-quality tag updates reach the event pipeline within 1 second.',
    sli: {
      metric: 'scada_tag_ingest_fresh_total / scada_tag_ingest_total',
      goodEvent: 'update accepted with good quality and end-to-end ingest latency <= 1s',
      unit: 'ratio',
    },
    objective: 0.999,
    windowDays: 30,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'edge-platform',
    runbook: 'docs/operations/sre-playbooks/gateway-failover.md',
  },
  {
    id: 'control-loop-confirmation',
    name: 'Control-loop confirmation latency',
    criticalPath: 'tick → batch → sign → anchor → confirmation',
    description: 'Integrity pipeline events are confirmed within the configured round-trip budget.',
    sli: {
      metric: 'scada_integrity_round_trip_within_slo_total / scada_integrity_round_trip_total',
      goodEvent: 'round-trip duration <= 4.8s and every recorded stage is within its stage budget',
      unit: 'ratio',
    },
    objective: 0.999,
    windowDays: 30,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'integrity-platform',
    runbook: 'docs/blockchain/validator-monitoring.md',
  },
  {
    id: 'api-tag-read-availability',
    name: 'Tag read API availability',
    criticalPath: 'operator/client → API → cache or historian',
    description: 'Authorized tag reads complete successfully without a server error.',
    sli: {
      metric: 'scada_api_tag_read_good_total / scada_api_tag_read_total',
      goodEvent: 'HTTP response is non-5xx and completes within 500ms',
      unit: 'ratio',
    },
    objective: 0.9995,
    windowDays: 30,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'control-plane',
    runbook: 'docs/operations/sre-playbooks/incident-response.md',
  },
  {
    id: 'websocket-delivery',
    name: 'Realtime subscription delivery',
    criticalPath: 'event pipeline → WebSocket fan-out → subscribed client',
    description: 'Eligible events reach connected subscribers within 2 seconds.',
    sli: {
      metric: 'scada_websocket_delivery_good_total / scada_websocket_delivery_total',
      goodEvent: 'event delivered to an authenticated connected subscriber within 2s',
      unit: 'ratio',
    },
    objective: 0.999,
    windowDays: 30,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'control-plane',
    runbook: 'docs/operations/sre-playbooks/scaling-runbook.md',
  },
  {
    id: 'historian-durability',
    name: 'Historian write durability',
    criticalPath: 'event pipeline → historian → integrity verification',
    description: 'Accepted historian writes remain readable and integrity-verifiable.',
    sli: {
      metric: 'scada_historian_verified_writes_total / scada_historian_accepted_writes_total',
      goodEvent: 'accepted write is readable and its Merkle proof verifies after persistence',
      unit: 'ratio',
    },
    objective: 0.99999,
    windowDays: 30,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'data-platform',
    runbook: 'docs/operations/sre-playbooks/database-recovery.md',
  },
  {
    id: 'gateway-failover-rto',
    name: 'Gateway failover recovery objective',
    criticalPath: 'heartbeat loss → drain → shard rebalance → fresh telemetry',
    description: 'A single gateway loss restores tag coverage in at most 60 seconds.',
    sli: {
      metric: 'scada_gateway_failover_within_rto_total / scada_gateway_failover_total',
      goodEvent: 'all affected shards produce fresh telemetry <= 60s after confirmed heartbeat loss',
      unit: 'ratio',
    },
    objective: 0.99,
    windowDays: 90,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'edge-platform',
    runbook: 'docs/operations/sre-playbooks/gateway-failover.md',
  },
  {
    id: 'database-recovery-rto',
    name: 'Historian database recovery objective',
    criticalPath: 'database incident → failover/restore → verified writes',
    description: 'Database recovery restores verified writes in at most 15 minutes.',
    sli: {
      metric: 'scada_database_recovery_within_rto_total / scada_database_recovery_total',
      goodEvent: 'verified read/write service restored <= 15m with RPO <= 60s',
      unit: 'ratio',
    },
    objective: 0.99,
    windowDays: 90,
    warningBurnRate: 0.5,
    criticalBurnRate: 1,
    owner: 'data-platform',
    runbook: 'docs/operations/sre-playbooks/database-recovery.md',
  },
]);

export class SloRegistry {
  private readonly definitions: ReadonlyMap<string, SloDefinition>;
  private readonly now: () => Date;

  constructor(
    definitions: readonly SloDefinition[] = CRITICAL_PATH_SLOS,
    options: { now?: () => Date } = {},
  ) {
    const byId = new Map<string, SloDefinition>();
    for (const definition of definitions) {
      if (byId.has(definition.id)) throw new Error(`Duplicate SLO id: ${definition.id}`);
      if (definition.objective <= 0 || definition.objective >= 1) {
        throw new Error(`SLO ${definition.id} objective must be between 0 and 1`);
      }
      if (!Number.isFinite(definition.windowDays) || definition.windowDays <= 0) {
        throw new Error(`SLO ${definition.id} windowDays must be positive`);
      }
      if (definition.warningBurnRate <= 0
        || definition.criticalBurnRate <= definition.warningBurnRate) {
        throw new Error(`SLO ${definition.id} burn-rate thresholds are invalid`);
      }
      byId.set(definition.id, { ...definition, sli: { ...definition.sli } });
    }
    this.definitions = byId;
    this.now = options.now ?? (() => new Date());
  }

  list(): readonly SloDefinition[] {
    return [...this.definitions.values()].map(item => ({ ...item, sli: { ...item.sli } }));
  }

  get(id: string): SloDefinition | undefined {
    const definition = this.definitions.get(id);
    return definition === undefined ? undefined : { ...definition, sli: { ...definition.sli } };
  }

  evaluate(id: string, observations: readonly SliObservation[]): SloEvaluation {
    const definition = this.definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown SLO: ${id}`);
    const windowEndDate = this.now();
    const windowStartDate = new Date(
      windowEndDate.getTime() - definition.windowDays * 24 * 60 * 60 * 1000,
    );
    let goodEvents = 0;
    let totalEvents = 0;
    for (const observation of observations) {
      const timestamp = Date.parse(observation.timestamp);
      if (!Number.isFinite(timestamp)) {
        throw new Error(`Observation timestamp is invalid: ${observation.timestamp}`);
      }
      if (!Number.isInteger(observation.goodEvents)
        || !Number.isInteger(observation.totalEvents)
        || observation.goodEvents < 0
        || observation.totalEvents < 0
        || observation.goodEvents > observation.totalEvents) {
        throw new Error('Observation event counts must be non-negative integers with good <= total');
      }
      if (timestamp >= windowStartDate.getTime() && timestamp <= windowEndDate.getTime()) {
        goodEvents += observation.goodEvents;
        totalEvents += observation.totalEvents;
      }
    }
    if (totalEvents === 0) {
      return {
        sloId: id,
        status: 'no-data',
        windowStart: windowStartDate.toISOString(),
        windowEnd: windowEndDate.toISOString(),
        objective: definition.objective,
        sli: null,
        goodEvents: 0,
        totalEvents: 0,
        badEvents: 0,
        allowedBadEvents: 0,
        errorBudgetConsumed: 0,
        errorBudgetRemaining: 1,
        burnRate: 0,
      };
    }
    const badEvents = totalEvents - goodEvents;
    const allowedBadEvents = totalEvents * (1 - definition.objective);
    const sli = goodEvents / totalEvents;
    const burnRate = allowedBadEvents === 0 ? 0 : badEvents / allowedBadEvents;
    const errorBudgetConsumed = Math.max(0, burnRate);
    const roundedBurnRate = Number(burnRate.toFixed(4));
    const status: SloStatus = roundedBurnRate >= definition.criticalBurnRate
      ? 'breached'
      : roundedBurnRate >= definition.warningBurnRate
        ? 'warning'
        : 'healthy';
    return {
      sloId: id,
      status,
      windowStart: windowStartDate.toISOString(),
      windowEnd: windowEndDate.toISOString(),
      objective: definition.objective,
      sli: Number(sli.toFixed(8)),
      goodEvents,
      totalEvents,
      badEvents,
      allowedBadEvents: Number(allowedBadEvents.toFixed(4)),
      errorBudgetConsumed: Number(errorBudgetConsumed.toFixed(4)),
      errorBudgetRemaining: Number(Math.max(0, 1 - errorBudgetConsumed).toFixed(4)),
      burnRate: roundedBurnRate,
    };
  }
}

export type RemediationRisk = 'low' | 'medium' | 'high';
export type RemediationStatus =
  | 'planned'
  | 'skipped'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'rolled-back';

export interface RemediationPrecondition {
  needed: boolean;
  safe: boolean;
  reason: string;
}

export interface RemediationOutcome {
  changed: boolean;
  message: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RemediationAction<Context = unknown> {
  id: string;
  description: string;
  risk: RemediationRisk;
  /** Affected resource key used for cooldown isolation. */
  scope(context: Context): string;
  precondition(context: Context): Promise<RemediationPrecondition>;
  execute(context: Context): Promise<RemediationOutcome>;
  verify?(context: Context, outcome: RemediationOutcome): Promise<boolean>;
  rollback?(context: Context, outcome: RemediationOutcome): Promise<void>;
}

export interface RemediationRequest<Context = unknown> {
  actionId: string;
  context: Context;
  idempotencyKey: string;
  dryRun?: boolean;
  /** Required for actions above the engine's automatic risk ceiling. */
  approvedBy?: string;
}

export interface RemediationResult {
  executionId: string;
  actionId: string;
  idempotencyKey: string;
  status: RemediationStatus;
  risk: RemediationRisk;
  dryRun: boolean;
  reused: boolean;
  startedAt: string;
  completedAt: string;
  scope: string;
  message: string;
  changed: boolean;
  verified: boolean;
  rollbackAttempted: boolean;
}

export interface RemediationPolicy {
  allowedActionIds?: readonly string[];
  maxAutomaticRisk?: RemediationRisk;
  cooldownMs?: number;
  maxExecutionsPerHour?: number;
  maxAuditEntries?: number;
}

interface CachedExecution {
  fingerprint: string;
  result: RemediationResult;
}

const RISK_RANK: Readonly<Record<RemediationRisk, number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export class AutoRemediationEngine {
  private readonly actions = new Map<string, RemediationAction<unknown>>();
  private readonly allowedActionIds?: ReadonlySet<string>;
  private readonly maxAutomaticRisk: RemediationRisk;
  private readonly cooldownMs: number;
  private readonly maxExecutionsPerHour: number;
  private readonly maxAuditEntries: number;
  private readonly now: () => Date;
  private readonly cached = new Map<string, CachedExecution>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<RemediationResult> }>();
  private readonly lastExecutionByScope = new Map<string, number>();
  private readonly executionTimes: number[] = [];
  private readonly auditLog: RemediationResult[] = [];

  constructor(
    actions: readonly RemediationAction<unknown>[] = [],
    policy: RemediationPolicy = {},
    options: { now?: () => Date } = {},
  ) {
    this.allowedActionIds = policy.allowedActionIds === undefined
      ? undefined
      : new Set(policy.allowedActionIds);
    this.maxAutomaticRisk = policy.maxAutomaticRisk ?? 'medium';
    this.cooldownMs = policy.cooldownMs ?? 5 * 60 * 1000;
    this.maxExecutionsPerHour = policy.maxExecutionsPerHour ?? 20;
    this.maxAuditEntries = policy.maxAuditEntries ?? 1_000;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) {
      throw new Error('cooldownMs must be non-negative');
    }
    if (!Number.isInteger(this.maxExecutionsPerHour) || this.maxExecutionsPerHour < 1) {
      throw new Error('maxExecutionsPerHour must be a positive integer');
    }
    if (!Number.isInteger(this.maxAuditEntries) || this.maxAuditEntries < 1) {
      throw new Error('maxAuditEntries must be a positive integer');
    }
    for (const action of actions) this.register(action);
  }

  register<Context>(action: RemediationAction<Context>): void {
    if (!action.id.trim()) throw new Error('Remediation action id is required');
    if (this.actions.has(action.id)) throw new Error(`Duplicate remediation action: ${action.id}`);
    this.actions.set(action.id, action as RemediationAction<unknown>);
  }

  listActions(): ReadonlyArray<Pick<RemediationAction, 'id' | 'description' | 'risk'>> {
    return [...this.actions.values()].map(({ id, description, risk }) => ({ id, description, risk }));
  }

  getAuditLog(limit = 100): readonly RemediationResult[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    return this.auditLog.slice(-limit).map(entry => ({ ...entry }));
  }

  async execute<Context>(request: RemediationRequest<Context>): Promise<RemediationResult> {
    if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 200) {
      throw new Error('idempotencyKey must contain 1 to 200 characters');
    }
    const action = this.actions.get(request.actionId) as RemediationAction<Context> | undefined;
    if (action === undefined) throw new Error(`Unknown remediation action: ${request.actionId}`);
    const fingerprint = hash({
      actionId: request.actionId,
      context: request.context,
      dryRun: request.dryRun ?? false,
      approvedBy: request.approvedBy ?? null,
    });
    const prior = this.cached.get(request.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error(`Idempotency key ${request.idempotencyKey} was already used for another request`);
      }
      return { ...prior.result, reused: true };
    }
    const running = this.inFlight.get(request.idempotencyKey);
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) {
        throw new Error(`Idempotency key ${request.idempotencyKey} is in use by another request`);
      }
      return { ...(await running.promise), reused: true };
    }

    const promise = this.executeOnce(action, request);
    this.inFlight.set(request.idempotencyKey, { fingerprint, promise });
    try {
      const result = await promise;
      this.cached.set(request.idempotencyKey, { fingerprint, result });
      return result;
    } finally {
      this.inFlight.delete(request.idempotencyKey);
    }
  }

  private async executeOnce<Context>(
    action: RemediationAction<Context>,
    request: RemediationRequest<Context>,
  ): Promise<RemediationResult> {
    const started = this.now();
    const scope = `${action.id}:${action.scope(request.context)}`;
    const executionId = `rem-${hash({
      actionId: action.id,
      idempotencyKey: request.idempotencyKey,
      startedAt: started.toISOString(),
    }).slice(0, 16)}`;
    const finish = (
      partial: Pick<RemediationResult, 'status' | 'message' | 'changed' | 'verified' | 'rollbackAttempted'>,
    ): RemediationResult => {
      const result: RemediationResult = {
        executionId,
        actionId: action.id,
        idempotencyKey: request.idempotencyKey,
        risk: action.risk,
        dryRun: request.dryRun ?? false,
        reused: false,
        startedAt: started.toISOString(),
        completedAt: this.now().toISOString(),
        scope,
        ...partial,
      };
      this.appendAudit(result);
      return result;
    };

    if (this.allowedActionIds !== undefined && !this.allowedActionIds.has(action.id)) {
      return finish({
        status: 'blocked',
        message: `Action ${action.id} is not on the remediation allowlist`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    if (RISK_RANK[action.risk] > RISK_RANK[this.maxAutomaticRisk]
      && !request.approvedBy?.trim()) {
      return finish({
        status: 'blocked',
        message: `${action.risk}-risk action requires an approver identity`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }

    let precondition: RemediationPrecondition;
    try {
      precondition = await action.precondition(request.context);
    } catch (error) {
      return finish({
        status: 'failed',
        message: `Precondition failed: ${error instanceof Error ? error.message : String(error)}`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    if (!precondition.safe) {
      return finish({
        status: 'blocked',
        message: precondition.reason,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    if (!precondition.needed) {
      return finish({
        status: 'skipped',
        message: precondition.reason,
        changed: false,
        verified: true,
        rollbackAttempted: false,
      });
    }
    if (request.dryRun) {
      return finish({
        status: 'planned',
        message: `Dry run: ${precondition.reason}`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }

    const nowMs = started.getTime();
    const previousExecution = this.lastExecutionByScope.get(scope);
    if (previousExecution !== undefined && nowMs - previousExecution < this.cooldownMs) {
      return finish({
        status: 'blocked',
        message: `Cooldown active for ${scope}`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    const hourAgo = nowMs - 60 * 60 * 1000;
    while (this.executionTimes.length > 0 && this.executionTimes[0] < hourAgo) {
      this.executionTimes.shift();
    }
    if (this.executionTimes.length >= this.maxExecutionsPerHour) {
      return finish({
        status: 'blocked',
        message: 'Global remediation execution rate limit reached',
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    this.executionTimes.push(nowMs);
    this.lastExecutionByScope.set(scope, nowMs);

    let outcome: RemediationOutcome;
    try {
      outcome = await action.execute(request.context);
    } catch (error) {
      return finish({
        status: 'failed',
        message: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
        changed: false,
        verified: false,
        rollbackAttempted: false,
      });
    }
    if (!outcome.changed) {
      return finish({
        status: 'skipped',
        message: outcome.message,
        changed: false,
        verified: true,
        rollbackAttempted: false,
      });
    }

    let verified = true;
    if (action.verify !== undefined) {
      try {
        verified = await action.verify(request.context, outcome);
      } catch {
        verified = false;
      }
    }
    if (verified) {
      return finish({
        status: 'succeeded',
        message: outcome.message,
        changed: true,
        verified: true,
        rollbackAttempted: false,
      });
    }
    if (action.rollback === undefined) {
      return finish({
        status: 'failed',
        message: `${outcome.message}; post-change verification failed and no rollback is available`,
        changed: true,
        verified: false,
        rollbackAttempted: false,
      });
    }
    try {
      await action.rollback(request.context, outcome);
      return finish({
        status: 'rolled-back',
        message: `${outcome.message}; verification failed and rollback completed`,
        changed: false,
        verified: false,
        rollbackAttempted: true,
      });
    } catch (error) {
      return finish({
        status: 'failed',
        message: `${outcome.message}; verification and rollback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        changed: true,
        verified: false,
        rollbackAttempted: true,
      });
    }
  }

  private appendAudit(result: RemediationResult): void {
    this.auditLog.push(result);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.splice(0, this.auditLog.length - this.maxAuditEntries);
    }
  }
}

export interface GatewayFailoverContext {
  gatewayId: string;
}

export interface GatewayFailoverAdapter {
  inspect(gatewayId: string): Promise<{
    healthy: boolean;
    activeGatewayCount: number;
    affectedShardCount: number;
  }>;
  failover(gatewayId: string): Promise<{ previousAssignments: unknown }>;
  verifyCoverage(gatewayId: string): Promise<boolean>;
  restore(gatewayId: string, previousAssignments: unknown): Promise<void>;
}

export function createGatewayFailoverAction(
  adapter: GatewayFailoverAdapter,
): RemediationAction<GatewayFailoverContext> {
  return {
    id: 'gateway-failover',
    description: 'Drain an unhealthy gateway and rebalance its shards to healthy peers.',
    risk: 'medium',
    scope: context => context.gatewayId,
    precondition: async context => {
      if (!context.gatewayId.trim()) return { needed: false, safe: false, reason: 'gatewayId is required' };
      const state = await adapter.inspect(context.gatewayId);
      if (state.healthy) return { needed: false, safe: true, reason: 'Gateway is already healthy' };
      if (state.activeGatewayCount < 2) {
        return {
          needed: true,
          safe: false,
          reason: 'Failover blocked: no healthy peer gateway can receive the affected shards',
        };
      }
      return {
        needed: state.affectedShardCount > 0,
        safe: true,
        reason: `${state.affectedShardCount} shards require failover`,
      };
    },
    execute: async context => {
      const result = await adapter.failover(context.gatewayId);
      return {
        changed: true,
        message: `Gateway ${context.gatewayId} drained and shard rebalance requested`,
        metadata: { previousAssignments: result.previousAssignments },
      };
    },
    verify: context => adapter.verifyCoverage(context.gatewayId),
    rollback: async (context, outcome) => {
      await adapter.restore(context.gatewayId, outcome.metadata?.previousAssignments);
    },
  };
}

export interface ScaleOutContext {
  component: string;
  desiredReplicas: number;
  maximumReplicas: number;
}

export interface ScaleOutAdapter {
  currentReplicas(component: string): Promise<number>;
  setReplicas(component: string, replicas: number): Promise<void>;
  readyReplicas(component: string): Promise<number>;
}

export function createScaleOutAction(adapter: ScaleOutAdapter): RemediationAction<ScaleOutContext> {
  return {
    id: 'scale-out',
    description: 'Increase replicas within an operator-supplied hard safety limit.',
    risk: 'low',
    scope: context => context.component,
    precondition: async context => {
      if (!context.component.trim()) return { needed: false, safe: false, reason: 'component is required' };
      if (!Number.isInteger(context.desiredReplicas) || !Number.isInteger(context.maximumReplicas)) {
        return { needed: false, safe: false, reason: 'Replica limits must be integers' };
      }
      if (context.desiredReplicas < 1 || context.desiredReplicas > context.maximumReplicas) {
        return {
          needed: false,
          safe: false,
          reason: 'desiredReplicas is outside the approved maximum',
        };
      }
      const current = await adapter.currentReplicas(context.component);
      if (context.desiredReplicas <= current) {
        return { needed: false, safe: true, reason: `Already running ${current} replicas` };
      }
      return {
        needed: true,
        safe: true,
        reason: `Scale ${context.component} from ${current} to ${context.desiredReplicas} replicas`,
      };
    },
    execute: async context => {
      const previousReplicas = await adapter.currentReplicas(context.component);
      await adapter.setReplicas(context.component, context.desiredReplicas);
      return {
        changed: true,
        message: `Scaled ${context.component} to ${context.desiredReplicas} replicas`,
        metadata: { previousReplicas },
      };
    },
    verify: async context => (await adapter.readyReplicas(context.component)) >= context.desiredReplicas,
    rollback: async (context, outcome) => {
      const previous = outcome.metadata?.previousReplicas;
      if (!Number.isInteger(previous)) throw new Error('Rollback replica count is unavailable');
      await adapter.setReplicas(context.component, previous as number);
    },
  };
}

export const sloRegistry = new SloRegistry();
