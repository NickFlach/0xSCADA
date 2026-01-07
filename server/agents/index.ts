/**
 * 0xSCADA Agent Framework
 * 
 * PRD Section 6.3 & 6.4: Agent Framework and Required Agents
 */

export * from "./base";
export * from "./ops-agent";
export * from "./change-control-agent";
export * from "./compliance-agent";

import { OpsAgent } from "./ops-agent";
import { ChangeControlAgent } from "./change-control-agent";
import { ComplianceAgent } from "./compliance-agent";
import { BaseAgent, generateAgentKeys } from "./base";
import { getEventService } from "../events";
import { db } from "../db";
import { agents } from "@shared/schema";
import { eq } from "drizzle-orm";

// =============================================================================
// AGENT REGISTRY
// =============================================================================

class AgentRegistry {
  private agents: Map<string, BaseAgent> = new Map();
  private eventUnsubscribers: Map<string, () => void> = new Map();

  /**
   * Register an agent
   */
  register(agent: BaseAgent): void {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent with ID ${agent.id} already registered`);
    }

    this.agents.set(agent.id, agent);
    console.log(`📝 Agent registered: ${agent.displayName} (${agent.id})`);
  }

  /**
   * Unregister an agent
   */
  async unregister(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    // Stop the agent
    await agent.stop();

    // Unsubscribe from events
    const unsubscribe = this.eventUnsubscribers.get(agentId);
    if (unsubscribe) {
      unsubscribe();
      this.eventUnsubscribers.delete(agentId);
    }

    this.agents.delete(agentId);
    console.log(`🗑️ Agent unregistered: ${agent.displayName}`);
  }

  /**
   * Start an agent and subscribe to events
   */
  async startAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    await agent.start();

    // Subscribe to event service
    const eventService = getEventService();
    const unsubscribe = eventService.onEvent(async (event) => {
      try {
        await agent.processEvent(event);
      } catch (error) {
        console.error(`Agent ${agentId} error processing event:`, error);
      }
    });

    this.eventUnsubscribers.set(agentId, unsubscribe);
  }

  /**
   * Stop an agent
   */
  async stopAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    await agent.stop();

    const unsubscribe = this.eventUnsubscribers.get(agentId);
    if (unsubscribe) {
      unsubscribe();
      this.eventUnsubscribers.delete(agentId);
    }
  }

  /**
   * Get an agent by ID
   */
  getAgent<T extends BaseAgent>(agentId: string): T | undefined {
    return this.agents.get(agentId) as T | undefined;
  }

  /**
   * Get all agents
   */
  getAllAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by type
   */
  getAgentsByType(agentType: string): BaseAgent[] {
    return Array.from(this.agents.values()).filter(a => a.agentType === agentType);
  }

  /**
   * Start all registered agents
   */
  async startAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await this.startAgent(agent.id);
    }
  }

  /**
   * Stop all registered agents
   */
  async stopAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await this.stopAgent(agent.id);
    }
  }
}

// Singleton instance
export const agentRegistry = new AgentRegistry();

// =============================================================================
// DEFAULT AGENT INITIALIZATION
// =============================================================================

/**
 * Persist an agent to the database (upsert)
 */
async function persistAgentToDb(agent: BaseAgent): Promise<void> {
  const existing = await db.select().from(agents).where(eq(agents.id, agent.id));
  
  if (existing.length === 0) {
    await db.insert(agents).values({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: `${agent.displayName} - Autonomous monitoring agent`,
      agentType: agent.agentType,
      publicKey: agent.publicKey,
      keyAlgorithm: "ed25519",
      ethereumAddress: null,
      capabilities: agent.capabilities,
      scope: agent.scope,
      status: "ACTIVE",
      version: "1.0.0",
      createdBy: "SYSTEM",
    });
  } else {
    await db.update(agents)
      .set({ 
        status: "ACTIVE",
        updatedAt: new Date()
      })
      .where(eq(agents.id, agent.id));
  }
}

/**
 * Initialize the default P0 agents (PRD Section 6.4)
 */
export async function initializeDefaultAgents(): Promise<{
  opsAgent: OpsAgent;
  changeControlAgent: ChangeControlAgent;
  complianceAgent: ComplianceAgent;
}> {
  // Create Ops Agent
  const opsAgent = new OpsAgent({
    id: "ops-agent-default",
    name: "ops-agent",
    displayName: "Ops Agent",
  });
  agentRegistry.register(opsAgent);
  await persistAgentToDb(opsAgent);

  // Create Change-Control Agent
  const changeControlAgent = new ChangeControlAgent({
    id: "change-control-agent-default",
    name: "change-control-agent",
    displayName: "Change-Control Agent",
  });
  agentRegistry.register(changeControlAgent);
  await persistAgentToDb(changeControlAgent);

  // Create Compliance Agent
  const complianceAgent = new ComplianceAgent({
    id: "compliance-agent-default",
    name: "compliance-agent",
    displayName: "Compliance Agent",
  });
  agentRegistry.register(complianceAgent);
  await persistAgentToDb(complianceAgent);

  console.log("🤖 Default agents initialized");

  return { opsAgent, changeControlAgent, complianceAgent };
}

/**
 * Start all default agents
 */
export async function startDefaultAgents(): Promise<void> {
  await agentRegistry.startAll();
  console.log("🚀 All agents started");
}

/**
 * Stop all agents
 */
export async function stopAllAgents(): Promise<void> {
  await agentRegistry.stopAll();
  console.log("🛑 All agents stopped");
}
