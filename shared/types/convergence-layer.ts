/**
 * 0xSCADA OT/IT Convergence Layer Types
 * 
 * ADR-0011: OT/IT Convergence Standards for Agentic Systems
 * 
 * Defines the formal boundaries, translation services, and protocol
 * standards for agents operating across OT and IT domains.
 * 
 * Critical rule: No IT-domain agent may directly address OT-domain
 * devices. All cross-domain communication flows through the
 * Convergence Layer.
 */

import { z } from "zod";

// =============================================================================
// DOMAIN DEFINITIONS
// =============================================================================

export const Domain = {
  OT: "OT",
  IT: "IT",
  CONVERGENCE: "CONVERGENCE",
} as const;

export type Domain = (typeof Domain)[keyof typeof Domain];

// =============================================================================
// AGENT DOMAIN AUTHORIZATION
// =============================================================================

export const AgentDomainType = {
  IT_ONLY: "IT_ONLY",
  CONVERGENCE: "CONVERGENCE",
  OT_SUPERVISED: "OT_SUPERVISED",
  OT_NATIVE: "OT_NATIVE",
} as const;

export type AgentDomainType = (typeof AgentDomainType)[keyof typeof AgentDomainType];

export const AGENT_DOMAIN_ACCESS: Record<AgentDomainType, {
  otAccess: "none" | "read_via_gateway" | "read_write_bounded" | "direct";
  convergenceAccess: "read_via_gateway" | "full" | "publish_only";
  itAccess: "none" | "full";
  description: string;
  examples: string[];
}> = {
  [AgentDomainType.IT_ONLY]: {
    otAccess: "none",
    convergenceAccess: "read_via_gateway",
    itAccess: "full",
    description: "No OT access. Read from convergence gateway. Full IT access.",
    examples: ["Dashboard", "Analytics", "Reporting"],
  },
  [AgentDomainType.CONVERGENCE]: {
    otAccess: "read_via_gateway",
    convergenceAccess: "full",
    itAccess: "full",
    description: "Read OT via gateway. Full convergence and IT access.",
    examples: ["Ops Agent", "Compliance Agent"],
  },
  [AgentDomainType.OT_SUPERVISED]: {
    otAccess: "read_write_bounded",
    convergenceAccess: "full",
    itAccess: "full",
    description: "Bounded read/write to OT. Full convergence and IT access.",
    examples: ["ChangeControl Agent (AC-3)"],
  },
  [AgentDomainType.OT_NATIVE]: {
    otAccess: "direct",
    convergenceAccess: "publish_only",
    itAccess: "none",
    description: "Direct OT access (embedded). Publish-only to convergence. No IT access.",
    examples: ["Safety PLC logic", "Embedded controllers"],
  },
};

// =============================================================================
// PROTOCOL STANDARDS
// =============================================================================

export const ProtocolType = {
  OPCUA: "OPCUA",
  MQTT: "MQTT",
  GRPC: "GRPC",
  JSON_RPC: "JSON_RPC",
  MODBUS_TCP: "MODBUS_TCP",
} as const;

export type ProtocolType = (typeof ProtocolType)[keyof typeof ProtocolType];

export const PROTOCOL_STANDARDS: Record<ProtocolType, {
  domain: string;
  useCase: string;
  agentInteraction: string;
}> = {
  [ProtocolType.OPCUA]: {
    domain: "OT ↔ Convergence",
    useCase: "Primary industrial protocol",
    agentInteraction: "Agents subscribe via gateway",
  },
  [ProtocolType.MQTT]: {
    domain: "Convergence ↔ IT",
    useCase: "Event streaming, telemetry",
    agentInteraction: "Agents publish/subscribe topics",
  },
  [ProtocolType.GRPC]: {
    domain: "IT ↔ IT",
    useCase: "Agent-to-agent communication",
    agentInteraction: "Direct with mTLS (ADR-0008)",
  },
  [ProtocolType.JSON_RPC]: {
    domain: "Convergence",
    useCase: "Blockchain interaction",
    agentInteraction: "Batch anchoring, governance",
  },
  [ProtocolType.MODBUS_TCP]: {
    domain: "OT (legacy)",
    useCase: "Legacy device access",
    agentInteraction: "Gateway translation only",
  },
};

// =============================================================================
// DATA TRANSLATION
// =============================================================================

export const TranslationType = {
  TAG_TO_EVENT: "TAG_TO_EVENT",
  COMMAND_TO_SETPOINT: "COMMAND_TO_SETPOINT",
  ALARM_TO_ALERT: "ALARM_TO_ALERT",
  REGISTER_TO_JSON: "REGISTER_TO_JSON",
} as const;

export type TranslationType = (typeof TranslationType)[keyof typeof TranslationType];

export const translationAuditEntrySchema = z.object({
  /** Unique translation ID */
  id: z.string().uuid(),

  /** Source domain */
  sourceDomain: z.enum(["OT", "IT", "CONVERGENCE"]),

  /** Target domain */
  targetDomain: z.enum(["OT", "IT", "CONVERGENCE"]),

  /** Agent that initiated the translation */
  agentId: z.string(),

  /** Translation type */
  translationType: z.enum([
    "TAG_TO_EVENT",
    "COMMAND_TO_SETPOINT",
    "ALARM_TO_ALERT",
    "REGISTER_TO_JSON",
  ]),

  /** Hash of the input data */
  inputHash: z.string(),

  /** Hash of the output data */
  outputHash: z.string(),

  /** Boundary check result */
  boundaryCheck: z.enum(["PASS", "FAIL", "ESCALATE"]),

  /** Boundary check failure reason (if applicable) */
  boundaryCheckReason: z.string().optional(),

  /** OT-precision timestamp (PTP, <1ms) */
  otTimestamp: z.string().datetime().optional(),

  /** IT-precision timestamp (NTP, <100ms) */
  itTimestamp: z.string().datetime(),

  /** Protocol used */
  protocol: z.enum(["OPCUA", "MQTT", "GRPC", "JSON_RPC", "MODBUS_TCP"]).optional(),
});

export type TranslationAuditEntry = z.infer<typeof translationAuditEntrySchema>;

// =============================================================================
// CONVERGENCE LAYER HEALTH
// =============================================================================

export const ConvergenceHealthStatus = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  OT_DISCONNECTED: "OT_DISCONNECTED",
  IT_DISCONNECTED: "IT_DISCONNECTED",
  OFFLINE: "OFFLINE",
} as const;

export type ConvergenceHealthStatus = (typeof ConvergenceHealthStatus)[keyof typeof ConvergenceHealthStatus];

export const convergenceHealthSchema = z.object({
  /** Overall status */
  status: z.enum(["HEALTHY", "DEGRADED", "OT_DISCONNECTED", "IT_DISCONNECTED", "OFFLINE"]),

  /** OT gateway connection status */
  otGateway: z.object({
    connected: z.boolean(),
    protocol: z.enum(["OPCUA", "MODBUS_TCP"]).optional(),
    lastHeartbeat: z.string().datetime().optional(),
    latencyMs: z.number().optional(),
  }),

  /** IT services connection status */
  itServices: z.object({
    connected: z.boolean(),
    lastHeartbeat: z.string().datetime().optional(),
    latencyMs: z.number().optional(),
  }),

  /** Blockchain/governance connection */
  governance: z.object({
    connected: z.boolean(),
    chainId: z.string().optional(),
    lastBlock: z.number().optional(),
  }),

  /** Translation buffer status */
  translationBuffer: z.object({
    pendingTranslations: z.number().int().nonnegative(),
    bufferedDuringOutage: z.number().int().nonnegative(),
  }),

  /** Time sync status */
  timeSync: z.object({
    ptpAvailable: z.boolean(),
    ntpAvailable: z.boolean(),
    maxDriftMs: z.number().optional(),
  }),

  /** Last updated */
  updatedAt: z.string().datetime(),
});

export type ConvergenceHealth = z.infer<typeof convergenceHealthSchema>;

// =============================================================================
// FAILURE ISOLATION RULES
// =============================================================================

export const FAILURE_ISOLATION_RULES = {
  /** If IT domain fails, OT continues operating independently */
  IT_FAILURE: {
    otImpact: "NONE — OT control loops run locally on PLCs",
    convergenceImpact: "Buffers events during IT outage",
    agentImpact: "Agents enter M3: SAFE_HOLD if they lose Convergence Layer connectivity",
    critical: "No IT failure can propagate to OT safety functions",
  },
  /** If OT gateway fails, IT services lose telemetry but remain functional */
  OT_GATEWAY_FAILURE: {
    otImpact: "NONE — OT runs independently of gateway",
    convergenceImpact: "No new telemetry data flows to IT",
    agentImpact: "Agents operate on cached data; confidence scores drop over time",
    critical: "OT safety systems are never dependent on gateway",
  },
  /** If blockchain/governance fails, existing permissions continue */
  GOVERNANCE_FAILURE: {
    otImpact: "NONE",
    convergenceImpact: "Events buffered for later anchoring",
    agentImpact: "Agents cannot get new capability tokens; existing tokens continue until expiry",
    critical: "Capability token TTLs provide graceful degradation",
  },
} as const;
