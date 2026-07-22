/**
 * Alarm Correlation Engine
 * ADR-0013 [13.2] — Issue #213
 *
 * Groups related alarms via the rules engine (causal chains, equipment
 * hierarchy, scoped temporal proximity), elects a deterministic root
 * cause per group, and suppresses downstream/consequential alarms with
 * severity guards and un-suppression when the root cause clears.
 *
 * All correlation logic is event-time driven — wall-clock never enters
 * grouping decisions, so replayed/backfilled alarm streams correlate
 * identically. Wall-clock is only supplied externally to sweep() for
 * idle-group housekeeping.
 */

import { EventEmitter } from 'events';
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
  enabled: true,
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
}

export class AlarmCorrelationEngine extends EventEmitter {
  readonly topology: EquipmentTopology;
  readonly rules: CorrelationRulesEngine;

  private suppressionPolicy: SuppressionPolicy;
  private readonly groupCloseAfterMs: number;
  private readonly maxGroupSpanMs: number;
  private readonly maxGroups: number;
  private readonly maxPendingAlarms: number;

  private groups: Map<string, AlarmGroup> = new Map();
  /** Ungrouped recent alarms — candidate peers for group formation */
  private pending: CorrelatedAlarm[] = [];
  /** alarmId → groupId, or null while standalone/pending */
  private alarmIndex: Map<string, string | null> = new Map();
  private groupCounter = 0;

  private metrics = {
    alarmsIngested: 0,
    groupsCreated: 0,
    groupsClosed: 0,
    alarmsSuppressed: 0,
    alarmsUnsuppressed: 0,
  };

  constructor(options: CorrelationEngineOptions = {}) {
    super();
    this.topology = options.topology ?? new EquipmentTopology();
    this.rules = options.rules ?? new CorrelationRulesEngine();
    this.suppressionPolicy = { ...DEFAULT_SUPPRESSION_POLICY, ...options.suppressionPolicy };
    this.groupCloseAfterMs = options.groupCloseAfterMs ?? 10 * 60 * 1000;
    this.maxGroupSpanMs = options.maxGroupSpanMs ?? 30 * 60 * 1000;
    this.maxGroups = options.maxGroups ?? 1000;
    this.maxPendingAlarms = options.maxPendingAlarms ?? 2000;
  }

  // ── Ingestion & correlation ──────────────────────────────────────────

  ingest(alarm: CorrelatedAlarm): IngestResult {
    if (this.alarmIndex.has(alarm.id)) {
      const groupId = this.alarmIndex.get(alarm.id) ?? undefined;
      const group = groupId ? this.groups.get(groupId) : undefined;
      return {
        alarmId: alarm.id,
        action: group ? 'joined-group' : 'standalone',
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
      const earliest = group.alarms[0]?.timestamp ?? group.createdAt;
      if (alarm.timestamp - earliest > this.maxGroupSpanMs) continue;
      const rule = this.rules.evaluateJoin(alarm, group, this.topology);
      if (rule) {
        return this.joinGroup(alarm, group, rule);
      }
    }

    // 2. Try to form a new group with a pending (ungrouped) alarm
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const peer = this.pending[i];
      const rule = this.rules.evaluatePair(alarm, peer, this.topology);
      if (rule) {
        return this.formGroup(alarm, peer, rule);
      }
    }

    // 3. Standalone — buffer as a candidate peer for future alarms
    this.pending.push(alarm);
    this.alarmIndex.set(alarm.id, null);
    this.prunePending(alarm.timestamp);
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
  alarmCleared(alarmId: string): { groupClosed?: string; unsuppressed: string[] } {
    const groupId = this.alarmIndex.get(alarmId);
    if (groupId === undefined) return { unsuppressed: [] };

    if (groupId === null) {
      const pendingAlarm = this.pending.find((a) => a.id === alarmId);
      if (pendingAlarm) pendingAlarm.state = 'cleared';
      return { unsuppressed: [] };
    }

    const group = this.groups.get(groupId);
    if (!group) return { unsuppressed: [] };

    const member = group.alarms.find((a) => a.id === alarmId);
    if (member) member.state = 'cleared';

    if (group.state === 'open' && group.rootCauseAlarmId === alarmId) {
      const unsuppressed = this.suppressionPolicy.unsuppressOnRootClear
        ? this.unsuppressActiveMembers(group)
        : [];
      this.closeGroup(group, 'root-cause-cleared');
      return { groupClosed: group.id, unsuppressed };
    }

    this.emit('group-updated', group);
    return { unsuppressed: [] };
  }

  alarmAcknowledged(alarmId: string): boolean {
    const groupId = this.alarmIndex.get(alarmId);
    if (groupId === undefined) return false;
    const alarm =
      groupId === null
        ? this.pending.find((a) => a.id === alarmId)
        : this.groups.get(groupId)?.alarms.find((a) => a.id === alarmId);
    if (!alarm) return false;
    if (alarm.state === 'active' || alarm.state === 'suppressed') {
      alarm.state = 'acknowledged';
    }
    return true;
  }

  // ── Housekeeping (wall-clock supplied externally) ────────────────────

  /** Close idle groups, prune stale pending alarms, enforce retention caps */
  sweep(nowMs: number): { closedGroups: string[] } {
    const closedGroups: string[] = [];
    for (const group of this.groups.values()) {
      if (group.state === 'open' && nowMs - group.lastAlarmAt > this.groupCloseAfterMs) {
        this.closeGroup(group, 'idle-timeout');
        closedGroups.push(group.id);
      }
    }
    this.prunePending(nowMs);
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
    this.suppressionPolicy = { ...this.suppressionPolicy, ...policy };
    return this.suppressionPolicy;
  }

  getSuppressionPolicy(): SuppressionPolicy {
    return { ...this.suppressionPolicy };
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
          : this.metrics.alarmsSuppressed / this.metrics.alarmsIngested,
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
    group.lastAlarmAt = Math.max(group.lastAlarmAt, alarm.timestamp);
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
      id: `ACG-${++this.groupCounter}`,
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

    this.groups.set(group.id, group);
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
    const memberEquipment = group.alarms
      .map((a) => a.equipmentId)
      .filter((id): id is string => !!id);

    const scored = group.alarms.map((alarm) => ({
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
    if (!this.suppressionPolicy.enabled) return;
    const floor = SEVERITY_RANK[this.suppressionPolicy.neverSuppressAtOrAbove];

    for (const alarm of group.alarms) {
      const isRoot = alarm.id === group.rootCauseAlarmId;
      const alreadySuppressed = group.suppressedAlarmIds.includes(alarm.id);

      if (isRoot && alreadySuppressed) {
        // A re-election promoted a suppressed member to root — restore it
        group.suppressedAlarmIds = group.suppressedAlarmIds.filter((id) => id !== alarm.id);
        if (alarm.state === 'suppressed') alarm.state = 'active';
        this.metrics.alarmsUnsuppressed++;
        this.emit('alarms-unsuppressed', { groupId: group.id, alarmIds: [alarm.id] });
        continue;
      }

      if (
        !isRoot &&
        !alreadySuppressed &&
        alarm.state === 'active' &&
        SEVERITY_RANK[alarm.severity] < floor
      ) {
        group.suppressedAlarmIds.push(alarm.id);
        alarm.state = 'suppressed';
        this.metrics.alarmsSuppressed++;
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
    for (const alarmId of group.suppressedAlarmIds) {
      const alarm = group.alarms.find((a) => a.id === alarmId);
      if (alarm && alarm.state === 'suppressed') {
        alarm.state = 'active';
        restored.push(alarmId);
        this.metrics.alarmsUnsuppressed++;
      }
    }
    group.suppressedAlarmIds = group.suppressedAlarmIds.filter(
      (id) => !restored.includes(id)
    );
    if (restored.length > 0) {
      this.emit('alarms-unsuppressed', { groupId: group.id, alarmIds: restored });
    }
    return restored;
  }

  private closeGroup(group: AlarmGroup, reason: AlarmGroup['closeReason']): void {
    if (group.state === 'closed') return;
    group.state = 'closed';
    group.closeReason = reason;
    group.closedAt = group.lastAlarmAt;
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
    for (const alarmId of group.alarmIds) {
      this.alarmIndex.delete(alarmId);
    }
    this.groups.delete(group.id);
  }

  private removeFromPending(alarmId: string): void {
    const idx = this.pending.findIndex((a) => a.id === alarmId);
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  /** Drop pending alarms too old to pair under the widest enabled rule window */
  private prunePending(referenceMs: number): void {
    const maxWindow = Math.max(
      1000,
      ...this.rules
        .list()
        .filter((r) => r.enabled)
        .map((r) => (r.config as { windowMs: number }).windowMs)
    );
    const cutoff = referenceMs - maxWindow * 2;
    let removed = 0;
    this.pending = this.pending.filter((alarm) => {
      const keep = alarm.timestamp >= cutoff;
      if (!keep) {
        this.alarmIndex.delete(alarm.id);
        removed++;
      }
      return keep;
    });
    if (this.pending.length > this.maxPendingAlarms) {
      const excess = this.pending.splice(0, this.pending.length - this.maxPendingAlarms);
      for (const alarm of excess) this.alarmIndex.delete(alarm.id);
      removed += excess.length;
    }
    if (removed > 0) this.emit('pending-pruned', { removed });
  }
}
