/**
 * 0xSCADA Agent Decision Record Integration
 * 
 * VERITY Architecture - Integration with BaseAgent
 * 
 * This module provides the bridge between the existing agent framework
 * and the new decision record storage system.
 */

import { sha256, signWithHmac } from "../crypto";
import type { BaseAgent, AgentConfig } from "./base";
import type {
  AgentDecision,
  CreateAgentDecisionInput,
  DecisionInputs,
  DecisionReasoning,
  DecisionOutput,
  DecisionVerification,
  Action,
  CheckResult,
  ContentHash,
} from "@shared/types";
import { 
  validateAgentDecision,
  agentDecisionSchema,
  decisionInputsSchema,
  decisionReasoningSchema,
  decisionOutputSchema,
  decisionVerificationSchema,
} from "@shared/types";

// =============================================================================
// DECISION BUILDER
// =============================================================================

/**
 * Builder for creating AgentDecision records
 * 
 * Usage:
 * ```typescript
 * const decision = new DecisionBuilder(agent)
 *   .withInputs({ artifacts: [...], context: '...', constraints: '...' })
 *   .withReasoning({ chainOfThought: '...', model: 'gpt-4', ... })
 *   .withOutput({ decision: '...', confidence: 0.85 })
 *   .withVerification({ automatedChecks: [...], safetyScore: 0.9 })
 *   .build();
 * ```
 */
export class DecisionBuilder {
  private agentConfig: AgentConfig;
  private siteId?: string;
  private assetIds?: string[];
  private inputs?: DecisionInputs;
  private reasoning?: DecisionReasoning;
  private output?: DecisionOutput;
  private verification?: DecisionVerification;
  private previousDecisionId?: ContentHash;
  private twinCheckpointHash?: ContentHash;

  constructor(agentConfig: AgentConfig) {
    this.agentConfig = agentConfig;
  }

  /**
   * Set site context
   */
  forSite(siteId: string): this {
    this.siteId = siteId;
    return this;
  }

  /**
   * Set asset context
   */
  forAssets(assetIds: string[]): this {
    this.assetIds = assetIds;
    return this;
  }

  /**
   * Set decision inputs
   */
  withInputs(inputs: DecisionInputs): this {
    this.inputs = inputs;
    return this;
  }

  /**
   * Set decision reasoning
   */
  withReasoning(reasoning: DecisionReasoning): this {
    this.reasoning = reasoning;
    return this;
  }

  /**
   * Set decision output
   */
  withOutput(output: DecisionOutput): this {
    this.output = output;
    return this;
  }

  /**
   * Set verification results
   */
  withVerification(verification: DecisionVerification): this {
    this.verification = verification;
    return this;
  }

  /**
   * Link to previous decision
   */
  chainFrom(previousDecisionId: ContentHash): this {
    this.previousDecisionId = previousDecisionId;
    return this;
  }

  /**
   * Link to twin checkpoint
   */
  atTwinCheckpoint(twinCheckpointHash: ContentHash): this {
    this.twinCheckpointHash = twinCheckpointHash;
    return this;
  }

  /**
   * Build the complete decision record
   */
  build(): CreateAgentDecisionInput {
    if (!this.inputs) {
      throw new Error("Decision inputs are required");
    }
    if (!this.reasoning) {
      throw new Error("Decision reasoning is required");
    }
    if (!this.output) {
      throw new Error("Decision output is required");
    }

    return {
      agent: {
        id: this.agentConfig.id,
        name: this.agentConfig.name,
        type: this.agentConfig.agentType,
        version: "1.0.0", // TODO: Get from agent config
      },
      siteId: this.siteId,
      assetIds: this.assetIds,
      inputs: this.inputs,
      reasoning: this.reasoning,
      output: this.output,
      verification: this.verification,
    };
  }
}

// =============================================================================
// DECISION HASH COMPUTATION
// =============================================================================

/**
 * Recursively sort object keys for deterministic JSON serialization
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute the content hash for a decision
 * This makes the decision content-addressable
 */
export function computeDecisionHash(input: CreateAgentDecisionInput): ContentHash {
  // Create a canonical representation for hashing
  const canonical = {
    agent: input.agent,
    siteId: input.siteId,
    assetIds: input.assetIds,
    inputs: input.inputs,
    reasoning: {
      chainOfThought: input.reasoning.chainOfThought,
      model: input.reasoning.model,
      temperature: input.reasoning.temperature,
      tokens: input.reasoning.tokens,
    },
    output: {
      decision: input.output.decision,
      action: input.output.action,
      confidence: input.output.confidence,
    },
    verification: input.verification,
  };

  // Sort keys recursively for deterministic serialization
  const sorted = sortObjectKeys(canonical);
  const json = JSON.stringify(sorted);
  return sha256(json) as ContentHash;
}

/**
 * Finalize a decision with ID, timestamp, and signature
 */
export function finalizeDecision(
  input: CreateAgentDecisionInput,
  privateKey: string
): AgentDecision {
  const timestamp = new Date().toISOString();
  const id = computeDecisionHash(input);

  // Create signature
  const signatureContent = JSON.stringify({ id, timestamp, agent: input.agent });
  const signatureValue = signWithHmac(signatureContent, privateKey);

  const decision: AgentDecision = {
    id,
    schemaVersion: "1.0.0",
    timestamp,
    agent: input.agent,
    siteId: input.siteId,
    assetIds: input.assetIds,
    inputs: input.inputs,
    reasoning: input.reasoning,
    output: input.output,
    verification: input.verification || {
      automatedChecks: [],
      safetyScore: 0,
    },
    signature: {
      algorithm: "hmac-sha256",
      keyId: input.agent.id,
      value: signatureValue,
      signedAt: timestamp,
    },
  };

  return decision;
}

// =============================================================================
// AUTOMATED CHECKS
// =============================================================================

/**
 * Standard automated checks for decisions
 */
export type AutomatedCheck = (decision: CreateAgentDecisionInput) => CheckResult;

/**
 * Check that all input artifacts exist
 */
export function checkInputArtifactsExist(
  artifactExistsFn: (hash: ContentHash) => boolean
): AutomatedCheck {
  return (decision) => {
    const missingArtifacts = decision.inputs.artifacts.filter(
      (hash) => !artifactExistsFn(hash)
    );

    return {
      name: "input_artifacts_exist",
      category: "dependency",
      status: missingArtifacts.length === 0 ? "pass" : "fail",
      message:
        missingArtifacts.length === 0
          ? "All input artifacts exist"
          : `Missing artifacts: ${missingArtifacts.join(", ")}`,
      checkedAt: new Date().toISOString(),
      details: { missingArtifacts },
    };
  };
}

/**
 * Check confidence threshold
 */
export function checkConfidenceThreshold(minConfidence: number): AutomatedCheck {
  return (decision) => ({
    name: "confidence_threshold",
    category: "policy",
    status: decision.output.confidence >= minConfidence ? "pass" : "warn",
    message:
      decision.output.confidence >= minConfidence
        ? `Confidence ${decision.output.confidence} meets threshold ${minConfidence}`
        : `Confidence ${decision.output.confidence} below threshold ${minConfidence}`,
    checkedAt: new Date().toISOString(),
    details: { confidence: decision.output.confidence, threshold: minConfidence },
  });
}

/**
 * Check action requires approval for high-risk operations
 */
export function checkHighRiskApproval(): AutomatedCheck {
  return (decision) => {
    const action = decision.output.action;
    if (!action) {
      return {
        name: "high_risk_approval",
        category: "safety",
        status: "skip",
        message: "No action to check",
        checkedAt: new Date().toISOString(),
      };
    }

    const highRiskTypes = ["command", "setpoint_change", "deployment"];
    const isHighRisk =
      highRiskTypes.includes(action.type) || action.priority === "critical";

    if (isHighRisk && !action.requiresApproval) {
      return {
        name: "high_risk_approval",
        category: "safety",
        status: "fail",
        message: `High-risk action type '${action.type}' must require approval`,
        checkedAt: new Date().toISOString(),
        details: { actionType: action.type, priority: action.priority },
      };
    }

    return {
      name: "high_risk_approval",
      category: "safety",
      status: "pass",
      message: "High-risk approval requirement satisfied",
      checkedAt: new Date().toISOString(),
    };
  };
}

/**
 * Check reasoning has sufficient tokens
 */
export function checkReasoningDepth(minTokens: number): AutomatedCheck {
  return (decision) => ({
    name: "reasoning_depth",
    category: "consistency",
    status: decision.reasoning.tokens >= minTokens ? "pass" : "warn",
    message:
      decision.reasoning.tokens >= minTokens
        ? `Reasoning depth ${decision.reasoning.tokens} tokens meets threshold`
        : `Reasoning depth ${decision.reasoning.tokens} tokens below threshold ${minTokens}`,
    checkedAt: new Date().toISOString(),
    details: { tokens: decision.reasoning.tokens, threshold: minTokens },
  });
}

/**
 * Run all automated checks
 */
export function runAutomatedChecks(
  decision: CreateAgentDecisionInput,
  checks: AutomatedCheck[]
): CheckResult[] {
  return checks.map((check) => check(decision));
}

/**
 * Compute safety score from check results
 */
export function computeSafetyScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 0;

  const weights: Record<string, number> = {
    safety: 0.4,
    compliance: 0.25,
    consistency: 0.15,
    boundary: 0.1,
    dependency: 0.05,
    policy: 0.05,
  };

  const statusScores: Record<string, number> = {
    pass: 1.0,
    warn: 0.7,
    skip: 0.5,
    fail: 0.0,
    error: 0.0,
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const check of checks) {
    const weight = weights[check.category] || 0.1;
    const score = statusScores[check.status] || 0;
    weightedSum += weight * score;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// =============================================================================
// INTEGRATION WITH BASE AGENT
// =============================================================================

/**
 * Mixin to add decision recording capabilities to BaseAgent
 */
export interface DecisionRecordingCapable {
  /**
   * Create a decision builder for this agent
   */
  createDecision(): DecisionBuilder;

  /**
   * Record a decision (store and optionally anchor)
   */
  recordDecision(decision: AgentDecision): Promise<ContentHash>;

  /**
   * Get decisions made by this agent
   */
  getMyDecisions(limit?: number): Promise<AgentDecision[]>;
}

/**
 * Default automated checks for all agents
 */
export const DEFAULT_AUTOMATED_CHECKS: AutomatedCheck[] = [
  checkHighRiskApproval(),
  checkConfidenceThreshold(0.3),
  checkReasoningDepth(100),
];

// =============================================================================
// ARTIFACT HELPERS
// =============================================================================

/**
 * Store chain-of-thought as an artifact and return its hash
 */
export async function storeChainOfThought(
  content: string,
  storeArtifact: (content: string | Buffer) => Promise<ContentHash>
): Promise<ContentHash> {
  return storeArtifact(content);
}

/**
 * Store context snapshot as an artifact
 */
export async function storeContextSnapshot(
  context: Record<string, unknown>,
  storeArtifact: (content: string | Buffer) => Promise<ContentHash>
): Promise<ContentHash> {
  const json = JSON.stringify(context, null, 2);
  return storeArtifact(json);
}

/**
 * Store constraints as an artifact
 */
export async function storeConstraints(
  constraints: Record<string, unknown>,
  storeArtifact: (content: string | Buffer) => Promise<ContentHash>
): Promise<ContentHash> {
  const json = JSON.stringify(constraints, null, 2);
  return storeArtifact(json);
}

// =============================================================================
// REPLAY SUPPORT
// =============================================================================

/**
 * Extract inputs needed for replay from a decision
 */
export function extractReplayInputs(decision: AgentDecision): {
  artifacts: ContentHash[];
  context: ContentHash;
  constraints: ContentHash;
  systemPromptHash?: ContentHash;
  model: string;
  temperature: number;
} {
  return {
    artifacts: decision.inputs.artifacts,
    context: decision.inputs.context,
    constraints: decision.inputs.constraints,
    systemPromptHash: decision.reasoning.systemPromptHash,
    model: decision.reasoning.model,
    temperature: decision.reasoning.temperature,
  };
}

/**
 * Compare two decisions for replay verification
 */
export function compareDecisions(
  original: AgentDecision,
  replayed: AgentDecision
): {
  outputMatches: boolean;
  decisionMatches: boolean;
  actionMatches: boolean;
  confidenceDelta: number;
  keyDifferences: string[];
} {
  const differences: string[] = [];

  // Compare decision text
  const decisionMatches = original.output.decision === replayed.output.decision;
  if (!decisionMatches) {
    differences.push("decision_text_differs");
  }

  // Compare action
  const originalAction = JSON.stringify(original.output.action || null);
  const replayedAction = JSON.stringify(replayed.output.action || null);
  const actionMatches = originalAction === replayedAction;
  if (!actionMatches) {
    differences.push("action_differs");
  }

  // Compare confidence
  const confidenceDelta = Math.abs(
    original.output.confidence - replayed.output.confidence
  );
  if (confidenceDelta > 0.1) {
    differences.push(`confidence_delta_${confidenceDelta.toFixed(2)}`);
  }

  return {
    outputMatches: decisionMatches && actionMatches && confidenceDelta < 0.05,
    decisionMatches,
    actionMatches,
    confidenceDelta,
    keyDifferences: differences,
  };
}
