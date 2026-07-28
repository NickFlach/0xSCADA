/**
 * Alarm Correlation Types
 * ADR-0013 [13.2] — Issue #213
 *
 * Types for grouping related alarms by temporal proximity, causal chains,
 * and equipment hierarchy; root-cause identification; and suppression of
 * downstream/consequential alarms.
 *
 * Severity aligns with the live runtime vocabulary (SingularisPrime
 * Severity / GR::LISTEN priority). Lifecycle state extends the client's
 * active|acknowledged|cleared vocabulary with 'shelved' (DB enum) and
 * 'suppressed' (ScadaAlarmBlock), which correlation introduces.
 */

export type AlarmSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type AlarmLifecycleState =
  | 'active'
  | 'acknowledged'
  | 'cleared'
  | 'shelved'
  | 'suppressed';

/** Normalized alarm instance flowing through the correlation engine */
export interface CorrelatedAlarm {
  id: string;
  name: string;
  /** Tag that triggered the alarm (free-string, convention "ASSET.EVENT") */
  tagId: string;
  /** Resolved equipment id — enables hierarchy/causal correlation */
  equipmentId?: string;
  siteId?: string;
  processArea?: string;
  severity: AlarmSeverity;
  state: AlarmLifecycleState;
  message: string;
  /** Event time in epoch ms — all correlation logic is event-time driven */
  timestamp: number;
  value?: number | string;
  limit?: number | string;
  /** Where the alarm came from (simulator, phi, spc, api, ...) */
  source?: string;
  /** Server-owned control-plane principal that acknowledged this alarm. */
  acknowledgedBy?: string;
  /** Server-owned control-plane principal that cleared this alarm. */
  clearedBy?: string;
}

// ── Equipment topology ────────────────────────────────────────────────────

/**
 * A node in the equipment graph. Two edge sets:
 * - parentId: physical/functional containment hierarchy (must be acyclic)
 * - causalDownstream: directed process-causality edges (cycles tolerated
 *   by traversal guards — recirculation loops exist in real plants)
 */
export interface EquipmentNode {
  equipmentId: string;
  name?: string;
  parentId?: string;
  causalDownstream: string[];
  siteId?: string;
  processArea?: string;
}

// ── Correlation rules ─────────────────────────────────────────────────────

export type CorrelationRuleType = 'causal' | 'hierarchy' | 'temporal';

export interface CausalRuleConfig {
  /** Max event-time gap between a candidate alarm and a connected member */
  windowMs: number;
  /** Max causal-edge hops for reachability */
  maxHops: number;
}

export interface HierarchyRuleConfig {
  windowMs: number;
  /** Max steps to a common ancestor for two nodes to count as related */
  maxDistance: number;
}

export interface TemporalRuleConfig {
  windowMs: number;
  /**
   * Bare temporal proximity never merges unrelated equipment. Scope
   * restricts which alarms a temporal rule may group:
   * - 'same-tag': repeats/chatter of one tag
   * - 'same-equipment': alarms of one equipment id
   * - 'process-area': alarms sharing a processArea value
   */
  scope: 'same-tag' | 'same-equipment' | 'process-area';
}

export interface CorrelationRule {
  id: string;
  name: string;
  type: CorrelationRuleType;
  enabled: boolean;
  /** Lower runs first */
  priority: number;
  config: CausalRuleConfig | HierarchyRuleConfig | TemporalRuleConfig;
}

/** Policy governing suppression of consequential alarms within groups */
export interface SuppressionPolicy {
  enabled: boolean;
  /** Alarms at or above this severity are never suppressed */
  neverSuppressAtOrAbove: AlarmSeverity;
  /** Re-emit suppressed members when the root cause clears */
  unsuppressOnRootClear: boolean;
}

// ── Groups & results ──────────────────────────────────────────────────────

export type AlarmGroupState = 'open' | 'closed';

export interface AlarmGroup {
  id: string;
  state: AlarmGroupState;
  /** Snapshots of member alarms, in ingestion order */
  alarms: CorrelatedAlarm[];
  /** Membership is tracked by id, never object identity */
  alarmIds: string[];
  rootCauseAlarmId: string;
  /** Rule that formed the group */
  formedByRuleId: string;
  /** Rule that admitted each member, keyed by alarm id */
  joinedVia: Record<string, string>;
  suppressedAlarmIds: string[];
  maxSeverity: AlarmSeverity;
  createdAt: number;
  lastAlarmAt: number;
  closedAt?: number;
  closeReason?: 'root-cause-cleared' | 'idle-timeout' | 'evicted';
}

export type IngestAction = 'joined-group' | 'formed-group' | 'standalone' | 'duplicate';

export interface IngestResult {
  alarmId: string;
  action: IngestAction;
  groupId?: string;
  ruleId?: string;
  suppressed: boolean;
  isRootCause: boolean;
  reason: string;
}

export interface RootCauseResult {
  groupId: string;
  alarm: CorrelatedAlarm;
  /** How many other members this alarm causally reaches */
  causalDominance: number;
  hierarchyDepth: number;
  electedBy: string;
}

export interface CorrelationMetrics {
  alarmsIngested: number;
  groupsCreated: number;
  groupsClosed: number;
  /** Unique ingested alarm instances that entered engine-owned suppression. */
  alarmsSuppressed: number;
  alarmsUnsuppressed: number;
  /** unique suppressed alarm instances / ingested alarms — the alarm-fatigue KPI */
  suppressionRate: number;
  openGroups: number;
  trackedAlarms: number;
}

/**
 * `process-local` — correlation state lives only in this process's heap. It is
 *   lost on restart and a second replica may hold a different view, so
 *   suppression stays off unless an operator opts into a single-process
 *   evaluation.
 * `durable` — correlation state is projected from the shared journal
 *   (`alarm_correlation_*`, migration 0015). Every replica applies the same
 *   totally-ordered entries, so membership, root cause and suppression agree
 *   across replicas and survive restart.
 */
export type CorrelationCoordinationMode = 'process-local' | 'durable';

/** Stable correlation metadata attached to each live alarm snapshot. */
export interface AlarmCorrelationSnapshot {
  groupId: string | null;
  groupState: AlarmGroupState | null;
  rootCauseAlarmId: string | null;
  suppressed: boolean;
  isRootCause: boolean;
  coordinationMode: CorrelationCoordinationMode;
  /**
   * Journal sequence of the operation that produced this state, when running
   * durably. Monotonic per alarm and shared by all replicas, so a consumer
   * receiving the same alarm from two instances keeps the higher seq and drops
   * the echo. `null` in process-local mode, where no shared order exists.
   */
  seq: number | null;
}

/** Canonical alarm payload emitted to live WebSocket consumers. */
export interface AlarmWireSnapshot extends CorrelatedAlarm {
  triggeredAt: string;
  tagValue?: number | string;
  correlation: AlarmCorrelationSnapshot;
}

// ── Durable coordination ──────────────────────────────────────────────────

/** Operations the shared journal orders. */
export type CorrelationJournalOp =
  | 'ingest'
  | 'acknowledge'
  | 'clear'
  | 'rule-upsert'
  | 'rule-remove'
  | 'rule-enabled'
  | 'topology-upsert'
  | 'topology-remove'
  | 'policy-set'
  /**
   * Idle-group housekeeping. Journaled rather than run per replica: closing an
   * idle group un-suppresses its members, so a sweep that ran on one replica
   * and not another would leave the two disagreeing about which alarms an
   * operator can see. The entry carries the sweep clock so every replica
   * applies the identical decision.
   */
  | 'sweep';

/** One durable, totally-ordered correlation operation. */
export interface CorrelationJournalEntry {
  seq: number;
  idempotencyKey: string;
  op: CorrelationJournalOp;
  payload: Record<string, unknown>;
  /** Authenticated control-plane principal — never taken from a request body. */
  principal: string;
  originInstance: string;
  recordedAt: number;
}

/**
 * Observable coordination health. `healthy: false` is not advisory: the
 * runtime has already forced suppression off and restored every suppressed
 * alarm by the time this reports degraded.
 */
export interface CorrelationCoordinationHealth {
  healthy: boolean;
  mode: CorrelationCoordinationMode;
  backend: 'postgres' | 'sqlite' | 'unopened' | 'none';
  /** Highest journal seq this replica has applied to its own engine. */
  appliedSeq: number;
  /** Watermark of the shared materialised projection. */
  materializedSeq: number;
  /** Operator's persisted intent, independent of whether it is being honoured. */
  policyEnabledIntent: boolean;
  /** Whether suppression is actually active in the engine right now. */
  suppressionActive: boolean;
  /** True when a coordination failure, not the operator, turned suppression off. */
  suppressionDisabledByHealth: boolean;
  lastError: string | null;
  lastHealthyAt: number | null;
  instanceId: string;
}
