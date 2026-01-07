/**
 * 0xSCADA Agent Framework Types
 * 
 * PRD Section 6.3: Agents are explicit platform components, not features.
 * PRD Section 4.2: Non-Human Users (Agents) are explicitly modeled users.
 */

import { z } from "zod";

// =============================================================================
// AGENT TYPES (PRD Section 6.4)
// =============================================================================

export const AgentType = {
  OPS: "OPS",                     // Summarizes plant state, shift handoffs
  CHANGE_CONTROL: "CHANGE_CONTROL", // Blueprint changes, codegen, change packages
  COMPLIANCE: "COMPLIANCE",       // Audit evidence, anchor verification
  SAFETY_OBSERVER: "SAFETY_OBSERVER", // Safety monitoring (future)
  CODEGEN: "CODEGEN",             // Code generation specialist
  CUSTOM: "CUSTOM",               // User-defined agents
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

// =============================================================================
// AGENT STATUS
// =============================================================================

export const AgentStatus = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  SUSPENDED: "SUSPENDED",
  ERROR: "ERROR",
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

// =============================================================================
// AGENT CAPABILITIES (What an agent can do)
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
  
  // Proposal capabilities (PRD: propose-only for changes)
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
// AGENT SCOPE (What an agent can access)
// =============================================================================

export const agentScopeSchema = z.object({
  // Site access
  allSites: z.boolean().default(false),
  siteIds: z.array(z.string()).default([]),
  
  // Asset access
  allAssets: z.boolean().default(false),
  assetIds: z.array(z.string()).default([]),
  assetTypes: z.array(z.string()).default([]),
  
  // Event type access
  allEventTypes: z.boolean().default(false),
  eventTypes: z.array(z.string()).default([]),
  
  // Time window (optional)
  maxHistoryDays: z.number().optional(),
});

export type AgentScope = z.infer<typeof agentScopeSchema>;

// =============================================================================
// AGENT IDENTITY (PRD: cryptographic identity)
// =============================================================================

export const agentIdentitySchema = z.object({
  // Unique identifier
  id: z.string().uuid(),
  
  // Human-readable
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  
  // Type and status
  agentType: z.nativeEnum(AgentType),
  status: z.nativeEnum(AgentStatus),
  
  // Cryptographic identity
  publicKey: z.string(), // Ed25519 or secp256k1 public key
  keyAlgorithm: z.enum(["ed25519", "secp256k1"]),
  
  // Ethereum identity (optional, for on-chain actions)
  ethereumAddress: z.string().optional(),
  
  // Capabilities and scope
  capabilities: z.array(z.nativeEnum(AgentCapability)),
  scope: agentScopeSchema,
  
  // Metadata
  version: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string(), // User ID who created this agent
  
  // Runtime info
  lastActiveAt: z.string().datetime().optional(),
  errorCount: z.number().default(0),
  lastError: z.string().optional(),
});

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

// =============================================================================
// AGENT STATE (Scoped memory - PRD Section 6.3)
// =============================================================================

export const agentStateSchema = z.object({
  agentId: z.string().uuid(),
  
  // Key-value state storage
  key: z.string(),
  value: z.unknown(),
  
  // Metadata
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type AgentState = z.infer<typeof agentStateSchema>;

// =============================================================================
// AGENT SUBSCRIPTION (Event stream subscriptions)
// =============================================================================

export const agentSubscriptionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  
  // What to subscribe to
  eventTypes: z.array(z.string()),
  siteIds: z.array(z.string()).optional(),
  assetIds: z.array(z.string()).optional(),
  
  // Filters
  filters: z.record(z.unknown()).optional(),
  
  // Delivery
  deliveryMode: z.enum(["PUSH", "POLL"]),
  webhookUrl: z.string().url().optional(),
  
  // Status
  active: z.boolean().default(true),
  createdAt: z.string().datetime(),
});

export type AgentSubscription = z.infer<typeof agentSubscriptionSchema>;

// =============================================================================
// AGENT OUTPUT (Signed outputs - PRD Section 6.3)
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

export const agentOutputSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  
  // Output type and content
  outputType: z.nativeEnum(AgentOutputType),
  title: z.string(),
  content: z.unknown(), // Type depends on outputType
  
  // Context
  siteId: z.string().optional(),
  assetIds: z.array(z.string()).optional(),
  eventIds: z.array(z.string()).optional(), // Events that triggered this output
  
  // Cryptographic (PRD: signed outputs)
  hash: z.string(),
  signature: z.string(),
  
  // Metadata
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
  createdAt: z.string().datetime(),
  
  // For proposals
  requiresApproval: z.boolean().default(false),
  approvalStatus: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
});

export type AgentOutput = z.infer<typeof agentOutputSchema>;

// =============================================================================
// AGENT PROPOSAL (PRD: All proposals require human approval)
// =============================================================================

export const proposalStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "EXECUTED",
  "FAILED",
]);

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const agentProposalSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string(),
  
  // What is being proposed
  proposalType: z.enum([
    "COMMAND",
    "SETPOINT_CHANGE",
    "MODE_CHANGE",
    "BLUEPRINT_CHANGE",
    "DEPLOYMENT",
    "MAINTENANCE",
    "CONFIGURATION",
  ]),
  
  title: z.string(),
  description: z.string(),
  
  // The proposed action
  action: z.unknown(),
  
  // Context and reasoning
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  supportingEventIds: z.array(z.string()),
  
  // Risk assessment
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  riskFactors: z.array(z.string()),
  
  // Cryptographic
  hash: z.string(),
  signature: z.string(),
  
  // Approval workflow
  status: proposalStatusSchema,
  requiredApprovals: z.number().default(1),
  approvals: z.array(z.object({
    userId: z.string(),
    userName: z.string(),
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: z.string().optional(),
    signature: z.string(),
    decidedAt: z.string().datetime(),
  })),
  
  // Timing
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  executedAt: z.string().datetime().optional(),
  
  // Result
  executionResult: z.unknown().optional(),
  executionError: z.string().optional(),
});

export type AgentProposal = z.infer<typeof agentProposalSchema>;

// =============================================================================
// PREDEFINED AGENT CONFIGURATIONS (PRD Section 6.4)
// =============================================================================

export const OPS_AGENT_CONFIG: Partial<AgentIdentity> = {
  agentType: AgentType.OPS,
  capabilities: [
    AgentCapability.READ_EVENTS,
    AgentCapability.READ_TELEMETRY,
    AgentCapability.READ_ALARMS,
    AgentCapability.READ_ASSETS,
    AgentCapability.READ_SITES,
    AgentCapability.SUMMARIZE,
    AgentCapability.ANALYZE_ANOMALIES,
    AgentCapability.GENERATE_REPORTS,
  ],
};

export const CHANGE_CONTROL_AGENT_CONFIG: Partial<AgentIdentity> = {
  agentType: AgentType.CHANGE_CONTROL,
  capabilities: [
    AgentCapability.READ_BLUEPRINTS,
    AgentCapability.READ_EVENTS,
    AgentCapability.GENERATE_CODE,
    AgentCapability.GENERATE_TESTS,
    AgentCapability.PROPOSE_CHANGES,
    AgentCapability.PROPOSE_DEPLOYMENTS,
  ],
};

export const COMPLIANCE_AGENT_CONFIG: Partial<AgentIdentity> = {
  agentType: AgentType.COMPLIANCE,
  capabilities: [
    AgentCapability.READ_EVENTS,
    AgentCapability.READ_ASSETS,
    AgentCapability.READ_SITES,
    AgentCapability.VERIFY_ANCHORS,
    AgentCapability.VERIFY_SIGNATURES,
    AgentCapability.VERIFY_COMPLIANCE,
    AgentCapability.GENERATE_REPORTS,
  ],
};
