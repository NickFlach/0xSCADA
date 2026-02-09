/**
 * Propagation Mode Selection Engine
 *
 * GhostOS Propagation Model - Mode Selection Service
 * See docs/propagation-model.md for specification
 *
 * Issue: #164 - Propagation Mode Selection Engine
 * Epic: #161 - GhostOS Propagation Model
 */

import {
  PropagationMode,
  IntentPacket,
  PropagationThresholds,
  DEFAULT_PROPAGATION_THRESHOLDS,
  CriticalityLevel,
  AUTHORITY_ORDER,
  AuthorityLevel,
} from "../../shared/types/intent-packet";

import {
  CouplingInputs,
  CouplingWeights,
  DEFAULT_COUPLING_WEIGHTS,
  LossInputs,
  ModeSelectionContext,
  ModeSelectionResult,
  ModeRationale,
  ModeConditionResult,
  PolicyFlag,
  PropagationEnvironment,
  DEFAULT_PROPAGATION_ENVIRONMENT,
  TargetAnalysis,
} from "../../shared/types/propagation";

// =============================================================================
// COUPLING CALCULATION (docs/propagation-model.md Section 6.1)
// =============================================================================

/**
 * Calculate coupling score from inputs
 * C(intent, target) = w1 * relevance + w2 * capability_match + w3 * scope_overlap
 */
export function calculateCoupling(
  inputs: CouplingInputs,
  weights: CouplingWeights = DEFAULT_COUPLING_WEIGHTS
): number {
  const { relevance, capabilityMatch, scopeOverlap } = inputs;
  const { relevance: w1, capabilityMatch: w2, scopeOverlap: w3 } = weights;

  // Normalize weights
  const totalWeight = w1 + w2 + w3;
  const normalizedW1 = w1 / totalWeight;
  const normalizedW2 = w2 / totalWeight;
  const normalizedW3 = w3 / totalWeight;

  const coupling =
    normalizedW1 * relevance +
    normalizedW2 * capabilityMatch +
    normalizedW3 * scopeOverlap;

  return Math.max(0, Math.min(1, coupling));
}

// =============================================================================
// LOSS CALCULATION (docs/propagation-model.md Section 6.2)
// =============================================================================

/**
 * Calculate loss score from inputs
 * L = L_base + L_distance + L_transformation
 * Where L_distance = min(1.0, d / d_0)
 */
export function calculateLoss(inputs: LossInputs, d0: number = 10): number {
  const { baseLoss, distance, transformationLoss } = inputs;

  const distanceLoss = Math.min(1.0, distance / d0);
  const totalLoss = baseLoss + distanceLoss + transformationLoss;

  return Math.max(0, Math.min(1, totalLoss));
}

/**
 * Calculate effective coupling after loss
 * C_effective = C * (1 - L)
 */
export function calculateEffectiveCoupling(coupling: number, loss: number): number {
  return coupling * (1 - loss);
}

// =============================================================================
// MODE CONDITION CHECKS
// =============================================================================

function checkLocalCoherenceConditions(
  context: ModeSelectionContext,
  thresholds: PropagationThresholds
): ModeConditionResult[] {
  const { coupling, loss, distance } = context;

  return [
    {
      mode: PropagationMode.LOCAL_COHERENCE,
      condition: "coupling >= C_threshold_local",
      passed: coupling >= thresholds.C_threshold_local,
      value: coupling,
      threshold: thresholds.C_threshold_local,
    },
    {
      mode: PropagationMode.LOCAL_COHERENCE,
      condition: "loss <= L_threshold_local",
      passed: loss <= thresholds.L_threshold_local,
      value: loss,
      threshold: thresholds.L_threshold_local,
    },
    {
      mode: PropagationMode.LOCAL_COHERENCE,
      condition: "distance <= d_local",
      passed: distance <= thresholds.d_local,
      value: distance,
      threshold: thresholds.d_local,
    },
  ];
}

function checkRemoteCoherenceConditions(
  context: ModeSelectionContext,
  thresholds: PropagationThresholds
): ModeConditionResult[] {
  const { coupling, loss, distance } = context;

  return [
    {
      mode: PropagationMode.REMOTE_COHERENCE,
      condition: "coupling >= C_threshold_remote",
      passed: coupling >= thresholds.C_threshold_remote,
      value: coupling,
      threshold: thresholds.C_threshold_remote,
    },
    {
      mode: PropagationMode.REMOTE_COHERENCE,
      condition: "loss <= L_threshold_remote",
      passed: loss <= thresholds.L_threshold_remote,
      value: loss,
      threshold: thresholds.L_threshold_remote,
    },
    {
      mode: PropagationMode.REMOTE_COHERENCE,
      condition: "distance > d_local",
      passed: distance > thresholds.d_local,
      value: distance,
      threshold: thresholds.d_local,
    },
  ];
}

function checkSafeHoldConditions(
  context: ModeSelectionContext,
  thresholds: PropagationThresholds
): ModeConditionResult[] {
  const { coupling, loss, hasAuthority, policyFlags } = context;

  return [
    {
      mode: PropagationMode.SAFE_HOLD,
      condition: "coupling < C_threshold_remote OR loss > L_threshold_remote",
      passed:
        coupling < thresholds.C_threshold_remote ||
        loss > thresholds.L_threshold_remote,
      value: coupling,
      threshold: thresholds.C_threshold_remote,
    },
    {
      mode: PropagationMode.SAFE_HOLD,
      condition: "authority_check_failed",
      passed: !hasAuthority,
    },
    {
      mode: PropagationMode.SAFE_HOLD,
      condition: "policy_risk_flag_set",
      passed: policyFlags.length > 0,
    },
  ];
}

function checkExplorationConditions(
  context: ModeSelectionContext
): ModeConditionResult[] {
  const { packet, targetsCritical, explorationAllowed } = context;

  return [
    {
      mode: PropagationMode.EXPLORATION,
      condition: "mode == EXPLORATION",
      passed: packet.mode === PropagationMode.EXPLORATION,
    },
    {
      mode: PropagationMode.EXPLORATION,
      condition: "target.criticality < CRITICAL",
      passed: !targetsCritical,
    },
    {
      mode: PropagationMode.EXPLORATION,
      condition: "environment.allows_exploration",
      passed: explorationAllowed,
    },
  ];
}

// =============================================================================
// MODE SCORING
// =============================================================================

function scoreMode(
  mode: PropagationMode,
  context: ModeSelectionContext,
  thresholds: PropagationThresholds
): number {
  const effectiveCoupling = calculateEffectiveCoupling(context.coupling, context.loss);

  // Base score from effective coupling
  let score = effectiveCoupling;

  // Mode-specific weights
  const modeWeights: Record<PropagationMode, number> = {
    [PropagationMode.LOCAL_COHERENCE]: 1.0,
    [PropagationMode.REMOTE_COHERENCE]: 0.8,
    [PropagationMode.SAFE_HOLD]: 0.0, // SAFE_HOLD is triggered by conditions, not score
    [PropagationMode.EXPLORATION]: 0.5,
  };

  score *= modeWeights[mode];

  // Apply penalties
  if (context.targetsCritical && mode === PropagationMode.EXPLORATION) {
    score = 0; // Cannot explore critical targets
  }

  if (!context.hasAuthority) {
    score = 0; // No authority means SAFE_HOLD
  }

  if (context.policyFlags.length > 0 && mode !== PropagationMode.SAFE_HOLD) {
    score *= 0.5; // Penalty for policy flags
  }

  return Math.max(0, Math.min(1, score));
}

// =============================================================================
// MODE SELECTION ENGINE
// =============================================================================

export class PropagationModeSelector {
  private environment: PropagationEnvironment;

  constructor(environment: Partial<PropagationEnvironment> = {}) {
    this.environment = {
      ...DEFAULT_PROPAGATION_ENVIRONMENT,
      ...environment,
      thresholds: {
        ...DEFAULT_PROPAGATION_THRESHOLDS,
        ...environment.thresholds,
      },
      couplingWeights: {
        ...DEFAULT_COUPLING_WEIGHTS,
        ...environment.couplingWeights,
      },
    };
  }

  /**
   * Select the appropriate propagation mode based on context
   */
  selectMode(context: ModeSelectionContext): ModeSelectionResult {
    const { thresholds } = this.environment;
    const effectiveCoupling = calculateEffectiveCoupling(context.coupling, context.loss);

    // Collect all condition results
    const conditionsChecked: ModeConditionResult[] = [
      ...checkLocalCoherenceConditions(context, thresholds),
      ...checkRemoteCoherenceConditions(context, thresholds),
      ...checkSafeHoldConditions(context, thresholds),
      ...checkExplorationConditions(context),
    ];

    // Calculate scores for each mode
    const modeScores: Record<PropagationMode, number> = {
      [PropagationMode.LOCAL_COHERENCE]: scoreMode(
        PropagationMode.LOCAL_COHERENCE,
        context,
        thresholds
      ),
      [PropagationMode.REMOTE_COHERENCE]: scoreMode(
        PropagationMode.REMOTE_COHERENCE,
        context,
        thresholds
      ),
      [PropagationMode.SAFE_HOLD]: scoreMode(
        PropagationMode.SAFE_HOLD,
        context,
        thresholds
      ),
      [PropagationMode.EXPLORATION]: scoreMode(
        PropagationMode.EXPLORATION,
        context,
        thresholds
      ),
    };

    // Build rationale
    const rationale: ModeRationale = {
      coupling: context.coupling,
      loss: context.loss,
      effectiveCoupling,
      distance: context.distance,
      thresholds,
      modeScores,
      conditionsChecked,
    };

    // Determine active policy flags
    const activeFlags = this.determineActiveFlags(context);

    // Check for forced SAFE_HOLD conditions
    const forcedSafeHold = this.checkForcedSafeHold(context, activeFlags);
    if (forcedSafeHold.forced) {
      return {
        mode: PropagationMode.SAFE_HOLD,
        effectiveCoupling,
        reason: forcedSafeHold.reason,
        rationale,
        forcedByPolicy: true,
        activeFlags,
      };
    }

    // Check for requested EXPLORATION mode
    if (context.packet.mode === PropagationMode.EXPLORATION) {
      const explorationResult = this.evaluateExploration(context, rationale, activeFlags);
      if (explorationResult) {
        return explorationResult;
      }
    }

    // Evaluate LOCAL_COHERENCE
    const localConditions = checkLocalCoherenceConditions(context, thresholds);
    if (localConditions.every((c) => c.passed)) {
      return {
        mode: PropagationMode.LOCAL_COHERENCE,
        effectiveCoupling,
        reason: `High coupling (${context.coupling.toFixed(2)}) and low loss (${context.loss.toFixed(2)}) within local distance`,
        rationale,
        forcedByPolicy: false,
        activeFlags,
      };
    }

    // Evaluate REMOTE_COHERENCE
    const remoteConditions = checkRemoteCoherenceConditions(context, thresholds);
    const remoteCouplingOk = context.coupling >= thresholds.C_threshold_remote;
    const remoteLossOk = context.loss <= thresholds.L_threshold_remote;

    if (remoteCouplingOk && remoteLossOk) {
      return {
        mode: PropagationMode.REMOTE_COHERENCE,
        effectiveCoupling,
        reason: `Moderate coupling (${context.coupling.toFixed(2)}) suitable for distributed coordination`,
        rationale,
        forcedByPolicy: false,
        activeFlags,
      };
    }

    // Default to SAFE_HOLD
    return {
      mode: PropagationMode.SAFE_HOLD,
      effectiveCoupling,
      reason: this.buildSafeHoldReason(context, thresholds),
      rationale,
      forcedByPolicy: false,
      activeFlags,
    };
  }

  /**
   * Determine which policy flags are active based on context
   */
  private determineActiveFlags(context: ModeSelectionContext): PolicyFlag[] {
    const flags: PolicyFlag[] = [...context.policyFlags];

    if (context.targetsCritical) {
      flags.push(PolicyFlag.CRITICAL_TARGET);
    }

    if (!context.hasAuthority) {
      flags.push(PolicyFlag.AUTHORITY_EXCEEDED);
    }

    if (context.packet.confidence < 0.5) {
      flags.push(PolicyFlag.LOW_CONFIDENCE);
    }

    if (context.loss > this.environment.thresholds.L_threshold_remote) {
      flags.push(PolicyFlag.HIGH_LOSS);
    }

    if (!context.explorationAllowed) {
      flags.push(PolicyFlag.EXPLORATION_DISABLED);
    }

    return [...new Set(flags)]; // Deduplicate
  }

  /**
   * Check if SAFE_HOLD should be forced by policy
   */
  private checkForcedSafeHold(
    context: ModeSelectionContext,
    activeFlags: PolicyFlag[]
  ): { forced: boolean; reason: string } {
    // Authority check
    if (!context.hasAuthority) {
      return {
        forced: true,
        reason: "Insufficient authority for requested operation",
      };
    }

    // Manual SAFE_HOLD flag
    if (activeFlags.includes(PolicyFlag.MANUAL_SAFE_HOLD)) {
      return {
        forced: true,
        reason: "SAFE_HOLD manually requested",
      };
    }

    // Requested mode is SAFE_HOLD
    if (context.packet.mode === PropagationMode.SAFE_HOLD) {
      return {
        forced: true,
        reason: "SAFE_HOLD mode explicitly requested",
      };
    }

    return { forced: false, reason: "" };
  }

  /**
   * Evaluate EXPLORATION mode request
   */
  private evaluateExploration(
    context: ModeSelectionContext,
    rationale: ModeRationale,
    activeFlags: PolicyFlag[]
  ): ModeSelectionResult | null {
    const effectiveCoupling = calculateEffectiveCoupling(context.coupling, context.loss);

    // Check exploration conditions
    if (!context.explorationAllowed) {
      return {
        mode: PropagationMode.SAFE_HOLD,
        effectiveCoupling,
        reason: "Exploration mode not allowed in this environment",
        rationale,
        forcedByPolicy: true,
        activeFlags: [...activeFlags, PolicyFlag.EXPLORATION_DISABLED],
      };
    }

    if (context.targetsCritical) {
      return {
        mode: PropagationMode.SAFE_HOLD,
        effectiveCoupling,
        reason: "Cannot use exploration mode with critical targets",
        rationale,
        forcedByPolicy: true,
        activeFlags: [...activeFlags, PolicyFlag.CRITICAL_TARGET],
      };
    }

    // Exploration approved
    return {
      mode: PropagationMode.EXPLORATION,
      effectiveCoupling,
      reason: "Exploration mode approved for non-critical learning operation",
      rationale,
      forcedByPolicy: false,
      activeFlags,
    };
  }

  /**
   * Build a descriptive reason for SAFE_HOLD
   */
  private buildSafeHoldReason(
    context: ModeSelectionContext,
    thresholds: PropagationThresholds
  ): string {
    const reasons: string[] = [];

    if (context.coupling < thresholds.C_threshold_remote) {
      reasons.push(
        `Low coupling (${context.coupling.toFixed(2)} < ${thresholds.C_threshold_remote})`
      );
    }

    if (context.loss > thresholds.L_threshold_remote) {
      reasons.push(
        `High loss (${context.loss.toFixed(2)} > ${thresholds.L_threshold_remote})`
      );
    }

    if (context.policyFlags.length > 0) {
      reasons.push(`Policy flags: ${context.policyFlags.join(", ")}`);
    }

    return reasons.length > 0
      ? `SAFE_HOLD triggered: ${reasons.join("; ")}`
      : "SAFE_HOLD triggered due to uncertainty";
  }

  /**
   * Get current environment configuration
   */
  getEnvironment(): PropagationEnvironment {
    return { ...this.environment };
  }

  /**
   * Update thresholds at runtime
   */
  updateThresholds(thresholds: Partial<PropagationThresholds>): void {
    this.environment.thresholds = {
      ...this.environment.thresholds,
      ...thresholds,
    };
  }

  /**
   * Get site-specific thresholds
   */
  getThresholdsForSite(siteId: string): PropagationThresholds {
    const siteOverrides = this.environment.siteOverrides?.[siteId];
    if (siteOverrides) {
      return {
        ...this.environment.thresholds,
        ...siteOverrides,
      };
    }
    return this.environment.thresholds;
  }
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Quick mode selection with default environment
 */
export function selectPropagationMode(
  context: ModeSelectionContext
): ModeSelectionResult {
  const selector = new PropagationModeSelector();
  return selector.selectMode(context);
}

/**
 * Build a mode selection context from an intent packet
 */
export function buildModeContext(
  packet: IntentPacket,
  options: {
    coupling: number;
    loss: number;
    distance: number;
    targetsCritical?: boolean;
    agentAuthority?: AuthorityLevel;
    explorationAllowed?: boolean;
    policyFlags?: PolicyFlag[];
  }
): ModeSelectionContext {
  const hasAuthority = options.agentAuthority
    ? AUTHORITY_ORDER[options.agentAuthority] >=
      AUTHORITY_ORDER[packet.authority_required]
    : true;

  return {
    packet,
    coupling: options.coupling,
    loss: options.loss,
    distance: options.distance,
    targetsCritical: options.targetsCritical ?? false,
    hasAuthority,
    explorationAllowed: options.explorationAllowed ?? true,
    policyFlags: options.policyFlags ?? [],
  };
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let selectorInstance: PropagationModeSelector | null = null;

export function getPropagationModeSelector(
  environment?: Partial<PropagationEnvironment>
): PropagationModeSelector {
  if (!selectorInstance) {
    selectorInstance = new PropagationModeSelector(environment);
  }
  return selectorInstance;
}

export function resetPropagationModeSelector(): void {
  selectorInstance = null;
}
