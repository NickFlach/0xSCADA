/**
 * Validator Dashboard API contract (issue #453).
 *
 * The browser NEVER talks to an oxscada node. It calls the same-origin,
 * authenticated `GET /api/validators` proxy, which polls the operator-configured
 * `ANCHOR_NODE_URLS` server-side and returns the aggregated view defined here.
 * Keeping the contract in `shared/` means the server response and the client
 * parser are validated against a single Zod schema.
 *
 * PROVENANCE WARNING — read before treating any of this as fact.
 * The oxscada `:9090` `/status` RPC returns an unsigned JSON document. This
 * repository has no registry of validator public keys, so the proxy cannot
 * verify that a node's claimed validator set is authentic: a node can report an
 * arbitrary peer list, arbitrary phases and an arbitrary order parameter. Every
 * response therefore carries an explicit `provenance` block with
 * `verified: false`, and the dashboard renders it. Do not use this surface as
 * the basis for an operator action that assumes attested facts.
 */

import { z } from 'zod';

// ─── Provenance ─────────────────────────────────────────────────────────────

/** How (or whether) node-reported data was cryptographically authenticated. */
export const validatorProvenanceSchema = z.object({
  /**
   * True only when every included node response was verified against a
   * registered public key. Currently always false — see `method`/`detail`.
   */
  verified: z.boolean(),
  /** Verification algorithm actually applied. `none` means no verification ran. */
  method: z.enum(['none', 'ed25519']),
  /** Operator-readable explanation of the verification status. */
  detail: z.string(),
});
export type ValidatorProvenance = z.infer<typeof validatorProvenanceSchema>;

/**
 * The single provenance value this build can honestly report.
 *
 * Signature verification is not implemented here because the two things it
 * needs do not exist on this branch: the oxscada `/status` response carries no
 * signature field (see `docs/blockchain/validator-monitoring.md` for the
 * authoritative schema), and there is no registered-validator-pubkey store to
 * verify one against. Issue #454 is the work item that introduces per-node
 * response-signature verification; when it lands, this constant is replaced by
 * a real per-node verification result rather than a fixed value.
 */
export const UNVERIFIED_NODE_REPORT: ValidatorProvenance = Object.freeze({
  verified: false,
  method: 'none',
  detail:
    'Node-reported and unsigned. The oxscada /status RPC returns no signature and this ' +
    'deployment has no registered validator public keys, so a node can report an arbitrary ' +
    'validator set. Treat as advisory telemetry, not attested fact.',
});

// ─── Per-validator phase sample (from a node /status) ────────────────────────

/**
 * One oscillator in the Kuramoto coupling model, as reported by a node.
 * Field names map 1:1 onto `0xSCADA-node`'s `/status` payload:
 *   id                    ← `node_id` (or `peer_phases[].node_id`)
 *   phase                 ← `local_phase` / `peer_phases[].phase`
 *   naturalFrequency      ← `peer_phases[].natural_freq`
 *   lastUpdatedUnixSeconds← `peer_phases[].last_updated`
 */
export const validatorPhaseSampleSchema = z.object({
  id: z.string().min(1),
  /** Oscillator phase in radians. */
  phase: z.number(),
  /**
   * Natural frequency (Hz). Null for the reporting node's own entry: `/status`
   * exposes `local_phase` but no local natural frequency.
   */
  naturalFrequency: z.number().nullable(),
  /**
   * `last_updated` exactly as the node reported it — UNIX SECONDS per the
   * documented node schema. Null for the reporting node's own entry, which
   * `/status` does not timestamp per-oscillator.
   */
  lastUpdatedUnixSeconds: z.number().nullable(),
  /** True when this sample is the reporting node's own `local_phase`. */
  self: z.boolean(),
  /** Display label of the node that reported this sample. */
  reportedBy: z.string(),
});
export type ValidatorPhaseSample = z.infer<typeof validatorPhaseSampleSchema>;

// ─── Per-node view ───────────────────────────────────────────────────────────

/** One `peer_phases[]` entry of an oxscada `/status` payload, camel-cased. */
export const peerPhaseViewSchema = z.object({
  nodeId: z.string(),
  phase: z.number(),
  naturalFrequency: z.number(),
  /** `last_updated` as reported — UNIX SECONDS per the documented node schema. */
  lastUpdatedUnixSeconds: z.number(),
});
export type PeerPhaseView = z.infer<typeof peerPhaseViewSchema>;

/** The subset of an oxscada `/status` payload the dashboard renders. */
export const nodeStatusViewSchema = z.object({
  nodeId: z.string(),
  height: z.number(),
  role: z.string(),
  /** Kuramoto order parameter as SELF-REPORTED by this node (0..1). */
  reportedOrderParameter: z.number(),
  reportedMeanPhase: z.number(),
  localPhase: z.number(),
  peers: z.number(),
  mempool: z.number(),
  uptimeTicks: z.number(),
  peerPhases: z.array(peerPhaseViewSchema),
});
export type NodeStatusView = z.infer<typeof nodeStatusViewSchema>;

export const validatorNodeViewSchema = z.object({
  /**
   * Host[:port] of the configured node URL. Deliberately scheme-less and
   * path-less: it identifies the node for troubleshooting without handing the
   * browser a fetchable endpoint.
   */
  label: z.string(),
  reachable: z.boolean(),
  /** Populated when the poll failed; null on success. */
  error: z.string().nullable(),
  /** Server wall-clock millis at which this sample was taken. */
  observedAt: z.number().int().nonnegative(),
  status: nodeStatusViewSchema.nullable(),
});
export type ValidatorNodeView = z.infer<typeof validatorNodeViewSchema>;

// ─── Merged validator row ────────────────────────────────────────────────────

export const validatorRowSchema = z.object({
  id: z.string().min(1),
  phase: z.number(),
  naturalFrequency: z.number().nullable(),
  lastUpdatedUnixSeconds: z.number().nullable(),
  /** Labels of every node that reported this validator, sorted. */
  reportedBy: z.array(z.string()),
  /**
   * True when reporting nodes disagree about this validator's phase by more
   * than `PHASE_DISAGREEMENT_RADIANS`. Unsigned reports make disagreement the
   * only divergence signal available, so it is surfaced rather than averaged away.
   */
  disputed: z.boolean(),
});
export type ValidatorRow = z.infer<typeof validatorRowSchema>;

// ─── Coherence ───────────────────────────────────────────────────────────────

export const coherenceSchema = z.object({
  /** Kuramoto order parameter r ∈ [0,1] derived from the merged phase set. */
  r: z.number(),
  /** Mean phase ψ (radians). */
  meanPhase: z.number(),
  /** Number of oscillators that contributed. */
  count: z.number().int().nonnegative(),
});
export type Coherence = z.infer<typeof coherenceSchema>;

// ─── Metrics the node RPC cannot supply ──────────────────────────────────────

/**
 * Machine-readable "we do not have this" list. Sub-wave 2a asked for
 * per-round attestation health and anchor-batch throughput; the oxscada
 * `:9090` surface exposes neither, so they are declared missing instead of
 * being synthesised.
 */
export const unavailableMetricSchema = z.object({
  metric: z.string(),
  reason: z.string(),
});
export type UnavailableMetric = z.infer<typeof unavailableMetricSchema>;

// ─── Aggregate response ──────────────────────────────────────────────────────

export const validatorOverviewSchema = z.object({
  /** False when ANCHOR_NODE_URLS is unset: no outbound request is made at all. */
  configured: z.boolean(),
  /** Server wall-clock millis the aggregate was produced. */
  generatedAt: z.number().int().nonnegative(),
  /**
   * True when this body was served from the server-side cache rather than a
   * fresh poll. The cache bounds outbound load independent of client count.
   */
  cached: z.boolean(),
  provenance: validatorProvenanceSchema,
  nodes: z.array(validatorNodeViewSchema),
  validators: z.array(validatorRowSchema),
  coherence: coherenceSchema,
  unavailableMetrics: z.array(unavailableMetricSchema),
});
export type ValidatorOverview = z.infer<typeof validatorOverviewSchema>;
