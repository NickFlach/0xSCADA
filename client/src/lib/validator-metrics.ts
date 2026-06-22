/**
 * validator-metrics.ts — PURE derivation logic for the Validator Dashboard.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * Everything here is a pure function of its inputs (no fetch, no React, no clock
 * except the explicitly passed `now`). This is the unit-tested core: stale
 * detection, attestation-rate over the last N rounds, Kuramoto coherence, and
 * anchor-batch throughput aggregation.
 */

import type { NodeStatus, ValidatorEvent, ValidatorPhase, NodePollResult } from './oxscada-rpc';

// ─── Stale detection ─────────────────────────────────────────────────────────

/**
 * A node/row is "stale" when it has not produced a usable status within
 * STALE_THRESHOLD_MS. The verification criterion is: killing a validator turns its
 * row stale in under 10s, so the default threshold is below 10s.
 */
export const STALE_THRESHOLD_MS = 8000;

export type NodeHealth = 'live' | 'stale' | 'error';

/**
 * Classify a node poll result against `now`.
 * - 'error'  → last poll failed AND no fresh status (transport/parse error).
 * - 'stale'  → last successful sample is older than the threshold.
 * - 'live'   → fresh status within the threshold.
 *
 * `referenceTime` is the timestamp we measure freshness against: prefer the
 * node-reported status.timestamp when present (clock the node believes), else the
 * client-side fetchedAt. We use the MORE RECENT of the two so a node that simply
 * stops responding (no new fetchedAt) goes stale even if its last status.timestamp
 * was recent.
 */
export function classifyNodeHealth(
  result: Pick<NodePollResult, 'status' | 'error' | 'fetchedAt'>,
  now: number,
  thresholdMs: number = STALE_THRESHOLD_MS,
): NodeHealth {
  const reference = lastSeenMillis(result);
  const age = now - reference;
  if (age >= thresholdMs) {
    // Old data dominates: a node that stopped answering is stale even if its last
    // poll errored — but a hard transport error with no prior data is 'error'.
    return result.status === null && result.error !== null ? 'error' : 'stale';
  }
  if (result.error !== null && result.status === null) return 'error';
  return 'live';
}

/**
 * The most recent moment we have evidence the node was alive. Uses the larger of
 * the node-reported status timestamp and the client fetch time, so a node that
 * stops responding ages out by fetchedAt no longer advancing.
 */
export function lastSeenMillis(result: Pick<NodePollResult, 'status' | 'fetchedAt'>): number {
  const statusTs = result.status?.timestamp ?? 0;
  return Math.max(statusTs, result.fetchedAt);
}

/** Human "Ns ago" style age string. */
export function formatAge(ageMs: number): string {
  if (ageMs < 0) ageMs = 0;
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// ─── Attestation rate over last N rounds ──────────────────────────────────────

/**
 * Attestation rate for a validator over the most recent `windowRounds` distinct
 * rounds present in `events`: fraction of those rounds in which the validator
 * produced an `attest` event (vs `miss`).
 *
 * Only 'attest' and 'miss' events count toward the denominator; 'anchor'/'phase'
 * events are ignored. A round in which the validator attested counts as a hit; a
 * round with only a 'miss' counts as a participating round that was missed.
 * Returns a value in [0,1], or null when there is no attestation data.
 */
export function attestationRate(
  events: ValidatorEvent[],
  validatorId: string,
  windowRounds: number,
): number | null {
  if (windowRounds <= 0) return null;

  // Collect, per round, whether the validator attested or missed.
  const perRound = new Map<number, { attested: boolean; participated: boolean }>();
  for (const ev of events) {
    if (ev.validatorId !== validatorId) continue;
    if (ev.kind !== 'attest' && ev.kind !== 'miss') continue;
    const entry = perRound.get(ev.round) ?? { attested: false, participated: false };
    entry.participated = true;
    if (ev.kind === 'attest') entry.attested = true;
    perRound.set(ev.round, entry);
  }

  if (perRound.size === 0) return null;

  // Keep only the most recent `windowRounds` round numbers.
  const rounds = [...perRound.keys()].sort((a, b) => b - a).slice(0, windowRounds);
  if (rounds.length === 0) return null;

  let hits = 0;
  for (const r of rounds) {
    if (perRound.get(r)?.attested) hits += 1;
  }
  return hits / rounds.length;
}

// ─── Kuramoto coherence (mean phase coupling) ──────────────────────────────────

export interface CoherenceResult {
  /** Order parameter r ∈ [0,1]; 1 = perfectly synchronized, 0 = incoherent. */
  r: number;
  /** Mean phase (radians) of the cluster, ψ. */
  meanPhase: number;
  /** Number of validators that contributed. */
  count: number;
}

/**
 * Kuramoto order parameter r·e^{iψ} = (1/N) Σ e^{iθ_k}.
 *
 * r is the magnitude of the mean of the unit phase vectors — the canonical measure
 * of phase coherence / mean coupling. With N=0 returns r=0. With N=1 returns r=1
 * (a single oscillator is trivially coherent with itself).
 */
export function kuramotoCoherence(phases: ReadonlyArray<Pick<ValidatorPhase, 'phase'>>): CoherenceResult {
  const count = phases.length;
  if (count === 0) return { r: 0, meanPhase: 0, count: 0 };

  let sumCos = 0;
  let sumSin = 0;
  for (const p of phases) {
    sumCos += Math.cos(p.phase);
    sumSin += Math.sin(p.phase);
  }
  const meanCos = sumCos / count;
  const meanSin = sumSin / count;
  const r = Math.min(1, Math.hypot(meanCos, meanSin));
  const meanPhase = Math.atan2(meanSin, meanCos);
  return { r, meanPhase, count };
}

/** Default coherence floor below which the indicator turns red. */
export const COHERENCE_RED_THRESHOLD = 0.7;

/** Whether a coherence value is below the alarm threshold (turns red). */
export function isCoherenceCritical(r: number, threshold: number = COHERENCE_RED_THRESHOLD): boolean {
  return r < threshold;
}

// ─── Anchor-batch throughput aggregation ───────────────────────────────────────

export interface ThroughputPoint {
  /** Bucket start (unix epoch millis). */
  bucketStart: number;
  txs: number;
  bytes: number;
}

export interface ThroughputSummary {
  /** Per-minute time series derived from anchor events, oldest first. */
  series: ThroughputPoint[];
  /** Rolling rate over the window. */
  txsPerMin: number;
  bytesPerMin: number;
  /** Distribution of batch sizes: size → count. Sorted ascending by size. */
  batchSizeDistribution: Array<{ size: number; count: number }>;
}

/**
 * Aggregate `anchor` events into a per-minute throughput series + a batch-size
 * histogram. `windowMs` bounds how far back we look (default 10 minutes). Pure:
 * `now` is supplied so bucketing is deterministic in tests.
 */
export function aggregateThroughput(
  events: ValidatorEvent[],
  now: number,
  windowMs = 10 * 60 * 1000,
): ThroughputSummary {
  const bucketMs = 60 * 1000;
  const windowStart = now - windowMs;

  const buckets = new Map<number, ThroughputPoint>();
  const sizeCounts = new Map<number, number>();

  for (const ev of events) {
    if (ev.kind !== 'anchor') continue;
    if (ev.timestamp < windowStart) continue;
    const bucketStart = Math.floor(ev.timestamp / bucketMs) * bucketMs;
    const point = buckets.get(bucketStart) ?? { bucketStart, txs: 0, bytes: 0 };
    const size = ev.batchSize ?? 0;
    point.txs += size;
    point.bytes += ev.bytes ?? 0;
    buckets.set(bucketStart, point);
    if (ev.batchSize !== undefined) {
      sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    }
  }

  const series = [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart);

  const totalTxs = series.reduce((acc, p) => acc + p.txs, 0);
  const totalBytes = series.reduce((acc, p) => acc + p.bytes, 0);
  const windowMinutes = windowMs / bucketMs;
  const txsPerMin = windowMinutes > 0 ? totalTxs / windowMinutes : 0;
  const bytesPerMin = windowMinutes > 0 ? totalBytes / windowMinutes : 0;

  const batchSizeDistribution = [...sizeCounts.entries()]
    .map(([size, count]) => ({ size, count }))
    .sort((a, b) => a.size - b.size);

  return { series, txsPerMin, bytesPerMin, batchSizeDistribution };
}

// ─── Per-validator row derivation (combines a node's status + cluster events) ──

export interface ValidatorRow {
  id: string;
  label: string;
  phase: number;
  frequency: number;
  lastSeen: number;
  /** Attestation rate over the window, or null when unknown. */
  attestationRate: number | null;
}

/**
 * Build a stable, sorted list of validator rows from the merged validator set
 * (across all reachable nodes) and the merged event stream. Deduplicates
 * validators by id, keeping the most recently-seen sample.
 */
export function buildValidatorRows(
  statuses: ReadonlyArray<NodeStatus>,
  events: ValidatorEvent[],
  windowRounds: number,
): ValidatorRow[] {
  const byId = new Map<string, ValidatorPhase>();
  for (const s of statuses) {
    for (const v of s.validators) {
      const existing = byId.get(v.id);
      if (!existing || v.lastSeen > existing.lastSeen) {
        byId.set(v.id, v);
      }
    }
  }

  const rows: ValidatorRow[] = [...byId.values()].map((v) => ({
    id: v.id,
    label: v.label ?? shortId(v.id),
    phase: v.phase,
    frequency: v.frequency,
    lastSeen: v.lastSeen,
    attestationRate: attestationRate(events, v.id, windowRounds),
  }));

  rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows;
}

/** Truncate a long id (e.g. an address) for display. */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
