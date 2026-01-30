/**
 * 0xSCADA Event Service
 * 
 * PRD Section 6.1: Event Model Implementation
 * - Deterministic serialization
 * - Signing
 * - Hashing
 * - Batch anchoring
 */

import { 
  computeEventHash, 
  signEvent, 
  canonicalize,
  sha256,
} from "../crypto";
import { batchManager } from "../merkle";
import type { InsertEvent } from "@shared/schema";

// =============================================================================
// EVENT TYPES
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
  // Ubiquity IOT Events
  UBIQUITY_DEVICE_CONNECTED: "UBIQUITY_DEVICE_CONNECTED",
  UBIQUITY_DEVICE_DISCONNECTED: "UBIQUITY_DEVICE_DISCONNECTED",
  UBIQUITY_FILE_TRANSFER: "UBIQUITY_FILE_TRANSFER",
  UBIQUITY_REMOTE_SESSION: "UBIQUITY_REMOTE_SESSION",
  UBIQUITY_PROCESS_ACTION: "UBIQUITY_PROCESS_ACTION",
  UBIQUITY_FIRMWARE_DEPLOYMENT: "UBIQUITY_FIRMWARE_DEPLOYMENT",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export const OriginType = {
  GATEWAY: "GATEWAY",
  USER: "USER",
  AGENT: "AGENT",
  SYSTEM: "SYSTEM",
} as const;

export type OriginType = (typeof OriginType)[keyof typeof OriginType];

// =============================================================================
// EVENT CREATION
// =============================================================================

export interface CreateEventInput {
  eventType: EventType;
  siteId: string;
  assetId?: string;
  sourceTimestamp: Date;
  originType: OriginType;
  originId: string;
  payload: Record<string, unknown>;
  details?: string;
}

export interface SignedEvent extends CreateEventInput {
  hash: string;
  signature: string;
}

/**
 * Create a signed event ready for storage
 */
export function createSignedEvent(
  input: CreateEventInput,
  signingKey: string
): SignedEvent {
  const hashInput = {
    eventType: input.eventType,
    siteId: input.siteId,
    assetId: input.assetId,
    sourceTimestamp: input.sourceTimestamp.toISOString(),
    originType: input.originType,
    originId: input.originId,
    payload: input.payload,
  };

  const hash = computeEventHash({
    ...hashInput,
    sourceTimestamp: hashInput.sourceTimestamp,
  });

  const signature = signEvent(
    {
      ...hashInput,
      sourceTimestamp: hashInput.sourceTimestamp,
    },
    signingKey
  );

  return {
    ...input,
    hash,
    signature,
  };
}

/**
 * Convert a signed event to database insert format
 */
export function toInsertEvent(event: SignedEvent): Omit<InsertEvent, "receiptTimestamp"> {
  return {
    eventType: event.eventType,
    siteId: event.siteId,
    assetId: event.assetId,
    sourceTimestamp: event.sourceTimestamp,
    originType: event.originType,
    originId: event.originId,
    payload: event.payload,
    details: event.details,
    signature: event.signature,
    hash: event.hash,
    anchorStatus: "PENDING",
  };
}

// =============================================================================
// EVENT SERVICE
// =============================================================================

export interface EventServiceConfig {
  signingKey: string;
  enableBatching: boolean;
  batchSize?: number;
  batchMaxAge?: number;
}

/**
 * Event Service
 * Handles event creation, signing, and batching
 */
export class EventService {
  private config: EventServiceConfig;
  private eventCallbacks: ((event: SignedEvent) => void)[] = [];

  constructor(config: EventServiceConfig) {
    this.config = config;

    if (config.enableBatching) {
      // Configure batch manager
      batchManager.setAnchorCallback(async (batch) => {
        // This will be connected to the blockchain service
        console.log(`📦 Batch ready for anchoring: ${batch.batchId}`);
        console.log(`   Events: ${batch.eventCount}`);
        console.log(`   Merkle Root: ${batch.merkleRoot}`);
        
        // Return null for now - will be connected to blockchain
        return null;
      });
    }
  }

  /**
   * Create and process a new event
   */
  createEvent(input: CreateEventInput): SignedEvent {
    const signedEvent = createSignedEvent(input, this.config.signingKey);

    // Add to batch if batching is enabled
    if (this.config.enableBatching) {
      batchManager.addEvent(signedEvent.hash, signedEvent.hash);
    }

    // Notify subscribers
    for (const callback of this.eventCallbacks) {
      try {
        callback(signedEvent);
      } catch (error) {
        console.error("Event callback error:", error);
      }
    }

    return signedEvent;
  }

  /**
   * Subscribe to new events
   */
  onEvent(callback: (event: SignedEvent) => void): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      const index = this.eventCallbacks.indexOf(callback);
      if (index > -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get batch manager stats
   */
  getBatchStats() {
    return batchManager.getStats();
  }

  /**
   * Force flush pending events to a batch
   */
  flushBatch() {
    return batchManager.flush();
  }
}

// =============================================================================
// TELEMETRY EVENT HELPERS
// =============================================================================

export interface TelemetryInput {
  siteId: string;
  assetId: string;
  tag: string;
  value: number | string | boolean;
  unit?: string;
  quality?: "GOOD" | "BAD" | "UNCERTAIN";
  originId: string;
  originType?: OriginType;
}

export function createTelemetryEvent(
  input: TelemetryInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.TELEMETRY,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.GATEWAY,
      originId: input.originId,
      payload: {
        tag: input.tag,
        value: input.value,
        unit: input.unit,
        quality: input.quality || "GOOD",
      },
      details: `${input.tag} = ${input.value}${input.unit ? ` ${input.unit}` : ""}`,
    },
    signingKey
  );
}

// =============================================================================
// ALARM EVENT HELPERS
// =============================================================================

export interface AlarmInput {
  siteId: string;
  assetId: string;
  alarmId: string;
  alarmType: "HIGH" | "LOW" | "HIHI" | "LOLO" | "DEVIATION" | "RATE" | "DISCRETE";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  state: "ACTIVE" | "CLEARED" | "ACKNOWLEDGED" | "SHELVED";
  message: string;
  value?: number | string | boolean;
  limit?: number;
  originId: string;
  originType?: OriginType;
}

export function createAlarmEvent(
  input: AlarmInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.ALARM,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.GATEWAY,
      originId: input.originId,
      payload: {
        alarmId: input.alarmId,
        alarmType: input.alarmType,
        severity: input.severity,
        state: input.state,
        message: input.message,
        value: input.value,
        limit: input.limit,
      },
      details: `[${input.severity}] ${input.message}`,
    },
    signingKey
  );
}

// =============================================================================
// COMMAND EVENT HELPERS
// =============================================================================

export interface CommandInput {
  siteId: string;
  assetId: string;
  commandType: "SETPOINT" | "MODE" | "START" | "STOP" | "RESET" | "ACKNOWLEDGE";
  target: string;
  value?: number | string | boolean;
  previousValue?: number | string | boolean;
  reason?: string;
  originId: string;
  originType?: OriginType;
}

export function createCommandEvent(
  input: CommandInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.COMMAND,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.USER,
      originId: input.originId,
      payload: {
        commandType: input.commandType,
        target: input.target,
        value: input.value,
        previousValue: input.previousValue,
        reason: input.reason,
        approved: false,
      },
      details: `${input.commandType} ${input.target}${input.value !== undefined ? ` → ${input.value}` : ""}`,
    },
    signingKey
  );
}

// =============================================================================
// ACKNOWLEDGEMENT EVENT HELPERS
// =============================================================================

export interface AcknowledgementInput {
  siteId: string;
  assetId?: string;
  alarmEventId: string;
  alarmId: string;
  comment?: string;
  originId: string;
  originType?: OriginType;
}

export function createAcknowledgementEvent(
  input: AcknowledgementInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.ACKNOWLEDGEMENT,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.USER,
      originId: input.originId,
      payload: {
        alarmEventId: input.alarmEventId,
        alarmId: input.alarmId,
        comment: input.comment,
        acknowledgedAt: new Date().toISOString(),
      },
      details: `Acknowledged alarm ${input.alarmId}`,
    },
    signingKey
  );
}

// =============================================================================
// MAINTENANCE EVENT HELPERS
// =============================================================================

export interface MaintenanceInput {
  siteId: string;
  assetId: string;
  workOrderId: string;
  maintenanceType: "PREVENTIVE" | "CORRECTIVE" | "PREDICTIVE" | "EMERGENCY";
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  description: string;
  technician?: string;
  parts?: string[];
  duration?: number;
  originId: string;
  originType?: OriginType;
}

export function createMaintenanceEvent(
  input: MaintenanceInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.MAINTENANCE,
      siteId: input.siteId,
      assetId: input.assetId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.USER,
      originId: input.originId,
      payload: {
        workOrderId: input.workOrderId,
        maintenanceType: input.maintenanceType,
        status: input.status,
        description: input.description,
        technician: input.technician,
        parts: input.parts,
        duration: input.duration,
      },
      details: `[${input.maintenanceType}] ${input.description}`,
    },
    signingKey
  );
}

// =============================================================================
// BLUEPRINT CHANGE EVENT HELPERS
// =============================================================================

export interface BlueprintChangeInput {
  siteId: string;
  blueprintType: "CONTROL_MODULE" | "UNIT" | "PHASE";
  blueprintId: string;
  blueprintName: string;
  changeType: "CREATE" | "UPDATE" | "DELETE";
  previousHash?: string;
  newHash: string;
  diff?: Record<string, unknown>;
  originId: string;
  originType?: OriginType;
}

export function createBlueprintChangeEvent(
  input: BlueprintChangeInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.BLUEPRINT_CHANGE,
      siteId: input.siteId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.USER,
      originId: input.originId,
      payload: {
        blueprintType: input.blueprintType,
        blueprintId: input.blueprintId,
        blueprintName: input.blueprintName,
        changeType: input.changeType,
        previousHash: input.previousHash,
        newHash: input.newHash,
        diff: input.diff,
      },
      details: `${input.changeType} ${input.blueprintType}: ${input.blueprintName}`,
    },
    signingKey
  );
}

// =============================================================================
// CODE GENERATION EVENT HELPERS
// =============================================================================

export interface CodeGenerationInput {
  siteId: string;
  blueprintId: string;
  blueprintName: string;
  vendorId: string;
  vendorName: string;
  language: string;
  codeHash: string;
  codeSize: number;
  generatedCodeId: string;
  originId: string;
  originType?: OriginType;
}

export function createCodeGenerationEvent(
  input: CodeGenerationInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.CODE_GENERATION,
      siteId: input.siteId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.SYSTEM,
      originId: input.originId,
      payload: {
        blueprintId: input.blueprintId,
        blueprintName: input.blueprintName,
        vendorId: input.vendorId,
        vendorName: input.vendorName,
        language: input.language,
        codeHash: input.codeHash,
        codeSize: input.codeSize,
        generatedCodeId: input.generatedCodeId,
      },
      details: `Generated ${input.language} code for ${input.blueprintName} (${input.vendorName})`,
    },
    signingKey
  );
}

// =============================================================================
// DEPLOYMENT INTENT EVENT HELPERS
// =============================================================================

export interface DeploymentIntentInput {
  siteId: string;
  intentId: string;
  blueprintId: string;
  blueprintName: string;
  codeHash: string;
  targetControllerId: string;
  targetControllerName: string;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "DEPLOYED" | "ROLLED_BACK";
  requiredApprovals: number;
  approvals?: Array<{
    userId: string;
    userName: string;
    decision: "APPROVE" | "REJECT";
    comment?: string;
    signature: string;
    decidedAt: string;
  }>;
  originId: string;
  originType?: OriginType;
}

export function createDeploymentIntentEvent(
  input: DeploymentIntentInput,
  signingKey: string
): SignedEvent {
  return createSignedEvent(
    {
      eventType: EventType.DEPLOYMENT_INTENT,
      siteId: input.siteId,
      sourceTimestamp: new Date(),
      originType: input.originType || OriginType.AGENT,
      originId: input.originId,
      payload: {
        intentId: input.intentId,
        blueprintId: input.blueprintId,
        blueprintName: input.blueprintName,
        codeHash: input.codeHash,
        targetControllerId: input.targetControllerId,
        targetControllerName: input.targetControllerName,
        status: input.status,
        requiredApprovals: input.requiredApprovals,
        approvals: input.approvals || [],
      },
      details: `[${input.status}] Deploy ${input.blueprintName} to ${input.targetControllerName}`,
    },
    signingKey
  );
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let eventServiceInstance: EventService | null = null;

export function getEventService(): EventService {
  if (!eventServiceInstance) {
    eventServiceInstance = new EventService({
      signingKey: process.env.EVENT_SIGNING_KEY || "development-signing-key",
      enableBatching: true,
      batchSize: 100,
      batchMaxAge: 60000,
    });
  }
  return eventServiceInstance;
}

export function initEventService(config: EventServiceConfig): EventService {
  eventServiceInstance = new EventService(config);
  return eventServiceInstance;
}
