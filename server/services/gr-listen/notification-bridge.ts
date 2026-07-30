/**
 * GR::LISTEN notification bridge — correlation → notification worthiness
 *
 * Alarm correlation (#213) answers a structural question: which alarms belong
 * together and which one is the root cause. GR::LISTEN (ADR-0022) answers a
 * different one: given the operator's finite attention, is this alert worth
 * raising right now. This module chains the two — it maps a
 * correlation-enriched alarm onto GR::LISTEN's `AlertInput` and attaches the
 * resulting decision to the broadcast payload as a `notification` field.
 *
 * Two properties this bridge must never break:
 *
 *  - **Nothing is dropped.** A `suppress` decision still broadcasts; it only
 *    travels with the decision attached so a consumer can de-clutter its own
 *    view. This is the same non-destructive posture the `correlation` field
 *    already uses — hiding an alarm at the transport layer is a safety
 *    failure, de-cluttering at the presentation layer is not.
 *  - **It never blocks fan-out.** Any failure inside GR::LISTEN yields the
 *    alarm unchanged rather than an exception on the broadcast path.
 *
 * Off unless `GR_LISTEN_ENABLED=true`, so an attention budget only starts
 * shaping what operators see when somebody deliberately turns it on.
 *
 * Closes #6
 */

import type { AlarmWireSnapshot } from '@shared/types/alarm-correlation';
import type { Severity } from '../singularis-prime/schemas';
import {
  GrListenFilter,
  getGrListenFilter,
  type AlertInput,
  type FilterDecision,
} from './index';

/** Alarm shapes that reach the WebSocket fan-out path. */
export type BroadcastAlarm = Record<string, unknown> | AlarmWireSnapshot;

/**
 * GR::LISTEN's verdict, as carried on the wire. A consumer that ignores this
 * field sees exactly the traffic it saw before the bridge existed.
 */
export interface AlarmNotificationDecision {
  decision: FilterDecision;
  /** Priority after any fatigue escalation; equals the alarm severity otherwise. */
  effectivePriority: Severity;
  /** Set when GR::LISTEN folded this alert into an incident. */
  incidentId?: string;
  reason: string;
}

/** A broadcast payload carrying GR::LISTEN's verdict. */
export type NotifiedAlarm<T extends BroadcastAlarm> = T & {
  notification: AlarmNotificationDecision;
};

export interface NotificationDecisionOptions {
  /** Filter to evaluate against. Defaults to the process singleton. */
  filter?: GrListenFilter;
  /** Overrides the `GR_LISTEN_ENABLED` env check. */
  enabled?: boolean;
  /** Operator role, for role-scoped filter rules. */
  operatorRole?: string;
}

/** The shape `CachedEventBridge` depends on, so tests can inject their own. */
export type NotificationDecider = (alarm: BroadcastAlarm) => BroadcastAlarm;

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Whether the wiring is live. Read per call rather than cached at import, so
 * turning the flag on does not depend on module evaluation order.
 */
export function isGrListenWiringEnabled(): boolean {
  return process.env.GR_LISTEN_ENABLED === 'true';
}

/**
 * Map a correlation-enriched alarm onto GR::LISTEN's `AlertInput`.
 *
 * Returns null when the alarm cannot be described as an alert without
 * inventing facts — no id, no event time, or a severity outside the shared
 * vocabulary. A null maps to "no decision", which leaves the alarm fully
 * visible; guessing a priority here would let a mis-shaped payload be
 * suppressed on the strength of a made-up severity.
 */
export function toAlertInput(alarm: BroadcastAlarm): AlertInput | null {
  const record = alarm as Record<string, unknown>;

  const alarmId = readString(record, 'id') ?? readString(record, 'alarmId');
  if (!alarmId) return null;

  const timestamp = readNumber(record, 'timestamp');
  if (timestamp === undefined) return null;

  const priority = readSeverity(record, 'severity') ?? readSeverity(record, 'priority');
  if (!priority) return null;

  const sourceTagId =
    readString(record, 'tagId')
    ?? readString(record, 'sourceTagId')
    ?? readString(record, 'tagName')
    ?? '';

  return {
    alarmId,
    alarmName: readString(record, 'name') ?? readString(record, 'alarmName') ?? alarmId,
    sourceTagId,
    priority,
    message: readString(record, 'message') ?? '',
    processArea: readString(record, 'processArea'),
    facility: readString(record, 'siteId') ?? readString(record, 'facility'),
    triggerValue: readScalar(record, 'value') ?? readScalar(record, 'triggerValue'),
    limitValue: readScalar(record, 'limit') ?? readScalar(record, 'limitValue'),
    timestamp,
  };
}

/**
 * True when correlation has already decided this alarm is a consequential
 * member hidden behind a root cause. Running it through GR::LISTEN as well
 * would be double-processing: it would consume attention budget and skew
 * fatigue counts for an alert no operator is being shown as primary.
 *
 * A root-cause alarm always goes through, whatever the suppression flag says —
 * it is the one alarm in a group that must reach the notification decision.
 */
export function isCorrelationSuppressed(alarm: BroadcastAlarm): boolean {
  const correlation = (alarm as { correlation?: unknown }).correlation;
  if (!correlation || typeof correlation !== 'object') return false;
  const { suppressed, isRootCause } = correlation as {
    suppressed?: unknown;
    isRootCause?: unknown;
  };
  if (isRootCause === true) return false;
  return suppressed === true;
}

/**
 * Run an alarm through GR::LISTEN and return it with the verdict attached.
 *
 * Returns the alarm untouched — same object, no `notification` field — when
 * the wiring is disabled, when correlation already suppressed it, when it
 * cannot be mapped to an alert, or when the filter throws. Every one of those
 * paths still broadcasts the alarm; that is the point.
 */
export function applyNotificationDecision<T extends BroadcastAlarm>(
  alarm: T,
  options: NotificationDecisionOptions = {},
): T | NotifiedAlarm<T> {
  const enabled = options.enabled ?? isGrListenWiringEnabled();
  if (!enabled) return alarm;
  if (isCorrelationSuppressed(alarm)) return alarm;

  const input = toAlertInput(alarm);
  if (!input) return alarm;

  try {
    const filter = options.filter ?? getGrListenFilter();
    const result = filter.evaluate(input, options.operatorRole);
    const notification: AlarmNotificationDecision = {
      decision: result.decision,
      effectivePriority: result.effectivePriority,
      reason: result.reason,
    };
    if (result.incidentId !== undefined) {
      notification.incidentId = result.incidentId;
    }
    return { ...alarm, notification };
  } catch {
    // GR::LISTEN is an advisory layer. If it fails, the alarm still ships.
    return alarm;
  }
}

// ── Field readers ────────────────────────────────────────────────────────────
//
// The fan-out path carries both the canonical `AlarmWireSnapshot` and arbitrary
// producer payloads, so every field is read defensively and a wrong-typed value
// reads as absent rather than being coerced.

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readScalar(
  source: Record<string, unknown>,
  key: string,
): number | string | undefined {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function readSeverity(
  source: Record<string, unknown>,
  key: string,
): Severity | undefined {
  const value = source[key];
  if (typeof value !== 'string') return undefined;
  return SEVERITIES.find((severity) => severity === value);
}
