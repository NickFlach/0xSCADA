/**
 * Anchor Router (Dual-Anchoring Dispatch)
 *
 * The dispatch layer that the operator-facing Anchor-Backend switch (#455) flips
 * at runtime. It decides which backend(s) a batch of anchorable events is routed
 * to: the L2 rollup (`l2`), the local 0xSCADA node chain (`node`), or `both`.
 *
 * This module is implemented MINIMALLY and independently off `main`. It overlaps
 * conceptually with the dual-anchoring backend decision in #443, but does NOT
 * depend on that branch.
 *
 * INTEGRATION (#443): once #443 lands the real backend clients + the canonical
 * `ANCHOR_BACKEND` env wiring, replace the simulated `dispatch()` bodies below
 * with calls into those clients. The `AnchorBackend` union and `projectSwitch()`
 * projection function are designed to be the stable seam both issues share.
 *
 * The projection logic (`projectSwitch`) is a PURE function with no external
 * dependencies so it is fully unit-testable.
 *
 * Issue: #455 — Anchor-Backend Switch UX
 */

/** The anchoring backends a switch can target. */
export type AnchorBackend = 'l2' | 'node' | 'both';

/** Per-backend operational characteristics used by the projection model. */
export interface BackendProfile {
  /**
   * Per-event anchoring cost in USD. With Merkle batching the marginal per-event
   * cost is small; this captures the amortised cost the operator cares about.
   */
  costPerEventUsd: number;
  /** Typical confirmation latency for this backend, in milliseconds. */
  confirmationLatencyMs: number;
}

/**
 * Default backend profiles. These are conservative public estimates and can be
 * overridden per-call (e.g. once #443 supplies measured values).
 *
 * - `l2`: cheap per event (rollup amortisation) but slower finality.
 * - `node`: the local PoA chain — effectively free, ~one block (5s) latency.
 */
export const DEFAULT_BACKEND_PROFILES: Readonly<Record<'l2' | 'node', BackendProfile>> = {
  l2: { costPerEventUsd: 0.00012, confirmationLatencyMs: 12_000 },
  node: { costPerEventUsd: 0.0, confirmationLatencyMs: 5_000 },
};

/** Inputs to the dry-run projection. */
export interface ProjectionInput {
  /** Proposed backend to route to. */
  backend: AnchorBackend;
  /** Current sustained event throughput in events per minute. */
  eventsPerMinute: number;
  /**
   * Optional override of backend profiles (cost + latency). Useful for tests and
   * for #443 to feed measured values. Missing keys fall back to defaults.
   */
  profiles?: Partial<Record<'l2' | 'node', BackendProfile>>;
}

/** Per-backend routing result inside a projection. */
export interface BackendRouting {
  backend: 'l2' | 'node';
  /** Events/min routed to this backend under the proposed config. */
  eventsPerMinute: number;
  /** Projected confirmation latency for this backend (ms). */
  confirmationLatencyMs: number;
  /** Projected daily anchor cost for this backend (USD). */
  dailyCostUsd: number;
}

/** Output of the dry-run projection. */
export interface SwitchProjection {
  backend: AnchorBackend;
  /** Total events/min entering the router (unchanged by the switch). */
  totalEventsPerMinute: number;
  /** Per-backend breakdown. Backends not targeted are omitted. */
  routes: BackendRouting[];
  /**
   * Effective confirmation latency the operator should expect. For `both` this
   * is the SLOWER of the two backends, since an event is only considered fully
   * anchored once every targeted backend has confirmed it.
   */
  effectiveConfirmationLatencyMs: number;
  /** Sum of per-backend daily costs (USD). */
  totalDailyCostUsd: number;
}

const MINUTES_PER_DAY = 60 * 24;

/** Which concrete backends a target routes to. `both` fans out to each. */
export function backendsFor(backend: AnchorBackend): Array<'l2' | 'node'> {
  switch (backend) {
    case 'l2':
      return ['l2'];
    case 'node':
      return ['node'];
    case 'both':
      return ['l2', 'node'];
    default: {
      // Exhaustiveness guard — keeps TS honest if the union grows.
      const _never: never = backend;
      throw new Error(`Unknown anchor backend: ${String(_never)}`);
    }
  }
}

/**
 * Pure projection of what a proposed switch would do. No I/O, no side effects —
 * safe to call from the dry-run path and from unit tests.
 *
 * Every targeted backend receives the FULL event stream (anchoring is a fan-out,
 * not a load-balance): under `both`, each event is anchored to L2 *and* the node
 * chain, so both backends see the full `eventsPerMinute`.
 */
export function projectSwitch(input: ProjectionInput): SwitchProjection {
  const { backend } = input;

  if (!Number.isFinite(input.eventsPerMinute) || input.eventsPerMinute < 0) {
    throw new Error(`eventsPerMinute must be a non-negative finite number, got ${input.eventsPerMinute}`);
  }

  const profiles: Record<'l2' | 'node', BackendProfile> = {
    l2: { ...DEFAULT_BACKEND_PROFILES.l2, ...(input.profiles?.l2 ?? {}) },
    node: { ...DEFAULT_BACKEND_PROFILES.node, ...(input.profiles?.node ?? {}) },
  };

  const targets = backendsFor(backend);

  const routes: BackendRouting[] = targets.map((b) => {
    const profile = profiles[b];
    const eventsPerDay = input.eventsPerMinute * MINUTES_PER_DAY;
    return {
      backend: b,
      eventsPerMinute: input.eventsPerMinute,
      confirmationLatencyMs: profile.confirmationLatencyMs,
      dailyCostUsd: round2dp(eventsPerDay * profile.costPerEventUsd),
    };
  });

  // For a fan-out to multiple backends, an event is fully anchored only once the
  // slowest backend confirms it. For a single backend it is just that latency.
  const effectiveConfirmationLatencyMs = routes.reduce(
    (max, r) => Math.max(max, r.confirmationLatencyMs),
    0,
  );

  const totalDailyCostUsd = round2dp(routes.reduce((sum, r) => sum + r.dailyCostUsd, 0));

  return {
    backend,
    totalEventsPerMinute: input.eventsPerMinute,
    routes,
    effectiveConfirmationLatencyMs,
    totalDailyCostUsd,
  };
}

/** Round to 2 decimal places (USD cents) without floating drift surprises. */
function round2dp(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** A minimal event shape the router can dispatch. Mirrors AnchorableEvent. */
export interface RoutableEvent {
  id: string;
  hash?: string;
}

/** Result of a real (non-dry-run) dispatch of a batch to the active backend(s). */
export interface DispatchResult {
  backend: AnchorBackend;
  /** Per-backend dispatch acknowledgements (e.g. simulated tx refs). */
  acks: Array<{ backend: 'l2' | 'node'; ref: string; eventCount: number }>;
}

/**
 * The runtime dispatch the switch flips. Holds the currently-active backend and
 * routes batches accordingly. Defaults from `ANCHOR_BACKEND` env (see #443) but
 * is overridable at runtime via `setBackend()` — which is exactly what the admin
 * switch endpoint calls on a committed (non-dry-run) change.
 */
export class AnchorRouter {
  private backend: AnchorBackend;
  private profiles: Record<'l2' | 'node', BackendProfile>;

  constructor(opts?: { backend?: AnchorBackend; profiles?: Partial<Record<'l2' | 'node', BackendProfile>> }) {
    this.backend = opts?.backend ?? parseBackendEnv(process.env.ANCHOR_BACKEND);
    this.profiles = {
      l2: { ...DEFAULT_BACKEND_PROFILES.l2, ...(opts?.profiles?.l2 ?? {}) },
      node: { ...DEFAULT_BACKEND_PROFILES.node, ...(opts?.profiles?.node ?? {}) },
    };
  }

  /** The currently-active anchoring backend. */
  getBackend(): AnchorBackend {
    return this.backend;
  }

  /**
   * Flip the active backend. Returns the previous value so the caller (the admin
   * endpoint) can record an auditable before/after in the switch event.
   */
  setBackend(backend: AnchorBackend): { previous: AnchorBackend; current: AnchorBackend } {
    const previous = this.backend;
    this.backend = backend;
    return { previous, current: backend };
  }

  /** Pure projection against the router's current profiles. */
  project(eventsPerMinute: number, backend: AnchorBackend = this.backend): SwitchProjection {
    return projectSwitch({ backend, eventsPerMinute, profiles: this.profiles });
  }

  /**
   * Dispatch a batch of events to every active backend (fan-out for `both`).
   *
   * PARTIAL / INTEGRATION (#443): the per-backend send is currently simulated
   * (returns a deterministic ref) because the real L2 + node anchoring clients
   * live behind #443. The routing decision, fan-out, and the seam are real; only
   * the wire call is stubbed. Replace `simulateSend` with the real clients.
   */
  async dispatch(events: RoutableEvent[]): Promise<DispatchResult> {
    const targets = backendsFor(this.backend);
    const acks = await Promise.all(
      targets.map(async (b) => ({
        backend: b,
        ref: await this.simulateSend(b, events),
        eventCount: events.length,
      })),
    );
    return { backend: this.backend, acks };
  }

  private async simulateSend(backend: 'l2' | 'node', events: RoutableEvent[]): Promise<string> {
    // INTEGRATION (#443): replace with real backend client call.
    const tag = events.length > 0 ? events[0].id.slice(0, 8) : 'empty';
    return `sim:${backend}:${tag}:${events.length}`;
  }
}

/**
 * Parse the ANCHOR_BACKEND env value into a valid backend, defaulting to `node`
 * (the safe, free, local option) when unset or invalid.
 */
export function parseBackendEnv(value: string | undefined): AnchorBackend {
  if (value === 'l2' || value === 'node' || value === 'both') {
    return value;
  }
  return 'node';
}

/** Singleton router used by the application + the admin switch endpoint. */
export const anchorRouter = new AnchorRouter();
