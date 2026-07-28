/**
 * DNP3 Secure Authentication v5 (SAv5) — HMAC Challenge/Response
 * Issue #464: DNP3 Outstation Mode
 *
 * Implements the interoperable challenge/reply portion of SAv5 with a
 * pre-provisioned Control Direction Session Key.
 *
 * DNP3 Secure Authentication v5 (IEEE 1815-2012 Annex / IEC 62351-5) protects
 * "critical" application-layer messages (e.g. control operations) from spoofing
 * by requiring the requester to prove possession of the current Control
 * Direction Session Key via an HMAC over the exact challenge fragment followed
 * by the challenged data.
 *
 * Flow (challenge-response mode, the testable core implemented here):
 *
 *   master                                   outstation
 *     |  --- critical ASDU (e.g. OPERATE) --->  |
 *     |  <---- g120v1 Challenge (CSQ, nonce) -- |   outstation challenges
 *     |  --- g120v2 Reply (HMAC over data) -->  |
 *     |  <----- result / OPERATE executed ----- |   outstation verifies HMAC
 *
 * IEEE 1815 Table A-3 defines the MAC input as the entire serialized
 * Authentication Challenge application fragment followed by the entire
 * critical ASDU. This module retains those exact octets and never reconstructs
 * them for verification.
 *
 * IMPLEMENTED here:
 *   - Challenge object (g120v1) build/parse
 *   - Challenge-Reply MAC computation + constant-time verification (g120v2)
 *   - Session-key establishment/key wrap is outside this module. The embedder
 *     provisions the already-established Control Direction Session Key.
 *     Aggressive mode and in-band key change remain separate extensions.
 *
 * Crypto uses Node's built-in `crypto` (no new dependency).
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** MAC algorithm identifiers as used on the wire (IEEE 1815 Table). */
export const SAV5_MAC_ALGORITHM = {
  /** HMAC-SHA-1 truncated to 10 octets (networked) */
  HMAC_SHA1_TRUNC_10: 2,
  /** HMAC-SHA-256 truncated to 8 octets */
  HMAC_SHA256_TRUNC_8: 3,
  /** HMAC-SHA-256 truncated to 16 octets */
  HMAC_SHA256_TRUNC_16: 4,
  /** HMAC-SHA-1 truncated to 8 octets (serial) */
  HMAC_SHA1_TRUNC_8: 5,
} as const;

export type Sav5MacAlgorithm =
  (typeof SAV5_MAC_ALGORITHM)[keyof typeof SAV5_MAC_ALGORITHM];

/** Reason a challenge is issued (g120v1 "reason for challenge"). */
export const SAV5_CHALLENGE_REASON = {
  CRITICAL: 1, // the received ASDU was critical
} as const;

const ALGO_SPEC: Record<
  Sav5MacAlgorithm,
  { hash: "sha1" | "sha256"; truncate: number }
> = {
  [SAV5_MAC_ALGORITHM.HMAC_SHA1_TRUNC_10]: { hash: "sha1", truncate: 10 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_8]: { hash: "sha256", truncate: 8 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16]: { hash: "sha256", truncate: 16 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA1_TRUNC_8]: { hash: "sha1", truncate: 8 },
};

/** A g120v1 Authentication Challenge object. */
export interface Sav5Challenge {
  /** Challenge Sequence Number (CSQ) — increments per challenge */
  challengeSeq: number;
  /** User number the challenge targets */
  userNumber: number;
  /** Negotiated MAC algorithm */
  macAlgorithm: Sav5MacAlgorithm;
  /** Reason for challenge */
  reason: number;
  /** Random challenge data (nonce) */
  challengeData: Buffer;
}

/** A g120v2 Authentication Reply object. */
export interface Sav5Reply {
  challengeSeq: number;
  userNumber: number;
  /** The MAC value computed by the requester */
  mac: Buffer;
}

/**
 * Compute the SAv5 reply MAC over the exact Table A-3 input:
 *   complete serialized challenge application fragment || criticalAsdu
 *
 * `criticalAsdu` is included only for a critical-function challenge. The HMAC
 * key is the current Control Direction Session Key.
 */
export function computeMac(
  key: Buffer,
  challenge: Pick<Sav5Challenge, "macAlgorithm" | "reason">,
  challengeFragment: Buffer,
  criticalAsdu: Buffer,
): Buffer {
  const spec = ALGO_SPEC[challenge.macAlgorithm];
  if (!spec) {
    throw new Error(
      `Unsupported SAv5 MAC algorithm: ${challenge.macAlgorithm}`,
    );
  }

  const hmac = createHmac(spec.hash, key);
  hmac.update(challengeFragment);
  if (challenge.reason === SAV5_CHALLENGE_REASON.CRITICAL) {
    hmac.update(criticalAsdu);
  }
  const full = hmac.digest();
  return full.subarray(0, spec.truncate);
}

/**
 * Constant-time comparison of two MAC buffers. Returns false (rather than
 * throwing) on length mismatch so it is safe for untrusted input.
 */
export function macEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Outstation-side Secure Authentication v5 state machine. Tracks per-user
 * Control Direction Session Keys, issues challenges with fresh nonces, and
 * verifies replies.
 *
 * This is the fully-implemented, unit-testable core. Wiring it into the APDU
 * pipeline (deciding which function codes are "critical", emitting g120v1/v2
 * objects on the wire) lives in index.ts and is documented as partial there.
 */
export class Sav5Outstation {
  /** userNumber -> current Control Direction Session Key */
  private controlDirectionKeys = new Map<number, Buffer>();
  /** pending challenge per DNP association awaiting a reply */
  private pending = new Map<
    number,
    {
      challenge: Sav5Challenge;
      expectedUserNumber: number;
      expectedAppSeq: number;
      challengeFragment?: Buffer;
      criticalAsdu: Buffer;
      issuedAt: number;
    }
  >();
  private csqCounter = 0;
  private readonly nonceBytes: number;
  private readonly defaultAlgorithm: Sav5MacAlgorithm;
  private readonly challengeTimeoutMs: number;

  constructor(opts?: {
    nonceBytes?: number;
    defaultAlgorithm?: Sav5MacAlgorithm;
    challengeTimeoutMs?: number;
  }) {
    this.nonceBytes = opts?.nonceBytes ?? 16;
    if (this.nonceBytes < 4) {
      throw new Error("SAv5 challenge data must be at least 4 octets");
    }
    this.defaultAlgorithm =
      opts?.defaultAlgorithm ?? SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16;
    this.challengeTimeoutMs = opts?.challengeTimeoutMs ?? 5000;
  }

  /** Provision (or rotate) the current Control Direction Session Key. */
  setControlDirectionKey(userNumber: number, key: Buffer): void {
    if (
      !Number.isInteger(userNumber) ||
      userNumber < 1 ||
      userNumber > 0xffff
    ) {
      throw new Error("SAv5 user number must be in the range 1..65535");
    }
    if (key.length < 16) {
      throw new Error(
        "SAv5 Control Direction Session Key must be at least 16 bytes",
      );
    }
    this.controlDirectionKeys.set(userNumber, Buffer.from(key));
  }

  hasUser(userNumber: number): boolean {
    return this.controlDirectionKeys.has(userNumber);
  }

  /**
   * Issue a challenge for a critical ASDU received from `userNumber`. Stores the
   * pending challenge + the exact critical bytes so the reply can be verified.
   *
   * @param nonce optional fixed nonce (test injection); otherwise random
   * @param now epoch ms (injected for deterministic expiry tests)
   */
  issueChallenge(
    expectedUserNumber: number,
    associationId: number,
    criticalAsdu: Buffer,
    opts?: {
      nonce?: Buffer;
      algorithm?: Sav5MacAlgorithm;
      now?: number;
      appSeq?: number;
    },
  ): Sav5Challenge {
    if (!this.controlDirectionKeys.has(expectedUserNumber)) {
      throw new Error(`SAv5: unknown user ${expectedUserNumber}`);
    }
    if (opts?.nonce && opts.nonce.length < 4) {
      throw new Error("SAv5 challenge data must be at least 4 octets");
    }
    const issuedAt = opts?.now ?? Date.now();
    const existing = this.pending.get(associationId);
    if (existing && issuedAt - existing.issuedAt > this.challengeTimeoutMs) {
      this.pending.delete(associationId);
    } else if (existing) {
      throw new Error(
        `SAv5: association ${associationId} is already waiting for a reply`,
      );
    }
    const challenge: Sav5Challenge = {
      challengeSeq: ++this.csqCounter >>> 0,
      // An outstation-initiated challenge cannot know which master user is
      // responding; IEEE 1815 requires USR=0 and the g120v2 reply supplies it.
      userNumber: 0,
      macAlgorithm: opts?.algorithm ?? this.defaultAlgorithm,
      reason: SAV5_CHALLENGE_REASON.CRITICAL,
      challengeData: opts?.nonce ?? randomBytes(this.nonceBytes),
    };
    this.pending.set(associationId, {
      challenge,
      expectedUserNumber,
      expectedAppSeq: opts?.appSeq ?? criticalAsdu[0] & 0x0f,
      criticalAsdu: Buffer.from(criticalAsdu),
      issuedAt,
    });
    return challenge;
  }

  /**
   * Bind the exact serialized AUTH_RESPONSE fragment to a pending challenge.
   * Verification intentionally MACs these received-on-the-wire-equivalent
   * octets rather than reconstructing the fragment from object fields.
   */
  bindChallengeFragment(associationId: number, fragment: Buffer): void {
    const pending = this.pending.get(associationId);
    if (!pending) {
      throw new Error(
        `SAv5: no pending challenge for association ${associationId}`,
      );
    }
    const encodedBody = encodeChallengeObject(pending.challenge);
    if (
      fragment.length < encodedBody.length ||
      !fragment
        .subarray(fragment.length - encodedBody.length)
        .equals(encodedBody)
    ) {
      throw new Error(
        "SAv5 challenge fragment does not contain the pending challenge body",
      );
    }
    pending.challengeFragment = Buffer.from(fragment);
  }

  /**
   * Verify a master's reply against the outstanding challenge for its user.
   * Returns a result describing success/failure and the verified critical ASDU
   * (so the caller can now safely execute the control). The challenge is
   * consumed on any verification attempt (single-use nonce).
   *
   * @param now epoch ms (injected for deterministic expiry tests)
   */
  verifyReply(
    reply: Sav5Reply,
    associationId: number,
    replyAppSeq: number,
    now: number = Date.now(),
  ): Sav5VerifyResult {
    const pending = this.pending.get(associationId);
    if (!pending) {
      return { ok: false, error: "no-pending-challenge" };
    }
    // Any syntactically valid reply received for this association completes
    // Wait-for-Reply. Invalid CSQ/user/MAC values discard the queued critical
    // ASDU rather than leaving a challenge reusable.
    this.pending.delete(associationId);
    if ((replyAppSeq & 0x0f) !== pending.expectedAppSeq) {
      return { ok: false, error: "app-seq-mismatch" };
    }
    if (pending.challenge.challengeSeq !== reply.challengeSeq) {
      return { ok: false, error: "csq-mismatch" };
    }
    if (reply.userNumber !== pending.expectedUserNumber) {
      return { ok: false, error: "unexpected-user" };
    }
    if (now - pending.issuedAt > this.challengeTimeoutMs) {
      return { ok: false, error: "challenge-expired" };
    }
    if (!pending.challengeFragment) {
      return { ok: false, error: "challenge-fragment-not-bound" };
    }
    const key = this.controlDirectionKeys.get(reply.userNumber);
    if (!key) {
      return { ok: false, error: "unknown-user" };
    }
    const expected = computeMac(
      key,
      pending.challenge,
      pending.challengeFragment,
      pending.criticalAsdu,
    );
    if (!macEquals(expected, reply.mac)) {
      return { ok: false, error: "mac-mismatch" };
    }
    return {
      ok: true,
      criticalAsdu: pending.criticalAsdu,
      userNumber: reply.userNumber,
    };
  }

  /** Whether a challenge is currently outstanding for an association. */
  hasPending(associationId: number): boolean {
    return this.pending.has(associationId);
  }

  /** Return Wait-for-Reply state, expiring a lost challenge at its deadline. */
  isWaiting(associationId: number, now: number = Date.now()): boolean {
    const pending = this.pending.get(associationId);
    if (!pending) return false;
    if (now - pending.issuedAt > this.challengeTimeoutMs) {
      this.pending.delete(associationId);
      return false;
    }
    return true;
  }

  /** Drop authentication state when an association closes. */
  clearAssociation(associationId: number): void {
    this.pending.delete(associationId);
  }
}

export type Sav5VerifyResult =
  | { ok: true; criticalAsdu: Buffer; userNumber: number }
  | {
      ok: false;
      error:
        | "no-pending-challenge"
        | "csq-mismatch"
        | "app-seq-mismatch"
        | "challenge-expired"
        | "challenge-fragment-not-bound"
        | "unexpected-user"
        | "unknown-user"
        | "mac-mismatch";
    };

/** Function codes treated as "critical" and therefore requiring SAv5. */
export const SAV5_CRITICAL_FUNCTIONS = new Set<number>([
  0x03, // SELECT
  0x04, // OPERATE
  0x05, // DIRECT_OPERATE
  0x06, // DIRECT_OPERATE_NR
  0x0d, // COLD_RESTART
  0x0e, // WARM_RESTART
  0x14, // ENABLE_UNSOLICITED
  0x15, // DISABLE_UNSOLICITED
  0x02, // WRITE
]);

/** Whether a function code requires Secure Authentication. */
export function isCriticalFunction(fc: number): boolean {
  return SAV5_CRITICAL_FUNCTIONS.has(fc);
}

// ─── g120v1 / g120v2 object (de)serialisation ────────────────────────────────
// Object body encoding. Qualifier-0x5B framing is handled by app-layer.ts.

/** Serialise a g120v1 Challenge object body (without object header). */
export function encodeChallengeObject(c: Sav5Challenge): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(c.challengeSeq >>> 0, 0);
  head.writeUInt16LE(c.userNumber & 0xffff, 4);
  head.writeUInt8(c.macAlgorithm & 0xff, 6);
  head.writeUInt8(c.reason & 0xff, 7);
  return Buffer.concat([head, c.challengeData]);
}

/** Parse a g120v1 Challenge object body. */
export function decodeChallengeObject(buf: Buffer): Sav5Challenge {
  if (buf.length < 8) throw new Error("SAv5 challenge object too short");
  return {
    challengeSeq: buf.readUInt32LE(0),
    userNumber: buf.readUInt16LE(4),
    macAlgorithm: buf.readUInt8(6) as Sav5MacAlgorithm,
    reason: buf.readUInt8(7),
    challengeData: Buffer.from(buf.subarray(8)),
  };
}

/** Serialise a g120v2 Reply object body. */
export function encodeReplyObject(r: Sav5Reply): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(r.challengeSeq >>> 0, 0);
  head.writeUInt16LE(r.userNumber & 0xffff, 4);
  return Buffer.concat([head, r.mac]);
}

/** Parse a g120v2 Reply object body. */
export function decodeReplyObject(buf: Buffer): Sav5Reply {
  if (buf.length < 6) throw new Error("SAv5 reply object too short");
  return {
    challengeSeq: buf.readUInt32LE(0),
    userNumber: buf.readUInt16LE(4),
    mac: Buffer.from(buf.subarray(6)),
  };
}
