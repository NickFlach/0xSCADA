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
export * from './store';
export * from './coordinator';

import type {
  AlarmGroup,
  AlarmSeverity,
  AlarmLifecycleState,
  CorrelatedAlarm,
  AlarmWireSnapshot,
  CorrelationCoordinationHealth,
  CorrelationCoordinationMode,
  IngestResult,
} from '@shared/types/alarm-correlation';
import { AlarmCorrelationEngine } from './engine';
import { AlarmCorrelationCoordinator } from './coordinator';
import { DrizzleCorrelationStore } from './store';

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
  if (isMissingSeverity(raw)) return true;
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

function isMissingSeverity(raw: unknown): boolean {
  return (
    raw === undefined
    || raw === null
    || (typeof raw === 'string' && raw.trim() === '')
  );
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
  // Existing live producers may omit severity. Keep accepting those inputs,
  // but map the unknown severity to the fail-safe floor so it can never be
  // hidden by suppression. Explicit "info" remains a suppressible severity.
  const severity = isMissingSeverity(rawSeverity)
    ? 'critical'
    : normalizeSeverity(rawSeverity);
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
    severity,
    state,
    message: String(raw.message ?? raw.name ?? raw.alarmName ?? ''),
    timestamp,
    value: raw.value as number | string | undefined ?? (raw.tagValue as number | undefined) ?? (raw.triggerValue as number | string | undefined),
    limit: (raw.limit as number | string | undefined) ?? (raw.limitValue as number | string | undefined),
    source: typeof raw.source === 'string' ? raw.source : undefined,
  };
}

/**
 * Coordination facts stamped onto a snapshot. Defaults describe an
 * uncoordinated process, which is the honest answer whenever no healthy
 * durable coordinator is attached.
 */
export interface WireSnapshotContext {
  coordinationMode?: CorrelationCoordinationMode;
  /** Journal seq of this alarm's latest state change; null when uncoordinated. */
  seq?: number | null;
}

export function toAlarmWireSnapshot(
  alarm: CorrelatedAlarm,
  group?: AlarmGroup,
  context: WireSnapshotContext = {},
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
      coordinationMode: context.coordinationMode ?? 'process-local',
      seq: context.seq ?? null,
    },
  };
}

/** Principal recorded for alarms that arrive from internal producers. */
const SYSTEM_PRINCIPAL = 'system';

/**
 * Read a retention duration in milliseconds from the environment.
 *
 * Returns undefined — i.e. "use the built-in default" — for anything that is
 * not a finite positive number. Retention deletes durable alarm state, so a
 * typo must fall back to the documented default rather than be coerced into a
 * cutoff that prunes far more than the operator asked for.
 */
function durationFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * Engine event handler kept for later removal. Payloads are engine-owned and
 * per-event, so each registration narrows `payload` itself rather than the
 * service carrying a union it would have to re-check.
 */
type EngineEventListener = (payload: unknown) => void;

export interface CorrelationServiceHealth {
  healthy: boolean;
  message: string;
  coordinationMode: CorrelationCoordinationMode;
  suppressionEnabled: boolean;
  ephemeralSuppressionAllowed: boolean;
  /** Null when running process-local. */
  coordination: CorrelationCoordinationHealth | null;
  /**
   * Whether an operator may turn production suppression on right now. True only
   * with a healthy durable coordinator; the ephemeral env flag is a separate,
   * explicitly single-process escape hatch reported above.
   */
  durableSuppressionAvailable: boolean;
}

export class AlarmCorrelationService extends EventEmitter {
  private coordinator: AlarmCorrelationCoordinator | null = null;
  private localEngine = new AlarmCorrelationEngine();

  private initialized = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly sweepIntervalMs: number;
  /** Engine currently wired to this service's outbound events, if any. */
  private listenedEngine: AlarmCorrelationEngine | null = null;
  private engineListeners: Array<[string, EngineEventListener]> = [];

  constructor(sweepIntervalMs = 30_000) {
    super();
    this.sweepIntervalMs = sweepIntervalMs;
    this.attachEngineListeners(this.localEngine);
  }

  /**
   * The engine currently holding correlation state. With a coordinator
   * attached this is the coordinator's engine, which is a projection of the
   * shared journal rather than process-local state.
   */
  get engine(): AlarmCorrelationEngine {
    return this.coordinator?.engine ?? this.localEngine;
  }

  /** Durable coordinator, or null when running process-local. */
  get durableCoordinator(): AlarmCorrelationCoordinator | null {
    return this.coordinator;
  }

  /**
   * Adopt a started coordinator. Its engine replaces the process-local one, so
   * every read surface (REST and WebSocket alike) serves the coordinated
   * projection and cannot disagree with it.
   */
  attachCoordinator(coordinator: AlarmCorrelationCoordinator): void {
    if (this.coordinator === coordinator) return;
    this.coordinator = coordinator;
    this.attachEngineListeners(coordinator.engine);
    coordinator.on('degraded', (payload: { reason: string }) => {
      this.emit('coordination-degraded', payload);
    });
    coordinator.on('recovered', (payload: CorrelationCoordinationHealth) => {
      this.emit('coordination-recovered', payload);
    });
  }

  /**
   * Build a durable coordinator from configuration and adopt it.
   *
   * Off unless `ALARM_CORRELATION_DURABLE=true`: it opens a database
   * connection, and a service that silently starts talking to a database
   * because it was imported is not something to switch on by default. Without
   * it the service runs exactly as #213 shipped it — process-local, suppression
   * off. Throws if the store cannot be opened, so a caller cannot mistake a
   * failed connection for durable coordination.
   */
  async enableDurableCoordination(options: {
    postgresUrl?: string;
    sqlitePath?: string;
    pollIntervalMs?: number;
    instanceId?: string;
    journalRetentionMs?: number;
    stateRetentionMs?: number;
  } = {}): Promise<AlarmCorrelationCoordinator> {
    if (this.coordinator) return this.coordinator;
    const store = new DrizzleCorrelationStore({
      postgresUrl: options.postgresUrl,
      sqlitePath: options.sqlitePath,
    });
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: options.instanceId,
      pollIntervalMs: options.pollIntervalMs,
      journalRetentionMs:
        options.journalRetentionMs
        ?? durationFromEnv('ALARM_CORRELATION_JOURNAL_RETENTION_MS'),
      stateRetentionMs:
        options.stateRetentionMs
        ?? durationFromEnv('ALARM_CORRELATION_STATE_RETENTION_MS'),
    });
    await coordinator.start();
    this.attachCoordinator(coordinator);
    return coordinator;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (process.env.ALARM_CORRELATION_DURABLE === 'true' && !this.coordinator) {
      // A configured-but-unreachable store must not be papered over: report it
      // and continue process-local with suppression off, which is safe.
      try {
        await this.enableDurableCoordination();
      } catch (error) {
        this.emit('coordination-degraded', {
          reason: `durable coordination unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    this.initialized = true;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Idle-group housekeeping.
   *
   * With a coordinator attached this is journaled rather than run locally:
   * closing an idle group un-suppresses its members, so a sweep that ran here
   * and not on the other replica would leave the two disagreeing about which
   * alarms an operator can see.
   */
  sweep(): void {
    const coordinator = this.coordinator;
    if (coordinator) {
      void coordinator
        .submitSweep(Date.now(), this.sweepIntervalMs)
        .catch(() => {
          // Already failed safe (suppression off, alarms restored); the next
          // interval retries.
        });
      return;
    }
    try {
      this.engine.sweep(Date.now());
    } catch {
      /* sweep failures must never take down the interval */
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.coordinator) {
      await this.coordinator.stop();
      this.coordinator = null;
      // Fall back to the process-local engine so the service stays usable —
      // uncoordinated, suppression off, which is the safe state.
      this.attachEngineListeners(this.localEngine);
    }
    this.initialized = false;
  }

  /**
   * Normalize and correlate one alarm in any supported shape, process-locally.
   * Returns null when the input has no usable timestamp.
   *
   * This is the uncoordinated path. `submit()` is the coordinated one; it falls
   * back to this when no coordinator is attached.
   */
  ingest(raw: Record<string, unknown>): { alarm: CorrelatedAlarm; result: IngestResult } | null {
    const alarm = normalizeAlarm(raw);
    if (!alarm) return null;
    return this.applyLocalIngest(alarm);
  }

  /**
   * Correlate one alarm through durable coordination when it is available.
   *
   * If the journal cannot be written the alarm is still correlated locally and
   * still returned, so it still reaches the operator. Coordination has already
   * failed safe by then — suppression is off — so a locally-correlated alarm
   * cannot be hidden by this fallback.
   */
  async submit(
    raw: Record<string, unknown>,
    principal: string = SYSTEM_PRINCIPAL,
  ): Promise<{ alarm: CorrelatedAlarm; result: IngestResult } | null> {
    const alarm = normalizeAlarm(raw);
    if (!alarm) return null;

    const coordinator = this.coordinator;
    if (!coordinator) return this.applyLocalIngest(alarm);

    try {
      const submitted = await coordinator.submitIngest(alarm, principal);
      const stored = coordinator.engine.getAlarm(alarm.id) ?? alarm;
      if (submitted.outcome) {
        return { alarm: stored, result: submitted.outcome };
      }
      // Duplicate delivery of an entry that was already applied. Report the
      // canonical current state rather than re-running correlation.
      const group = coordinator.engine.getGroupForAlarm(alarm.id);
      return {
        alarm: stored,
        result: {
          alarmId: alarm.id,
          action: 'duplicate',
          groupId: group?.id,
          suppressed: group?.suppressedAlarmIds.includes(alarm.id) ?? false,
          isRootCause: group?.rootCauseAlarmId === alarm.id,
          reason: 'duplicate alarm id — already ingested',
        },
      };
    } catch {
      // Storage or coordination loss must never hide an alarm.
      return this.applyLocalIngest(alarm);
    }
  }

  /** Acknowledge through coordination when available, else process-locally. */
  async acknowledge(alarmId: string, principal: string): Promise<boolean> {
    const coordinator = this.coordinator;
    if (!coordinator) return this.engine.alarmAcknowledged(alarmId, principal);
    try {
      const submitted = await coordinator.submitAcknowledge(alarmId, principal);
      if (submitted.outcome !== undefined) return submitted.outcome;
      return coordinator.engine.getAlarm(alarmId)?.state === 'acknowledged';
    } catch {
      return this.engine.alarmAcknowledged(alarmId, principal);
    }
  }

  /** Clear through coordination when available, else process-locally. */
  async clear(
    alarmId: string,
    principal: string,
  ): Promise<ReturnType<AlarmCorrelationEngine['alarmCleared']>> {
    const coordinator = this.coordinator;
    if (!coordinator) return this.engine.alarmCleared(alarmId, principal);
    try {
      const submitted = await coordinator.submitClear(alarmId, principal);
      if (submitted.outcome !== undefined) return submitted.outcome;
      const alarm = coordinator.engine.getAlarm(alarmId);
      return {
        cleared: alarm?.state === 'cleared',
        clearedBy: alarm?.clearedBy,
        unsuppressed: [],
      };
    } catch {
      return this.engine.alarmCleared(alarmId, principal);
    }
  }

  /**
   * Latest canonical state for every alarm this replica is tracking that an
   * operator could still act on. Cleared alarms are omitted; suppressed ones
   * are included and marked suppressed, because a reconnecting client needs to
   * know an alarm exists and is currently hidden, not be left unaware of it.
   *
   * Exactly one entry per alarm id, so a reconnecting client cannot receive the
   * same alarm twice from the snapshot itself.
   */
  getReconnectSnapshot(): AlarmWireSnapshot[] {
    const engine = this.engine;
    const seen = new Set<string>();
    const snapshots: AlarmWireSnapshot[] = [];
    for (const alarm of engine.listTrackedAlarms()) {
      if (seen.has(alarm.id)) continue;
      seen.add(alarm.id);
      if (alarm.state === 'cleared') continue;
      snapshots.push(this.snapshotFor(alarm, engine.getGroupForAlarm(alarm.id)));
    }
    return snapshots.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  /**
   * Build the canonical wire snapshot for one alarm.
   *
   * The shared seq is stamped only while coordination is healthy. A degraded
   * replica emits `seq: null`, which makes its snapshots undedupable by design:
   * the corrections a degraded replica sends (notably restoring suppressed
   * alarms) must never be mistaken for a stale echo and dropped.
   */
  snapshotFor(alarm: CorrelatedAlarm, group?: AlarmGroup): AlarmWireSnapshot {
    const mode = this.coordinationMode();
    return toAlarmWireSnapshot(alarm, group, {
      coordinationMode: mode,
      seq: mode === 'durable' ? this.coordinator?.alarmSeq(alarm.id) ?? null : null,
    });
  }

  coordinationMode(): CorrelationCoordinationMode {
    return this.coordinator?.health().mode ?? 'process-local';
  }

  async healthCheck(): Promise<CorrelationServiceHealth> {
    const metrics = this.engine.getMetrics();
    const coordination = this.coordinator?.health() ?? null;
    return {
      healthy: this.initialized && (coordination?.healthy ?? true),
      message: this.initialized
        ? `Alarm correlation running: ${metrics.openGroups} open groups, ` +
          `${(metrics.suppressionRate * 100).toFixed(1)}% suppression rate`
        : 'Alarm correlation service not initialized',
      coordinationMode: this.coordinationMode(),
      suppressionEnabled: this.engine.getSuppressionPolicy().enabled,
      ephemeralSuppressionAllowed:
        process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION === 'true',
      coordination,
      durableSuppressionAvailable: coordination?.healthy === true,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private applyLocalIngest(
    alarm: CorrelatedAlarm,
  ): { alarm: CorrelatedAlarm; result: IngestResult } {
    const engine = this.engine;
    const result = engine.ingest(alarm);
    if (result.action === 'duplicate') {
      if (alarm.state === 'acknowledged') {
        engine.alarmAcknowledged(alarm.id);
      } else if (alarm.state === 'cleared') {
        engine.alarmCleared(alarm.id);
      }
    }
    return { alarm: engine.getAlarm(alarm.id) ?? alarm, result };
  }

  /**
   * Re-point this service's outbound events at `engine`, detaching whatever it
   * was listening to. Detaching matters: adopting a coordinator swaps the
   * engine, and leaving the old one wired would keep a stopped engine able to
   * emit alarm snapshots into a live service.
   */
  private attachEngineListeners(engine: AlarmCorrelationEngine): void {
    if (this.listenedEngine === engine) return;
    if (this.listenedEngine) {
      for (const [event, listener] of this.engineListeners) {
        this.listenedEngine.off(event, listener);
      }
    }
    this.engineListeners = [];

    const register = (event: string, listener: EngineEventListener): void => {
      this.engineListeners.push([event, listener]);
      engine.on(event, listener);
    };

    for (const event of ['group-created', 'group-updated', 'group-closed']) {
      register(event, (payload) => {
        const group = payload as AlarmGroup;
        this.emit(event, group);
        for (const alarm of group.alarms) {
          this.emit('alarm-snapshot', this.snapshotFor(alarm, group));
        }
      });
    }
    for (const event of [
      'root-cause-changed',
      'alarm-suppressed',
      'alarms-unsuppressed',
    ]) {
      register(event, (payload) => this.emit(event, payload));
    }
    register('alarm-updated', (payload) => {
      const alarm = payload as CorrelatedAlarm;
      this.emit('alarm-updated', alarm);
      this.emit('alarm-snapshot', this.snapshotFor(alarm));
    });

    this.listenedEngine = engine;
  }
}

export const alarmCorrelationService = new AlarmCorrelationService();
