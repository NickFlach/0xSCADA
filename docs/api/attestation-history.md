# Attestation history API (`/api/nodes`)

Backs the **Slashing & Liveness Visualizer** (`/slashing` in the web UI, issue #456).

Both endpoints are **read-only**. Nothing here slashes, penalises, or mutates any
state; the visualizer projects hypothetical penalties client-side with the pure
simulator in `client/src/lib/slashing-simulator.ts`.

Both endpoints require an operator API key via the `X-API-Key` header
(`requireControlPlaneAccess({ roles: ["operator"] })`).

---

## There is still no consensus attestation feed in this build

This is stated plainly because the previous implementation of this endpoint
served pseudo-random numbers as if they were measurements, and that was rejected
under the repository's Integrity Rule.

The tree was searched for a real per-validator **attestation duty** source. There
is none, and nothing below changes that:

| Candidate | Why it is not an attestation feed |
|---|---|
| `server/blockchain/validator-health.ts` | Real and tested, but polls the oxscada node `GET /status`, whose schema is `height` / `peers` / `mempool` / Kuramoto phase / `uptime_ticks`. No per-slot duty outcome. Keeps only the latest sample — no history. |
| `server/blockchain.ts` | A declared stub: `isConnected()` returns `false`, `getBlockchainHealth()` reports `"Not implemented"`. Chain integration is opt-in via `ENABLE_BLOCKCHAIN` and exposes no attestation RPC. |
| Cross-node state proxy (#454) | A point-in-time signed read of one state key. Not a per-slot duty log. |
| `server/batch-anchoring.ts` | Anchors Merkle roots of **industrial events**, not validator duties. |

## What this build *can* observe: observed liveness

`server/blockchain/liveness-collector.ts` polls every node in
`ANCHOR_NODE_URLS` on a cadence and persists the result of each round to
`validator_liveness_observations` (migration `0012`). Each row is a real
measurement taken at a real moment:

| Status | Meaning **for this source** |
|---|---|
| `miss` | The node did not answer that poll round — transport failure, timeout, non-2xx, oversized body, or an unparseable `/status` payload. **Not** a missed consensus duty. |
| `hit` | The node answered and the chain height it reported was strictly greater than the height of its previous observation. |
| `late` | The node answered but the height did not advance, **or** this was its first observation so no previous height existed. Whether a stalled height indicates a fault depends on the node's block cadence versus the configured poll cadence. |

Why this mapping: only `miss` is slashable in the simulator, and "did not answer
at all" is the strongest liveness signal this build can observe — nothing weaker
is mapped to it. `late` counts as participation but is flagged, which is exactly
what "alive but showed no progress" deserves; mapping it to `miss` would
manufacture penalties out of a fast poll interval. A first observation is `late`
rather than `hit` because one sample demonstrates no progress, and a height
regression is `late` rather than `miss` because the node did answer.

`AttestationRecord.slot` is the **poll-round ordinal**, not a consensus slot. The
chain height actually read is carried separately as `observedHeight` (`null` when
the node did not answer). Height is not used as the round id because it is
per-node, absent exactly on the rows that matter most for slashing, and can
regress; the ordinal is resumed from `MAX(round_seq)` at startup so it stays
monotonic across restarts.

**Stake is not observed.** No stake source exists in this build, so
`ValidatorHistory.stake` is `0`, the descriptor reports
`stake.available: false`, and the UI shows the projected penalty as a percentage
only rather than a confident "≈ 0 stake".

**OFF by default.** With `VALIDATOR_LIVENESS_COLLECTOR_ENABLED` unset, no timer
is armed, no poll happens, no row is written, and the live endpoint fails closed
exactly as it did before. Retention defaults to 7 days (the longest window the
UI offers) and is enforced after every round, so the table cannot grow without
bound.

---

## `GET /api/nodes/attestation-history`

Live, **observed** history from the registered source.

**Query:** `window` (`1h` \| `24h` \| `7d`, default `24h`), optional `validatorId`.

**200** — when a live source has been registered with
`registerLiveAttestationSource()`. The `observation` descriptor is **mandatory**:
a source that will not declare what it measured cannot be served, because `miss`
is otherwise indistinguishable from a missed consensus duty. The response also
carries `X-Data-Provenance: live:<kind>`.

```json
{
  "synthetic": false,
  "demo": false,
  "provenance": "live",
  "source": "oxscada-observed-liveness",
  "window": "24h",
  "observation": {
    "kind": "observed-liveness",
    "sourceId": "oxscada-observed-liveness",
    "summary": "Observed liveness of each configured oxscada node: whether it answered each poll round, and whether the chain height it reported advanced. These are not consensus attestation duties.",
    "method": {
      "transport": "http-get",
      "endpoint": "/status",
      "fields": ["height", "uptime_ticks", "local_phase", "mean_phase", "node_id"],
      "pollIntervalMs": 60000,
      "retentionMs": 604800000,
      "maxRecordsPerQuery": 100000
    },
    "statusSemantics": {
      "hit": "The node answered this poll round and the chain height it reported was strictly greater than the height of its previous observation.",
      "miss": "The node did not answer this poll round ... This is NOT a missed consensus attestation duty; no duty outcome is observable in this build.",
      "late": "The node answered but the height it reported did not advance, or this was its first observation ..."
    },
    "roundIdentifier": { "field": "slot", "meaning": "Monotonic ordinal of the poll round ... not a consensus slot." },
    "stake": { "available": false, "note": "No stake source exists in this build ..." },
    "consensusAttestation": { "available": false, "note": "Consensus attestation duty history remains unavailable ..." }
  },
  "validators": [ /* ValidatorHistory[] */ ]
}
```

**502** — the registered source threw. A failing feed surfaces as a failure; it
is never replaced with substituted data.

**503** — no source is registered (the default deployment). The endpoint
**never** substitutes generated records, not even when the demo flag is enabled.
`reason` keeps two facts apart on purpose: consensus attestation duty history is
unavailable in this *build* and no configuration changes that, whereas the
observed-liveness feed is merely not running on this *deployment* — which is the
part an operator can act on (see below):

```json
{
  "error": "attestation_source_unavailable",
  "synthetic": false,
  "provenance": "live",
  "message": "No live attestation history is available. This endpoint fails closed rather than returning generated data.",
  "reason": "No live source is registered on this deployment. Consensus attestation duty history is unavailable in this build at all: ... An observed-liveness feed IS available ... but it is opt-in: set VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true and configure ANCHOR_NODE_URLS. ...",
  "demo": {
    "available": false,
    "path": "/api/nodes/attestation-history/demo",
    "enabledBy": "SLASHING_DEMO_DATA=true"
  }
}
```

**400** on an invalid `window`. **401** without an operator key.

### Enabling the observed-liveness source

```bash
ANCHOR_NODE_URLS=http://10.0.0.11:9090,http://10.0.0.12:9090
VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true
# optional
VALIDATOR_LIVENESS_POLL_INTERVAL_MS=60000     # clamped 5000..3600000
VALIDATOR_LIVENESS_RETENTION_MS=604800000     # clamped 3600000..2592000000
```

`server/index.ts` calls `startValidatorLivenessCollector()` at boot. It primes
the round ordinal and the per-node height baseline from the table before arming
its timer, so history is continuous across restarts; if the store cannot be read
it leaves the collector unarmed rather than writing from a wrong baseline.
Failures are counted on `getValidatorLivenessCollectorStatus()` and exported as
`scada_validator_liveness_*` metrics — a lost round is never silent.

Run the collector on **one** replica. `round_seq` is a per-collector ordinal and
the unique index on `(validator_id, round_seq)` assumes a single writer; inserts
use `ON CONFLICT DO NOTHING` so a second writer is dropped rather than
corrupting the ordering.

### Wiring a real consensus attestation feed

Implement `LiveAttestationSource` (`server/routes/nodes.ts`) over a source that
**observed** the duty outcomes, give it a descriptor with
`kind: "consensus-attestation"`, and call `registerLiveAttestationSource()` once
at startup. The live route and the UI serve it unchanged. Do not point it at
`server/demo/`.

---

## `GET /api/nodes/attestation-history/demo`

**Synthetic data. Fabricated by a seeded PRNG. Not a measurement of anything.**

Exists so the timeline UI and the (real, unit-tested) what-if slashing math can
be exercised on a build with no validator fleet attached.

**Disabled by default.** Returns **404 `demo_data_disabled`** unless the server
is started with `SLASHING_DEMO_DATA=true`. Never enable it on a deployment where
an operator might act on what they see.

**Query:** `window`, optional `validatorId`, optional `seed` (integer; pins the
PRNG so a demonstration is reproducible — defaults to `0x5cada`).

**200** response, labelled synthetic at every level:

```http
HTTP/1.1 200 OK
X-Data-Provenance: synthetic
Warning: 199 - "SYNTHETIC DEMO DATA - generated by a seeded PRNG (mulberry32), not observed attestation history; not valid for any operational decision."
```

```json
{
  "synthetic": true,
  "demo": true,
  "provenance": "synthetic",
  "generator": "mulberry32",
  "notice": "SYNTHETIC DEMO DATA — these attestation records were generated by a seeded pseudo-random number generator (mulberry32), not observed from any validator. ...",
  "seed": 380122,
  "window": "24h",
  "anchorMs": 1700000000000,
  "validators": [
    {
      "validatorId": "demo-aurora",
      "label": "Aurora (demo)",
      "stake": 32000,
      "synthetic": true,
      "generator": "mulberry32",
      "records": [ { "slot": 0, "timestamp": 1699913600000, "status": "hit" } ]
    }
  ]
}
```

Layers of labelling, so no single truncation or copy/paste can hide it:

1. a **separate route** from the live one, under `/demo`;
2. an **opt-in env flag**, off by default;
3. `synthetic` / `demo` / `provenance` / `generator` / `notice` in the envelope;
4. `synthetic` and `generator` on **each validator object**;
5. `X-Data-Provenance` and `Warning` **response headers**;
6. `demo-` id prefixes and `(demo)` label suffixes that survive screenshots;
7. the generator lives in `server/demo/`, so the import path itself says so;
8. the UI renders a sticky alert banner, a per-validator `SYNTHETIC` badge, a
   modified page heading, and requires an explicit click to load it at all.

---

## UI behaviour

`client/src/pages/SlashingVisualizer.tsx` asks the **live** endpoint first. On
`503` it renders a "No live attestation data source" panel — no timeline, no
numbers — and offers a *Load synthetic demo data* button **only** when the server
reported `demo.available: true`. Loading demo data replaces the page chrome with
the synthetic markings listed above.

On a live `200` it renders the `observation` descriptor above the timelines: the
source id and kind, what was polled and how often, the hit/miss/late definitions
verbatim from the server, the "consensus attestation duty history is not
available" statement, and — when `stake.available` is `false` — the projected
penalty as a percentage only.

When the descriptor's `kind` is `observed-liveness` the per-validator card also
drops the consensus vocabulary: it counts **poll rounds** rather than "duties",
and a consecutive-miss run is reported over **poll rounds** rather than "slots".
Those words are the terms of art for consensus attestation, and using them one
line below the descriptor panel would re-introduce the confusion the panel
exists to prevent. A source that declares `kind: "consensus-attestation"` keeps
the original wording.

## Tests

- `server/__tests__/nodes-attestation-history-http.test.ts` — HTTP contract:
  live fails closed (including with the demo flag on), a registered source is
  served with `synthetic: false` plus its descriptor, demo is 404 by default,
  labelling and headers when enabled, auth on both routes.
- `server/blockchain/__tests__/liveness-collector.test.ts` — configuration
  gating (inert by default), the status mapping for each of
  reachable-and-advancing / unreachable / responded-but-stalled, lifecycle, and
  a storage failure surfacing rather than being swallowed.
- `server/blockchain/__tests__/liveness-collector-durability.test.ts` — against
  a real SQLite database: observations persist and are read back across a
  simulated restart, retention prunes beyond the window, window and
  per-validator filtering, and an end-to-end case where the existing simulator
  replays a rule over stored records and produces penalties.
- `server/__tests__/nodes-history.test.ts` — the synthetic generator is
  deterministic, self-labelling, and replays through the simulator.
- `client/src/lib/__tests__/slashing-simulator.test.ts` — the slashing/liveness
  math, including a 24h replay against a hand-computed expectation.
- `client/src/pages/__tests__/SlashingVisualizer.test.tsx` — the UI never shows
  synthetic data unmarked, never loads it without an explicit action, and
  renders the live source's semantics descriptor.
- `shared/__tests__/schema-parity.test.ts` — the observation table is defined
  identically on Postgres and the SQLite dev fallback.
