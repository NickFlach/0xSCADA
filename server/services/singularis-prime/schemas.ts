/**
 * SingularisPrime Event Schemas for SCADA Domain
 *
 * Defines typed event envelopes for publishing SCADA telemetry, alarms,
 * equipment state, operator actions and system health into the
 * SingularisPrime / Flux Universe event mesh.
 *
 * Issue: #348 — Define SingularisPrime event schema for SCADA domain
 * ADR: ADR-0022
 */

// ── Shared metadata ──────────────────────────────────────────────────────────

/** Quality codes (OPC-UA inspired) */
export type SignalQuality = "good" | "uncertain" | "bad" | "not-connected";

/** Severity tiers used across alarms & health */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Common metadata attached to every SingularisPrime SCADA event */
export interface ScadaEventMeta {
  /** Originating protocol adapter (e.g. "modbus-tcp", "opcua", "mqtt") */
  sourceAdapter: string;
  /** Geographic / logical region */
  region: string;
  /** Facility or plant identifier */
  facility: string;
  /** Severity classification */
  severity: Severity;
  /** Correlation ID to link related events across services */
  correlationId: string;
  /** Optional process area within the facility */
  processArea?: string;
  /** Optional equipment class */
  equipmentClass?: string;
}

// ── Event envelope ───────────────────────────────────────────────────────────

export type ScadaEventType =
  | "process_variable_change"
  | "alarm_activation"
  | "alarm_acknowledgment"
  | "alarm_clear"
  | "alarm_shelve"
  | "equipment_state_transition"
  | "operator_action"
  | "system_health";

/**
 * Top-level SingularisPrime event envelope for the SCADA domain.
 * Generic over the payload discriminated by `type`.
 */
export interface SingularisPrimeScadaEvent<
  T extends ScadaEventType = ScadaEventType,
  P = unknown,
> {
  /** Fixed domain discriminator */
  domain: "scada";
  /** Event type discriminator */
  type: T;
  /** ISO-8601 timestamp of event origination */
  timestamp: string;
  /** Monotonic sequence within the source for ordering guarantees */
  sequence: number;
  /** Schema version (semver) — bump on breaking changes */
  schemaVersion: string;
  /** Common metadata */
  meta: ScadaEventMeta;
  /** Type-specific payload */
  payload: P;
}

// ── Payload types ────────────────────────────────────────────────────────────

/** #1 — Process Variable Change */
export interface ProcessVariableChangePayload {
  tagId: string;
  tagName: string;
  value: number | string | boolean;
  previousValue?: number | string | boolean;
  engineeringUnit?: string;
  quality: SignalQuality;
  /** Source timestamp from the field device */
  sourceTimestamp: string;
  deadband?: number;
}

/** #2-5 — Alarm payloads */
export interface AlarmPayload {
  alarmId: string;
  alarmName: string;
  /** Point / tag that triggered the alarm */
  sourceTagId: string;
  priority: Severity;
  message: string;
  /** Current measured value at alarm time */
  triggerValue?: number | string;
  /** Setpoint or limit that was breached */
  limitValue?: number | string;
  /** For acknowledgment/shelve — who did it */
  operatorId?: string;
  /** Shelve duration in seconds (shelve events only) */
  shelveDurationSec?: number;
}

/** #6 — Equipment State Transition */
export interface EquipmentStateTransitionPayload {
  equipmentId: string;
  equipmentName: string;
  previousState: string;
  currentState: string;
  /** What caused the transition */
  trigger: "automatic" | "operator" | "interlock" | "fault";
  /** Runtime hours at transition */
  runtimeHours?: number;
}

/** #7 — Operator Action */
export interface OperatorActionPayload {
  operatorId: string;
  operatorName?: string;
  actionType: "setpoint_change" | "mode_switch" | "command" | "override" | "acknowledge";
  targetTagId?: string;
  targetEquipmentId?: string;
  previousValue?: number | string | boolean;
  newValue?: number | string | boolean;
  reason?: string;
}

/** #8 — System Health */
export interface SystemHealthPayload {
  componentId: string;
  componentName: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  /** Metrics snapshot */
  metrics?: {
    cpuPercent?: number;
    memoryPercent?: number;
    diskPercent?: number;
    scanCycleMs?: number;
    activeConnections?: number;
    eventQueueDepth?: number;
  };
  message?: string;
}

// ── Convenience aliases ──────────────────────────────────────────────────────

export type ProcessVariableChangeEvent = SingularisPrimeScadaEvent<
  "process_variable_change",
  ProcessVariableChangePayload
>;
export type AlarmActivationEvent = SingularisPrimeScadaEvent<"alarm_activation", AlarmPayload>;
export type AlarmAcknowledgmentEvent = SingularisPrimeScadaEvent<"alarm_acknowledgment", AlarmPayload>;
export type AlarmClearEvent = SingularisPrimeScadaEvent<"alarm_clear", AlarmPayload>;
export type AlarmShelveEvent = SingularisPrimeScadaEvent<"alarm_shelve", AlarmPayload>;
export type EquipmentStateTransitionEvent = SingularisPrimeScadaEvent<
  "equipment_state_transition",
  EquipmentStateTransitionPayload
>;
export type OperatorActionEvent = SingularisPrimeScadaEvent<"operator_action", OperatorActionPayload>;
export type SystemHealthEvent = SingularisPrimeScadaEvent<"system_health", SystemHealthPayload>;

/** Union of all concrete SCADA event types */
export type AnyScadaEvent =
  | ProcessVariableChangeEvent
  | AlarmActivationEvent
  | AlarmAcknowledgmentEvent
  | AlarmClearEvent
  | AlarmShelveEvent
  | EquipmentStateTransitionEvent
  | OperatorActionEvent
  | SystemHealthEvent;

// ── Schema version constant ──────────────────────────────────────────────────

export const SCADA_SCHEMA_VERSION = "1.0.0";
