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

export function getAnchorBackend(): AnchorBackend {
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

/** Test hook: reset the one-time warning latch. */
export function _resetWarningLatch(): void {
  warned = false;
}
