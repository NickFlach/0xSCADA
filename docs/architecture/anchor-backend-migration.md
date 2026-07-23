# Anchor Backend: Decision & Migration (issue #443)

## Decision

**The canonical anchor backend is `0xSCADA-node`** — events flow over NATS
(`scada.events`, canonical wire schema per #440) into the Rust validator
network, reach Kuramoto-BFT consensus, and land as `AnchorBatch`
transactions on the purpose-built ledger.

The TS-side L2 path (`contracts/EventAnchor.sol` via
`server/bridge/event-anchor.ts`) is **deprecated**. Two facts drove this:

1. The node path is the one with a real, tested implementation (191-test
   Rust suite, live 3-validator deployments). The L2 bridge's
   `submitToBlockchain` is still a simulation stub (random tx hashes,
   `Math.random()` failure injection) — it has never anchored to a real L2.
2. Both paths were wired unconditionally, so depending on which services
   were up, an event could anchor twice, once, or not at all — exactly the
   ambiguity #443 flagged.

## The switch

`ANCHOR_BACKEND` (read by `server/bridge/anchor-backend.ts`):

| Value | Node path (NATS → Kuramoto-BFT) | L2 path (EventAnchor.sol) |
|-------|--------------------------------|---------------------------|
| `node` *(default)* | ✅ | ❌ (bridge refuses to initialize) |
| `l2` | ❌ (`publishScadaEvent` is silent) | ✅ (subject to `BLOCKCHAIN_ANCHORING`) |
| `both` | ✅ | ✅ — migration/comparison window only |

Unknown values warn once and behave as `node`.

## Migration window

- **Now:** default is `node`. Deployments that still rely on the L2 path
  must set `ANCHOR_BACKEND=l2` explicitly (and should plan to migrate).
- **Comparison runs:** `both` exists so operators can diff anchor streams
  during cutover. It intentionally double-anchors; do not leave it on.
- **Removal:** once no deployment sets `l2`/`both`, the L2 bridge,
  `contracts/EventAnchor.sol` submission tasks (`blockchain/tasks/`), and
  this switch's `l2` arm can be deleted. File that as a `cycle:fix` issue
  when the window closes.

Operator-facing switch UX (dry-run projections, audit-anchored switch
events, admin UI) is #455 and builds on this env-level mechanism.

## Roadmap reconciliation

`ROADMAP.md`'s "Distributed Architecture / Multi-Node Coordination" items
describe capability that `0xSCADA-node` already provides (multi-validator
coordination, state sync via consensus, partition tolerance via Raft
fallback). The roadmap now points there rather than implying it is all
future work.
