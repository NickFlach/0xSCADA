/**
 * Agent Runtime Service
 * 
 * Phase 2: Agent Framework & Runtime
 * 
 * Features:
 * - Agent lifecycle management
 * - Event subscription and routing
 * - Proposal generation and approval workflow
 * - Audit trail for all agent actions
 */

import { EventEmitter } from "events";
import { db } from "../db";
import { agents, agentOutputs, agentProposals, agentState } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getEventService, EventType, OriginType } from "../events";
import { hashObject, signWithHmac } from "../crypto";
import { agentRegistry } from "./index";
import type { BaseAgent } from "./base";

// =============================================================================
// AGENT RUNTIME TYPES
// =============================================================================

export interface AgentRuntimeConfig {
  maxConcurrentAgents: number;
  proposalExpirationHours: number;
  auditLogEnabled: boolean;
  eventBufferSize: number;
}

export interface AgentAuditEntry {
  id: string;
  agentId: string;
  action: "START" | "STOP" | "EVENT_PROCESSED" | "OUTPUT_CREATED" | "PROPOSAL_CREATED" | "PROPOSAL_APPROVED" | "PROPOSAL_REJECTED" | "ERROR";
  details: Record<string, unknown>;
  timestamp: Date;
  signature?: string;
}

export interface ProposalApproval {
  userId: string;
  userName: string;
  decision: "APPROVE" | "REJECT";
  comment?: string;
  signature: string;
  decidedAt: Date;
}

// =============================================================================
// AGENT RUNTIME SERVICE
// =============================================================================

export class AgentRuntime extends EventEmitter {
  private config: AgentRuntimeConfig;
  private auditLog: AgentAuditEntry[] = [];
  private eventBuffer: Map<string, any[]> = new Map();
  private processingIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<AgentRuntimeConfig> = {}) {
    super();
    this.config = {
      maxConcurrentAgents: 10,
      proposalExpirationHours: 24,
      auditLogEnabled: true,
      eventBufferSize: 1000,
      ...config,
    };
  }

  /**
   * Start an agent
   */
  async startAgent(agentId: string): Promise<void> {
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Update database status
    await db.update(agents)
      .set({ status: "ACTIVE", lastActiveAt: new Date(), updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    // Start the agent
    await agent.start();

    // Subscribe to events
    this.subscribeAgentToEvents(agent);

    // Log audit entry
    this.logAudit({
      agentId,
      action: "START",
      details: { capabilities: agent.capabilities },
    });

    this.emit("agentStarted", { agentId, agent });
  }

  /**
   * Stop an agent
   */
  async stopAgent(agentId: string): Promise<void> {
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Clear processing interval
    const interval = this.processingIntervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.processingIntervals.delete(agentId);
    }

    // Stop the agent
    await agent.stop();

    // Update database status
    await db.update(agents)
      .set({ status: "INACTIVE", updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    // Log audit entry
    this.logAudit({
      agentId,
      action: "STOP",
      details: {},
    });

    this.emit("agentStopped", { agentId });
  }

  /**
   * Subscribe an agent to relevant events
   */
  private subscribeAgentToEvents(agent: BaseAgent): void {
    const eventService = getEventService();
    
    // Create event buffer for this agent
    this.eventBuffer.set(agent.id, []);

    // Subscribe to events
    eventService.onEvent((event) => {
      // Check if agent should receive this event based on scope
      if (this.shouldAgentReceiveEvent(agent, event)) {
        const buffer = this.eventBuffer.get(agent.id) || [];
        buffer.push(event);
        
        // Trim buffer if too large
        if (buffer.length > this.config.eventBufferSize) {
          buffer.shift();
        }
        
        this.eventBuffer.set(agent.id, buffer);
      }
    });

    // Set up periodic processing
    const interval = setInterval(async () => {
      await this.processAgentEvents(agent);
    }, 5000); // Process every 5 seconds

    this.processingIntervals.set(agent.id, interval);
  }

  /**
   * Check if an agent should receive an event based on its scope
   */
  private shouldAgentReceiveEvent(agent: BaseAgent, event: any): boolean {
    const scope = agent.scope;
    
    // Check site scope
    if (scope.siteIds && scope.siteIds.length > 0) {
      if (!scope.siteIds.includes(event.siteId)) {
        return false;
      }
    }

    // Check event type scope
    if (scope.eventTypes && scope.eventTypes.length > 0) {
      if (!scope.eventTypes.includes(event.eventType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Process buffered events for an agent
   */
  private async processAgentEvents(agent: BaseAgent): Promise<void> {
    const buffer = this.eventBuffer.get(agent.id) || [];
    if (buffer.length === 0) return;

    // Clear buffer
    this.eventBuffer.set(agent.id, []);

    try {
      // Process events through agent
      for (const event of buffer) {
        await agent.processEvent(event);
        
        this.logAudit({
          agentId: agent.id,
          action: "EVENT_PROCESSED",
          details: { eventId: event.id, eventType: event.eventType },
        });
      }

      // Update last active time
      await db.update(agents)
        .set({ lastActiveAt: new Date() })
        .where(eq(agents.id, agent.id));

    } catch (error) {
      this.logAudit({
        agentId: agent.id,
        action: "ERROR",
        details: { error: error instanceof Error ? error.message : "Unknown error" },
      });

      // Update error count
      const [agentRecord] = await db.select().from(agents).where(eq(agents.id, agent.id));
      if (agentRecord) {
        await db.update(agents)
          .set({ 
            errorCount: (agentRecord.errorCount || 0) + 1,
            lastError: error instanceof Error ? error.message : "Unknown error",
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id));
      }
    }
  }

  /**
   * Create a proposal from an agent
   */
  async createProposal(
    agentId: string,
    proposal: {
      proposalType: string;
      title: string;
      description: string;
      action: Record<string, unknown>;
      reasoning: string;
      confidence: number;
      supportingEventIds?: string[];
      riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      riskFactors?: string[];
      requiredApprovals?: number;
      expiresAt?: Date;
    }
  ): Promise<any> {
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Create hash of proposal content
    const proposalContent = {
      agentId,
      proposalType: proposal.proposalType,
      title: proposal.title,
      action: proposal.action,
      timestamp: new Date().toISOString(),
    };
    const hash = hashObject(proposalContent);

    // Sign the proposal
    const signature = signWithHmac(hash, agent.publicKey);

    // Calculate expiration
    const expiresAt = proposal.expiresAt || 
      new Date(Date.now() + this.config.proposalExpirationHours * 60 * 60 * 1000);

    // Store in database
    const [stored] = await db.insert(agentProposals).values({
      agentId,
      proposalType: proposal.proposalType,
      title: proposal.title,
      description: proposal.description,
      action: proposal.action,
      reasoning: proposal.reasoning,
      confidence: proposal.confidence,
      supportingEventIds: proposal.supportingEventIds || [],
      riskLevel: proposal.riskLevel,
      riskFactors: proposal.riskFactors || [],
      hash,
      signature,
      status: "PENDING_APPROVAL",
      requiredApprovals: proposal.requiredApprovals || 1,
      approvals: [],
      expiresAt,
    }).returning();

    // Log audit entry
    this.logAudit({
      agentId,
      action: "PROPOSAL_CREATED",
      details: { proposalId: stored.id, proposalType: proposal.proposalType },
    });

    // Create event for proposal
    const eventService = getEventService();
    eventService.createEvent({
      eventType: EventType.DEPLOYMENT_INTENT,
      siteId: agent.scope.siteIds?.[0] || "system",
      sourceTimestamp: new Date(),
      originType: OriginType.AGENT,
      originId: agentId,
      payload: {
        intentId: stored.id,
        proposalType: proposal.proposalType,
        title: proposal.title,
        status: "PROPOSED",
        requiredApprovals: proposal.requiredApprovals || 1,
      },
      details: `Agent proposal: ${proposal.title}`,
    });

    this.emit("proposalCreated", stored);
    return stored;
  }

  /**
   * Approve a proposal
   */
  async approveProposal(
    proposalId: string,
    approval: {
      userId: string;
      userName: string;
      comment?: string;
      signature: string;
    }
  ): Promise<any> {
    const [proposal] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    if (proposal.status !== "PENDING_APPROVAL") {
      throw new Error(`Proposal is not pending approval: ${proposal.status}`);
    }

    // Check expiration
    if (proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) {
      await db.update(agentProposals)
        .set({ status: "EXPIRED" })
        .where(eq(agentProposals.id, proposalId));
      throw new Error("Proposal has expired");
    }

    // Add approval
    const approvals = (proposal.approvals as ProposalApproval[]) || [];
    approvals.push({
      userId: approval.userId,
      userName: approval.userName,
      decision: "APPROVE",
      comment: approval.comment,
      signature: approval.signature,
      decidedAt: new Date(),
    });

    // Check if fully approved
    const newStatus = approvals.length >= proposal.requiredApprovals 
      ? "APPROVED" 
      : "PENDING_APPROVAL";

    const [updated] = await db.update(agentProposals)
      .set({ approvals, status: newStatus })
      .where(eq(agentProposals.id, proposalId))
      .returning();

    // Log audit entry
    this.logAudit({
      agentId: proposal.agentId,
      action: "PROPOSAL_APPROVED",
      details: { 
        proposalId, 
        approvedBy: approval.userId,
        fullyApproved: newStatus === "APPROVED",
      },
    });

    this.emit("proposalApproved", { proposal: updated, approval });

    // If fully approved, execute the proposal
    if (newStatus === "APPROVED") {
      await this.executeProposal(proposalId);
    }

    return updated;
  }

  /**
   * Reject a proposal
   */
  async rejectProposal(
    proposalId: string,
    rejection: {
      userId: string;
      userName: string;
      comment?: string;
      signature: string;
    }
  ): Promise<any> {
    const [proposal] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const approvals = (proposal.approvals as ProposalApproval[]) || [];
    approvals.push({
      userId: rejection.userId,
      userName: rejection.userName,
      decision: "REJECT",
      comment: rejection.comment,
      signature: rejection.signature,
      decidedAt: new Date(),
    });

    const [updated] = await db.update(agentProposals)
      .set({ approvals, status: "REJECTED" })
      .where(eq(agentProposals.id, proposalId))
      .returning();

    // Log audit entry
    this.logAudit({
      agentId: proposal.agentId,
      action: "PROPOSAL_REJECTED",
      details: { proposalId, rejectedBy: rejection.userId },
    });

    this.emit("proposalRejected", { proposal: updated, rejection });
    return updated;
  }

  /**
   * Execute an approved proposal
   */
  private async executeProposal(proposalId: string): Promise<void> {
    const [proposal] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposalId));
    
    if (!proposal || proposal.status !== "APPROVED") {
      return;
    }

    try {
      // Execute based on proposal type
      const action = proposal.action as Record<string, unknown>;
      
      // In production, this would dispatch to appropriate handlers
      console.log(`🚀 Executing proposal ${proposalId}:`, action);

      await db.update(agentProposals)
        .set({ 
          executedAt: new Date(),
          executionResult: { success: true },
        })
        .where(eq(agentProposals.id, proposalId));

      this.emit("proposalExecuted", { proposalId, action });

    } catch (error) {
      await db.update(agentProposals)
        .set({ 
          executionError: error instanceof Error ? error.message : "Unknown error",
        })
        .where(eq(agentProposals.id, proposalId));

      this.emit("proposalExecutionFailed", { proposalId, error });
    }
  }

  /**
   * Store an agent output
   */
  async storeOutput(
    agentId: string,
    output: {
      outputType: string;
      title: string;
      content: Record<string, unknown>;
      siteId?: string;
      assetIds?: string[];
      eventIds?: string[];
      confidence?: number;
      reasoning?: string;
      requiresApproval?: boolean;
    }
  ): Promise<any> {
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Create hash and signature
    const hash = hashObject({ agentId, ...output, timestamp: new Date().toISOString() });
    const signature = signWithHmac(hash, agent.publicKey);

    const [stored] = await db.insert(agentOutputs).values({
      agentId,
      outputType: output.outputType,
      title: output.title,
      content: output.content,
      siteId: output.siteId,
      assetIds: output.assetIds || [],
      eventIds: output.eventIds || [],
      hash,
      signature,
      confidence: output.confidence,
      reasoning: output.reasoning,
      requiresApproval: output.requiresApproval || false,
    }).returning();

    // Log audit entry
    this.logAudit({
      agentId,
      action: "OUTPUT_CREATED",
      details: { outputId: stored.id, outputType: output.outputType },
    });

    this.emit("outputCreated", stored);
    return stored;
  }

  /**
   * Get agent state
   */
  async getAgentState(agentId: string): Promise<Record<string, unknown>> {
    const stateEntries = await db.select().from(agentState).where(eq(agentState.agentId, agentId));
    
    const state: Record<string, unknown> = {};
    for (const entry of stateEntries) {
      // Check expiration
      if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
        continue;
      }
      state[entry.key] = entry.value;
    }
    
    return state;
  }

  /**
   * Set agent state
   */
  async setAgentState(agentId: string, key: string, value: unknown, expiresAt?: Date): Promise<void> {
    const existing = await db.select().from(agentState)
      .where(eq(agentState.agentId, agentId));
    
    const existingKey = existing.find(s => s.key === key);
    
    if (existingKey) {
      await db.update(agentState)
        .set({ value, expiresAt, updatedAt: new Date() })
        .where(eq(agentState.id, existingKey.id));
    } else {
      await db.insert(agentState).values({
        agentId,
        key,
        value,
        expiresAt,
      });
    }
  }

  /**
   * Log an audit entry
   */
  private logAudit(entry: Omit<AgentAuditEntry, "id" | "timestamp">): void {
    if (!this.config.auditLogEnabled) return;

    const auditEntry: AgentAuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      ...entry,
    };

    this.auditLog.push(auditEntry);

    // Trim log if too large
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-5000);
    }

    this.emit("auditLog", auditEntry);
  }

  /**
   * Get audit log
   */
  getAuditLog(agentId?: string, limit = 100): AgentAuditEntry[] {
    let log = this.auditLog;
    
    if (agentId) {
      log = log.filter(e => e.agentId === agentId);
    }
    
    return log.slice(-limit);
  }

  /**
   * Get runtime statistics
   */
  getStats(): Record<string, unknown> {
    const allAgents = agentRegistry.getAllAgents();
    
    return {
      totalAgents: allAgents.length,
      activeAgents: allAgents.filter(a => a.running).length,
      auditLogSize: this.auditLog.length,
      eventBuffers: Object.fromEntries(
        Array.from(this.eventBuffer.entries()).map(([id, buffer]) => [id, buffer.length])
      ),
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let runtimeInstance: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime();
  }
  return runtimeInstance;
}

export function initAgentRuntime(config: Partial<AgentRuntimeConfig>): AgentRuntime {
  runtimeInstance = new AgentRuntime(config);
  return runtimeInstance;
}
