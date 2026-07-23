/**
 * Anchor-Backend Switch (operator-facing dual-anchoring control) — Issue #455
 *
 * The operator-facing switch layer that decides which backend(s) anchorable
 * events are routed to: the L2 rollup (`l2`), the local 0xSCADA node chain
 * (`node`), or `both`. It backs the admin Anchor-Backend Switch UX
 * (`/admin/anchor-backend`, `POST /api/admin/anchor-backend`) and provides a
 * PURE dry-run projection of cost/latency before a switch is committed.
 *
 * RELATIONSHIP TO #443: the canonical backend selection lives in
 * `./anchor-backend.ts`. The application singleton is bound to that shared
 * runtime source, so an operator commit immediately affects production
 * `anchorsToNode()` / `anchorsToL2()` decisions as well as this UI model.
 *
 * The projection logic (`projectSwitch`) is a PURE function with no external
 * dependencies so it is fully unit-testable.
 *
 * @module server/bridge/anchor-switch
 */

// Share the canonical backend union with #443 rather than redefining it, so the
// two anchoring modules cannot drift.
import {
  getAnchorBackend,
  setAnchorBackend,
  type AnchorBackend,
} from './anchor-backend';

export type { AnchorBackend };

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

/** A minimal event shape the switch can dispatch. Mirrors AnchorableEvent. */
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

export interface AnchorBackendStore {
  get(): AnchorBackend;
  set(backend: AnchorBackend): { previous: AnchorBackend; current: AnchorBackend };
}

/**
 * The operator-facing runtime switch. Holds the currently-active backend and
 * routes batches accordingly. Defaults from `ANCHOR_BACKEND` env (shared with
 * #443) but is overridable at runtime via `setBackend()` — which is exactly what
 * the admin switch endpoint calls on a committed (non-dry-run) change.
 *
 * NOTE: this is the #455 control-plane switch, distinct from #443's production
 * bridge. It stays separate so the operator projection remains pure.
 */
export class AnchorSwitch {
  private backend: AnchorBackend;
  private profiles: Record<'l2' | 'node', BackendProfile>;
  private readonly backendStore?: AnchorBackendStore;
  /**
   * Promise-chain mutex for control-plane commits. The resolved tail never
   * carries an operation's rejection, so one failed request cannot poison the
   * queue for later requests.
   */
  private commitTail: Promise<void> = Promise.resolve();

  constructor(opts?: {
    backend?: AnchorBackend;
    profiles?: Partial<Record<'l2' | 'node', BackendProfile>>;
    backendStore?: AnchorBackendStore;
  }) {
    this.backend = opts?.backend ?? parseBackendEnv(process.env.ANCHOR_BACKEND);
    this.backendStore = opts?.backendStore;
    this.profiles = {
      l2: { ...DEFAULT_BACKEND_PROFILES.l2, ...(opts?.profiles?.l2 ?? {}) },
      node: { ...DEFAULT_BACKEND_PROFILES.node, ...(opts?.profiles?.node ?? {}) },
    };
  }

  /** The currently-active anchoring backend. */
  getBackend(): AnchorBackend {
    return this.backendStore?.get() ?? this.backend;
  }

  /**
   * Flip the active backend. Returns the previous value so the caller (the admin
   * endpoint) can record an auditable before/after in the switch event.
   */
  setBackend(backend: AnchorBackend): { previous: AnchorBackend; current: AnchorBackend } {
    if (this.backendStore) {
      return this.backendStore.set(backend);
    }
    const previous = this.backend;
    this.backend = backend;
    return { previous, current: backend };
  }

  /**
   * Serialize a complete switch commit (readiness check, audit queueing, and
   * state mutation). Callers must keep every commit side effect inside the
   * callback so two operator requests cannot observe or roll back each other's
   * state.
   */
  async runCommitExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const predecessor = this.commitTail;
    let release!: () => void;
    this.commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Pure projection against the switch's current profiles. */
  project(eventsPerMinute: number, backend: AnchorBackend = this.getBackend()): SwitchProjection {
    return projectSwitch({ backend, eventsPerMinute, profiles: this.profiles });
  }

  /**
   * Dispatch a batch of events to every active backend (fan-out for `both`).
   *
   * PARTIAL / INTEGRATION (#443): the per-backend send is currently simulated
   * (returns a deterministic ref) because the real production anchoring path
   * lives in #443's production bridge. The routing decision, fan-out, and the
   * seam are real; only the wire call is stubbed.
   */
  async dispatch(events: RoutableEvent[]): Promise<DispatchResult> {
    const activeBackend = this.getBackend();
    const targets = backendsFor(activeBackend);
    const acks = await Promise.all(
      targets.map(async (b) => ({
        backend: b,
        ref: await this.simulateSend(b, events),
        eventCount: events.length,
      })),
    );
    return { backend: activeBackend, acks };
  }

  private async simulateSend(backend: 'l2' | 'node', events: RoutableEvent[]): Promise<string> {
    // INTEGRATION (#443): replace with the real production anchoring path.
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

/** Singleton bound to the same source consumed by production anchor routing. */
export const anchorSwitch = new AnchorSwitch({
  backendStore: {
    get: getAnchorBackend,
    set: setAnchorBackend,
  },
});
