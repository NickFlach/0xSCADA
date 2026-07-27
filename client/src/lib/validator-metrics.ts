/**
 * validator-metrics.ts — PURE presentation logic for the Validator Dashboard.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * Everything here is a pure function of its inputs (no fetch, no React, no
 * implicit clock — `now` is always passed in). The numeric aggregation the
 * dashboard displays (Kuramoto coherence, phase merge) is computed server-side
 * in `server/blockchain/validator-dashboard.ts` from the data the server itself
 * polled; this module only classifies and formats what the API returned.
 *
 * CLOCK DISCIPLINE: three different clocks appear in the payload and mixing them
 * silently would produce nonsense ages, so each helper states which one it uses.
 *   - client clock  → how old the last successful API response is
 *   - server clock  → `generatedAt` / `observedAt`, comparable only to each other
 *   - node clock    → `lastUpdatedUnixSeconds`, set by the reporting node
 */

import type {
  ValidatorNodeView,
  ValidatorOverview,
  ValidatorRow,
} from '@shared/types/services/validator-dashboard';

// ─── Staleness ───────────────────────────────────────────────────────────────

/**
 * The dashboard is "stale" when the last successful `/api/validators` response
 * is older than this. The verification criterion for #453 is that killing a
 * validator shows up in under 10s, so the threshold sits below that and the
 * poll interval sits well below the threshold.
 */
export const STALE_THRESHOLD_MS = 8000;

export type NodeHealth = 'live' | 'stale' | 'error';

/**
 * Classify one node row.
 *
 * `overviewAgeMs` is measured on the CLIENT clock: it is `Date.now()` minus the
 * moment this browser received the overview. It is never derived from the
 * server's `generatedAt`, because the two clocks are unrelated.
 *
 * - 'error' → the server could not reach or parse this node on its last poll.
 * - 'stale' → the node answered, but the whole overview is older than the
 *             threshold (poll stopped, request failing, tab suspended).
 * - 'live'  → reachable and fresh.
 */
export function classifyNodeHealth(
  node: Pick<ValidatorNodeView, 'reachable'>,
  overviewAgeMs: number,
  thresholdMs: number = STALE_THRESHOLD_MS,
): NodeHealth {
  if (!node.reachable) return 'error';
  if (overviewAgeMs >= thresholdMs) return 'stale';
  return 'live';
}

/**
 * How far behind the aggregate a single node's sample was, in millis.
 * Both operands are the SERVER's clock, so this comparison is well-defined.
 * Negative skew is clamped to 0.
 */
export function nodeSampleLagMs(
  overview: Pick<ValidatorOverview, 'generatedAt'>,
  node: Pick<ValidatorNodeView, 'observedAt'>,
): number {
  return Math.max(0, overview.generatedAt - node.observedAt);
}

/** Human "Ns ago" style age string. */
export function formatAge(ageMs: number): string {
  const clamped = ageMs < 0 ? 0 : ageMs;
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/**
 * Age of a validator's phase sample, in millis, or null when the node did not
 * timestamp it (`/status` carries no per-oscillator timestamp for a node's own
 * `local_phase`).
 *
 * CAVEAT: `lastUpdatedUnixSeconds` comes from the reporting NODE's clock while
 * `generatedAt` comes from the server's. A skewed node produces a skewed age,
 * which is exactly why the dashboard labels this column as node-reported.
 */
export function validatorSampleAgeMs(
  row: Pick<ValidatorRow, 'lastUpdatedUnixSeconds'>,
  generatedAtMs: number,
): number | null {
  if (row.lastUpdatedUnixSeconds === null) return null;
  return Math.max(0, generatedAtMs - row.lastUpdatedUnixSeconds * 1000);
}

// ─── Coherence thresholds ────────────────────────────────────────────────────

/** Default coherence floor below which the indicator turns red. */
export const COHERENCE_RED_THRESHOLD = 0.7;

/** Whether a coherence value is below the alarm threshold (turns red). */
export function isCoherenceCritical(r: number, threshold: number = COHERENCE_RED_THRESHOLD): boolean {
  return r < threshold;
}

/**
 * Largest absolute gap between the coherence the server derived from the merged
 * phase set and what each node self-reported as its `order_parameter`, or null
 * when no reachable node reported one.
 *
 * A large gap means the nodes' own claim disagrees with the arithmetic on the
 * phases they published. With unsigned reports that is the only cross-check
 * available, so it is surfaced rather than hidden.
 */
export function orderParameterDivergence(overview: ValidatorOverview): number | null {
  let worst: number | null = null;
  for (const node of overview.nodes) {
    if (!node.status) continue;
    const gap = Math.abs(node.status.reportedOrderParameter - overview.coherence.r);
    if (worst === null || gap > worst) worst = gap;
  }
  return worst;
}

/** Truncate a long id (e.g. a hex node id) for display. */
export function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
