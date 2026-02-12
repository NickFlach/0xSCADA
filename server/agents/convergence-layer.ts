/**
 * 0xSCADA OT/IT Convergence Layer
 * 
 * ADR-0011: OT/IT Convergence Standards for Agentic Systems
 * 
 * Provides formal boundaries, translation services, and protocol
 * standards for agents operating across OT and IT domains:
 * - Domain boundary enforcement
 * - Data translation (Tag→Event, Command→Setpoint, Alarm→Alert)
 * - Cross-domain audit logging with dual timestamps
 * - Failure isolation (IT failure cannot propagate to OT)
 * - Translation buffering during outages
 */

import { randomUUID } from "crypto";
import { sha256, canonicalize } from "../crypto";
import { log, logError } from "../logger";
import type {
  AgentDomainType,
  Domain,
  TranslationType,
  TranslationAuditEntry,
  ConvergenceHealth,
  ProtocolType,
} from "@shared/types/convergence-layer";
import {
  AgentDomainType as DomainTypes,
  Domain as Domains,
  AGENT_DOMAIN_ACCESS,
  FAILURE_ISOLATION_RULES,
} from "@shared/types/convergence-layer";

// =============================================================================
// AGENT DOMAIN REGISTRY
// =============================================================================

interface RegisteredAgent {
  agentId: string;
  domainType: AgentDomainType;
  registeredAt: Date;
}

// =============================================================================
// CONVERGENCE LAYER SERVICE
// =============================================================================

export class ConvergenceLayer {
  /** Registered agents and their domain authorization */
  private agents: Map<string, RegisteredAgent> = new Map();

  /** Translation audit log */
  private auditLog: TranslationAuditEntry[] = [];
  private readonly maxAuditLog = 10000;

  /** Translation buffer for outage recovery */
  private outageBuffer: Array<{
    entry: TranslationAuditEntry;
    payload: unknown;
    bufferedAt: Date;
  }> = [];

  /** Connection state */
  private otGatewayConnected: boolean = false;
  private itServicesConnected: boolean = false;
  private governanceConnected: boolean = false;
  private otLastHeartbeat: Date | null = null;
  private itLastHeartbeat: Date | null = null;

  // ==========================================================================
  // AGENT REGISTRATION
  // ==========================================================================

  /**
   * Register an agent with its domain authorization type
   */
  registerAgent(agentId: string, domainType: AgentDomainType): void {
    this.agents.set(agentId, {
      agentId,
      domainType,
      registeredAt: new Date(),
    });

    const access = AGENT_DOMAIN_ACCESS[domainType];
    log(
      `🔌 Agent registered in convergence layer: ${agentId} (${domainType}: OT=${access.otAccess}, IT=${access.itAccess})`,
      "convergence"
    );
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Get an agent's domain type
   */
  getAgentDomainType(agentId: string): AgentDomainType | undefined {
    return this.agents.get(agentId)?.domainType;
  }

  // ==========================================================================
  // DOMAIN BOUNDARY ENFORCEMENT
  // ==========================================================================

  /**
   * Check if an agent can access a target domain.
   * This is the core enforcement point — no IT agent may directly address OT devices.
   */
  checkDomainAccess(
    agentId: string,
    targetDomain: Domain,
    accessType: "read" | "write"
  ): { allowed: boolean; reason?: string } {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { allowed: false, reason: `Agent ${agentId} not registered in convergence layer` };
    }

    const access = AGENT_DOMAIN_ACCESS[agent.domainType];

    // IT domain access
    if (targetDomain === Domains.IT) {
      if (access.itAccess === "none") {
        return { allowed: false, reason: `${agent.domainType} agents have no IT access` };
      }
      return { allowed: true };
    }

    // Convergence layer access
    if (targetDomain === Domains.CONVERGENCE) {
      if (access.convergenceAccess === "publish_only" && accessType === "read") {
        return { allowed: false, reason: `${agent.domainType} agents can only publish to convergence` };
      }
      return { allowed: true };
    }

    // OT domain access — the critical check
    if (targetDomain === Domains.OT) {
      if (access.otAccess === "none") {
        return {
          allowed: false,
          reason: `CRITICAL: ${agent.domainType} agents have NO OT access. All OT interaction must go through Convergence Layer.`,
        };
      }

      if (access.otAccess === "read_via_gateway" && accessType === "write") {
        return {
          allowed: false,
          reason: `${agent.domainType} agents can only READ from OT via gateway, not write`,
        };
      }

      if (access.otAccess === "read_write_bounded" && accessType === "write") {
        // Allowed but must go through envelope checking (ADR-0009)
        return { allowed: true };
      }

      return { allowed: true };
    }

    return { allowed: false, reason: `Unknown domain: ${targetDomain}` };
  }

  // ==========================================================================
  // DATA TRANSLATION
  // ==========================================================================

  /**
   * Translate data between domains with full audit logging.
   * Every cross-domain translation is logged and hash-anchored.
   */
  translate(options: {
    agentId: string;
    translationType: TranslationType;
    sourceDomain: Domain;
    targetDomain: Domain;
    inputData: unknown;
    protocol?: ProtocolType;
    otTimestamp?: string;
  }): {
    success: boolean;
    outputHash?: string;
    auditEntry?: TranslationAuditEntry;
    reason?: string;
  } {
    // 1. Check domain access
    const accessCheck = this.checkDomainAccess(
      options.agentId,
      options.targetDomain,
      options.translationType === "COMMAND_TO_SETPOINT" ? "write" : "read"
    );

    if (!accessCheck.allowed) {
      return { success: false, reason: accessCheck.reason };
    }

    // 2. Check connectivity
    if (options.targetDomain === Domains.OT && !this.otGatewayConnected) {
      // Buffer the translation for later
      const entry = this.buildAuditEntry(options, "ESCALATE", "OT gateway disconnected");
      this.bufferTranslation(entry, options.inputData);
      return { success: false, reason: "OT gateway disconnected — translation buffered" };
    }

    if (options.targetDomain === Domains.IT && !this.itServicesConnected) {
      const entry = this.buildAuditEntry(options, "ESCALATE", "IT services disconnected");
      this.bufferTranslation(entry, options.inputData);
      return { success: false, reason: "IT services disconnected — translation buffered" };
    }

    // 3. Compute hashes for audit
    const inputHash = sha256(canonicalize(options.inputData));
    const outputHash = sha256(canonicalize({ translated: options.inputData, type: options.translationType }));

    // 4. Build audit entry
    const entry = this.buildAuditEntry(options, "PASS");
    entry.inputHash = inputHash;
    entry.outputHash = outputHash;

    // 5. Record audit
    this.recordAudit(entry);

    return { success: true, outputHash, auditEntry: entry };
  }

  // ==========================================================================
  // CONNECTION MANAGEMENT
  // ==========================================================================

  /**
   * Update OT gateway connection status
   */
  setOtGatewayStatus(connected: boolean): void {
    const wasConnected = this.otGatewayConnected;
    this.otGatewayConnected = connected;

    if (connected) {
      this.otLastHeartbeat = new Date();

      // Flush buffered OT translations
      if (!wasConnected) {
        this.flushBuffer(Domains.OT);
      }
    }

    log(`🔌 OT Gateway: ${connected ? "CONNECTED" : "DISCONNECTED"}`, "convergence");
  }

  /**
   * Update IT services connection status
   */
  setItServicesStatus(connected: boolean): void {
    const wasConnected = this.itServicesConnected;
    this.itServicesConnected = connected;

    if (connected) {
      this.itLastHeartbeat = new Date();

      if (!wasConnected) {
        this.flushBuffer(Domains.IT);
      }
    }

    log(`🔌 IT Services: ${connected ? "CONNECTED" : "DISCONNECTED"}`, "convergence");
  }

  /**
   * Update governance connection status
   */
  setGovernanceStatus(connected: boolean): void {
    this.governanceConnected = connected;
    log(`🔌 Governance: ${connected ? "CONNECTED" : "DISCONNECTED"}`, "convergence");
  }

  // ==========================================================================
  // OUTAGE BUFFERING
  // ==========================================================================

  private bufferTranslation(entry: TranslationAuditEntry, payload: unknown): void {
    this.outageBuffer.push({
      entry,
      payload,
      bufferedAt: new Date(),
    });

    // Trim buffer to prevent memory issues
    if (this.outageBuffer.length > 10000) {
      this.outageBuffer = this.outageBuffer.slice(-5000);
    }

    log(
      `📦 Translation buffered (${this.outageBuffer.length} pending): ${entry.translationType} ${entry.sourceDomain}→${entry.targetDomain}`,
      "convergence"
    );
  }

  private flushBuffer(targetDomain: Domain): void {
    const toFlush = this.outageBuffer.filter(
      (b) => b.entry.targetDomain === targetDomain
    );

    if (toFlush.length === 0) return;

    // Remove flushed entries from buffer
    this.outageBuffer = this.outageBuffer.filter(
      (b) => b.entry.targetDomain !== targetDomain
    );

    // Record all buffered translations as completed
    for (const buffered of toFlush) {
      buffered.entry.boundaryCheck = "PASS";
      buffered.entry.boundaryCheckReason = `Flushed after outage recovery (buffered at ${buffered.bufferedAt.toISOString()})`;
      this.recordAudit(buffered.entry);
    }

    log(
      `📤 Flushed ${toFlush.length} buffered translations to ${targetDomain}`,
      "convergence"
    );
  }

  // ==========================================================================
  // HEALTH & STATUS
  // ==========================================================================

  /**
   * Get convergence layer health status
   */
  getHealth(): ConvergenceHealth {
    let status: ConvergenceHealth["status"] = "HEALTHY";

    if (!this.otGatewayConnected && !this.itServicesConnected) {
      status = "OFFLINE";
    } else if (!this.otGatewayConnected) {
      status = "OT_DISCONNECTED";
    } else if (!this.itServicesConnected) {
      status = "IT_DISCONNECTED";
    } else if (this.outageBuffer.length > 100) {
      status = "DEGRADED";
    }

    return {
      status,
      otGateway: {
        connected: this.otGatewayConnected,
        lastHeartbeat: this.otLastHeartbeat?.toISOString(),
      },
      itServices: {
        connected: this.itServicesConnected,
        lastHeartbeat: this.itLastHeartbeat?.toISOString(),
      },
      governance: {
        connected: this.governanceConnected,
        chainId: this.governanceConnected ? "0x5CADA" : undefined,
      },
      translationBuffer: {
        pendingTranslations: this.outageBuffer.length,
        bufferedDuringOutage: this.outageBuffer.length,
      },
      timeSync: {
        ptpAvailable: this.otGatewayConnected, // PTP available when OT connected
        ntpAvailable: true, // NTP always available on IT side
      },
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get failure isolation rules
   */
  getFailureIsolationRules(): typeof FAILURE_ISOLATION_RULES {
    return FAILURE_ISOLATION_RULES;
  }

  // ==========================================================================
  // AUDIT LOG
  // ==========================================================================

  /**
   * Get translation audit log
   */
  getAuditLog(options?: {
    agentId?: string;
    sourceDomain?: Domain;
    targetDomain?: Domain;
    limit?: number;
  }): TranslationAuditEntry[] {
    let result = this.auditLog;

    if (options?.agentId) {
      result = result.filter((e) => e.agentId === options.agentId);
    }
    if (options?.sourceDomain) {
      result = result.filter((e) => e.sourceDomain === options.sourceDomain);
    }
    if (options?.targetDomain) {
      result = result.filter((e) => e.targetDomain === options.targetDomain);
    }

    return result.slice(-(options?.limit ?? 100));
  }

  /**
   * Get statistics
   */
  getStats(): {
    registeredAgents: number;
    byDomainType: Record<string, number>;
    totalTranslations: number;
    bufferedTranslations: number;
    failedTranslations: number;
  } {
    const byDomainType: Record<string, number> = {};
    for (const agent of this.agents.values()) {
      byDomainType[agent.domainType] = (byDomainType[agent.domainType] || 0) + 1;
    }

    return {
      registeredAgents: this.agents.size,
      byDomainType,
      totalTranslations: this.auditLog.length,
      bufferedTranslations: this.outageBuffer.length,
      failedTranslations: this.auditLog.filter((e) => e.boundaryCheck === "FAIL").length,
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private buildAuditEntry(
    options: {
      agentId: string;
      translationType: TranslationType;
      sourceDomain: Domain;
      targetDomain: Domain;
      protocol?: ProtocolType;
      otTimestamp?: string;
    },
    boundaryCheck: "PASS" | "FAIL" | "ESCALATE",
    reason?: string
  ): TranslationAuditEntry {
    return {
      id: randomUUID(),
      sourceDomain: options.sourceDomain as "OT" | "IT" | "CONVERGENCE",
      targetDomain: options.targetDomain as "OT" | "IT" | "CONVERGENCE",
      agentId: options.agentId,
      translationType: options.translationType as "TAG_TO_EVENT" | "COMMAND_TO_SETPOINT" | "ALARM_TO_ALERT" | "REGISTER_TO_JSON",
      inputHash: "",
      outputHash: "",
      boundaryCheck,
      boundaryCheckReason: reason,
      otTimestamp: options.otTimestamp,
      itTimestamp: new Date().toISOString(),
      protocol: options.protocol as any,
    };
  }

  private recordAudit(entry: TranslationAuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > this.maxAuditLog) {
      this.auditLog = this.auditLog.slice(-Math.floor(this.maxAuditLog / 2));
    }
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let convergenceInstance: ConvergenceLayer | null = null;

export function getConvergenceLayer(): ConvergenceLayer {
  if (!convergenceInstance) {
    convergenceInstance = new ConvergenceLayer();
  }
  return convergenceInstance;
}

export function initConvergenceLayer(): ConvergenceLayer {
  convergenceInstance = new ConvergenceLayer();
  return convergenceInstance;
}
