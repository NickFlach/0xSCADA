/**
 * 0xSCADA Agent Base Class
 * 
 * PRD Section 6.3: Agent Framework
 * - Agents are explicit platform components
 * - Every agent has scope, permissions, and cryptographic identity
 * - Agents can subscribe to event streams
 * - Agents produce signed outputs
 */

import { 
  computeEventHash, 
  signWithHmac, 
  sha256,
  generateRandomKey,
} from "../crypto";
import type { SignedEvent } from "../events";
import type { Agent, AgentOutput, AgentProposal } from "@shared/schema";

// =============================================================================
// AGENT CAPABILITY TYPES
// =============================================================================

export const AgentCapability = {
  // Read capabilities
  READ_EVENTS: "READ_EVENTS",
  READ_TELEMETRY: "READ_TELEMETRY",
  READ_ALARMS: "READ_ALARMS",
  READ_BLUEPRINTS: "READ_BLUEPRINTS",
  READ_ASSETS: "READ_ASSETS",
  READ_SITES: "READ_SITES",
  
  // Analysis capabilities
  SUMMARIZE: "SUMMARIZE",
  ANALYZE_ANOMALIES: "ANALYZE_ANOMALIES",
  GENERATE_REPORTS: "GENERATE_REPORTS",
  
  // Proposal capabilities
  PROPOSE_COMMANDS: "PROPOSE_COMMANDS",
  PROPOSE_CHANGES: "PROPOSE_CHANGES",
  PROPOSE_DEPLOYMENTS: "PROPOSE_DEPLOYMENTS",
  
  // Generation capabilities
  GENERATE_CODE: "GENERATE_CODE",
  GENERATE_TESTS: "GENERATE_TESTS",
  GENERATE_DOCUMENTATION: "GENERATE_DOCUMENTATION",
  
  // Verification capabilities
  VERIFY_ANCHORS: "VERIFY_ANCHORS",
  VERIFY_SIGNATURES: "VERIFY_SIGNATURES",
  VERIFY_COMPLIANCE: "VERIFY_COMPLIANCE",
} as const;

export type AgentCapability = (typeof AgentCapability)[keyof typeof AgentCapability];

// =============================================================================
// AGENT SCOPE
// =============================================================================

export interface AgentScope {
  allSites: boolean;
  siteIds: string[];
  allAssets: boolean;
  assetIds: string[];
  assetTypes: string[];
  allEventTypes: boolean;
  eventTypes: string[];
  maxHistoryDays?: number;
}

// =============================================================================
// AGENT OUTPUT TYPES
// =============================================================================

export const AgentOutputType = {
  SUMMARY: "SUMMARY",
  REPORT: "REPORT",
  PROPOSAL: "PROPOSAL",
  ANALYSIS: "ANALYSIS",
  CODE: "CODE",
  ALERT: "ALERT",
} as const;

export type AgentOutputType = (typeof AgentOutputType)[keyof typeof AgentOutputType];

// =============================================================================
// AGENT STATE
// =============================================================================

export interface AgentStateEntry {
  key: string;
  value: unknown;
  expiresAt?: Date;
}

// =============================================================================
// BASE AGENT CLASS
// =============================================================================

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  agentType: string;
  capabilities: AgentCapability[];
  scope: AgentScope;
  privateKey: string;
  publicKey: string;
}

export interface AgentOutputInput {
  outputType: AgentOutputType;
  title: string;
  content: unknown;
  siteId?: string;
  assetIds?: string[];
  eventIds?: string[];
  confidence?: number;
  reasoning?: string;
  requiresApproval?: boolean;
}

export interface AgentProposalInput {
  proposalType: string;
  title: string;
  description: string;
  action: unknown;
  reasoning: string;
  confidence: number;
  supportingEventIds: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskFactors: string[];
  requiredApprovals?: number;
  expiresAt?: Date;
}

/**
 * Base Agent Class
 * All agents extend this class
 */
export abstract class BaseAgent {
  protected config: AgentConfig;
  protected state: Map<string, AgentStateEntry> = new Map();
  protected eventSubscriptions: (() => void)[] = [];
  protected isRunning: boolean = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    
    console.log(`🤖 Starting agent: ${this.config.displayName}`);
    this.isRunning = true;
    await this.onStart();
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log(`🛑 Stopping agent: ${this.config.displayName}`);
    
    // Unsubscribe from all events
    for (const unsubscribe of this.eventSubscriptions) {
      unsubscribe();
    }
    this.eventSubscriptions = [];
    
    this.isRunning = false;
    await this.onStop();
  }

  /**
   * Called when agent starts - override in subclass
   */
  protected abstract onStart(): Promise<void>;

  /**
   * Called when agent stops - override in subclass
   */
  protected abstract onStop(): Promise<void>;

  // ==========================================================================
  // CAPABILITIES
  // ==========================================================================

  /**
   * Check if agent has a capability
   */
  hasCapability(capability: AgentCapability): boolean {
    return this.config.capabilities.includes(capability);
  }

  /**
   * Check if agent can access a site
   */
  canAccessSite(siteId: string): boolean {
    if (this.config.scope.allSites) {
      return true;
    }
    return this.config.scope.siteIds.includes(siteId);
  }

  /**
   * Check if agent can access an asset
   */
  canAccessAsset(assetId: string, assetType?: string): boolean {
    if (this.config.scope.allAssets) {
      return true;
    }
    if (this.config.scope.assetIds.includes(assetId)) {
      return true;
    }
    if (assetType && this.config.scope.assetTypes.includes(assetType)) {
      return true;
    }
    return false;
  }

  /**
   * Check if agent can access an event type
   */
  canAccessEventType(eventType: string): boolean {
    if (this.config.scope.allEventTypes) {
      return true;
    }
    return this.config.scope.eventTypes.includes(eventType);
  }

  // ==========================================================================
  // STATE MANAGEMENT (PRD: Scoped memory)
  // ==========================================================================

  /**
   * Get state value
   */
  getState<T>(key: string): T | undefined {
    const entry = this.state.get(key);
    if (!entry) {
      return undefined;
    }
    
    // Check expiration
    if (entry.expiresAt && entry.expiresAt < new Date()) {
      this.state.delete(key);
      return undefined;
    }
    
    return entry.value as T;
  }

  /**
   * Set state value
   */
  setState(key: string, value: unknown, expiresAt?: Date): void {
    this.state.set(key, { key, value, expiresAt });
  }

  /**
   * Delete state value
   */
  deleteState(key: string): void {
    this.state.delete(key);
  }

  /**
   * Clear all state
   */
  clearState(): void {
    this.state.clear();
  }

  // ==========================================================================
  // OUTPUT GENERATION (PRD: Signed outputs)
  // ==========================================================================

  /**
   * Create a signed output
   */
  protected createOutput(input: AgentOutputInput): Omit<AgentOutput, "id" | "createdAt"> {
    const content = {
      outputType: input.outputType,
      title: input.title,
      content: input.content,
      agentId: this.config.id,
      timestamp: new Date().toISOString(),
    };

    const hash = sha256(JSON.stringify(content));
    const signature = signWithHmac(hash, this.config.privateKey);

    return {
      agentId: this.config.id,
      outputType: input.outputType,
      title: input.title,
      content: input.content,
      siteId: input.siteId || null,
      assetIds: input.assetIds || [],
      eventIds: input.eventIds || [],
      hash,
      signature,
      confidence: input.confidence ? Math.round(input.confidence * 100) : null,
      reasoning: input.reasoning || null,
      requiresApproval: input.requiresApproval || false,
      approvalStatus: input.requiresApproval ? "PENDING" : null,
      approvedBy: null,
      approvedAt: null,
    };
  }

  /**
   * Create a proposal (PRD: All proposals require human approval)
   */
  protected createProposal(input: AgentProposalInput): Omit<AgentProposal, "id" | "createdAt"> {
    const proposalContent = {
      proposalType: input.proposalType,
      title: input.title,
      description: input.description,
      action: input.action,
      agentId: this.config.id,
      timestamp: new Date().toISOString(),
    };

    const hash = sha256(JSON.stringify(proposalContent));
    const signature = signWithHmac(hash, this.config.privateKey);

    return {
      agentId: this.config.id,
      proposalType: input.proposalType,
      title: input.title,
      description: input.description,
      action: input.action,
      reasoning: input.reasoning,
      confidence: Math.round(input.confidence * 100),
      supportingEventIds: input.supportingEventIds,
      riskLevel: input.riskLevel,
      riskFactors: input.riskFactors,
      hash,
      signature,
      status: "PENDING_APPROVAL",
      requiredApprovals: input.requiredApprovals || 1,
      approvals: [],
      expiresAt: input.expiresAt || null,
      executedAt: null,
      executionResult: null,
      executionError: null,
    };
  }

  // ==========================================================================
  // EVENT HANDLING
  // ==========================================================================

  /**
   * Handle an incoming event - override in subclass
   */
  abstract handleEvent(event: SignedEvent): Promise<void>;

  /**
   * Process an event with capability and scope checks
   */
  async processEvent(event: SignedEvent): Promise<void> {
    // Check capabilities
    if (!this.hasCapability(AgentCapability.READ_EVENTS)) {
      return;
    }

    // Check scope
    if (!this.canAccessSite(event.siteId)) {
      return;
    }

    if (event.assetId && !this.canAccessAsset(event.assetId)) {
      return;
    }

    if (!this.canAccessEventType(event.eventType)) {
      return;
    }

    // Process the event
    await this.handleEvent(event);
  }

  // ==========================================================================
  // GETTERS
  // ==========================================================================

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  get displayName(): string {
    return this.config.displayName;
  }

  get agentType(): string {
    return this.config.agentType;
  }

  get capabilities(): AgentCapability[] {
    return this.config.capabilities;
  }

  get scope(): AgentScope {
    return this.config.scope;
  }

  get publicKey(): string {
    return this.config.publicKey;
  }

  get running(): boolean {
    return this.isRunning;
  }
}

// =============================================================================
// AGENT FACTORY
// =============================================================================

export function generateAgentKeys(): { publicKey: string; privateKey: string } {
  const privateKey = generateRandomKey();
  const publicKey = sha256(privateKey); // Simplified - in production use proper key derivation
  return { publicKey, privateKey };
}
