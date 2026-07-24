/**
 * Alarm Correlation Service
 * ADR-0013 [13.2] — Issue #213
 *
 * Singleton wrapper around the correlation engine: normalizes the repo's
 * divergent alarm shapes (tag-stream broadcastAlarm, SingularisPrime /
 * GR::LISTEN AlarmPayload, DB enum vocabulary) into CorrelatedAlarm,
 * runs periodic idle-group sweeps, and re-emits engine events for
 * downstream consumers (WebSocket bridge, routes).
 */

import { EventEmitter } from 'events';

export * from './topology';
export * from './rules';
export * from './engine';

import type {
  AlarmGroup,
  AlarmSeverity,
  AlarmLifecycleState,
  CorrelatedAlarm,
  AlarmWireSnapshot,
  IngestResult,
} from '@shared/types/alarm-correlation';
import { AlarmCorrelationEngine } from './engine';

/**
 * Map any severity vocabulary seen in this repo onto the runtime one.
 * DB enums (INFO/WARNING/CRITICAL/EMERGENCY), SPC ('warning'|'alarm'),
 * and client severities all funnel through here.
 */
export function normalizeSeverity(raw: unknown): AlarmSeverity {
  const value = String(raw ?? '').toLowerCase();
  switch (value) {
    case 'critical':
    case 'emergency':
      return 'critical';
    case 'high':
    case 'alarm':
      return 'high';
    case 'medium':
    case 'warning':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

function isRecognizedSeverity(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true;
  return [
    'critical',
    'emergency',
    'high',
    'alarm',
    'medium',
    'warning',
    'low',
    'info',
  ].includes(String(raw).toLowerCase());
}

function normalizeState(raw: unknown): AlarmLifecycleState | null {
  const value = String(raw ?? '').toLowerCase();
  switch (value) {
    case '':
    case 'active':
      return 'active';
    case 'acknowledged':
      return 'acknowledged';
    case 'cleared':
      return 'cleared';
    case 'shelved':
      return 'shelved';
    case 'suppressed':
      // Suppression is a correlation-engine decision, never caller-owned
      // state on a newly raised live alarm.
      return 'active';
    default:
      return null;
  }
}

/** Normalize only timestamps that JavaScript Date can safely serialize. */
export function normalizeAlarmTimestamp(raw: unknown): number | null {
  if (
    typeof raw === 'number'
    && Number.isFinite(raw)
    && Number.isFinite(new Date(raw).getTime())
  ) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Resolve an equipment id from a tag following the repo convention
 * "ASSET.EVENT" (simulator: `${asset.nameOrTag}.${eventType}`). Tags that
 * do not follow the convention resolve to themselves so same-equipment
 * grouping still works per tag.
 */
export function resolveEquipmentFromTag(tagId: string): string | undefined {
  if (!tagId) return undefined;
  const dot = tagId.indexOf('.');
  return dot > 0 ? tagId.slice(0, dot) : tagId;
}

/**
 * Normalize any of the repo's alarm shapes into a CorrelatedAlarm.
 * Accepts the tag-stream broadcastAlarm shape ({id, name, severity, state,
 * tagValue, triggeredAt}), the SingularisPrime/GR::LISTEN AlarmPayload
 * shape ({alarmId, alarmName, sourceTagId, priority, message, ...}), or a
 * native CorrelatedAlarm. Returns null when no usable timestamp exists.
 */
export function normalizeAlarm(raw: Record<string, unknown>): CorrelatedAlarm | null {
  const timestamp = normalizeAlarmTimestamp(
    raw.timestamp ?? raw.triggeredAt ?? raw.sourceTimestamp
  );
  if (timestamp === null) return null;
  const rawSeverity = raw.severity ?? raw.priority;
  if (!isRecognizedSeverity(rawSeverity)) return null;
  const state = normalizeState(raw.state);
  if (!state) return null;

  const tagId = String(raw.tagId ?? raw.sourceTagId ?? raw.tagName ?? '');
  const id = String(raw.id ?? raw.alarmId ?? `${tagId || 'alarm'}:${timestamp}`);
  const equipmentId =
    typeof raw.equipmentId === 'string' && raw.equipmentId !== ''
      ? raw.equipmentId
      : resolveEquipmentFromTag(tagId);

  return {
    id,
    name: String(raw.name ?? raw.alarmName ?? id),
    tagId,
    equipmentId,
    siteId: typeof raw.siteId === 'string' ? raw.siteId : undefined,
    processArea: typeof raw.processArea === 'string' ? raw.processArea : undefined,
    severity: normalizeSeverity(rawSeverity),
    state,
    message: String(raw.message ?? raw.name ?? raw.alarmName ?? ''),
    timestamp,
    value: raw.value as number | string | undefined ?? (raw.tagValue as number | undefined) ?? (raw.triggerValue as number | string | undefined),
    limit: (raw.limit as number | string | undefined) ?? (raw.limitValue as number | string | undefined),
    source: typeof raw.source === 'string' ? raw.source : undefined,
  };
}

export function toAlarmWireSnapshot(
  alarm: CorrelatedAlarm,
  group?: AlarmGroup,
): AlarmWireSnapshot {
  return {
    ...alarm,
    triggeredAt: new Date(alarm.timestamp).toISOString(),
    tagValue: alarm.value,
    correlation: {
      groupId: group?.id ?? null,
      groupState: group?.state ?? null,
      rootCauseAlarmId: group?.rootCauseAlarmId ?? null,
      suppressed:
        group?.suppressedAlarmIds.includes(alarm.id)
        ?? alarm.state === 'suppressed',
      isRootCause: group?.rootCauseAlarmId === alarm.id,
      coordinationMode: 'process-local',
    },
  };
}

export class AlarmCorrelationService extends EventEmitter {
  readonly engine = new AlarmCorrelationEngine();

  private initialized = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly sweepIntervalMs: number;

  constructor(sweepIntervalMs = 30_000) {
    super();
    this.sweepIntervalMs = sweepIntervalMs;
    for (const event of ['group-created', 'group-updated', 'group-closed']) {
      this.engine.on(event, (group: AlarmGroup) => {
        this.emit(event, group);
        for (const alarm of group.alarms) {
          this.emit('alarm-snapshot', toAlarmWireSnapshot(alarm, group));
        }
      });
    }
    for (const event of [
      'root-cause-changed',
      'alarm-suppressed',
      'alarms-unsuppressed',
    ]) {
      this.engine.on(event, (payload) => this.emit(event, payload));
    }
    this.engine.on('alarm-updated', (alarm: CorrelatedAlarm) => {
      this.emit('alarm-updated', alarm);
      this.emit('alarm-snapshot', toAlarmWireSnapshot(alarm));
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.sweepTimer = setInterval(() => {
      try {
        this.engine.sweep(Date.now());
      } catch {
        /* sweep failures must never take down the interval */
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.initialized = false;
  }

  /**
   * Normalize and correlate one alarm in any supported shape.
   * Returns null when the input has no usable timestamp.
   */
  ingest(raw: Record<string, unknown>): { alarm: CorrelatedAlarm; result: IngestResult } | null {
    const alarm = normalizeAlarm(raw);
    if (!alarm) return null;
    const result = this.engine.ingest(alarm);
    if (result.action === 'duplicate') {
      if (alarm.state === 'acknowledged') {
        this.engine.alarmAcknowledged(alarm.id);
      } else if (alarm.state === 'cleared') {
        this.engine.alarmCleared(alarm.id);
      }
    }
    return {
      alarm: this.engine.getAlarm(alarm.id) ?? alarm,
      result,
    };
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    message: string;
    coordinationMode: 'process-local';
    suppressionEnabled: boolean;
    ephemeralSuppressionAllowed: boolean;
  }> {
    const metrics = this.engine.getMetrics();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Alarm correlation running: ${metrics.openGroups} open groups, ` +
          `${(metrics.suppressionRate * 100).toFixed(1)}% suppression rate`
        : 'Alarm correlation service not initialized',
      coordinationMode: 'process-local',
      suppressionEnabled: this.engine.getSuppressionPolicy().enabled,
      ephemeralSuppressionAllowed:
        process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION === 'true',
    };
  }
}

export const alarmCorrelationService = new AlarmCorrelationService();
