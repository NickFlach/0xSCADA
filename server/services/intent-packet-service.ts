/**
 * Intent Packet Service
 *
 * GhostOS Propagation Model - Intent Packet Validation and Processing
 * See docs/propagation-model.md for specification
 *
 * Issue: #163 - Intent Packet Schema & Validation
 * Epic: #161 - GhostOS Propagation Model
 */

import {
  IntentPacket,
  CreateIntentPacket,
  PropagationResult,
  PropagationOutcome,
  PropagationMode,
  IntentPacketValidationError,
  validateIntentPacket,
  createIntentPacket,
  intentPacketSchema,
  AUTHORITY_ORDER,
  AuthorityLevel,
} from "../../shared/types/intent-packet";

// =============================================================================
// SERVICE TYPES
// =============================================================================

export interface IntentPacketServiceConfig {
  strictValidation: boolean;
  maxPendingIntents: number;
  defaultTtl: number;
}

export interface ValidationResult {
  valid: boolean;
  packet?: IntentPacket;
  errors?: IntentPacketValidationError[];
  warnings?: string[];
}

export interface IntentPacketContext {
  agentAuthority: AuthorityLevel;
  agentId?: string;
  userId?: string;
  source: string;
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: IntentPacketServiceConfig = {
  strictValidation: true,
  maxPendingIntents: 1000,
  defaultTtl: 300000, // 5 minutes
};

// =============================================================================
// INTENT PACKET SERVICE
// =============================================================================

export class IntentPacketService {
  private config: IntentPacketServiceConfig;
  private pendingIntents: Map<string, IntentPacket> = new Map();

  constructor(config: Partial<IntentPacketServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate an incoming intent packet at API/service boundary
   * Returns actionable errors for malformed packets
   */
  validate(data: unknown): ValidationResult {
    const result = validateIntentPacket(data);

    if (!result.valid) {
      return {
        valid: false,
        errors: result.errors,
      };
    }

    const packet = result.data!;
    const warnings: string[] = [];

    // Additional semantic validation
    if (packet.confidence < 0.5) {
      warnings.push("Low confidence intent may trigger SAFE_HOLD mode");
    }

    if (packet.ttl > 3600000) {
      warnings.push("TTL exceeds 1 hour - consider shorter expiration");
    }

    if (packet.constraints.length === 0) {
      warnings.push("No constraints specified - consider adding execution limits");
    }

    if (packet.expected_observables.length === 0) {
      warnings.push("No expected observables - validation will be skipped");
    }

    return {
      valid: true,
      packet,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Create a new intent packet with auto-generated ID and timestamp
   */
  create(data: CreateIntentPacket, context?: IntentPacketContext): IntentPacket {
    const packet = createIntentPacket({
      ...data,
      originator: context
        ? {
            agent_id: context.agentId,
            user_id: context.userId,
            source: context.source,
          }
        : data.originator,
    });

    return packet;
  }

  /**
   * Validate and create an intent packet in one operation
   * This is the primary entry point for intent ingestion
   */
  ingest(
    data: unknown,
    context?: IntentPacketContext
  ): { success: true; packet: IntentPacket; warnings?: string[] } | { success: false; errors: IntentPacketValidationError[] } {
    // First validate the base structure
    const validation = this.validate(data);

    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors!,
      };
    }

    const packet = validation.packet!;

    // Check authority if context provided
    if (context) {
      const authorityCheck = this.checkAuthority(packet, context.agentAuthority);
      if (!authorityCheck.authorized) {
        return {
          success: false,
          errors: [
            {
              field: "authority_required",
              message: authorityCheck.reason,
              code: "INSUFFICIENT_AUTHORITY",
            },
          ],
        };
      }
    }

    // Store in pending intents if within limit
    if (this.pendingIntents.size < this.config.maxPendingIntents) {
      this.pendingIntents.set(packet.intent_id, packet);
    }

    return {
      success: true,
      packet,
      warnings: validation.warnings,
    };
  }

  /**
   * Check if the given authority level is sufficient for the intent
   */
  checkAuthority(
    packet: IntentPacket,
    agentAuthority: AuthorityLevel
  ): { authorized: boolean; reason: string } {
    const requiredLevel = AUTHORITY_ORDER[packet.authority_required];
    const agentLevel = AUTHORITY_ORDER[agentAuthority];

    if (agentLevel >= requiredLevel) {
      return { authorized: true, reason: "Authority level sufficient" };
    }

    return {
      authorized: false,
      reason: `Intent requires ${packet.authority_required} authority, but agent has ${agentAuthority}`,
    };
  }

  /**
   * Get a pending intent by ID
   */
  getPending(intentId: string): IntentPacket | undefined {
    return this.pendingIntents.get(intentId);
  }

  /**
   * Remove a pending intent (after processing)
   */
  removePending(intentId: string): boolean {
    return this.pendingIntents.delete(intentId);
  }

  /**
   * Get count of pending intents
   */
  getPendingCount(): number {
    return this.pendingIntents.size;
  }

  /**
   * Clear expired intents based on TTL
   */
  clearExpired(): number {
    const now = Date.now();
    let cleared = 0;

    for (const [id, packet] of this.pendingIntents) {
      if (packet.created_at) {
        const createdAt = new Date(packet.created_at).getTime();
        if (now - createdAt > packet.ttl) {
          this.pendingIntents.delete(id);
          cleared++;
        }
      }
    }

    return cleared;
  }

  /**
   * Build a rejection result for invalid packets
   */
  buildRejectionResult(
    intentId: string,
    errors: IntentPacketValidationError[]
  ): PropagationResult {
    const now = new Date().toISOString();

    return {
      intent_id: intentId,
      outcome: PropagationOutcome.REJECTED,
      mode: PropagationMode.SAFE_HOLD,
      rationale: {
        coupling: 0,
        loss: 1,
        effective_coupling: 0,
        mode_selected: PropagationMode.SAFE_HOLD,
        mode_reason: "Intent packet validation failed",
        policy_flags: ["VALIDATION_FAILED"],
        constraints_evaluated: [],
      },
      telemetry: {
        duration_ms: 0,
        coupling: 0,
        loss: 1,
      },
      rejection_reason: "Intent packet validation failed",
      validation_errors: errors.map((e) => ({
        path: e.field.split("."),
        message: e.message,
      })),
      started_at: now,
      completed_at: now,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let serviceInstance: IntentPacketService | null = null;

export function getIntentPacketService(
  config?: Partial<IntentPacketServiceConfig>
): IntentPacketService {
  if (!serviceInstance) {
    serviceInstance = new IntentPacketService(config);
  }
  return serviceInstance;
}

export function resetIntentPacketService(): void {
  serviceInstance = null;
}
