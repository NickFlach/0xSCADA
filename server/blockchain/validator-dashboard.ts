/**
 * Validator Dashboard aggregation (issue #453).
 *
 * Server-side companion to `GET /api/validators`. The browser must never reach
 * an oxscada node directly — doing so breaks under TLS (mixed content) and
 * depends on every node running permissive CORS — so all `:9090` polling happens
 * here, from the operator-configured `ANCHOR_NODE_URLS`.
 *
 * The `/status` wire schema is NOT redefined here. It is parsed with
 * `parseOxscadaStatus` from `./validator-health`, which mirrors the authoritative
 * `0xSCADA-node/src/rpc.rs` shape (see docs/blockchain/validator-monitoring.md).
 *
 * PROVENANCE: `/status` responses are unsigned and this deployment holds no
 * registered validator public keys, so nothing here is cryptographically
 * verified. Every aggregate carries `UNVERIFIED_NODE_REPORT` and the dashboard
 * renders it. See the note on that constant for why verification is deferred to
 * issue #454 rather than faked here.
 *
 * BOUNDING: a slow or hostile node must not be able to hang `/api/validators`.
 * Every outbound request is bounded by (a) a per-request timeout that also
 * covers the body read, (b) a response byte cap, (c) a cap on how many fetches
 * run concurrently, and (d) exactly one attempt — there is no retry. A short
 * response cache with in-flight de-duplication bounds outbound load regardless
 * of how many operators have the dashboard open.
 */

import {
  UNVERIFIED_NODE_REPORT,
  type Coherence,
  type UnavailableMetric,
  type ValidatorNodeView,
  type ValidatorOverview,
  type ValidatorPhaseSample,
  type ValidatorRow,
} from '@shared/types/services/validator-dashboard';
import { parseOxscadaStatus, type OxscadaStatus } from './validator-health';

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Hard cap on configured nodes, independent of how long the env value is. */
export const MAX_NODES = 32;
/** Largest `/status` body accepted from a node before the read is aborted. */
export const MAX_RESPONSE_BYTES = 256 * 1024;

const TIMEOUT_MS_DEFAULT = 3_000;
const TIMEOUT_MS_MIN = 250;
const TIMEOUT_MS_MAX = 10_000;

const CONCURRENCY_DEFAULT = 4;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 16;

const CACHE_TTL_MS_DEFAULT = 2_000;
const CACHE_TTL_MS_MIN = 0;
const CACHE_TTL_MS_MAX = 60_000;

/**
 * Two reporting nodes whose phase samples for the same validator differ by more
 * than this are treated as disagreeing rather than silently merged.
 */
export const PHASE_DISAGREEMENT_RADIANS = 0.05;

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ValidatorDashboardConfig {
  /** Normalised node base URLs. Empty means the feature is not configured. */
  nodeUrls: string[];
  timeoutMs: number;
  maxConcurrency: number;
  cacheTtlMs: number;
}

/**
 * Parse the `ANCHOR_NODE_URLS` csv into normalised, de-duplicated base URLs.
 *
 * Only `http:` and `https:` are accepted — an operator typo must not turn into
 * a `file:` or `data:` read. Unparseable and non-HTTP entries are dropped rather
 * than throwing, so one bad entry cannot take the whole dashboard down. The
 * result is capped at `MAX_NODES`. Pure; exported for tests.
 */
export function parseNodeUrls(csv: string | undefined | null): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_NODES) break;
  }
  return out;
}

/**
 * Display label for a node: host[:port] only. Deliberately scheme-less and
 * path-less so the response identifies a node for troubleshooting without
 * handing the browser something it could fetch.
 */
export function nodeLabel(nodeUrl: string): string {
  try {
    return new URL(nodeUrl).host;
  } catch {
    return nodeUrl;
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Read the dashboard configuration from the environment. Pure in `env`. */
export function loadValidatorDashboardConfig(
  env: NodeJS.ProcessEnv = process.env,
): ValidatorDashboardConfig {
  return {
    nodeUrls: parseNodeUrls(env.ANCHOR_NODE_URLS),
    timeoutMs: clampInt(env.VALIDATOR_RPC_TIMEOUT_MS, TIMEOUT_MS_DEFAULT, TIMEOUT_MS_MIN, TIMEOUT_MS_MAX),
    maxConcurrency: clampInt(
      env.VALIDATOR_RPC_MAX_CONCURRENCY,
      CONCURRENCY_DEFAULT,
      CONCURRENCY_MIN,
      CONCURRENCY_MAX,
    ),
    cacheTtlMs: clampInt(env.VALIDATOR_RPC_CACHE_TTL_MS, CACHE_TTL_MS_DEFAULT, CACHE_TTL_MS_MIN, CACHE_TTL_MS_MAX),
  };
}

// ─── Bounded transport ───────────────────────────────────────────────────────

/** Injectable for tests; defaults to the global fetch (Node 18+). */
export type DashboardFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/**
 * Read a response body with a hard byte cap. A hostile node that answers fast
 * but never stops would otherwise be limited only by the request timeout, which
 * is long enough to stream a great deal of memory into the process.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`response body exceeds the ${maxBytes}-byte cap (content-length ${size})`);
    }
  }

  const body = res.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response body exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    // Releases the connection when we bailed out early; a no-op once drained.
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface PollOptions {
  timeoutMs: number;
  fetchImpl?: DashboardFetch;
  maxResponseBytes?: number;
  /** Wall clock, injectable so aggregation is deterministic in tests. */
  now?: () => number;
}

/**
 * Describe why a poll failed, in terms an operator can act on.
 *
 * `fetch` reports every connection-level failure with the same opaque message,
 * "fetch failed", and puts the actionable reason on `err.cause` — an
 * `AggregateError` when several addresses were tried. That message is the ONLY
 * record of why a node was unreachable: it becomes `ValidatorNodeView.error` on
 * the dashboard and, via `classifyObservation`, the `detail` column of every
 * `miss` row in `validator_liveness_observations`. "fetch failed" alone cannot
 * tell an operator auditing a slashing projection whether the node was down
 * (ECONNREFUSED), the hostname does not resolve (ENOTFOUND), or the poll timed
 * out — three findings with three different responses.
 *
 * Only the error CODE is appended, never the cause's message: causes embed the
 * address that was dialled, which is exactly the topology detail the URL is
 * deliberately kept out of. An aborted request is reported as a timeout,
 * because the abort signal here has one cause — `options.timeoutMs` elapsing.
 *
 * Pure; exported for tests.
 */
export function describeFetchFailure(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === 'AbortError') {
    return `${base} (timeout)`;
  }

  // Walk the cause chain, and the branches of any AggregateError within it, for
  // the first errno-style code. Depth-bounded so a self-referential cause (or a
  // hostile deep chain) cannot spin here.
  const queue: unknown[] = [err];
  for (let depth = 0; depth < 8 && queue.length > 0; depth += 1) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null) continue;
    const code = (current as { code?: unknown }).code;
    // errno-style codes only (ECONNREFUSED, ENOTFOUND, ...); a numeric or
    // free-text `code` carries nothing an operator can look up.
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,31}$/.test(code)) {
      return base.includes(code) ? base : `${base} (${code})`;
    }
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      // Push branch-by-branch, never `push(...errors)`: the array width is one
      // entry per address the resolver returned, so it is not ours to choose,
      // and spreading a wide one overflows the argument stack. This function
      // throwing would break `pollNodeStatus`'s documented contract that it
      // never throws — costing the whole poll round, not one node's row. Only
      // as many branches as the depth bound can examine are queued at all.
      for (const branch of errors.slice(0, 8)) queue.push(branch);
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause !== undefined) queue.push(cause);
  }

  return base;
}

/**
 * Poll one node's `/status`. Exactly one attempt, no retry. Never throws:
 * failures are captured into the returned view so one dead node cannot fail the
 * whole request.
 */
export async function pollNodeStatus(
  nodeUrl: string,
  options: PollOptions,
): Promise<ValidatorNodeView> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const now = options.now ?? Date.now;
  const label = nodeLabel(nodeUrl);

  const controller = new AbortController();
  // The timer covers the body read as well as the headers, so a node that
  // answers immediately and then trickles bytes is still bounded.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetchImpl(`${nodeUrl}/status`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`/status returned HTTP ${res.status}`);
    }
    const text = await readBoundedText(res, maxBytes);
    const parsed = parseOxscadaStatus(JSON.parse(text) as unknown);
    return {
      label,
      reachable: true,
      error: null,
      observedAt: now(),
      status: toStatusView(parsed),
    };
  } catch (err) {
    const message = describeFetchFailure(err);
    return {
      label,
      reachable: false,
      // The message can echo node-controlled text, so keep it short and never
      // include the full URL (which may carry internal topology detail).
      error: message.slice(0, 200),
      observedAt: now(),
      status: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function toStatusView(status: OxscadaStatus): NonNullable<ValidatorNodeView['status']> {
  return {
    nodeId: status.node_id,
    height: status.height,
    role: status.role,
    reportedOrderParameter: status.order_parameter,
    reportedMeanPhase: status.mean_phase,
    localPhase: status.local_phase,
    peers: status.peers,
    mempool: status.mempool,
    uptimeTicks: status.uptime_ticks,
    peerPhases: status.peer_phases.map((peer) => ({
      nodeId: peer.node_id,
      phase: peer.phase,
      naturalFrequency: peer.natural_freq,
      lastUpdatedUnixSeconds: peer.last_updated,
    })),
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 * Pure control flow; exported for tests.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.trunc(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(effectiveLimit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Aggregation (pure) ──────────────────────────────────────────────────────

/**
 * Kuramoto order parameter r·e^{iψ} = (1/N) Σ e^{iθ_k} — the canonical measure
 * of phase coherence. N=0 gives r=0; N=1 gives r=1 (an oscillator is trivially
 * coherent with itself).
 */
export function kuramotoCoherence(phases: readonly number[]): Coherence {
  const count = phases.length;
  if (count === 0) return { r: 0, meanPhase: 0, count: 0 };

  let sumCos = 0;
  let sumSin = 0;
  for (const phase of phases) {
    sumCos += Math.cos(phase);
    sumSin += Math.sin(phase);
  }
  const meanCos = sumCos / count;
  const meanSin = sumSin / count;
  return {
    r: Math.min(1, Math.hypot(meanCos, meanSin)),
    meanPhase: Math.atan2(meanSin, meanCos),
    count,
  };
}

/**
 * Flatten a node's `/status` into phase samples: the node's own `local_phase`
 * plus every entry of `peer_phases`. `/status` carries no natural frequency or
 * per-oscillator timestamp for the reporting node itself, so those are null
 * rather than borrowed from a peer entry.
 */
export function toPhaseSamples(view: ValidatorNodeView): ValidatorPhaseSample[] {
  const status = view.status;
  if (!status) return [];
  const samples: ValidatorPhaseSample[] = [
    {
      id: status.nodeId,
      phase: status.localPhase,
      naturalFrequency: null,
      lastUpdatedUnixSeconds: null,
      self: true,
      reportedBy: view.label,
    },
  ];
  for (const peer of status.peerPhases) {
    samples.push({
      id: peer.nodeId,
      phase: peer.phase,
      naturalFrequency: peer.naturalFrequency,
      lastUpdatedUnixSeconds: peer.lastUpdatedUnixSeconds,
      self: false,
      reportedBy: view.label,
    });
  }
  return samples;
}

/**
 * Merge phase samples from every reachable node into one row per validator id.
 *
 * The freshest sample (largest `last_updated`) wins; a node's report about
 * itself is preferred over a peer's hearsay at equal freshness. Because no
 * report is authenticated, conflicting phases are not averaged away — the row
 * is flagged `disputed` so an operator can see that reporting nodes disagree.
 */
export function mergeValidatorPhases(samples: readonly ValidatorPhaseSample[]): ValidatorRow[] {
  const byId = new Map<string, { best: ValidatorPhaseSample; reporters: Set<string>; disputed: boolean }>();

  for (const sample of samples) {
    const existing = byId.get(sample.id);
    if (!existing) {
      byId.set(sample.id, { best: sample, reporters: new Set([sample.reportedBy]), disputed: false });
      continue;
    }
    existing.reporters.add(sample.reportedBy);
    if (Math.abs(existing.best.phase - sample.phase) > PHASE_DISAGREEMENT_RADIANS) {
      existing.disputed = true;
    }
    if (isFresher(sample, existing.best)) {
      existing.best = sample;
    }
  }

  const rows: ValidatorRow[] = [...byId.values()].map((entry) => ({
    id: entry.best.id,
    phase: entry.best.phase,
    naturalFrequency: entry.best.naturalFrequency,
    lastUpdatedUnixSeconds: entry.best.lastUpdatedUnixSeconds,
    reportedBy: [...entry.reporters].sort(),
    disputed: entry.disputed,
  }));

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

function isFresher(candidate: ValidatorPhaseSample, incumbent: ValidatorPhaseSample): boolean {
  const candidateTs = candidate.lastUpdatedUnixSeconds;
  const incumbentTs = incumbent.lastUpdatedUnixSeconds;
  if (candidateTs !== null && incumbentTs !== null) return candidateTs > incumbentTs;
  // A node's own report is first-hand; prefer it when timestamps cannot decide.
  if (candidate.self !== incumbent.self) return candidate.self;
  return candidateTs !== null && incumbentTs === null;
}

/**
 * Metrics sub-wave 2a asked for that the oxscada `:9090` RPC does not expose.
 * Declared explicitly instead of being synthesised from a placeholder source.
 */
export const UNAVAILABLE_METRICS: readonly UnavailableMetric[] = Object.freeze([
  Object.freeze({
    metric: 'attestation-rate-per-round',
    reason:
      'The oxscada /status RPC reports phase, height, peers and mempool but no per-round ' +
      'attest/miss record, and /events carries bridged SCADA events rather than consensus ' +
      'attestations. No attestation rate is computed.',
  }),
  Object.freeze({
    metric: 'anchor-batch-throughput',
    reason:
      'No anchor-batch counters exist on the oxscada /status RPC and this server exposes no ' +
      'batch-anchoring metrics source. No throughput series is computed.',
  }),
]);

/** Assemble the response body from already-polled node views. Pure. */
export function buildOverview(
  nodes: readonly ValidatorNodeView[],
  options: { configured: boolean; generatedAt: number; cached: boolean },
): ValidatorOverview {
  const samples = nodes.flatMap(toPhaseSamples);
  const validators = mergeValidatorPhases(samples);
  return {
    configured: options.configured,
    generatedAt: options.generatedAt,
    cached: options.cached,
    provenance: UNVERIFIED_NODE_REPORT,
    nodes: [...nodes],
    validators,
    coherence: kuramotoCoherence(validators.map((row) => row.phase)),
    unavailableMetrics: [...UNAVAILABLE_METRICS],
  };
}

// ─── Cached, single-flight collection ────────────────────────────────────────

export interface CollectOptions {
  config?: ValidatorDashboardConfig;
  fetchImpl?: DashboardFetch;
  now?: () => number;
}

/**
 * Poll every configured node once, bounded by the configured concurrency, and
 * build the aggregate. No caching — `getValidatorOverview` layers that on top.
 */
export async function collectValidatorOverview(
  options: CollectOptions = {},
): Promise<ValidatorOverview> {
  const config = options.config ?? loadValidatorDashboardConfig();
  const now = options.now ?? Date.now;

  if (config.nodeUrls.length === 0) {
    return buildOverview([], { configured: false, generatedAt: now(), cached: false });
  }

  const nodes = await mapWithConcurrency(config.nodeUrls, config.maxConcurrency, (nodeUrl) =>
    pollNodeStatus(nodeUrl, {
      timeoutMs: config.timeoutMs,
      fetchImpl: options.fetchImpl,
      now,
    }),
  );

  return buildOverview(nodes, { configured: true, generatedAt: now(), cached: false });
}

interface CacheEntry {
  overview: ValidatorOverview;
  expiresAt: number;
}

let cached: CacheEntry | undefined;
let inFlight: Promise<ValidatorOverview> | undefined;

/**
 * Cached, de-duplicated view used by the HTTP route. Concurrent requests share
 * one poll and a fresh result is reused for `cacheTtlMs`, so the outbound load
 * on the node fleet is bounded no matter how many dashboards are open.
 */
export async function getValidatorOverview(options: CollectOptions = {}): Promise<ValidatorOverview> {
  const config = options.config ?? loadValidatorDashboardConfig();
  const now = options.now ?? Date.now;
  const at = now();

  if (cached && cached.expiresAt > at) {
    return { ...cached.overview, cached: true };
  }
  if (inFlight) {
    const shared = await inFlight;
    return { ...shared, cached: true };
  }

  const request = collectValidatorOverview({ ...options, config, now })
    .then((overview) => {
      cached = { overview, expiresAt: now() + config.cacheTtlMs };
      return overview;
    })
    .finally(() => {
      inFlight = undefined;
    });

  inFlight = request;
  return request;
}

/** Test hook: drop the cached aggregate and any in-flight poll. */
export function _resetValidatorDashboardCache(): void {
  cached = undefined;
  inFlight = undefined;
}
