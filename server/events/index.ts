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
