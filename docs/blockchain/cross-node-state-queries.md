# Cross-Node State Queries (`/api/nodes/:id/state/:key`)

## Overview

Operators investigating a divergence need to ask a *specific* validator what it
believes about a key ("what does validator 2 think about event X?"). That answer
is only useful if the server can prove three things before showing it:

1. **It really came from that validator** — Ed25519 signature verified against a
   public key held in this server's database, never one supplied in the payload.
2. **It answers *this* request** — the signature covers a random challenge the
   server minted moments ago, and the validator's own observation timestamp
   falls inside a bounded window.
3. **It is not a rolled-back view** — the reported block height is not below the
   highest height this server has already accepted for that `(validator, key)`
   pair.

If any of those fails, no value reaches the client.

Implementation:

| Concern | File |
|---|---|
| Canonical message, Ed25519 verify, freshness bounds | `server/blockchain/state-signature.ts` |
| Validator RPC transport + error taxonomy | `server/blockchain/node-client.ts` |
| Route, authz, rate limit, anti-rollback | `server/routes/nodes.ts` |
| Registry + high-water-mark persistence | `server/storage.ts` |
| Tables | `migrations/0007_validator_registry.sql`, `shared/schema.ts` |

## The signed message (`oxscada-state-v2`)

```
oxscada-state-v2\n<key>\n<blockHeight>\n<nonce>\n<observedAt>\n<canonicalJson(value)>
```

* `oxscada-state-v2` is domain separation: a signature minted for another purpose
  cannot be replayed as a state attestation.
* `nonce` is 16 random bytes chosen by *this server* per request and passed to the
  validator as `?nonce=`.
* `observedAt` is the validator's ISO-8601 observation time.
* `canonicalJson` sorts object keys recursively so both sides serialize identical
  bytes.

Response body:

```json
{
  "key": "event-X",
  "value": { "reading": 42 },
  "blockHeight": 4300,
  "nonce": "<echoed challenge>",
  "observedAt": "2026-07-27T10:00:00.000Z",
  "keyId": "node-key-1",
  "signature": "<hex ed25519>"
}
```

## What is enforced where

**Enforced by this server, unconditionally:**

* Public key resolution from `validator_pubkeys` by the exact `keyId` the response
  names. An unregistered node, an unregistered/retired `keyId`, or a non-Ed25519
  algorithm is refused — the registry, not the payload, decides trust.
* Ed25519 verification of the canonical message, before anything is returned.
* `observedAt` within `[now - 30s, now + 5s]`.
* Per-`(node, key)` monotonic block height, persisted in
  `validator_state_watermarks`. Equal heights are fine (the same block read
  twice); a regression is refused. The advanced mark is written *before* the
  answer is returned, and a failure to read or write it fails the request closed.

**Requires a node-side change (NOT in this repository):**

The nonce round-trip has a producer half that lives in the oxscada validator
(`0xSCADA-node`, the Rust node — see `docs/blockchain/validator-monitoring.md`),
not here. That node must:

1. read the `?nonce=` query parameter on `GET /state/:key`,
2. include it and its own `observedAt` in the canonical signed message above,
3. echo both in the response body.

Until a validator ships that, the proxy does **not** silently downgrade to the
old `(key, value, blockHeight)`-only signature. `NodeRpcClient` classifies a
response missing `nonce`/`observedAt` as `state-protocol-incompatible` (HTTP 502)
and no value is returned. The timestamp window and the block-height high-water
mark are enforced regardless of what the node implements, but they are weaker on
their own: without the nonce, a response captured within the freshness window at
the current height could still be replayed. That is the honest limit of what this
repository can enforce alone.

## Seeding the validator registry

`migrations/0007_validator_registry.sql` creates the tables and inserts **no
rows**. There is no safe default validator set: a hard-coded RPC URL or public
key would be a silent trust decision baked into the schema. An empty registry
fails closed — every read answers `404 unknown-validator`.

Registration is an explicit, admin-authenticated operation. `validator.admin`
scope is required (an `admin`/`*` gateway key satisfies it); a plain `operator`
key gets 403.

```bash
# 1. Register the validator and its RPC endpoint (http/https only).
curl -X POST http://localhost:5000/api/nodes \
  -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"validator-2","name":"Validator 2","rpcUrl":"http://10.0.0.12:9090","region":"east"}'

# 2. Register the Ed25519 public key its responses are signed with.
#    Rejected at registration time if it is not a PEM SPKI Ed25519 key.
curl -X POST http://localhost:5000/api/nodes/validator-2/pubkeys \
  -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"keyId\":\"node-key-1\",\"publicKeyPem\":\"$(cat validator2.pub.pem)\"}"

# 3. Read state as an operator.
curl http://localhost:5000/api/nodes/validator-2/state/event-X \
  -H "X-API-Key: $OPERATOR_API_KEY"

# Rotation: POST a new keyId, then retire the old one.
curl -X DELETE http://localhost:5000/api/nodes/validator-2/pubkeys/node-key-0 \
  -H "X-API-Key: $ADMIN_API_KEY"
```

This works against the development SQLite database as well as Postgres —
`server/storage.ts` implements both paths, so the feature does not require a
hand-seeded Postgres to be usable or testable.

## Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/nodes` | operator | List registered validators (no key material) |
| `POST` | `/api/nodes` | `validator.admin` | Register / update a validator |
| `POST` | `/api/nodes/:id/pubkeys` | `validator.admin` | Register / rotate a verification key |
| `DELETE` | `/api/nodes/:id/pubkeys/:keyId` | `validator.admin` | Retire a verification key |
| `GET` | `/api/nodes/:id/state/:key` | operator | Signed cross-node state read |

State reads are rate limited to 60/min per operator identity (falling back to the
client IP for an unnamed key).

## Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid-params` / `invalid-body` | Request failed Zod validation |
| 400 | `invalid-public-key` | Not a PEM SPKI Ed25519 public key |
| 401 | — | No / unknown API key |
| 403 | — | Key lacks the required role or scope |
| 404 | `unknown-validator` | Validator not registered, or disabled |
| 404 | `key-not-found` | Validator reports the state key is unknown |
| 404 | `no-matching-pubkey` (DELETE) | No active key with that `keyId` |
| 409 | `no-matching-pubkey` | No active Ed25519 key for the `keyId` the response named |
| 502 | `validator-unreachable` | Could not reach the validator |
| 502 | `validator-rpc-error` | Validator returned a non-OK / malformed response |
| 502 | `state-protocol-incompatible` | Validator still speaks v1: no freshness proof |
| 502 | `validator-key-id-missing` | Response did not name a signing key |
| 502 | `signature-invalid` | Signature did not verify (`reason` narrows it) |
| 502 | `response-not-fresh` | `reason`: `nonce-mismatch` (replay), `stale-response`, `future-response`, `key-mismatch`, `invalid-observed-at` |
| 502 | `state-rollback` | `reason`: `block-height-regression`; includes `highestAcceptedBlockHeight` |
| 503 | `rollback-check-unavailable` | High-water mark could not be read or persisted — fail closed |
| 504 | `validator-timeout` | Validator did not answer within the deadline |
| 500 | `registry-error` | Registry lookup/write failed |

## Tests

* `server/__tests__/cross-node-state.test.ts` — canonical message and Ed25519
  unit tests, plus route integration against a real local validator: happy path,
  in-flight tamper, verbatim replay of a captured valid response, stale and
  future timestamps, block-height regression, fail-closed watermark store,
  unreachable/timeout/404/409 shapes, rate limiting.
* `server/__tests__/validator-registry.test.ts` — the seeding path against a real
  in-memory SQLite database with the production wiring (no injected registry,
  watermark store or RPC client): empty registry fails closed, operator keys
  cannot seed, admin registration persists, the signed read then works, the
  high-water mark is persisted and a regression is refused, retiring the key
  fails closed again.
