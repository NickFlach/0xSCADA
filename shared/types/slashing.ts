/**
 * Shared types for the Slashing & Liveness Visualizer (issue #456).
 *
 * These describe per-validator attestation participation history and the
 * "what-if" slashing-rule model. They are intentionally framework-agnostic so
 * that BOTH the server `/history` endpoint and the client simulator/UI share a
 * single source of truth.
 *
 * INTEGRATION (#wave:2a Validator Dashboard): the canonical validator/attestation
 * data layer is owned by the Validator Dashboard issue, which is NOT present on
 * `main` at the time this branch was cut. To stay self-contained we define a
 * MINIMAL local model here. When the dashboard's data layer lands, this file
 * should be reconciled with (or re-exported from) the canonical types — the
 * field names below (`validatorId`, `slot`, `timestamp`, `status`) are chosen to
 * match the expected canonical shape to keep that reconciliation mechanical.
 */

/**
 * Outcome of a single attestation duty for one validator at one slot.
 * - `hit`     : the validator attested correctly and on time.
 * - `miss`    : the validator failed to attest (liveness fault contributor).
 * - `late`    : the validator attested but outside the inclusion window. Treated
 *               as a participation hit but flagged so the UI can distinguish it.
 */
export type AttestationStatus = "hit" | "miss" | "late";

/**
 * A single attestation duty record. One per assigned slot per validator.
 */
export interface AttestationRecord {
  /** Slot index this duty was assigned for (monotonically increasing). */
  slot: number;
  /** Unix epoch milliseconds at which the slot occurred. */
  timestamp: number;
  /** Outcome of the duty. */
  status: AttestationStatus;
}

/**
 * Full attestation history for a single validator over some window.
 * Records are expected to be sorted ascending by `slot` (and therefore time).
 */
export interface ValidatorHistory {
  /** Stable validator identifier (e.g. pubkey prefix or node id). */
  validatorId: string;
  /** Human-friendly label for display. */
  label: string;
  /**
   * Effective stake balance (in the fabric's native staking unit) at the start
   * of the window. Penalty projections are expressed as a fraction of this.
   */
  stake: number;
  /** Chronologically ascending attestation records. */
  records: AttestationRecord[];
}

/** Selectable timeline windows. */
export type TimelineWindow = "1h" | "24h" | "7d";

/** Window durations in milliseconds. */
export const WINDOW_MS: Record<TimelineWindow, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/**
 * A proposed slashing rule for the what-if simulator.
 *
 * Models the canonical operator phrasing: "slash {penaltyPctPerMiss}% per miss
 * after {missThreshold} misses within a {windowMs} sliding window".
 *
 * The rule is evaluated as a PURE projection against actual history — it never
 * mutates state and never actually slashes anything.
 */
export interface SlashingRule {
  /** Human label for the scenario. */
  name: string;
  /**
   * Number of misses within the sliding window that must be reached BEFORE any
   * penalty applies. Misses at or below this count are free. The first
   * penalised miss is the (missThreshold + 1)-th miss in the window.
   */
  missThreshold: number;
  /** Sliding window length, in milliseconds, over which misses are counted. */
  windowMs: number;
  /** Penalty as a percentage of stake applied per penalised miss. */
  penaltyPctPerMiss: number;
  /**
   * Optional cap on total penalty as a percentage of stake. When omitted the
   * penalty is uncapped (other than the implicit 100% of stake). Defaults to
   * 100 when evaluated.
   */
  maxPenaltyPct?: number;
  /**
   * Minimum length of a consecutive-miss run that should be flagged as a
   * liveness fault in the timeline. This is a UI/detection threshold and does
   * NOT affect penalty math. Defaults to 3 when evaluated.
   */
  livenessRunThreshold?: number;
}

/** A penalty event produced by replaying a rule over history. */
export interface PenaltyEvent {
  /** Slot at which the penalised miss occurred. */
  slot: number;
  /** Timestamp of the penalised miss. */
  timestamp: number;
  /** Count of misses within the sliding window at this point (inclusive). */
  missesInWindow: number;
  /** Penalty applied for THIS miss, as a percentage of stake. */
  penaltyPct: number;
  /** Penalty applied for THIS miss, in absolute stake units. */
  penaltyAmount: number;
}

/** A detected run of consecutive misses (a candidate liveness fault). */
export interface LivenessFaultRun {
  /** Index into `records` where the run starts (inclusive). */
  startIndex: number;
  /** Index into `records` where the run ends (inclusive). */
  endIndex: number;
  /** Slot at which the run starts. */
  startSlot: number;
  /** Slot at which the run ends. */
  endSlot: number;
  /** Number of consecutive misses in the run. */
  length: number;
  /** Timestamp of the first miss in the run. */
  startTimestamp: number;
  /** Timestamp of the last miss in the run. */
  endTimestamp: number;
}

/** Aggregate participation statistics for a validator over a window. */
export interface ParticipationSummary {
  total: number;
  hits: number;
  misses: number;
  late: number;
  /** Participation rate = (hits + late) / total, in [0, 1]. 0 when total is 0. */
  participationRate: number;
}

/** The full result of replaying a rule over one validator's history. */
export interface SimulationResult {
  validatorId: string;
  /** The window of records actually evaluated (post-filtering). */
  evaluated: AttestationRecord[];
  summary: ParticipationSummary;
  /** Penalised misses, in chronological order. */
  penalties: PenaltyEvent[];
  /** Detected consecutive-miss runs at/above the liveness threshold. */
  livenessFaults: LivenessFaultRun[];
  /** Total penalty as a percentage of stake (capped at maxPenaltyPct). */
  totalPenaltyPct: number;
  /** Total penalty in absolute stake units. */
  totalPenaltyAmount: number;
}
