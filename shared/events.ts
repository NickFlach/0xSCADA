/**
 * 0xSCADA Event Model
 * 
 * PRD Section 6.1: Every event MUST be:
 * - Deterministic in serialization
 * - Signed by its origin (gateway / user / agent)
 * - Hashable
 * - Anchorable
 */

import { z } from "zod";

// =============================================================================
// EVENT TYPES (PRD Section 6.1)
// =============================================================================

export const EventType = {
  TELEMETRY: "TELEMETRY",
  ALARM: "ALARM",
  COMMAND: "COMMAND",
  ACKNOWLEDGEMENT: "ACKNOWLEDGEMENT",
  MAINTENANCE: "MAINTENANCE",
  BLUEPRINT_CHANGE: "BLUEPRINT_CHANGE",
  CODE_GENERATION: "CODE_GENERATION",
  DEPLOYMENT_INTENT: "DEPLOYMENT_INTENT",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// =============================================================================
// ORIGIN TYPES (Who/what created the event)
// =============================================================================

export const OriginType = {
  GATEWAY: "GATEWAY",
  USER: "USER",
  AGENT: "AGENT",
  SYSTEM: "SYSTEM",
} as const;

export type OriginType = (typeof OriginType)[keyof typeof OriginType];

// =============================================================================
// ANCHOR STATUS
// =============================================================================

export const AnchorStatus = {
  PENDING: "PENDING",
  BATCHED: "BATCHED",
  ANCHORED: "ANCHORED",
  FAILED: "FAILED",
} as const;

export type AnchorStatus = (typeof AnchorStatus)[keyof typeof AnchorStatus];

// =============================================================================
// BASE EVENT SCHEMA (All events extend this)
// =============================================================================

export const baseEventSchema = z.object({
  // Identity
  id: z.string().uuid(),
  eventType: z.nativeEnum(EventType),
  
  // Location
  siteId: z.string(),
  assetId: z.string().optional(),
  
  // Timestamps (PRD: source + receipt)
  sourceTimestamp: z.string().datetime(), // When the event occurred at source
  receiptTimestamp: z.string().datetime(), // When the platform received it
  
  // Origin (PRD: signed by origin)
  originType: z.nativeEnum(OriginType),
  originId: z.string(), // Gateway ID, User ID, or Agent ID
  
  // Payload (event-specific data)
  payload: z.record(z.unknown()),
  
  // Cryptographic fields (PRD: signed, hashable, anchorable)
  signature: z.string(), // Origin's signature over canonical payload
  hash: z.string(), // SHA-256 of canonical event
  
  // Anchor reference (PRD: optional anchor reference)
  anchorStatus: z.nativeEnum(AnchorStatus),
  batchId: z.string().optional(), // Which batch this event belongs to
  merkleIndex: z.number().optional(), // Position in Merkle tree
  merkleProof: z.array(z.string()).optional(), // Proof path
  anchorTxHash: z.string().optional(), // Ethereum transaction hash
  anchoredAt: z.string().datetime().optional(), // When anchored
});

export type BaseEvent = z.infer<typeof baseEventSchema>;

// =============================================================================
// TELEMETRY EVENT
// =============================================================================

export const telemetryPayloadSchema = z.object({
  tag: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().optional(),
  quality: z.enum(["GOOD", "BAD", "UNCERTAIN"]).optional(),
  engineeringUnits: z.string().optional(),
});

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

// =============================================================================
// ALARM EVENT
// =============================================================================

export const alarmPayloadSchema = z.object({
  alarmId: z.string(),
  alarmType: z.enum(["HIGH", "LOW", "HIHI", "LOLO", "DEVIATION", "RATE", "DISCRETE"]),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
  state: z.enum(["ACTIVE", "CLEARED", "ACKNOWLEDGED", "SHELVED"]),
  message: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  limit: z.number().optional(),
  previousState: z.string().optional(),
});

export type AlarmPayload = z.infer<typeof alarmPayloadSchema>;

// =============================================================================
// COMMAND EVENT
// =============================================================================

export const commandPayloadSchema = z.object({
  commandType: z.enum(["SETPOINT", "MODE", "START", "STOP", "RESET", "ACKNOWLEDGE"]),
  target: z.string(), // Tag or asset
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  previousValue: z.union([z.number(), z.string(), z.boolean()]).optional(),
  reason: z.string().optional(),
  approved: z.boolean().default(false),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
});

export type CommandPayload = z.infer<typeof commandPayloadSchema>;

// =============================================================================
// ACKNOWLEDGEMENT EVENT
// =============================================================================

export const acknowledgementPayloadSchema = z.object({
  targetEventId: z.string().uuid(), // Event being acknowledged
  targetEventType: z.nativeEnum(EventType),
  acknowledgedBy: z.string(),
  comment: z.string().optional(),
});

export type AcknowledgementPayload = z.infer<typeof acknowledgementPayloadSchema>;

// =============================================================================
// MAINTENANCE EVENT
// =============================================================================

export const maintenancePayloadSchema = z.object({
  workOrderId: z.string(),
  maintenanceType: z.enum(["PREVENTIVE", "CORRECTIVE", "PREDICTIVE", "EMERGENCY"]),
  description: z.string(),
  performedBy: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  partsUsed: z.array(z.object({
    partNumber: z.string(),
    quantity: z.number(),
    description: z.string().optional(),
  })).optional(),
  attachmentHashes: z.array(z.string()).optional(),
  nextDueAt: z.string().datetime().optional(),
});

export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

// =============================================================================
// BLUEPRINT CHANGE EVENT
// =============================================================================

export const blueprintChangePayloadSchema = z.object({
  changeType: z.enum(["CREATE", "UPDATE", "DELETE"]),
  entityType: z.enum(["CONTROL_MODULE", "UNIT", "PHASE", "TEMPLATE"]),
  entityId: z.string(),
  entityName: z.string(),
  previousHash: z.string().optional(),
  newHash: z.string(),
  diff: z.string().optional(), // JSON diff or text diff
  reason: z.string(),
  requestedBy: z.string(),
});

export type BlueprintChangePayload = z.infer<typeof blueprintChangePayloadSchema>;

// =============================================================================
// CODE GENERATION EVENT
// =============================================================================

export const codeGenerationPayloadSchema = z.object({
  sourceType: z.enum(["CONTROL_MODULE", "PHASE", "UNIT"]),
  sourceId: z.string(),
  sourceName: z.string(),
  sourceHash: z.string(), // Hash of source blueprint
  vendorId: z.string(),
  vendorName: z.string(),
  language: z.string(), // SCL, ST, Ladder, etc.
  codeHash: z.string(), // Hash of generated code
  codeSize: z.number(), // Bytes
  generatedBy: z.string(), // Agent ID or User ID
});

export type CodeGenerationPayload = z.infer<typeof codeGenerationPayloadSchema>;

// =============================================================================
// DEPLOYMENT INTENT EVENT (PRD Section 7.3)
// =============================================================================

export const deploymentIntentPayloadSchema = z.object({
  // What is being deployed
  blueprintId: z.string(),
  blueprintName: z.string(),
  blueprintHash: z.string(),
  codegenId: z.string(),
  codeHash: z.string(),
  
  // Where
  targetControllerId: z.string(),
  targetControllerName: z.string(),
  
  // Change package (PRD: diffs, test plans, rollback steps)
  changePackage: z.object({
    diff: z.string(),
    testPlan: z.array(z.string()),
    rollbackSteps: z.array(z.string()),
    estimatedDowntime: z.string().optional(),
  }),
  
  // Approval chain
  requiredApprovals: z.number(),
  approvals: z.array(z.object({
    userId: z.string(),
    userName: z.string(),
    signature: z.string(),
    approvedAt: z.string().datetime(),
    comment: z.string().optional(),
  })),
  
  // Status
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "DEPLOYED", "ROLLED_BACK"]),
  deployedAt: z.string().datetime().optional(),
  deployedBy: z.string().optional(),
});

export type DeploymentIntentPayload = z.infer<typeof deploymentIntentPayloadSchema>;

// =============================================================================
// TYPED EVENT CONSTRUCTORS
// =============================================================================

export interface TelemetryEvent extends BaseEvent {
  eventType: typeof EventType.TELEMETRY;
  payload: TelemetryPayload;
}

export interface AlarmEvent extends BaseEvent {
  eventType: typeof EventType.ALARM;
  payload: AlarmPayload;
}

export interface CommandEvent extends BaseEvent {
  eventType: typeof EventType.COMMAND;
  payload: CommandPayload;
}

export interface AcknowledgementEvent extends BaseEvent {
  eventType: typeof EventType.ACKNOWLEDGEMENT;
  payload: AcknowledgementPayload;
}

export interface MaintenanceEvent extends BaseEvent {
  eventType: typeof EventType.MAINTENANCE;
  payload: MaintenancePayload;
}

export interface BlueprintChangeEvent extends BaseEvent {
  eventType: typeof EventType.BLUEPRINT_CHANGE;
  payload: BlueprintChangePayload;
}

export interface CodeGenerationEvent extends BaseEvent {
  eventType: typeof EventType.CODE_GENERATION;
  payload: CodeGenerationPayload;
}

export interface DeploymentIntentEvent extends BaseEvent {
  eventType: typeof EventType.DEPLOYMENT_INTENT;
  payload: DeploymentIntentPayload;
}

export type TypedEvent =
  | TelemetryEvent
  | AlarmEvent
  | CommandEvent
  | AcknowledgementEvent
  | MaintenanceEvent
  | BlueprintChangeEvent
  | CodeGenerationEvent
  | DeploymentIntentEvent;
