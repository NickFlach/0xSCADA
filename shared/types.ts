/**
 * 0xSCADA Shared Types
 * 
 * VERITY Architecture - Agentic-QE Types
 * 
 * Agent decision record schemas and types for the Agentic-QE fork.
 */

import { z } from "zod";
import { contentHashSchema, type ContentHash } from "./artifact";

// Re-export ContentHash for convenience
export type { ContentHash } from "./artifact";

// =============================================================================
// AGENT METADATA
// =============================================================================

export const agentMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  version: z.string(),
});

export type AgentMetadata = z.infer<typeof agentMetadataSchema>;

// =============================================================================
// DECISION INPUTS
// =============================================================================

export const decisionInputsSchema = z.object({
  /** Artifact hashes that served as inputs */
  artifacts: z.array(contentHashSchema),
  
  /** Hash of the context/world model used */
  context: contentHashSchema,
  
  /** Hash of the constraints/rules applied */
  constraints: contentHashSchema,
});

export type DecisionInputs = z.infer<typeof decisionInputsSchema>;

// =============================================================================
// DECISION REASONING
// =============================================================================

export const decisionReasoningSchema = z.object({
  /** Hash of the chain-of-thought stored as artifact */
  chainOfThought: contentHashSchema,
  
  /** Model identifier used */
  model: z.string(),
  
  /** Temperature setting */
  temperature: z.number().min(0).max(2),
  
  /** Token count used */
  tokens: z.number().int().positive(),
  
  /** Optional: hash of the system prompt used */
  systemPromptHash: contentHashSchema.optional(),
});

export type DecisionReasoning = z.infer<typeof decisionReasoningSchema>;

// =============================================================================
// ACTION
// =============================================================================

export const actionSchema = z.object({
  /** Action type */
  type: z.enum([
    "command",
    "setpoint_change",
    "mode_change",
    "alarm_ack",
    "recommendation",
    "alert",
    "report",
    "deployment",
    "other",
  ]),
  
  /** Action target (asset ID, site ID, etc.) */
  target: z.string().optional(),
  
  /** Action payload */
  payload: z.record(z.unknown()).optional(),
  
  /** Whether this action requires human approval */
  requiresApproval: z.boolean().default(true),
  
  /** Priority level */
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export type Action = z.infer<typeof actionSchema>;

// =============================================================================
// DECISION OUTPUT
// =============================================================================

export const decisionOutputSchema = z.object({
  /** Human-readable decision statement */
  decision: z.string(),
  
  /** Optional action to take */
  action: actionSchema.optional(),
  
  /** Confidence level (0-1) */
  confidence: z.number().min(0).max(1),
});

export type DecisionOutput = z.infer<typeof decisionOutputSchema>;

// =============================================================================
// CHECK RESULT
// =============================================================================

export const checkResultSchema = z.object({
  /** Name of the check */
  name: z.string(),
  
  /** Category */
  category: z.enum([
    "safety",
    "compliance",
    "consistency",
    "boundary",
    "dependency",
    "policy",
  ]),
  
  /** Result status */
  status: z.enum(["pass", "warn", "fail", "skip", "error"]),
  
  /** Human-readable message */
  message: z.string(),
  
  /** When the check was run */
  checkedAt: z.string().datetime(),
  
  /** Additional details */
  details: z.record(z.unknown()).optional(),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

// =============================================================================
// DECISION VERIFICATION
// =============================================================================

export const decisionVerificationSchema = z.object({
  /** Whether a human approved this decision */
  humanApproved: z.boolean().optional(),
  
  /** Human approver ID */
  humanApproverId: z.string().optional(),
  
  /** Approval timestamp */
  approvedAt: z.string().datetime().optional(),
  
  /** Results of automated checks */
  automatedChecks: z.array(checkResultSchema),
  
  /** Overall safety score (0-1) */
  safetyScore: z.number().min(0).max(1),
});

export type DecisionVerification = z.infer<typeof decisionVerificationSchema>;

// =============================================================================
// CRYPTO SIGNATURE (for decisions)
// =============================================================================

export const decisionSignatureSchema = z.object({
  /** Signature algorithm */
  algorithm: z.enum(["hmac-sha256", "ed25519", "secp256k1"]),
  
  /** Key identifier */
  keyId: z.string(),
  
  /** Signature value (hex) */
  value: z.string(),
  
  /** When signed */
  signedAt: z.string().datetime(),
});

export type DecisionSignature = z.infer<typeof decisionSignatureSchema>;

// =============================================================================
// AGENT DECISION (Complete record)
// =============================================================================

export const agentDecisionSchema = z.object({
  /** Content-addressed ID */
  id: contentHashSchema,
  
  /** Schema version */
  schemaVersion: z.string().default("1.0.0"),
  
  /** When the decision was made */
  timestamp: z.string().datetime(),
  
  /** Agent that made the decision */
  agent: agentMetadataSchema,
  
  /** Site context */
  siteId: z.string().optional(),
  
  /** Asset context */
  assetIds: z.array(z.string()).optional(),
  
  /** Inputs to the decision */
  inputs: decisionInputsSchema,
  
  /** Reasoning process */
  reasoning: decisionReasoningSchema,
  
  /** Output/result */
  output: decisionOutputSchema,
  
  /** Verification results */
  verification: decisionVerificationSchema,
  
  /** Cryptographic signature */
  signature: decisionSignatureSchema.optional(),
  
  /** Link to previous decision in chain */
  previousDecisionId: contentHashSchema.optional(),
  
  /** Link to twin checkpoint this decision was made against */
  twinCheckpointHash: contentHashSchema.optional(),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

// =============================================================================
// CREATE AGENT DECISION INPUT
// =============================================================================

export const createAgentDecisionInputSchema = z.object({
  agent: agentMetadataSchema,
  siteId: z.string().optional(),
  assetIds: z.array(z.string()).optional(),
  inputs: decisionInputsSchema,
  reasoning: decisionReasoningSchema,
  output: decisionOutputSchema,
  verification: decisionVerificationSchema.optional(),
  previousDecisionId: contentHashSchema.optional(),
  twinCheckpointHash: contentHashSchema.optional(),
});

export type CreateAgentDecisionInput = z.infer<typeof createAgentDecisionInputSchema>;

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

export function validateAgentDecision(decision: unknown): {
  valid: boolean;
  errors?: string[];
  decision?: AgentDecision;
} {
  try {
    const validated = agentDecisionSchema.parse(decision);
    return { valid: true, decision: validated };
  } catch (error: any) {
    if (error.errors) {
      return {
        valid: false,
        errors: error.errors.map((e: any) => `${e.path.join(".")}: ${e.message}`),
      };
    }
    return { valid: false, errors: [error.message] };
  }
}
