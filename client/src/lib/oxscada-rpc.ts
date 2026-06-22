/**
 * oxscada-rpc.ts — Typed client for the oxscada node :9090 RPC.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * The oxscada Rust node exposes a small read-only HTTP RPC on port 9090 with two
 * endpoints consumed by the operator dashboard:
 *   - GET /status  → a snapshot of this node's validator + anchor-batch state
 *   - GET /events  → a bounded window of recent attestation / anchor events
 *
 * This module defines a MINIMAL, locally-owned typed contract for those payloads
 * plus thin fetch wrappers. The shapes mirror the `/api/blockchain/*` surface that
 * the validator-monitor rewrite (issue #442) exposes server-side, but because this
 * branch is cut from `main` we cannot import #442's types. We therefore define a
 * minimal local version here and validate at the seam with Zod (repo convention).
 *
 * INTEGRATION (#442): when #442 lands its validator-monitor types under
 * `@shared/types/services/blockchain`, replace the local Zod schemas below with the
 * shared ones (or have #442 re-export `ValidatorStatus` / `AnchorEvent`) and drop
 * the duplicated definitions. The wire field names here are the integration contract.
 *
 * Pure aggregation/coherence/stale logic lives in `./validator-metrics` so it is
 * unit-testable without a live node.
 */

import { z } from 'zod';

// ─── Wire schemas (validated at the network boundary) ───────────────────────

/** Phase of a validator in the Kuramoto-style coupling model (radians, 0..2π). */
export const validatorPhaseSchema = z.object({
  /** Stable validator identity (address or node id). */
  id: z.string().min(1),
  /** Human-readable label, falls back to a truncated id when absent. */
  label: z.string().optional(),
  /** Current oscillator phase in radians. */
  phase: z.number(),
  /** Natural frequency in Hz (rounds per second the validator is driving). */
  frequency: z.number(),
  /** Unix epoch millis the node last produced this sample. */
  lastSeen: z.number().int().nonnegative(),
});
export type ValidatorPhase = z.infer<typeof validatorPhaseSchema>;

/** Per-node anchor-batch throughput counters (monotonic since node start). */
export const anchorStatsSchema = z.object({
  /** Total batches anchored. */
  batchesAnchored: z.number().int().nonnegative(),
  /** Total transactions across all batches. */
  txsAnchored: z.number().int().nonnegative(),
  /** Total bytes anchored. */
  bytesAnchored: z.number().int().nonnegative(),
  /** Size (tx count) of the most recent batches, newest last. */
  recentBatchSizes: z.array(z.number().int().nonnegative()).default([]),
});
export type AnchorStats = z.infer<typeof anchorStatsSchema>;

/**
 * GET /status response — a single node's view of the validator set + its anchor
 * throughput. The node reports the full validator set it observes (incl. itself).
 */
export const nodeStatusSchema = z.object({
  /** Node id reporting this status. */
  nodeId: z.string().min(1),
  /** Round / height the node currently observes. */
  round: z.number().int().nonnegative(),
  /** Validators observed by this node (Kuramoto oscillators). */
  validators: z.array(validatorPhaseSchema),
  /** Anchor-batch throughput counters. */
  anchors: anchorStatsSchema,
  /** Unix epoch millis the node generated this status. */
  timestamp: z.number().int().nonnegative(),
});
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

/** A single attestation/anchor event from GET /events. */
export const validatorEventSchema = z.object({
  /** Unix epoch millis. */
  timestamp: z.number().int().nonnegative(),
  /** Round this event belongs to. */
  round: z.number().int().nonnegative(),
  /** Validator that produced the event. */
  validatorId: z.string().min(1),
  /** Event kind. `attest` events count toward the attestation rate. */
  kind: z.enum(['attest', 'miss', 'anchor', 'phase']),
  /** Optional batch size when kind === 'anchor'. */
  batchSize: z.number().int().nonnegative().optional(),
  /** Optional byte count when kind === 'anchor'. */
  bytes: z.number().int().nonnegative().optional(),
});
export type ValidatorEvent = z.infer<typeof validatorEventSchema>;

export const eventsResponseSchema = z.object({
  nodeId: z.string().min(1),
  events: z.array(validatorEventSchema),
});
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

// ─── Environment configuration ──────────────────────────────────────────────

/**
 * Parse the ANCHOR_NODE_URLS csv env value into a normalized, de-duplicated list
 * of node base URLs (no trailing slash). Pure — exported for unit tests.
 *
 * Accepts comma and/or whitespace separated entries. Blank entries are dropped.
 */
export function parseNodeUrls(csv: string | undefined | null): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Resolve the configured node URLs from Vite env (client-side). Vite only exposes
 * vars prefixed with VITE_, so the operator sets `VITE_ANCHOR_NODE_URLS`. We also
 * accept a bare `ANCHOR_NODE_URLS` for parity with the issue's naming when the
 * build injects it. Falls back to a single local node default.
 */
export function getConfiguredNodeUrls(): string[] {
  // import.meta.env is typed loosely; read defensively without `any`.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const csv = env.VITE_ANCHOR_NODE_URLS ?? env.ANCHOR_NODE_URLS;
  const parsed = parseNodeUrls(csv);
  return parsed.length > 0 ? parsed : ['http://localhost:9090'];
}

// ─── Fetch wrappers ─────────────────────────────────────────────────────────

/** Error carrying the offending node URL so the UI can attribute failures. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly nodeUrl: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

const DEFAULT_TIMEOUT_MS = 4000;

async function fetchJson(url: string, nodeUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Chain an externally provided signal (e.g. component unmount) into ours.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new RpcError(`HTTP ${res.status} from ${url}`, nodeUrl);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError(`request to ${url} failed`, nodeUrl, err);
  } finally {
    clearTimeout(timer);
  }
}

export interface RpcClientOptions {
  /** Per-request timeout; a node that does not answer within this becomes stale. */
  timeoutMs?: number;
  /** Abort signal to cancel in-flight requests (component unmount). */
  signal?: AbortSignal;
}

/** GET {nodeUrl}/status, validated. Throws RpcError on transport/parse failure. */
export async function fetchNodeStatus(nodeUrl: string, opts: RpcClientOptions = {}): Promise<NodeStatus> {
  const data = await fetchJson(`${nodeUrl}/status`, nodeUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  const parsed = nodeStatusSchema.safeParse(data);
  if (!parsed.success) {
    throw new RpcError(`malformed /status from ${nodeUrl}: ${parsed.error.message}`, nodeUrl, parsed.error);
  }
  return parsed.data;
}

/** GET {nodeUrl}/events, validated. Throws RpcError on transport/parse failure. */
export async function fetchNodeEvents(nodeUrl: string, opts: RpcClientOptions = {}): Promise<EventsResponse> {
  const data = await fetchJson(`${nodeUrl}/events`, nodeUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  const parsed = eventsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new RpcError(`malformed /events from ${nodeUrl}: ${parsed.error.message}`, nodeUrl, parsed.error);
  }
  return parsed.data;
}

/** Combined per-node poll result, with both calls attempted independently. */
export interface NodePollResult {
  nodeUrl: string;
  /** Wall-clock millis when this poll completed (used for stale detection). */
  fetchedAt: number;
  status: NodeStatus | null;
  events: ValidatorEvent[];
  /** Populated when either call failed. */
  error: string | null;
}

/**
 * Poll one node's /status and /events together. Never throws — failures are
 * captured into `error` so the UI can mark the row stale/errored independently.
 */
export async function pollNode(nodeUrl: string, opts: RpcClientOptions = {}): Promise<NodePollResult> {
  const [statusRes, eventsRes] = await Promise.allSettled([
    fetchNodeStatus(nodeUrl, opts),
    fetchNodeEvents(nodeUrl, opts),
  ]);

  const status = statusRes.status === 'fulfilled' ? statusRes.value : null;
  const events = eventsRes.status === 'fulfilled' ? eventsRes.value.events : [];

  let error: string | null = null;
  if (statusRes.status === 'rejected') {
    error = statusRes.reason instanceof Error ? statusRes.reason.message : String(statusRes.reason);
  } else if (eventsRes.status === 'rejected') {
    error = eventsRes.reason instanceof Error ? eventsRes.reason.message : String(eventsRes.reason);
  }

  return { nodeUrl, fetchedAt: Date.now(), status, events, error };
}
