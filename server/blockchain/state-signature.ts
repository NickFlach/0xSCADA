/**
 * Cross-Node State Signature Verification (#454)
 *
 * Pure, dependency-free helpers for the signature half of the per-validator
 * `/state/:key` proxy. A validator returns a value for a key together with a
 * signature over a canonical representation of
 * `(key, value, blockHeight, nonce, observedAt)`.
 * Before the server hands the response back to an operator it MUST verify that
 * signature against the validator's registered public key.
 *
 * ## Signature scheme
 * We use **Ed25519** via Node's built-in `node:crypto` module (`crypto.verify`
 * / `crypto.sign` with a `null` digest algorithm). This matches the repo's
 * existing reliance on `node:crypto` for signing (see `server/integrity/hsm.ts`)
 * and requires NO new dependency. Ed25519 is deterministic, has small keys, and
 * is a natural fit for validator identity keys.
 *
 * Keys are exchanged as PEM-encoded SPKI public keys (the standard
 * `-----BEGIN PUBLIC KEY-----` format) which is what `crypto.generateKeyPairSync`
 * emits and what we store in the `validator_pubkeys` table.
 *
 * ## Replay / freshness (`oxscada-state-v2`)
 * A signature over `(key, value, blockHeight)` alone is replayable: a captured
 * valid response stays valid forever. v2 therefore binds the signature to a
 * per-request, server-chosen `nonce` and to the validator's `observedAt`
 * timestamp, and the proxy checks both before returning anything.
 *
 * The nonce half of that contract has a producer requirement that CANNOT be
 * satisfied from this repository: the oxscada validator (the geth fork, a
 * separate codebase) must read the `?nonce=` query parameter, sign it together
 * with its own `observedAt`, and echo both in the response body. This module
 * and `node-client.ts` fail closed rather than pretend otherwise — a response
 * missing `nonce`/`observedAt` is rejected as `state-protocol-incompatible`
 * and never verified as if it were fresh.
 *
 * The two checks that are enforceable purely server-side — the timestamp
 * window here, and the persisted per-(node, key) block-height high-water mark
 * in `server/routes/nodes.ts` — hold regardless of what the node implements.
 *
 * This module is intentionally free of Express / DB / network imports so the
 * verification logic can be unit-tested in isolation.
 */

import {
  verify as cryptoVerify,
  createPublicKey,
  KeyObject,
} from "node:crypto";

/**
 * The payload a validator returns for a state query, prior to verification.
 * Mirrors the on-the-wire shape produced by the oxscada RPC `state_get` method.
 */
export interface SignedStateResponse {
  /** The key that was queried. Echoed back by the validator. */
  key: string;
  /**
   * The validator's value for that key. `null` is a valid signed answer for a
   * known-but-empty key; a *missing* key is signalled out-of-band (see
   * `node-client.ts` / route 404 handling), not by signing `null`.
   */
  value: unknown;
  /** Block height / sequence at which this value was observed. */
  blockHeight: number;
  /** Per-request challenge supplied by the proxy. */
  nonce: string;
  /** ISO-8601 time at which the validator observed the value. */
  observedAt: string;
  /** Optional identifier of the key the validator signed with (for rotation). */
  keyId?: string;
  /** Hex-encoded Ed25519 signature over the canonical message. */
  signature: string;
}

/** Discriminated outcome of verifying a signed state response. */
export type SignatureVerificationResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailureReason; detail?: string };

export type SignatureFailureReason =
  | "missing-signature"
  | "malformed-signature"
  | "malformed-pubkey"
  | "signature-mismatch";

export type FreshnessFailureReason =
  | "key-mismatch"
  | "nonce-mismatch"
  | "invalid-observed-at"
  | "stale-response"
  | "future-response";

export type FreshnessVerificationResult =
  { valid: true } | { valid: false; reason: FreshnessFailureReason };

/**
 * Build the canonical, deterministic message that is signed/verified.
 *
 * Determinism is critical: the validator and the server must serialize the
 * exact same bytes or every signature would appear invalid. We therefore:
 *   - fix field order explicitly (do not rely on object key ordering),
 *   - JSON-serialize the value with sorted object keys so semantically-equal
 *     objects always produce identical bytes.
 *
 * Format:
 * `oxscada-state-v2\n<key>\n<blockHeight>\n<nonce>\n<observedAt>\n<canonicalJson(value)>`
 *
 * The `oxscada-state-v2` domain-separation prefix prevents a signature minted
 * for some other purpose from being replayed as a state attestation.
 */
export function buildStateSigningMessage(params: {
  key: string;
  value: unknown;
  blockHeight: number;
  nonce: string;
  observedAt: string;
}): string {
  const canonicalValue = canonicalJsonStringify(params.value);
  return [
    "oxscada-state-v2",
    params.key,
    String(params.blockHeight),
    params.nonce,
    params.observedAt,
    canonicalValue,
  ].join("\n");
}

/**
 * Verify that a validly signed response belongs to this request and is recent.
 * A captured response cannot satisfy a new random nonce, while the timestamp
 * bounds prevent a validator from returning an indefinitely old observation.
 */
export function verifyStateResponseFreshness(
  response: SignedStateResponse,
  expected: {
    key: string;
    nonce: string;
    nowMs?: number;
    maxAgeMs?: number;
    maxFutureSkewMs?: number;
  },
): FreshnessVerificationResult {
  if (response.key !== expected.key) {
    return { valid: false, reason: "key-mismatch" };
  }
  if (response.nonce !== expected.nonce) {
    return { valid: false, reason: "nonce-mismatch" };
  }

  const observedAtMs = Date.parse(response.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    return { valid: false, reason: "invalid-observed-at" };
  }

  const nowMs = expected.nowMs ?? Date.now();
  const maxAgeMs = expected.maxAgeMs ?? 30_000;
  const maxFutureSkewMs = expected.maxFutureSkewMs ?? 5_000;
  if (observedAtMs < nowMs - maxAgeMs) {
    return { valid: false, reason: "stale-response" };
  }
  if (observedAtMs > nowMs + maxFutureSkewMs) {
    return { valid: false, reason: "future-response" };
  }
  return { valid: true };
}

/**
 * Deterministically stringify a JSON value with object keys sorted recursively.
 * Arrays preserve order; primitives serialize as standard JSON. Used so the
 * canonical signing message is byte-stable regardless of key insertion order.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // A normal `{}` treats the own key "__proto__" as a prototype setter.
    // A null-prototype dictionary preserves every JSON key in the signed bytes.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortValue(obj[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Parse a PEM-encoded SPKI public key into a KeyObject.
 * Returns `null` if the PEM is malformed / not an Ed25519 key we can use.
 */
export function parsePublicKeyPem(publicKeyPem: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: publicKeyPem, format: "pem" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/**
 * Verify a validator's signed state response against a registered public key.
 *
 * This is the security-critical path called from the route *before* returning
 * to the client. It never throws — all failure modes map to a discriminated
 * `{ valid: false, reason }` so the caller can choose the right status code.
 *
 * @param response   The (possibly tampered) response received from the node.
 * @param publicKeyPem PEM SPKI public key registered for this validator.
 */
export function verifySignedStateResponse(
  response: SignedStateResponse,
  publicKeyPem: string,
): SignatureVerificationResult {
  if (!response.signature || typeof response.signature !== "string") {
    return { valid: false, reason: "missing-signature" };
  }

  // Hex must be even-length, non-empty, and valid hex characters.
  if (
    response.signature.length === 0 ||
    response.signature.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(response.signature)
  ) {
    return { valid: false, reason: "malformed-signature" };
  }

  const key = parsePublicKeyPem(publicKeyPem);
  if (!key) {
    return { valid: false, reason: "malformed-pubkey" };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(response.signature, "hex");
  } catch {
    return { valid: false, reason: "malformed-signature" };
  }

  const message = Buffer.from(
    buildStateSigningMessage({
      key: response.key,
      value: response.value,
      blockHeight: response.blockHeight,
      nonce: response.nonce,
      observedAt: response.observedAt,
    }),
    "utf8",
  );

  let ok = false;
  try {
    // Ed25519: pass `null` as the digest algorithm — the key type selects the
    // scheme. Returns false (not throws) for a mismatched signature, but we
    // guard against unexpected key/scheme errors too.
    ok = cryptoVerify(null, message, key, signatureBytes);
  } catch {
    return { valid: false, reason: "malformed-signature" };
  }

  return ok ? { valid: true } : { valid: false, reason: "signature-mismatch" };
}
