/**
 * PID Auto-Tuning Types
 * ADR-0013 [13.4] — Issue #215
 *
 * Safety envelopes (ADR-0009), human-approval tuning proposals, and
 * RL-based tuning over a FOPDT process model. Builds on the existing
 * PIDController/PIDAutoTuner stack from issue #351.
 */

export interface GainRange {
  min: number;
  max: number;
}

/**
 * Absolute safety envelope for controller gains (ADR-0009). The existing
 * per-step rate limit (maxGainChangeFraction) bounds each change; the
 * envelope bounds where gains can ever end up — repeated rate-limited
 * steps can no longer walk gains arbitrarily far.
 */
export interface GainEnvelope {
  kpRange: GainRange;
  kiRange: GainRange;
  kdRange: GainRange;
}

/** First-order-plus-dead-time process model for simulation-based tuning */
export interface FOPDTModel {
  /** Process gain K */
  gain: number;
  /** Time constant τ in seconds */
  timeConstantS: number;
  /** Dead time θ in seconds */
  deadTimeS: number;
  /** Optional measurement noise sigma */
  noiseSigma?: number;
}

export interface EpisodeMetrics {
  ise: number;
  iae: number;
  itae: number;
  /** Peak overshoot as a fraction of the setpoint change */
  overshoot: number;
  /** Sim-time seconds to stay within the 2% band, null if never settled */
  settlingTimeS: number | null;
  oscillating: boolean;
}

export interface RLTunerConfig {
  episodes: number;
  episodeTicks: number;
  dtS: number;
  /** Exploration rate (0..1), decayed per episode */
  epsilon: number;
  epsilonDecay: number;
  learningRate: number;
  discount: number;
  /** Reward penalty multiplier for overshoot */
  overshootPenalty: number;
  /** Reward penalty applied when the loop oscillates */
  oscillationPenalty: number;
  /** RNG seed for reproducible runs */
  seed?: number;
}

export interface RLEpisode {
  episode: number;
  gains: { kp: number; ki: number; kd: number };
  reward: number;
  metrics: EpisodeMetrics;
  action: string;
  explored: boolean;
}

export interface RLTuningOutcome {
  bestGains: { kp: number; ki: number; kd: number };
  bestReward: number;
  initialReward: number;
  improvedOverInitial: boolean;
  episodes: RLEpisode[];
}

export type TuningProposalStatus =
  | 'pending'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'expired'
  | 'failed';

export type ProposalMethod = 'relay-feedback' | 'ziegler-nichols' | 'cohen-coon' | 'rl' | 'monitor';

/**
 * A human-approval tuning proposal. Every gain change flows through one of
 * these — there is no auto-apply path (ADR-0013: human-in-the-loop).
 */
export interface TuningProposal {
  id: string;
  controllerId: string;
  method: ProposalMethod;
  currentGains: { kp: number; ki: number; kd: number };
  /** Target gains after envelope clamping */
  proposedGains: { kp: number; ki: number; kd: number };
  /** True when the raw recommendation exceeded the envelope and was clamped */
  clampedByEnvelope: boolean;
  reason: string;
  confidence: number;
  status: TuningProposalStatus;
  /** Governance gate instance backing the approval */
  gateInstanceId: string;
  createdAt: number;
  resolvedAt?: number;
  decidedBy?: string;
  /**
   * Gains actually written on approval. May differ from proposedGains when
   * the per-step rate limit truncated the move; `fullyApplied` is false in
   * that case and a follow-up proposal is required to finish the move.
   */
  appliedGains?: { kp: number; ki: number; kd: number };
  fullyApplied?: boolean;
}
