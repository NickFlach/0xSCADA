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
  AlarmSeverity,
  AlarmLifecycleState,
  CorrelatedAlarm,
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

function normalizeState(raw: unknown): AlarmLifecycleState {
  const value = String(raw ?? '').toLowerCase();
  switch (value) {
    case 'acknowledged':
      return 'acknowledged';
    case 'cleared':
      return 'cleared';
    case 'shelved':
      return 'shelved';
    case 'suppressed':
      return 'suppressed';
    default:
      return 'active';
  }
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
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
  const timestamp = normalizeTimestamp(
    raw.timestamp ?? raw.triggeredAt ?? raw.sourceTimestamp
  );
  if (timestamp === null) return null;

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
    severity: normalizeSeverity(raw.severity ?? raw.priority),
    state: normalizeState(raw.state),
    message: String(raw.message ?? raw.name ?? raw.alarmName ?? ''),
    timestamp,
    value: raw.value as number | string | undefined ?? (raw.tagValue as number | undefined) ?? (raw.triggerValue as number | string | undefined),
    limit: (raw.limit as number | string | undefined) ?? (raw.limitValue as number | string | undefined),
    source: typeof raw.source === 'string' ? raw.source : undefined,
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
    for (const event of [
      'group-created',
      'group-updated',
      'group-closed',
      'root-cause-changed',
      'alarm-suppressed',
      'alarms-unsuppressed',
    ]) {
      this.engine.on(event, (payload) => this.emit(event, payload));
    }
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
    return { alarm, result };
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const metrics = this.engine.getMetrics();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Alarm correlation running: ${metrics.openGroups} open groups, ` +
          `${(metrics.suppressionRate * 100).toFixed(1)}% suppression rate`
        : 'Alarm correlation service not initialized',
    };
  }
}

export const alarmCorrelationService = new AlarmCorrelationService();
