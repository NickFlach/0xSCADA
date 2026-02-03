/**
 * 0xSCADA Decision Replay Engine
 * 
 * VERITY Architecture - Phase γ.2: Decision Replay Engine
 * 
 * "Every decision must be replayable: Inputs → Constraints → Reasoning → Outputs"
 * "If replay is impossible, the decision is invalid."
 * 
 * This engine re-runs agent decisions with frozen inputs to:
 * - Verify decision determinism
 * - Detect behavioral regressions
 * - Audit decision-making processes
 * - Support compliance verification
 */

import { EventEmitter } from "events";
import { z } from "zod";
import type { ContentHash } from "@shared/artifact";
import type {
  AgentDecision,
  DecisionInputs,
  DecisionReasoning,
  DecisionOutput,
  DecisionReplayResult,
  CreateAgentDecisionInput,
} from "@shared/types";
import { agentDecisionSchema, decisionReplayResultSchema } from "@shared/types";
import { ArtifactStorageService, artifactStorage } from "./artifact-storage";
import { sha256 } from "../crypto";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of validating if a decision can be replayed
 */
export interface ReplayValidationResult {
  /** Whether the decision can be replayed */
  replayable: boolean;
  
  /** Missing artifacts that prevent replay */
  missingArtifacts: ContentHash[];
  
  /** Artifacts that exist but are corrupted */
  corruptedArtifacts: ContentHash[];
  
  /** Warnings that don't prevent replay */
  warnings: string[];
  
  /** Validation details */
  details: {
    inputArtifactsValid: boolean;
    contextArtifactValid: boolean;
    constraintsArtifactValid: boolean;
    chainOfThoughtValid: boolean;
    systemPromptValid: boolean;
  };
}

/**
 * Detailed comparison between original and replayed decisions
 */
export interface DecisionDiff {
  /** Overall match status */
  matches: boolean;
  
  /** Decision text comparison */
  decision: {
    matches: boolean;
    original: string;
    replayed: string;
    similarity: number; // 0-1 Jaccard similarity
  };
  
  /** Action comparison */
  action: {
    matches: boolean;
    typeMatches: boolean;
    parametersMatch: boolean;
    original: unknown;
    replayed: unknown;
  };
  
  /** Confidence comparison */
  confidence: {
    matches: boolean;
    original: number;
    replayed: number;
    delta: number;
    withinTolerance: boolean;
  };
  
  /** Key factors comparison */
  keyFactors: {
    matches: boolean;
    added: string[];
    removed: string[];
    common: string[];
  };
  
  /** Uncertainties comparison */
  uncertainties: {
    matches: boolean;
    added: string[];
    removed: string[];
    common: string[];
  };
  
  /** Alternatives comparison */
  alternatives: {
    matches: boolean;
    countDiff: number;
  };
  
  /** Verification comparison */
  verification: {
    safetyScoreMatches: boolean;
    safetyScoreDelta: number;
    checksMatch: boolean;
  };
  
  /** Summary of all differences */
  keyDifferences: string[];
}

/**
 * Replay execution context
 */
export interface ReplayContext {
  /** Original decision being replayed */
  originalDecision: AgentDecision;
  
  /** Reconstructed inputs (loaded from LFS) */
  inputs: {
    artifacts: Map<ContentHash, Buffer>;
    context: Buffer;
    constraints: Buffer;
    systemPrompt?: Buffer;
  };
  
  /** Replay configuration */
  config: ReplayConfig;
}

/**
 * Configuration for replay execution
 */
export interface ReplayConfig {
  /** Maximum allowed confidence delta before flagging */
  confidenceTolerance: number;
  
  /** Whether to use exact model matching */
  requireExactModel: boolean;
  
  /** Whether to enforce seed matching for determinism */
  enforceSeed: boolean;
  
  /** Maximum replay duration in ms */
  timeoutMs: number;
  
  /** Custom decision executor (for testing) */
  executor?: DecisionExecutor;
}

/**
 * Function that executes a decision given inputs
 */
export type DecisionExecutor = (
  context: ReplayContext
) => Promise<CreateAgentDecisionInput>;

/**
 * Result of a full replay
 */
export interface ReplayResult {
  /** Replay ID */
  id: ContentHash;
  
  /** Original decision ID */
  originalDecisionId: ContentHash;
  
  /** Replayed decision (new ID due to timestamp) */
  replayedDecision: AgentDecision;
  
  /** Validation result */
  validation: ReplayValidationResult;
  
  /** Detailed comparison */
  diff: DecisionDiff;
  
  /** Replay metadata */
  metadata: {
    replayedAt: string;
    replayDurationMs: number;
    replayReason?: string;
    executorVersion?: string;
  };
}

/**
 * Replay service configuration
 */
export interface DecisionReplayServiceConfig {
  /** Artifact storage service */
  artifactStorage: ArtifactStorageService;
  
  /** Default replay configuration */
  defaultConfig: Partial<ReplayConfig>;
  
  /** Decision storage adapter */
  decisionStorage?: IDecisionStorage;
}

/**
 * Simple decision storage interface
 */
export interface IDecisionStorage {
  get(id: ContentHash): Promise<AgentDecision | null>;
  store(decision: AgentDecision): Promise<ContentHash>;
}

// =============================================================================
// DEFAULT VALUES
// =============================================================================

const DEFAULT_REPLAY_CONFIG: ReplayConfig = {
  confidenceTolerance: 0.05,
  requireExactModel: true,
  enforceSeed: false,
  timeoutMs: 30000,
};

// =============================================================================
// DECISION REPLAY SERVICE
// =============================================================================

export class DecisionReplayService extends EventEmitter {
  private artifactStorage: ArtifactStorageService;
  private decisionStorage?: IDecisionStorage;
  private defaultConfig: ReplayConfig;
  private replayHistory: Map<ContentHash, ReplayResult> = new Map();

  constructor(config?: Partial<DecisionReplayServiceConfig>) {
    super();
    this.artifactStorage = config?.artifactStorage ?? artifactStorage;
    this.decisionStorage = config?.decisionStorage;
    this.defaultConfig = {
      ...DEFAULT_REPLAY_CONFIG,
      ...config?.defaultConfig,
    };
  }

  // ===========================================================================
  // VALIDATION
  // ===========================================================================

  /**
   * Validate if a decision can be replayed
   * 
   * A decision is replayable if all its input artifacts exist and are intact.
   */
  async validateReplayability(
    decision: AgentDecision
  ): Promise<ReplayValidationResult> {
    const missingArtifacts: ContentHash[] = [];
    const corruptedArtifacts: ContentHash[] = [];
    const warnings: string[] = [];

    // Check input artifacts
    let inputArtifactsValid = true;
    for (const artifactHash of decision.inputs.artifacts) {
      const exists = await this.artifactStorage.exists(artifactHash);
      if (!exists) {
        missingArtifacts.push(artifactHash);
        inputArtifactsValid = false;
      } else {
        const valid = await this.artifactStorage.verifyIntegrity(artifactHash);
        if (!valid) {
          corruptedArtifacts.push(artifactHash);
          inputArtifactsValid = false;
        }
      }
    }

    // Check context artifact
    const contextExists = await this.artifactStorage.exists(decision.inputs.context);
    const contextArtifactValid = contextExists &&
      await this.artifactStorage.verifyIntegrity(decision.inputs.context);
    if (!contextExists) {
      missingArtifacts.push(decision.inputs.context);
    } else if (!contextArtifactValid) {
      corruptedArtifacts.push(decision.inputs.context);
    }

    // Check constraints artifact
    const constraintsExists = await this.artifactStorage.exists(decision.inputs.constraints);
    const constraintsArtifactValid = constraintsExists &&
      await this.artifactStorage.verifyIntegrity(decision.inputs.constraints);
    if (!constraintsExists) {
      missingArtifacts.push(decision.inputs.constraints);
    } else if (!constraintsArtifactValid) {
      corruptedArtifacts.push(decision.inputs.constraints);
    }

    // Check chain-of-thought artifact
    const cotExists = await this.artifactStorage.exists(decision.reasoning.chainOfThought);
    const chainOfThoughtValid = cotExists &&
      await this.artifactStorage.verifyIntegrity(decision.reasoning.chainOfThought);
    if (!cotExists) {
      missingArtifacts.push(decision.reasoning.chainOfThought);
    } else if (!chainOfThoughtValid) {
      corruptedArtifacts.push(decision.reasoning.chainOfThought);
    }

    // Check system prompt artifact (optional)
    let systemPromptValid = true;
    if (decision.reasoning.systemPromptHash) {
      const promptExists = await this.artifactStorage.exists(decision.reasoning.systemPromptHash);
      systemPromptValid = promptExists &&
        await this.artifactStorage.verifyIntegrity(decision.reasoning.systemPromptHash);
      if (!promptExists) {
        missingArtifacts.push(decision.reasoning.systemPromptHash);
        systemPromptValid = false;
      } else if (!systemPromptValid) {
        corruptedArtifacts.push(decision.reasoning.systemPromptHash);
      }
    }

    // Check for optional but recommended fields
    if (!decision.reasoning.seed) {
      warnings.push("No seed specified - replay may not be deterministic");
    }
    if (decision.reasoning.temperature > 0) {
      warnings.push(`Temperature ${decision.reasoning.temperature} > 0 - replay may not be deterministic`);
    }
    if (!decision.signature) {
      warnings.push("Decision is unsigned - authenticity cannot be verified");
    }

    const replayable = 
      missingArtifacts.length === 0 && 
      corruptedArtifacts.length === 0;

    return {
      replayable,
      missingArtifacts,
      corruptedArtifacts,
      warnings,
      details: {
        inputArtifactsValid,
        contextArtifactValid,
        constraintsArtifactValid,
        chainOfThoughtValid,
        systemPromptValid,
      },
    };
  }

  // ===========================================================================
  // CONTEXT RECONSTRUCTION
  // ===========================================================================

  /**
   * Reconstruct the exact context from stored artifacts
   */
  async reconstructContext(
    decision: AgentDecision,
    config: ReplayConfig
  ): Promise<ReplayContext> {
    // Load all input artifacts
    const artifacts = new Map<ContentHash, Buffer>();
    for (const hash of decision.inputs.artifacts) {
      const content = await this.artifactStorage.getContent(hash);
      if (!content) {
        throw new Error(`Missing input artifact: ${hash}`);
      }
      artifacts.set(hash, content);
    }

    // Load context
    const context = await this.artifactStorage.getContent(decision.inputs.context);
    if (!context) {
      throw new Error(`Missing context artifact: ${decision.inputs.context}`);
    }

    // Load constraints
    const constraints = await this.artifactStorage.getContent(decision.inputs.constraints);
    if (!constraints) {
      throw new Error(`Missing constraints artifact: ${decision.inputs.constraints}`);
    }

    // Load system prompt (optional)
    let systemPrompt: Buffer | undefined;
    if (decision.reasoning.systemPromptHash) {
      systemPrompt = await this.artifactStorage.getContent(decision.reasoning.systemPromptHash) ?? undefined;
    }

    return {
      originalDecision: decision,
      inputs: {
        artifacts,
        context,
        constraints,
        systemPrompt,
      },
      config,
    };
  }

  // ===========================================================================
  // COMPARISON
  // ===========================================================================

  /**
   * Calculate Jaccard similarity between two strings
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return union.size > 0 ? intersection.size / union.size : 1;
  }

  /**
   * Compare two string arrays
   */
  private compareArrays(original: string[] = [], replayed: string[] = []): {
    matches: boolean;
    added: string[];
    removed: string[];
    common: string[];
  } {
    const originalSet = new Set(original);
    const replayedSet = new Set(replayed);
    
    const common = original.filter(x => replayedSet.has(x));
    const added = replayed.filter(x => !originalSet.has(x));
    const removed = original.filter(x => !replayedSet.has(x));
    
    return {
      matches: added.length === 0 && removed.length === 0,
      added,
      removed,
      common,
    };
  }

  /**
   * Compare two decisions in detail
   */
  compareDecisions(
    original: AgentDecision,
    replayed: AgentDecision,
    tolerances: { confidence: number } = { confidence: 0.05 }
  ): DecisionDiff {
    const keyDifferences: string[] = [];

    // Decision text comparison
    const decisionMatches = original.output.decision === replayed.output.decision;
    const decisionSimilarity = this.calculateSimilarity(
      original.output.decision,
      replayed.output.decision
    );
    if (!decisionMatches) {
      keyDifferences.push(
        `Decision text differs (similarity: ${(decisionSimilarity * 100).toFixed(1)}%)`
      );
    }

    // Action comparison
    const originalAction = original.output.action;
    const replayedAction = replayed.output.action;
    const actionExists = !!originalAction === !!replayedAction;
    let actionTypeMatches = true;
    let actionParametersMatch = true;
    
    if (originalAction && replayedAction) {
      actionTypeMatches = originalAction.type === replayedAction.type;
      actionParametersMatch = 
        JSON.stringify(originalAction.parameters) === 
        JSON.stringify(replayedAction.parameters);
      
      if (!actionTypeMatches) {
        keyDifferences.push(
          `Action type differs: ${originalAction.type} → ${replayedAction.type}`
        );
      }
      if (!actionParametersMatch) {
        keyDifferences.push("Action parameters differ");
      }
    } else if (!actionExists) {
      keyDifferences.push(
        originalAction ? "Action removed in replay" : "Action added in replay"
      );
    }
    const actionMatches = actionExists && actionTypeMatches && actionParametersMatch;

    // Confidence comparison
    const confidenceDelta = Math.abs(
      original.output.confidence - replayed.output.confidence
    );
    const confidenceWithinTolerance = confidenceDelta <= tolerances.confidence;
    if (!confidenceWithinTolerance) {
      keyDifferences.push(
        `Confidence delta ${(confidenceDelta * 100).toFixed(1)}% exceeds tolerance`
      );
    }

    // Key factors comparison
    const keyFactorsComparison = this.compareArrays(
      original.output.keyFactors,
      replayed.output.keyFactors
    );
    if (!keyFactorsComparison.matches) {
      keyDifferences.push(
        `Key factors differ: +${keyFactorsComparison.added.length}, -${keyFactorsComparison.removed.length}`
      );
    }

    // Uncertainties comparison
    const uncertaintiesComparison = this.compareArrays(
      original.output.uncertainties,
      replayed.output.uncertainties
    );
    if (!uncertaintiesComparison.matches) {
      keyDifferences.push(
        `Uncertainties differ: +${uncertaintiesComparison.added.length}, -${uncertaintiesComparison.removed.length}`
      );
    }

    // Alternatives comparison
    const originalAlts = original.output.alternatives?.length ?? 0;
    const replayedAlts = replayed.output.alternatives?.length ?? 0;
    const alternativesMatch = originalAlts === replayedAlts;
    if (!alternativesMatch) {
      keyDifferences.push(
        `Alternatives count differs: ${originalAlts} → ${replayedAlts}`
      );
    }

    // Verification comparison
    const safetyScoreDelta = Math.abs(
      original.verification.safetyScore - replayed.verification.safetyScore
    );
    const safetyScoreMatches = safetyScoreDelta <= tolerances.confidence;
    
    const originalChecks = original.verification.automatedChecks.length;
    const replayedChecks = replayed.verification.automatedChecks.length;
    const checksMatch = originalChecks === replayedChecks;

    if (!safetyScoreMatches) {
      keyDifferences.push(
        `Safety score delta ${(safetyScoreDelta * 100).toFixed(1)}% exceeds tolerance`
      );
    }

    // Overall match
    const matches = 
      decisionMatches &&
      actionMatches &&
      confidenceWithinTolerance;

    return {
      matches,
      decision: {
        matches: decisionMatches,
        original: original.output.decision,
        replayed: replayed.output.decision,
        similarity: decisionSimilarity,
      },
      action: {
        matches: actionMatches,
        typeMatches: actionTypeMatches,
        parametersMatch: actionParametersMatch,
        original: originalAction,
        replayed: replayedAction,
      },
      confidence: {
        matches: original.output.confidence === replayed.output.confidence,
        original: original.output.confidence,
        replayed: replayed.output.confidence,
        delta: confidenceDelta,
        withinTolerance: confidenceWithinTolerance,
      },
      keyFactors: keyFactorsComparison,
      uncertainties: uncertaintiesComparison,
      alternatives: {
        matches: alternativesMatch,
        countDiff: replayedAlts - originalAlts,
      },
      verification: {
        safetyScoreMatches,
        safetyScoreDelta,
        checksMatch,
      },
      keyDifferences,
    };
  }

  // ===========================================================================
  // REPLAY EXECUTION
  // ===========================================================================

  /**
   * Execute a replay using the provided executor
   */
  private async executeReplay(
    context: ReplayContext,
    executor: DecisionExecutor
  ): Promise<AgentDecision> {
    const startTime = Date.now();
    
    // Execute decision logic with frozen inputs
    const replayedInput = await executor(context);
    
    const duration = Date.now() - startTime;
    if (duration > context.config.timeoutMs) {
      throw new Error(`Replay timed out after ${duration}ms`);
    }

    // Finalize the replayed decision
    const timestamp = new Date().toISOString();
    const id = this.computeDecisionHash(replayedInput);

    const replayedDecision: AgentDecision = {
      id,
      schemaVersion: "1.0.0",
      timestamp,
      agent: replayedInput.agent,
      siteId: replayedInput.siteId,
      assetIds: replayedInput.assetIds,
      inputs: replayedInput.inputs,
      reasoning: replayedInput.reasoning,
      output: replayedInput.output,
      verification: replayedInput.verification ?? {
        automatedChecks: [],
        safetyScore: 0,
      },
      relatedArtifacts: {
        previousDecision: context.originalDecision.id,
      },
    };

    return replayedDecision;
  }

  /**
   * Compute hash of decision input for content addressing
   */
  private computeDecisionHash(input: CreateAgentDecisionInput): ContentHash {
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
    };

    const json = JSON.stringify(canonical, Object.keys(canonical).sort());
    return sha256(json) as ContentHash;
  }

  /**
   * Default executor that simulates replay (for testing)
   * In production, this would call the actual agent framework
   */
  private defaultExecutor: DecisionExecutor = async (context) => {
    // For testing, just return the original decision structure
    // A real executor would call the agent with frozen inputs
    const original = context.originalDecision;
    
    return {
      agent: original.agent,
      siteId: original.siteId,
      assetIds: original.assetIds,
      inputs: original.inputs,
      reasoning: original.reasoning,
      output: original.output,
      verification: original.verification,
    };
  };

  // ===========================================================================
  // MAIN REPLAY API
  // ===========================================================================

  /**
   * Replay a decision by ID
   * 
   * This is the main entry point for decision replay.
   */
  async replayDecision(
    decisionId: ContentHash,
    options?: {
      config?: Partial<ReplayConfig>;
      reason?: string;
    }
  ): Promise<ReplayResult> {
    const startTime = Date.now();

    // Load original decision
    let decision: AgentDecision | null = null;
    if (this.decisionStorage) {
      decision = await this.decisionStorage.get(decisionId);
    }
    if (!decision) {
      throw new Error(`Decision not found: ${decisionId}`);
    }

    return this.replayDecisionObject(decision, options);
  }

  /**
   * Replay a decision from its full object
   */
  async replayDecisionObject(
    decision: AgentDecision,
    options?: {
      config?: Partial<ReplayConfig>;
      reason?: string;
    }
  ): Promise<ReplayResult> {
    const startTime = Date.now();
    const config: ReplayConfig = {
      ...this.defaultConfig,
      ...options?.config,
    };

    // Validate replayability
    const validation = await this.validateReplayability(decision);
    if (!validation.replayable) {
      throw new Error(
        `Decision ${decision.id} is not replayable: ` +
        `missing=${validation.missingArtifacts.length}, ` +
        `corrupted=${validation.corruptedArtifacts.length}`
      );
    }

    // Reconstruct context
    const context = await this.reconstructContext(decision, config);

    // Execute replay
    const executor = config.executor ?? this.defaultExecutor;
    const replayedDecision = await this.executeReplay(context, executor);

    // Compare results
    const diff = this.compareDecisions(
      decision,
      replayedDecision,
      { confidence: config.confidenceTolerance }
    );

    const replayDurationMs = Date.now() - startTime;

    // Build result
    const replayId = sha256(
      JSON.stringify({ original: decision.id, replayedAt: new Date().toISOString() })
    ) as ContentHash;

    const result: ReplayResult = {
      id: replayId,
      originalDecisionId: decision.id,
      replayedDecision,
      validation,
      diff,
      metadata: {
        replayedAt: new Date().toISOString(),
        replayDurationMs,
        replayReason: options?.reason,
        executorVersion: "1.0.0",
      },
    };

    // Store in history
    this.replayHistory.set(replayId, result);

    // Emit events
    this.emit("replay:completed", {
      id: replayId,
      originalId: decision.id,
      matches: diff.matches,
      duration: replayDurationMs,
    });

    if (!diff.matches) {
      this.emit("replay:divergence", {
        id: replayId,
        originalId: decision.id,
        differences: diff.keyDifferences,
      });
    }

    return result;
  }

  // ===========================================================================
  // BATCH OPERATIONS
  // ===========================================================================

  /**
   * Replay multiple decisions
   */
  async replayBatch(
    decisionIds: ContentHash[],
    options?: {
      config?: Partial<ReplayConfig>;
      reason?: string;
      continueOnError?: boolean;
    }
  ): Promise<Map<ContentHash, ReplayResult | Error>> {
    const results = new Map<ContentHash, ReplayResult | Error>();

    for (const id of decisionIds) {
      try {
        const result = await this.replayDecision(id, options);
        results.set(id, result);
      } catch (error) {
        if (options?.continueOnError) {
          results.set(id, error as Error);
        } else {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Validate multiple decisions for replayability
   */
  async validateBatch(
    decisions: AgentDecision[]
  ): Promise<Map<ContentHash, ReplayValidationResult>> {
    const results = new Map<ContentHash, ReplayValidationResult>();

    for (const decision of decisions) {
      const validation = await this.validateReplayability(decision);
      results.set(decision.id, validation);
    }

    return results;
  }

  // ===========================================================================
  // REGRESSION TESTING SUPPORT
  // ===========================================================================

  /**
   * Run regression tests on a set of decisions
   * 
   * This is useful for CI/CD pipelines to ensure agent behavior
   * hasn't changed unexpectedly.
   */
  async runRegressionTest(
    decisions: AgentDecision[],
    config?: Partial<ReplayConfig>
  ): Promise<RegressionTestResult> {
    const startTime = Date.now();
    const results: ReplayResult[] = [];
    const failures: ReplayFailure[] = [];
    const skipped: { id: ContentHash; reason: string }[] = [];

    for (const decision of decisions) {
      try {
        const validation = await this.validateReplayability(decision);
        if (!validation.replayable) {
          skipped.push({
            id: decision.id,
            reason: `Not replayable: missing=${validation.missingArtifacts.length}`,
          });
          continue;
        }

        const result = await this.replayDecisionObject(decision, { config });
        results.push(result);

        if (!result.diff.matches) {
          failures.push({
            decisionId: decision.id,
            replayId: result.id,
            differences: result.diff.keyDifferences,
          });
        }
      } catch (error) {
        failures.push({
          decisionId: decision.id,
          error: error as Error,
        });
      }
    }

    const duration = Date.now() - startTime;
    const passed = results.filter(r => r.diff.matches).length;

    return {
      totalDecisions: decisions.length,
      replayed: results.length,
      passed,
      failed: failures.length,
      skipped: skipped.length,
      passRate: results.length > 0 ? passed / results.length : 0,
      duration,
      results,
      failures,
      skippedDecisions: skipped,
    };
  }

  // ===========================================================================
  // HISTORY & STATS
  // ===========================================================================

  /**
   * Get replay history
   */
  getReplayHistory(): ReplayResult[] {
    return Array.from(this.replayHistory.values());
  }

  /**
   * Get specific replay result
   */
  getReplayResult(id: ContentHash): ReplayResult | undefined {
    return this.replayHistory.get(id);
  }

  /**
   * Clear replay history
   */
  clearHistory(): void {
    this.replayHistory.clear();
  }

  /**
   * Get replay statistics
   */
  getStats(): ReplayStats {
    const history = this.getReplayHistory();
    if (history.length === 0) {
      return {
        totalReplays: 0,
        successfulMatches: 0,
        divergences: 0,
        matchRate: 0,
        avgDurationMs: 0,
        avgConfidenceDelta: 0,
      };
    }

    const matches = history.filter(r => r.diff.matches);
    const totalDuration = history.reduce(
      (sum, r) => sum + r.metadata.replayDurationMs,
      0
    );
    const totalConfidenceDelta = history.reduce(
      (sum, r) => sum + r.diff.confidence.delta,
      0
    );

    return {
      totalReplays: history.length,
      successfulMatches: matches.length,
      divergences: history.length - matches.length,
      matchRate: matches.length / history.length,
      avgDurationMs: totalDuration / history.length,
      avgConfidenceDelta: totalConfidenceDelta / history.length,
    };
  }
}

// =============================================================================
// SUPPORTING TYPES
// =============================================================================

export interface ReplayFailure {
  decisionId: ContentHash;
  replayId?: ContentHash;
  differences?: string[];
  error?: Error;
}

export interface RegressionTestResult {
  totalDecisions: number;
  replayed: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  duration: number;
  results: ReplayResult[];
  failures: ReplayFailure[];
  skippedDecisions: { id: ContentHash; reason: string }[];
}

export interface ReplayStats {
  totalReplays: number;
  successfulMatches: number;
  divergences: number;
  matchRate: number;
  avgDurationMs: number;
  avgConfidenceDelta: number;
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const decisionReplayService = new DecisionReplayService();

// =============================================================================
// FACTORY
// =============================================================================

export function createDecisionReplayService(
  config?: Partial<DecisionReplayServiceConfig>
): DecisionReplayService {
  return new DecisionReplayService(config);
}
