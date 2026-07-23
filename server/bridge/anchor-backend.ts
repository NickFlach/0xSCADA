/**
 * Anchor backend selection (issue #443)
 *
 * Two anchoring paths exist:
 *  - "node": NATS → 0xSCADA-node (Kuramoto-BFT AnchorBatch txs) — CANONICAL
 *  - "l2":   EventAnchorBridge → EventAnchor.sol on an EVM L2 — DEPRECATED,
 *            kept only for the migration window
 *
 * Before this switch both paths were wired unconditionally, so an event
 * could anchor twice, once, or not at all depending on which services
 * happened to be up. ANCHOR_BACKEND makes the routing explicit:
 *
 *   ANCHOR_BACKEND=node   (default) — node path only
 *   ANCHOR_BACKEND=l2     — legacy L2 path only
 *   ANCHOR_BACKEND=both   — dual-anchor during migration/comparison only
 *
 * See docs/architecture/anchor-backend-migration.md.
 */

export type AnchorBackend = 'l2' | 'node' | 'both';

const VALID: readonly AnchorBackend[] = ['l2', 'node', 'both'];

let warned = false;
let runtimeBackend: AnchorBackend | undefined;
let runtimeBackendRevision = 0;

export interface AnchorBackendSnapshot {
  backend: AnchorBackend;
  /**
   * Process-local optimistic-concurrency token. It advances on every runtime
   * mutation, including same-value writes, so a dry-run can detect ABA changes.
   */
  revision: number;
}

export function getAnchorBackend(): AnchorBackend {
  if (runtimeBackend) return runtimeBackend;

  const raw = (process.env.ANCHOR_BACKEND ?? 'node').toLowerCase();
  if ((VALID as readonly string[]).includes(raw)) {
    return raw as AnchorBackend;
  }
  if (!warned) {
    warned = true;
    console.warn(
      `[anchor-backend] Unknown ANCHOR_BACKEND "${process.env.ANCHOR_BACKEND}", defaulting to "node"`
    );
  }
  return 'node';
}

/** Read the active backend and its optimistic-concurrency revision together. */
export function getAnchorBackendSnapshot(): AnchorBackendSnapshot {
  return {
    backend: getAnchorBackend(),
    revision: runtimeBackendRevision,
  };
}

/**
 * Update the process-wide backend used by every production routing decision.
 *
 * The environment remains the boot-time default, while an authenticated
 * operator switch installs a runtime override. Keeping this state here means
 * NATS/node routing, the L2 bridge gate, health, and the admin UI all read the
 * same source of truth.
 */
export function setAnchorBackend(
  backend: AnchorBackend,
): { previous: AnchorBackend; current: AnchorBackend } {
  const previous = getAnchorBackend();
  runtimeBackend = backend;
  runtimeBackendRevision += 1;
  return { previous, current: backend };
}

export interface AnchorBackendCoordinationStatus {
  ready: boolean;
  replicas: number;
  reason?: string;
}

/**
 * Runtime overrides are process-local. Refuse live switching when the deployment
 * declares more than one server replica until a distributed coordination store
 * is introduced, otherwise different pods could anchor to different backends.
 */
export function getAnchorBackendCoordinationStatus(
  env: NodeJS.ProcessEnv = process.env,
): AnchorBackendCoordinationStatus {
  const raw = env.OXSCADA_REPLICA_COUNT;
  if (raw === undefined || raw === "") {
    if (env.NODE_ENV === "production") {
      return {
        ready: false,
        replicas: 0,
        reason:
          "OXSCADA_REPLICA_COUNT must be declared before enabling process-local anchor-backend switching in production",
      };
    }
    return { ready: true, replicas: 1 };
  }

  const replicas = Number(raw);
  if (!Number.isSafeInteger(replicas) || replicas < 1) {
    return {
      ready: false,
      replicas: 0,
      reason: `invalid OXSCADA_REPLICA_COUNT value ${JSON.stringify(raw)}`,
    };
  }
  if (replicas > 1) {
    return {
      ready: false,
      replicas,
      reason:
        "live anchor-backend switching is held for multi-replica deployments until a distributed coordination store is configured",
    };
  }
  return { ready: true, replicas };
}

/** Whether events should flow to the legacy L2 EventAnchor contract path. */
export function anchorsToL2(): boolean {
  const backend = getAnchorBackend();
  return backend === 'l2' || backend === 'both';
}

/** Whether events should flow to the 0xSCADA-node path (NATS → Kuramoto-BFT). */
export function anchorsToNode(): boolean {
  const backend = getAnchorBackend();
  return backend === 'node' || backend === 'both';
}

/**
 * Log the routing this process resolved at boot. Runtime overrides installed
 * via POST /api/admin/anchor-backend are process-local and do not survive a
 * restart: after a crash or redeploy, routing silently returns to the
 * environment default. Logging the boot state makes that reversion visible
 * to operators auditing an earlier committed switch.
 */
export function logAnchorBackendBootState(): void {
  const source = process.env.ANCHOR_BACKEND !== undefined ? 'ANCHOR_BACKEND env' : 'default';
  console.log(
    `[anchor-backend] boot routing = "${getAnchorBackend()}" (source: ${source}); ` +
      'runtime overrides do not persist across restarts',
  );
}

/** Test hook: reset the one-time warning latch. */
export function _resetWarningLatch(): void {
  warned = false;
}

/** Test hook: restore environment-driven routing and the warning latch. */
export function _resetAnchorBackendState(): void {
  runtimeBackend = undefined;
  runtimeBackendRevision = 0;
  warned = false;
}
