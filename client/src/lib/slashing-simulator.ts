/**
 * Slashing & Liveness Simulator — PURE-FUNCTIONAL rule evaluator (issue #456).
 *
 * This module contains NO side effects: every function takes its inputs and
 * returns new values. It never mutates its arguments, never touches the network
 * or DB, and never performs any actual slashing. It is a read + projection only,
 * satisfying the acceptance criterion "No mutations — pure read + projection".
 *
 * Design goals:
 *  - Deterministic: identical inputs always yield identical outputs.
 *  - Exhaustively unit-testable without any external system present.
 *  - Faithful to the operator phrasing
 *    "slash {penaltyPctPerMiss}% per miss after {missThreshold} in {window}".
 *
 * It is imported by client/src/pages/SlashingVisualizer.tsx for the UI, and by
 * the test suite for the hand-computed-expectation replay test.
 */

import type {
  AttestationRecord,
  AttestationStatus,
  LivenessFaultRun,
  ParticipationSummary,
  PenaltyEvent,
  SimulationResult,
  SlashingRule,
  TimelineWindow,
  ValidatorHistory,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

// Default rule fields when omitted.
const DEFAULT_MAX_PENALTY_PCT = 100;
const DEFAULT_LIVENESS_RUN_THRESHOLD = 3;

/**
 * Return a NEW array of records sorted ascending by slot. Pure — the input is
 * not mutated (we copy before sorting). Stable for equal slots.
 */
export function sortRecords(records: readonly AttestationRecord[]): AttestationRecord[] {
  return [...records].sort((a, b) => a.slot - b.slot);
}

/**
 * Filter records to those whose timestamp falls within `windowMs` of `now`
 * (i.e. timestamp >= now - windowMs). Returns a new array; input untouched.
 *
 * When `now` is omitted, the latest record timestamp is used as the anchor so
 * that fixed test fixtures behave deterministically regardless of wall clock.
 */
export function filterToWindow(
  records: readonly AttestationRecord[],
  window: TimelineWindow,
  now?: number,
): AttestationRecord[] {
  if (records.length === 0) return [];
  const sorted = sortRecords(records);
  const anchor = now ?? sorted[sorted.length - 1].timestamp;
  const cutoff = anchor - WINDOW_MS[window];
  return sorted.filter((r) => r.timestamp >= cutoff && r.timestamp <= anchor);
}

/** Count records by status. Pure. */
export function summarize(records: readonly AttestationRecord[]): ParticipationSummary {
  let hits = 0;
  let misses = 0;
  let late = 0;
  for (const r of records) {
    if (r.status === "hit") hits += 1;
    else if (r.status === "miss") misses += 1;
    else if (r.status === "late") late += 1;
  }
  const total = records.length;
  const participating = hits + late;
  return {
    total,
    hits,
    misses,
    late,
    participationRate: total === 0 ? 0 : participating / total,
  };
}

/**
 * Detect runs of CONSECUTIVE misses at or above `threshold` length.
 *
 * "Consecutive" is defined over the ordered record sequence: a `late` or `hit`
 * breaks a run. Records are sorted by slot first so callers may pass unordered
 * input safely. Returns runs in chronological order. Pure.
 */
export function detectLivenessFaults(
  records: readonly AttestationRecord[],
  threshold: number = DEFAULT_LIVENESS_RUN_THRESHOLD,
): LivenessFaultRun[] {
  const safeThreshold = Math.max(1, Math.floor(threshold));
  const sorted = sortRecords(records);
  const runs: LivenessFaultRun[] = [];

  let runStart = -1;
  const flush = (endExclusive: number) => {
    if (runStart === -1) return;
    const length = endExclusive - runStart;
    if (length >= safeThreshold) {
      const startIndex = runStart;
      const endIndex = endExclusive - 1;
      runs.push({
        startIndex,
        endIndex,
        startSlot: sorted[startIndex].slot,
        endSlot: sorted[endIndex].slot,
        length,
        startTimestamp: sorted[startIndex].timestamp,
        endTimestamp: sorted[endIndex].timestamp,
      });
    }
    runStart = -1;
  };

  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].status === "miss") {
      if (runStart === -1) runStart = i;
    } else {
      flush(i);
    }
  }
  flush(sorted.length);

  return runs;
}

/**
 * A `miss` is a "participation miss" for slashing purposes. `late` attestations
 * count as participation and are therefore NOT slashable here. Centralised so
 * the policy is defined in exactly one place.
 */
function isSlashableMiss(status: AttestationStatus): boolean {
  return status === "miss";
}

/**
 * Replay a slashing rule over one validator's history and project the
 * hypothetical penalties. PURE — neither `history` nor `rule` is mutated.
 *
 * Algorithm (sliding-window count of slashable misses):
 *   For each record in chronological order:
 *     - If it is a slashable miss, count how many slashable misses (including
 *       this one) fall within [timestamp - rule.windowMs, timestamp].
 *     - If that running count exceeds `rule.missThreshold`, this miss is
 *       penalised: it contributes `rule.penaltyPctPerMiss`% of stake.
 *   The cumulative penalty is capped at `rule.maxPenaltyPct` (default 100%).
 *
 * Penalties are reported per-miss with the in-window miss count that triggered
 * them, so the UI can show exactly which misses crossed the threshold.
 *
 * @param history  the validator's actual attestation history.
 * @param rule     the proposed (hypothetical) slashing rule.
 * @param window   optional UI window to first restrict the evaluated records.
 *                 When omitted, the ENTIRE history is evaluated.
 * @param now      optional time anchor for window filtering (see filterToWindow).
 */
export function simulateRule(
  history: ValidatorHistory,
  rule: SlashingRule,
  window?: TimelineWindow,
  now?: number,
): SimulationResult {
  const evaluated = window
    ? filterToWindow(history.records, window, now)
    : sortRecords(history.records);

  const maxPenaltyPct = rule.maxPenaltyPct ?? DEFAULT_MAX_PENALTY_PCT;
  const livenessThreshold = rule.livenessRunThreshold ?? DEFAULT_LIVENESS_RUN_THRESHOLD;
  const threshold = Math.max(0, Math.floor(rule.missThreshold));
  const perMissPct = Math.max(0, rule.penaltyPctPerMiss);

  // Indices (into `evaluated`) of slashable misses, used for the sliding window.
  const missTimestamps: number[] = [];
  const penalties: PenaltyEvent[] = [];

  let cumulativePct = 0;

  for (const record of evaluated) {
    if (!isSlashableMiss(record.status)) continue;

    missTimestamps.push(record.timestamp);

    // Count slashable misses within the sliding window ending at this miss.
    const windowStart = record.timestamp - rule.windowMs;
    let missesInWindow = 0;
    for (let k = missTimestamps.length - 1; k >= 0; k -= 1) {
      if (missTimestamps[k] >= windowStart) missesInWindow += 1;
      else break; // timestamps are ascending, so we can stop early.
    }

    // The first `threshold` misses in the window are free. Penalise beyond that.
    if (missesInWindow <= threshold) continue;

    if (cumulativePct >= maxPenaltyPct) {
      // Already capped — record a zero-penalty event so the UI can still show
      // that the threshold was crossed, but apply nothing further.
      penalties.push({
        slot: record.slot,
        timestamp: record.timestamp,
        missesInWindow,
        penaltyPct: 0,
        penaltyAmount: 0,
      });
      continue;
    }

    const remaining = maxPenaltyPct - cumulativePct;
    const appliedPct = Math.min(perMissPct, remaining);
    cumulativePct += appliedPct;

    penalties.push({
      slot: record.slot,
      timestamp: record.timestamp,
      missesInWindow,
      penaltyPct: appliedPct,
      penaltyAmount: (appliedPct / 100) * history.stake,
    });
  }

  const totalPenaltyPct = cumulativePct;
  const totalPenaltyAmount = (cumulativePct / 100) * history.stake;

  return {
    validatorId: history.validatorId,
    evaluated,
    summary: summarize(evaluated),
    penalties,
    livenessFaults: detectLivenessFaults(evaluated, livenessThreshold),
    totalPenaltyPct,
    totalPenaltyAmount,
  };
}

/**
 * Convenience: simulate a rule across many validators. Pure; returns a new map
 * keyed by validatorId. Useful for the page's multi-validator view.
 */
export function simulateAll(
  histories: readonly ValidatorHistory[],
  rule: SlashingRule,
  window?: TimelineWindow,
  now?: number,
): Record<string, SimulationResult> {
  const out: Record<string, SimulationResult> = {};
  for (const h of histories) {
    out[h.validatorId] = simulateRule(h, rule, window, now);
  }
  return out;
}

/**
 * Parse the operator's natural-language rule phrasing into a SlashingRule.
 *
 * Supported (case-insensitive) phrasing:
 *   "slash 1% per miss after 10 in 1h"
 *   "slash 0.5% per miss after 5 in 24h"
 *   "slash 2 percent per miss after 3 misses in 7d"
 *
 * Returns `null` when the phrase cannot be parsed, so the UI can fall back to
 * the structured form fields. Pure — no exceptions thrown for bad input.
 */
export function parseRulePhrase(phrase: string): SlashingRule | null {
  const normalized = phrase.trim().toLowerCase();
  // slash <pct>% per miss after <n> [misses] in <window>
  const re =
    /slash\s+([0-9]*\.?[0-9]+)\s*(?:%|percent)\s+per\s+miss\s+after\s+([0-9]+)\s*(?:misses?)?\s+in\s+(1h|24h|7d)/;
  const m = normalized.match(re);
  if (!m) return null;

  const penaltyPctPerMiss = Number.parseFloat(m[1]);
  const missThreshold = Number.parseInt(m[2], 10);
  const win = m[3] as TimelineWindow;
  if (!Number.isFinite(penaltyPctPerMiss) || !Number.isFinite(missThreshold)) {
    return null;
  }
  if (!(win in WINDOW_MS)) return null;

  return {
    name: phrase.trim(),
    penaltyPctPerMiss,
    missThreshold,
    windowMs: WINDOW_MS[win],
  };
}

/**
 * Bucket records into evenly-sized time buckets for a compact timeline view.
 * Each bucket reports its hit/miss/late counts. Pure.
 *
 * @param records   records to bucket (any order).
 * @param window    window whose duration defines the bucketing span.
 * @param bucketCount number of buckets to split the span into (>= 1).
 * @param now       optional anchor (defaults to latest record timestamp).
 */
export interface TimelineBucket {
  index: number;
  startTime: number;
  endTime: number;
  hits: number;
  misses: number;
  late: number;
  total: number;
}

export function bucketTimeline(
  records: readonly AttestationRecord[],
  window: TimelineWindow,
  bucketCount: number,
  now?: number,
): TimelineBucket[] {
  const count = Math.max(1, Math.floor(bucketCount));
  const span = WINDOW_MS[window];
  const sorted = sortRecords(records);
  const anchor = now ?? (sorted.length ? sorted[sorted.length - 1].timestamp : 0);
  const start = anchor - span;
  const bucketSpan = span / count;

  const buckets: TimelineBucket[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    startTime: start + i * bucketSpan,
    endTime: start + (i + 1) * bucketSpan,
    hits: 0,
    misses: 0,
    late: 0,
    total: 0,
  }));

  for (const r of sorted) {
    if (r.timestamp < start || r.timestamp > anchor) continue;
    let idx = Math.floor((r.timestamp - start) / bucketSpan);
    if (idx >= count) idx = count - 1; // clamp the right edge.
    if (idx < 0) idx = 0;
    const b = buckets[idx];
    if (r.status === "hit") b.hits += 1;
    else if (r.status === "miss") b.misses += 1;
    else if (r.status === "late") b.late += 1;
    b.total += 1;
  }

  return buckets;
}
