/**
 * Alarm Correlation Engine
 * ADR-0013 [13.2] — Issue #213
 *
 * Groups related alarms via the rules engine (causal chains, equipment
 * hierarchy, scoped temporal proximity), elects a deterministic root
 * cause per group, and suppresses downstream/consequential alarms with
 * severity guards and un-suppression when the root cause clears.
 *
 * Correlation decisions use event time, and pending connected components are
 * reconciled deterministically when they fit one bounded group. Components
 * split by safety caps or already-open groups may retain arrival-order
 * partitions. Wall clock is supplied only to sweep() for housekeeping.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import type {
  AlarmGroup,
  AlarmSeverity,
  CorrelatedAlarm,
  CorrelationMetrics,
  CorrelationRule,
  IngestResult,
  RootCauseResult,
  SuppressionPolicy,
} from '@shared/types/alarm-correlation';
import { EquipmentTopology } from './topology';
import { CorrelationRulesEngine } from './rules';

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Alarms this close in event time tie on "earliest" during root election */
const ROOT_ELECTION_TIME_BUCKET_MS = 100;

export const DEFAULT_SUPPRESSION_POLICY: SuppressionPolicy = {
  enabled: false,
  neverSuppressAtOrAbove: 'critical',
  unsuppressOnRootClear: true,
};

export interface CorrelationEngineOptions {
  topology?: EquipmentTopology;
  rules?: CorrelationRulesEngine;
  suppressionPolicy?: Partial<SuppressionPolicy>;
  /** Open groups with no new alarms for this long (vs sweep clock) close */
  groupCloseAfterMs?: number;
  /** A group never admits alarms this far (event time) after its earliest member */
  maxGroupSpanMs?: number;
  /** Retained groups (open + closed); oldest closed evicted first */
  maxGroups?: number;
  /** Ungrouped alarms retained as candidate peers for future groups */
  maxPendingAlarms?: number;
  /** Hard cap on members in one group to bound root-election work */
  maxAlarmsPerGroup?: number;
  /** Processing-time clock used only for lifecycle housekeeping */
  clock?: () => number;
  /**
   * Mints the id for a newly formed group. Defaults to a process-local random
   * UUID, which is collision-free but arbitrary: two replicas replaying the
   * same operation would mint different ids for the same group. The durable
   * coordinator (#573) supplies a factory deriving the id from the shared
   * journal sequence instead, so every replica names the group identically and
   * a monotonic, never-reused sequence rules out reuse.
   */
  groupIdFactory?: () => string;
}

/**
 * Everything a restart or a second replica needs to reconstitute this engine's
 * correlation state. Deliberately excludes rules and topology, which are owned
 * by their own components and restored separately.
 */
export interface CorrelationEngineState {
  groups: AlarmGroup[];
  /** Tracked but ungrouped alarms — candidate peers for future groups. */
  pending: CorrelatedAlarm[];
  metrics: {
    alarmsIngested: number;
    groupsCreated: number;
    groupsClosed: number;
    alarmsSuppressed: number;
    alarmsUnsuppressed: number;
  };
}

export class AlarmCorrelationEngine extends EventEmitter {
  readonly topology: EquipmentTopology;
  readonly rules: CorrelationRulesEngine;

  private suppressionPolicy: SuppressionPolicy;
  private readonly groupCloseAfterMs: number;
  private readonly maxGroupSpanMs: number;
  private readonly maxGroups: number;
  private readonly maxPendingAlarms: number;
  private readonly maxAlarmsPerGroup: number;
  private readonly clock: () => number;
  private readonly groupIdFactory: () => string;

  private groups: Map<string, AlarmGroup> = new Map();
  private groupLastTouchedAt: Map<string, number> = new Map();
  /** Ungrouped recent alarms — candidate peers for group formation */
  private pending: CorrelatedAlarm[] = [];
  private pendingLastTouchedAt: Map<string, number> = new Map();
  /** alarmId → groupId, or null while standalone/pending */
  private alarmIndex: Map<string, string | null> = new Map();

  private metrics = {
    alarmsIngested: 0,
    groupsCreated: 0,
    groupsClosed: 0,
    alarmsSuppressed: 0,
    alarmsUnsuppressed: 0,
  };
  /**
   * Alarm ids already counted for suppression while their groups are
   * retained. Entries are discarded with group eviction, bounding this set
   * by the retained-group/member caps after synchronous cap enforcement.
   */
  private suppressionCountedAlarmIds = new Set<string>();

  constructor(options: CorrelationEngineOptions = {}) {
    super();
    this.topology = options.topology ?? new EquipmentTopology();
    this.rules = options.rules ?? new CorrelationRulesEngine();
    this.suppressionPolicy = { ...DEFAULT_SUPPRESSION_POLICY, ...options.suppressionPolicy };
    this.groupCloseAfterMs = options.groupCloseAfterMs ?? 10 * 60 * 1000;
    this.maxGroupSpanMs = options.maxGroupSpanMs ?? 30 * 60 * 1000;
    this.maxGroups = options.maxGroups ?? 1000;
    this.maxPendingAlarms = options.maxPendingAlarms ?? 2000;
    this.maxAlarmsPerGroup = options.maxAlarmsPerGroup ?? 128;
    this.clock = options.clock ?? Date.now;
    this.groupIdFactory = options.groupIdFactory ?? (() => `ACG-${randomUUID()}`);
    if (options.suppressionPolicy?.unsuppressOnRootClear === false) {
      throw new Error('unsuppressOnRootClear must remain enabled for fail-safe closure');
    }
    for (const [name, value] of [
      ['groupCloseAfterMs', this.groupCloseAfterMs],
      ['maxGroupSpanMs', this.maxGroupSpanMs],
      ['maxGroups', this.maxGroups],
      ['maxPendingAlarms', this.maxPendingAlarms],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (!Number.isSafeInteger(this.maxAlarmsPerGroup) || this.maxAlarmsPerGroup < 2) {
      throw new Error('maxAlarmsPerGroup must be an integer of at least 2');
    }
  }

  // ── Ingestion & correlation ──────────────────────────────────────────

  ingest(input: CorrelatedAlarm): IngestResult {
    // Suppression is engine-owned state. A newly raised alarm cannot arrive
    // already suppressed and escape the engine's tracking/restoration path.
    const alarm: CorrelatedAlarm =
      input.state === 'suppressed'
        ? { ...input, state: 'active' }
        : input;
    if (this.alarmIndex.has(alarm.id)) {
      const groupId = this.alarmIndex.get(alarm.id) ?? undefined;
      const group = groupId ? this.groups.get(groupId) : undefined;
      return {
        alarmId: alarm.id,
        action: 'duplicate',
        groupId,
        suppressed: group ? group.suppressedAlarmIds.includes(alarm.id) : false,
        isRootCause: group ? group.rootCauseAlarmId === alarm.id : false,
        reason: 'duplicate alarm id — already ingested',
      };
    }

    this.metrics.alarmsIngested++;

    // 1. Try to join an existing open group (most recently active first)
    const openGroups = Array.from(this.groups.values())
      .filter((g) => g.state === 'open')
      .sort((a, b) => b.lastAlarmAt - a.lastAlarmAt);

    for (const group of openGroups) {
      if (group.alarmIds.length >= this.maxAlarmsPerGroup) continue;
      if (!this.withinGroupSpan(group, alarm.timestamp)) continue;
      const rule = this.rules.evaluateJoin(alarm, group, this.topology);
      if (rule) {
        const result = this.joinGroup(alarm, group, rule);
        this.reconcilePending(group);
        return this.refreshIngestResult(result, alarm, group);
      }
    }

    // 2. Try to form a new group with a pending (ungrouped) alarm
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const peer = this.pending[i];
      if (peer.state === 'cleared' || peer.state === 'shelved') continue;
      if (Math.abs(alarm.timestamp - peer.timestamp) > this.maxGroupSpanMs) continue;
      const rule = this.rules.evaluatePair(alarm, peer, this.topology);
      if (rule) {
        const result = this.formGroup(alarm, peer, rule);
        const group = this.groups.get(result.groupId!);
        if (!group) return result;
        this.reconcilePending(group);
        return this.refreshIngestResult(result, alarm, group);
      }
    }

    // 3. Standalone — buffer as a candidate peer for future alarms
    this.pending.push(alarm);
    this.pendingLastTouchedAt.set(alarm.id, this.clock());
    this.alarmIndex.set(alarm.id, null);
    this.prunePending(alarm.timestamp);
    this.emit('alarm-updated', alarm);
    return {
      alarmId: alarm.id,
      action: 'standalone',
      suppressed: false,
      isRootCause: false,
      reason: 'no enabled rule matched an open group or pending alarm',
    };
  }

  // ── Alarm lifecycle updates ──────────────────────────────────────────

  /**
   * Mark an alarm cleared. Clearing a group's root cause closes the group
   * and (per policy) un-suppresses its remaining active members.
   */
  alarmCleared(
    alarmId: string,
    actor?: string,
  ): {
    cleared: boolean;
    clearedBy?: string;
    groupClosed?: string;
    unsuppressed: string[];
  } {
    const groupId = this.alarmIndex.get(alarmId);
    if (groupId === undefined) return { cleared: false, unsuppressed: [] };

    if (groupId === null) {
      const pendingAlarm = this.pending.find((a) => a.id === alarmId);
      if (!pendingAlarm) return { cleared: false, unsuppressed: [] };
      if (pendingAlarm.state === 'cleared') {
        return {
          cleared: true,
          clearedBy: pendingAlarm.clearedBy,
          unsuppressed: [],
        };
      }
      pendingAlarm.state = 'cleared';
      if (actor) pendingAlarm.clearedBy = actor;
      this.emit('alarm-updated', pendingAlarm);
      return {
        cleared: true,
        clearedBy: pendingAlarm.clearedBy,
        unsuppressed: [],
      };
    }

    const group = this.groups.get(groupId);
    if (!group) return { cleared: false, unsuppressed: [] };

    const member = group.alarms.find((a) => a.id === alarmId);
    if (!member) return { cleared: false, unsuppressed: [] };
    if (member.state === 'cleared') {
      return {
        cleared: true,
        clearedBy: member.clearedBy,
        groupClosed: group.state === 'closed' ? group.id : undefined,
        unsuppressed: [],
      };
    }
    this.removeSuppressionRecord(group, alarmId);
    member.state = 'cleared';
    if (actor) member.clearedBy = actor;

    if (group.state === 'open' && group.rootCauseAlarmId === alarmId) {
      const unsuppressed = this.unsuppressActiveMembers(group);
      this.closeGroup(group, 'root-cause-cleared');
      return {
        cleared: true,
        clearedBy: member.clearedBy,
        groupClosed: group.id,
        unsuppressed,
      };
    }

    this.emit('group-updated', group);
    return {
      cleared: true,
      clearedBy: member.clearedBy,
      unsuppressed: [],
    };
  }

  alarmAcknowledged(alarmId: string, actor?: string): boolean {
    const groupId = this.alarmIndex.get(alarmId);
    if (groupId === undefined) return false;
    const group = groupId === null ? undefined : this.groups.get(groupId);
    const alarm =
      groupId === null
        ? this.pending.find((a) => a.id === alarmId)
        : group?.alarms.find((a) => a.id === alarmId);
    if (!alarm) return false;
    if (alarm.state === 'acknowledged') return true;
    if (alarm.state !== 'active' && alarm.state !== 'suppressed') return false;
    if (group) {
      this.removeSuppressionRecord(group, alarmId);
    }
    alarm.state = 'acknowledged';
    if (actor) alarm.acknowledgedBy = actor;
    if (group) this.emit('group-updated', group);
    else this.emit('alarm-updated', alarm);
    return true;
  }

  // ── Housekeeping (wall-clock supplied externally) ────────────────────

  /** Close idle groups, prune stale pending alarms, enforce retention caps */
  sweep(nowMs: number): { closedGroups: string[] } {
    const closedGroups: string[] = [];
    for (const group of this.groups.values()) {
      const lastTouchedAt = this.groupLastTouchedAt.get(group.id) ?? nowMs;
      if (group.state === 'open' && nowMs - lastTouchedAt > this.groupCloseAfterMs) {
        this.closeGroup(group, 'idle-timeout');
        closedGroups.push(group.id);
      }
    }
    this.prunePendingByProcessingTime(nowMs);
    this.enforceGroupCap();
    return { closedGroups };
  }

  // ── Queries ──────────────────────────────────────────────────────────

  getGroups(filter?: { state?: 'open' | 'closed' }): AlarmGroup[] {
    let groups = Array.from(this.groups.values());
    if (filter?.state) groups = groups.filter((g) => g.state === filter.state);
    return groups.sort((a, b) => b.lastAlarmAt - a.lastAlarmAt);
  }

  getGroup(groupId: string): AlarmGroup | undefined {
    return this.groups.get(groupId);
  }

  /** Return the canonical stored alarm for lifecycle response/readback. */
  getAlarm(alarmId: string): CorrelatedAlarm | undefined {
    const groupId = this.alarmIndex.get(alarmId);
    if (groupId === undefined) return undefined;
    if (groupId === null) {
      return this.pending.find((alarm) => alarm.id === alarmId);
    }
    return this.groups
      .get(groupId)
      ?.alarms.find((alarm) => alarm.id === alarmId);
  }

  /** The group an alarm currently belongs to, or undefined when ungrouped. */
  getGroupForAlarm(alarmId: string): AlarmGroup | undefined {
    const groupId = this.alarmIndex.get(alarmId);
    if (!groupId) return undefined;
    return this.groups.get(groupId);
  }

  /** Every alarm this engine is tracking, grouped or not. */
  listTrackedAlarms(): CorrelatedAlarm[] {
    const alarms: CorrelatedAlarm[] = [];
    for (const group of this.groups.values()) alarms.push(...group.alarms);
    alarms.push(...this.pending);
    return alarms;
  }

  getRootCause(groupId: string): RootCauseResult | null {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const root = group.alarms.find((a) => a.id === group.rootCauseAlarmId);
    if (!root) return null;

    const memberEquipment = group.alarms
      .map((a) => a.equipmentId)
      .filter((id): id is string => !!id);
    return {
      groupId,
      alarm: root,
      causalDominance: root.equipmentId
        ? this.topology.causalDominance(root.equipmentId, memberEquipment, 8)
        : 0,
      hierarchyDepth: root.equipmentId ? this.topology.depth(root.equipmentId) : 0,
      electedBy: 'earliest-bucket, causal-dominance, hierarchy-depth, id',
    };
  }

  setSuppressionPolicy(policy: Partial<SuppressionPolicy>): SuppressionPolicy {
    if (policy.unsuppressOnRootClear === false) {
      throw new Error('unsuppressOnRootClear must remain enabled for fail-safe closure');
    }
    this.suppressionPolicy = { ...this.suppressionPolicy, ...policy };
    for (const group of this.groups.values()) {
      if (group.state === 'open') {
        this.applySuppression(group);
        this.emit('group-updated', group);
      }
    }
    return { ...this.suppressionPolicy };
  }

  getSuppressionPolicy(): SuppressionPolicy {
    return { ...this.suppressionPolicy };
  }

  /** Re-elect roots and reapply fail-safe suppression after topology changes. */
  reconcileTopology(): void {
    for (const group of this.groups.values()) {
      if (group.state !== 'open') continue;
      const previousRoot = group.rootCauseAlarmId;
      this.electRootCause(group);
      if (group.rootCauseAlarmId !== previousRoot) {
        this.emit('root-cause-changed', {
          groupId: group.id,
          previous: previousRoot,
          current: group.rootCauseAlarmId,
        });
      }
      this.applySuppression(group);
      this.emit('group-updated', group);
    }
  }

  // ── Durable recovery (#573) ──────────────────────────────────────────

  /**
   * Deep copy of everything a restart needs to reconstitute correlation.
   * Copies rather than live references, so a caller cannot mutate engine state
   * through the snapshot it persists.
   */
  exportState(): CorrelationEngineState {
    return {
      groups: Array.from(this.groups.values(), (group) => this.cloneGroup(group)),
      pending: this.pending.map((alarm) => ({ ...alarm })),
      metrics: this.getCounters(),
    };
  }

  /**
   * Raw cumulative counters, without the derived rate in `getMetrics()` and
   * without the whole-state deep copy in `exportState()`. The durable
   * projection writes these on every applied journal entry, so it must not have
   * to clone every group to read five numbers.
   */
  getCounters(): CorrelationEngineState['metrics'] {
    return { ...this.metrics };
  }

  /**
   * Replace this engine's correlation state with a previously exported one —
   * the restart path, and how a replica adopts the shared projection.
   *
   * Emits nothing: hydration is a recovery of state that consumers were
   * already told about before the restart, and re-emitting it as fresh
   * suppression decisions would be a lie about when they were made. The
   * reconnect snapshot is what re-informs consumers, and it is explicitly
   * labelled as a snapshot.
   *
   * Suppressed members are restored into `suppressedAlarmIds` exactly as
   * persisted, which is the whole point of persisting them: an alarm the
   * operator cannot currently see must remain restorable after a restart. A
   * member marked suppressed whose group is closed is corrected to active
   * here, because a closed group can never un-suppress it later.
   */
  hydrate(state: CorrelationEngineState): void {
    this.groups = new Map();
    this.groupLastTouchedAt = new Map();
    this.pending = [];
    this.pendingLastTouchedAt = new Map();
    this.alarmIndex = new Map();
    this.suppressionCountedAlarmIds = new Set();

    const now = this.clock();
    for (const input of state.groups) {
      const group = this.cloneGroup(input);
      const memberIds = new Set(group.alarms.map((alarm) => alarm.id));
      group.alarmIds = group.alarms.map((alarm) => alarm.id);
      group.suppressedAlarmIds = group.suppressedAlarmIds.filter((id) =>
        memberIds.has(id));

      if (group.state === 'closed') {
        for (const alarm of group.alarms) {
          if (alarm.state === 'suppressed') alarm.state = 'active';
        }
        group.suppressedAlarmIds = [];
      }

      this.groups.set(group.id, group);
      this.groupLastTouchedAt.set(group.id, now);
      for (const alarm of group.alarms) {
        this.alarmIndex.set(alarm.id, group.id);
      }
      for (const alarmId of group.suppressedAlarmIds) {
        this.suppressionCountedAlarmIds.add(alarmId);
      }
    }

    for (const input of state.pending) {
      if (this.alarmIndex.has(input.id)) continue;
      // Suppression is group-scoped; an ungrouped alarm can never be holding a
      // suppression record, so it is restored visible.
      const alarm: CorrelatedAlarm = {
        ...input,
        state: input.state === 'suppressed' ? 'active' : input.state,
      };
      this.pending.push(alarm);
      this.pendingLastTouchedAt.set(alarm.id, now);
      this.alarmIndex.set(alarm.id, null);
    }

    this.metrics = { ...state.metrics };
  }

  private cloneGroup(group: AlarmGroup): AlarmGroup {
    return {
      ...group,
      alarms: group.alarms.map((alarm) => ({ ...alarm })),
      alarmIds: [...group.alarmIds],
      joinedVia: { ...group.joinedVia },
      suppressedAlarmIds: [...group.suppressedAlarmIds],
    };
  }

  getMetrics(): CorrelationMetrics {
    const openGroups = Array.from(this.groups.values()).filter(
      (g) => g.state === 'open'
    ).length;
    return {
      ...this.metrics,
      suppressionRate:
        this.metrics.alarmsIngested === 0
          ? 0
          : Math.min(
            1,
            this.metrics.alarmsSuppressed / this.metrics.alarmsIngested,
          ),
      openGroups,
      trackedAlarms: this.alarmIndex.size,
    };
  }

  // ── Private: group mechanics ─────────────────────────────────────────

  private joinGroup(
    alarm: CorrelatedAlarm,
    group: AlarmGroup,
    rule: CorrelationRule
  ): IngestResult {
    group.alarms.push(alarm);
    group.alarmIds.push(alarm.id);
    group.joinedVia[alarm.id] = rule.id;
    group.createdAt = Math.min(group.createdAt, alarm.timestamp);
    group.lastAlarmAt = Math.max(group.lastAlarmAt, alarm.timestamp);
    this.groupLastTouchedAt.set(group.id, this.clock());
    if (SEVERITY_RANK[alarm.severity] > SEVERITY_RANK[group.maxSeverity]) {
      group.maxSeverity = alarm.severity;
    }
    this.alarmIndex.set(alarm.id, group.id);
    this.removeFromPending(alarm.id);

    const previousRoot = group.rootCauseAlarmId;
    this.electRootCause(group);
    if (group.rootCauseAlarmId !== previousRoot) {
      this.emit('root-cause-changed', {
        groupId: group.id,
        previous: previousRoot,
        current: group.rootCauseAlarmId,
      });
    }
    this.applySuppression(group);
    this.emit('group-updated', group);

    return {
      alarmId: alarm.id,
      action: 'joined-group',
      groupId: group.id,
      ruleId: rule.id,
      suppressed: group.suppressedAlarmIds.includes(alarm.id),
      isRootCause: group.rootCauseAlarmId === alarm.id,
      reason: `matched rule "${rule.name}"`,
    };
  }

  private formGroup(
    alarm: CorrelatedAlarm,
    peer: CorrelatedAlarm,
    rule: CorrelationRule
  ): IngestResult {
    const members = [peer, alarm].sort((a, b) => a.timestamp - b.timestamp);
    const group: AlarmGroup = {
      id: this.groupIdFactory(),
      state: 'open',
      alarms: members,
      alarmIds: members.map((a) => a.id),
      rootCauseAlarmId: members[0].id,
      formedByRuleId: rule.id,
      joinedVia: { [peer.id]: rule.id, [alarm.id]: rule.id },
      suppressedAlarmIds: [],
      maxSeverity: members.reduce<AlarmSeverity>(
        (max, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[max] ? a.severity : max),
        'info'
      ),
      createdAt: members[0].timestamp,
      lastAlarmAt: members[members.length - 1].timestamp,
    };

    // A reused group id would silently merge two unrelated groups and orphan
    // the suppression records of the first. Refuse rather than corrupt.
    if (this.groups.has(group.id)) {
      throw new Error(`Correlation group id "${group.id}" is already in use`);
    }
    this.groups.set(group.id, group);
    this.groupLastTouchedAt.set(group.id, this.clock());
    this.metrics.groupsCreated++;
    this.alarmIndex.set(alarm.id, group.id);
    this.alarmIndex.set(peer.id, group.id);
    this.removeFromPending(peer.id);
    this.removeFromPending(alarm.id);

    this.electRootCause(group);
    this.applySuppression(group);
    this.enforceGroupCap();
    this.emit('group-created', group);

    return {
      alarmId: alarm.id,
      action: 'formed-group',
      groupId: group.id,
      ruleId: rule.id,
      suppressed: group.suppressedAlarmIds.includes(alarm.id),
      isRootCause: group.rootCauseAlarmId === alarm.id,
      reason: `formed group with "${peer.id}" via rule "${rule.name}"`,
    };
  }

  /**
   * Deterministic root election (total order):
   * earliest 100ms time bucket → highest causal dominance → shallowest
   * hierarchy depth → lexicographically smallest id.
   */
  private electRootCause(group: AlarmGroup): void {
    const eligibleAlarms = group.alarms.filter(
      (alarm) => alarm.state !== 'cleared' && alarm.state !== 'shelved',
    );
    if (eligibleAlarms.length === 0) return;
    const memberEquipment = [...new Set(eligibleAlarms
      .map((a) => a.equipmentId)
      .filter((id): id is string => !!id))];

    const scored = eligibleAlarms.map((alarm) => ({
      alarm,
      bucket: Math.floor(alarm.timestamp / ROOT_ELECTION_TIME_BUCKET_MS),
      dominance: alarm.equipmentId
        ? this.topology.causalDominance(alarm.equipmentId, memberEquipment, 8)
        : 0,
      depth: alarm.equipmentId ? this.topology.depth(alarm.equipmentId) : Number.MAX_SAFE_INTEGER,
    }));

    scored.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.dominance !== b.dominance) return b.dominance - a.dominance;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.alarm.id < b.alarm.id ? -1 : 1;
    });

    group.rootCauseAlarmId = scored[0].alarm.id;
  }

  /**
   * Root cause is never suppressed. Other members are suppressed unless
   * severity meets the never-suppress floor or they are already
   * cleared/acknowledged.
   */
  private applySuppression(group: AlarmGroup): void {
    if (!this.suppressionPolicy.enabled) {
      this.unsuppressActiveMembers(group);
      return;
    }
    const floor = SEVERITY_RANK[this.suppressionPolicy.neverSuppressAtOrAbove];
    const root = group.alarms.find(
      (alarm) => alarm.id === group.rootCauseAlarmId,
    );

    for (const alarm of group.alarms) {
      const isRoot = alarm.id === group.rootCauseAlarmId;
      const alreadySuppressed = group.suppressedAlarmIds.includes(alarm.id);
      const shouldSuppress =
        !isRoot
        && !!root
        && this.rules.areSitesCompatible(root, alarm, this.topology)
        && (alarm.state === 'active' || alarm.state === 'suppressed')
        && SEVERITY_RANK[alarm.severity] < floor;

      if (!shouldSuppress && alarm.state === 'suppressed') {
        this.restoreSuppressedAlarm(group, alarm);
        continue;
      }

      if (!alreadySuppressed && shouldSuppress) {
        group.suppressedAlarmIds.push(alarm.id);
        alarm.state = 'suppressed';
        if (!this.suppressionCountedAlarmIds.has(alarm.id)) {
          this.suppressionCountedAlarmIds.add(alarm.id);
          this.metrics.alarmsSuppressed++;
        }
        this.emit('alarm-suppressed', {
          groupId: group.id,
          alarmId: alarm.id,
          rootCauseAlarmId: group.rootCauseAlarmId,
        });
      }
    }
  }

  private unsuppressActiveMembers(group: AlarmGroup): string[] {
    const restored: string[] = [];
    for (const alarm of group.alarms) {
      if (alarm.state === 'suppressed') {
        alarm.state = 'active';
        restored.push(alarm.id);
        this.metrics.alarmsUnsuppressed++;
      }
    }
    group.suppressedAlarmIds = [];
    if (restored.length > 0) {
      this.emit('alarms-unsuppressed', { groupId: group.id, alarmIds: restored });
    }
    return restored;
  }

  private closeGroup(group: AlarmGroup, reason: AlarmGroup['closeReason']): void {
    if (group.state === 'closed') return;
    this.unsuppressActiveMembers(group);
    group.state = 'closed';
    group.closeReason = reason;
    group.closedAt = this.clock();
    this.metrics.groupsClosed++;
    this.emit('group-closed', group);
  }

  private enforceGroupCap(): void {
    if (this.groups.size <= this.maxGroups) return;
    const closedOldestFirst = Array.from(this.groups.values())
      .filter((g) => g.state === 'closed')
      .sort((a, b) => a.lastAlarmAt - b.lastAlarmAt);
    for (const group of closedOldestFirst) {
      if (this.groups.size <= this.maxGroups) return;
      this.evictGroup(group);
    }
    // Still over cap — evict oldest open groups (pathological load)
    const openOldestFirst = Array.from(this.groups.values()).sort(
      (a, b) => a.lastAlarmAt - b.lastAlarmAt
    );
    for (const group of openOldestFirst) {
      if (this.groups.size <= this.maxGroups) return;
      this.closeGroup(group, 'evicted');
      this.evictGroup(group);
    }
  }

  private evictGroup(group: AlarmGroup): void {
    this.unsuppressActiveMembers(group);
    for (const alarmId of group.alarmIds) {
      this.alarmIndex.delete(alarmId);
      this.suppressionCountedAlarmIds.delete(alarmId);
    }
    this.groupLastTouchedAt.delete(group.id);
    this.groups.delete(group.id);
    // Carries the member ids so a durable projection can drop exactly the rows
    // this engine just forgot, instead of guessing from a count.
    this.emit('group-evicted', {
      groupId: group.id,
      alarmIds: [...group.alarmIds],
    });
  }

  private removeFromPending(alarmId: string): void {
    const idx = this.pending.findIndex((a) => a.id === alarmId);
    if (idx >= 0) this.pending.splice(idx, 1);
    this.pendingLastTouchedAt.delete(alarmId);
  }

  /**
   * Admit pending alarms that are connected to any current member. Re-scan
   * after each pass because a newly admitted bridge may connect an older
   * candidate. Both the group and pending collections are hard-capped.
   */
  private reconcilePending(group: AlarmGroup): void {
    let admitted = true;
    while (
      admitted
      && group.state === 'open'
      && group.alarmIds.length < this.maxAlarmsPerGroup
    ) {
      admitted = false;
      const candidates = [...this.pending].sort(
        (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
      );
      for (const candidate of candidates) {
        if (group.alarmIds.length >= this.maxAlarmsPerGroup) return;
        if (this.alarmIndex.get(candidate.id) !== null) continue;
        if (candidate.state === 'cleared' || candidate.state === 'shelved') continue;
        if (!this.withinGroupSpan(group, candidate.timestamp)) continue;
        const rule = this.rules.evaluateJoin(candidate, group, this.topology);
        if (!rule) continue;
        this.joinGroup(candidate, group, rule);
        admitted = true;
      }
    }
  }

  private refreshIngestResult(
    result: IngestResult,
    alarm: CorrelatedAlarm,
    group: AlarmGroup,
  ): IngestResult {
    return {
      ...result,
      suppressed: group.suppressedAlarmIds.includes(alarm.id),
      isRootCause: group.rootCauseAlarmId === alarm.id,
    };
  }

  private withinGroupSpan(group: AlarmGroup, timestamp: number): boolean {
    const earliest = Math.min(group.createdAt, timestamp);
    const latest = Math.max(group.lastAlarmAt, timestamp);
    return latest - earliest <= this.maxGroupSpanMs;
  }

  private removeSuppressionRecord(group: AlarmGroup, alarmId: string): void {
    group.suppressedAlarmIds = group.suppressedAlarmIds.filter(
      (suppressedId) => suppressedId !== alarmId,
    );
  }

  private restoreSuppressedAlarm(group: AlarmGroup, alarm: CorrelatedAlarm): void {
    this.removeSuppressionRecord(group, alarm.id);
    if (alarm.state !== 'suppressed') return;
    alarm.state = 'active';
    this.metrics.alarmsUnsuppressed++;
    this.emit('alarms-unsuppressed', {
      groupId: group.id,
      alarmIds: [alarm.id],
    });
  }

  /** Drop pending alarms too old to pair under the widest enabled rule window */
  private prunePending(referenceMs: number): void {
    const maxWindow = this.maxEnabledRuleWindowMs();
    const cutoff = referenceMs - maxWindow * 2;
    const removedIds: string[] = [];
    this.pending = this.pending.filter((alarm) => {
      const keep = alarm.timestamp >= cutoff;
      if (!keep) {
        this.alarmIndex.delete(alarm.id);
        this.pendingLastTouchedAt.delete(alarm.id);
        removedIds.push(alarm.id);
      }
      return keep;
    });
    if (this.pending.length > this.maxPendingAlarms) {
      const excess = this.pending.splice(0, this.pending.length - this.maxPendingAlarms);
      for (const alarm of excess) {
        this.alarmIndex.delete(alarm.id);
        this.pendingLastTouchedAt.delete(alarm.id);
        removedIds.push(alarm.id);
      }
    }
    if (removedIds.length > 0) {
      this.emit('pending-pruned', { removed: removedIds.length, alarmIds: removedIds });
    }
  }

  private prunePendingByProcessingTime(nowMs: number): void {
    const cutoff = nowMs - this.maxEnabledRuleWindowMs() * 2;
    const removedIds: string[] = [];
    this.pending = this.pending.filter((alarm) => {
      const keep = (this.pendingLastTouchedAt.get(alarm.id) ?? nowMs) >= cutoff;
      if (!keep) {
        this.alarmIndex.delete(alarm.id);
        this.pendingLastTouchedAt.delete(alarm.id);
        removedIds.push(alarm.id);
      }
      return keep;
    });
    if (removedIds.length > 0) {
      this.emit('pending-pruned', { removed: removedIds.length, alarmIds: removedIds });
    }
  }

  private maxEnabledRuleWindowMs(): number {
    return Math.max(
      1000,
      ...this.rules
        .list()
        .filter((rule) => rule.enabled)
        .map((rule) => (rule.config as { windowMs: number }).windowMs),
    );
  }
}
