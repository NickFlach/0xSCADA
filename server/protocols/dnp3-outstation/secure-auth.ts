/**
 * DNP3 Secure Authentication v5 (SAv5) — HMAC Challenge/Response
 * Issue #464: DNP3 Outstation Mode
 *
 * FULLY IMPLEMENTED + UNIT TESTED (the HMAC challenge/response core).
 *
 * DNP3 Secure Authentication v5 (IEEE 1815-2012 Annex / IEC 62351-5) protects
 * "critical" application-layer messages (e.g. control operations) from spoofing
 * by requiring the requester to prove possession of a shared Update Key via an
 * HMAC over the challenged data.
 *
 * Flow (challenge-response mode, the testable core implemented here):
 *
 *   master                                   outstation
 *     |  --- critical ASDU (e.g. OPERATE) --->  |
 *     |  <---- g120v1 Challenge (CSQ, nonce) -- |   outstation challenges
 *     |  --- g120v2 Reply (HMAC over data) -->  |
 *     |  <----- result / OPERATE executed ----- |   outstation verifies HMAC
 *
 * The MAC is computed over: challenge-sequence-number || user-number ||
 * MAC-algorithm || reason || challenge-data || the critical ASDU bytes. We
 * implement HMAC-SHA-256 (truncated per algorithm) and HMAC-SHA-1, the two
 * algorithms an opendnp3 master commonly negotiates.
 *
 * IMPLEMENTED here:
 *   - Challenge object (g120v1) build/parse
 *   - Challenge-Reply MAC computation + constant-time verification (g120v2)
 *   - Session-key wrap is OUT OF SCOPE for this core (Update Key used directly);
 *     see TODO. Aggressive mode and key-change (g120v6/v5) are TODO.
 *
 * Crypto uses Node's built-in `crypto` (no new dependency).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** MAC algorithm identifiers as used on the wire (IEEE 1815 Table). */
export const SAV5_MAC_ALGORITHM = {
  /** HMAC-SHA-1 truncated to 4 octets (legacy, discouraged) */
  HMAC_SHA1_TRUNC_4: 1,
  /** HMAC-SHA-256 truncated to 8 octets */
  HMAC_SHA256_TRUNC_8: 3,
  /** HMAC-SHA-256 truncated to 16 octets */
  HMAC_SHA256_TRUNC_16: 4,
  /** HMAC-SHA-256 full 32 octets */
  HMAC_SHA256_FULL: 7,
} as const;

export type Sav5MacAlgorithm = (typeof SAV5_MAC_ALGORITHM)[keyof typeof SAV5_MAC_ALGORITHM];

/** Reason a challenge is issued (g120v1 "reason for challenge"). */
export const SAV5_CHALLENGE_REASON = {
  CRITICAL: 1, // the received ASDU was critical
} as const;

const ALGO_SPEC: Record<Sav5MacAlgorithm, { hash: 'sha1' | 'sha256'; truncate: number }> = {
  [SAV5_MAC_ALGORITHM.HMAC_SHA1_TRUNC_4]: { hash: 'sha1', truncate: 4 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_8]: { hash: 'sha256', truncate: 8 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16]: { hash: 'sha256', truncate: 16 },
  [SAV5_MAC_ALGORITHM.HMAC_SHA256_FULL]: { hash: 'sha256', truncate: 32 },
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
 * Compute the SAv5 MAC over the canonical input:
 *   CSQ(4 LE) || userNumber(2 LE) || macAlgorithm(1) || reason(1) ||
 *   challengeData || criticalAsdu
 *
 * The Update/Session key is the HMAC key. Returns the truncated MAC per the
 * negotiated algorithm.
 */
export function computeMac(
  key: Buffer,
  challenge: Pick<Sav5Challenge, 'challengeSeq' | 'userNumber' | 'macAlgorithm' | 'reason' | 'challengeData'>,
  criticalAsdu: Buffer,
): Buffer {
  const spec = ALGO_SPEC[challenge.macAlgorithm];
  if (!spec) {
    throw new Error(`Unsupported SAv5 MAC algorithm: ${challenge.macAlgorithm}`);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32LE(challenge.challengeSeq >>> 0, 0);
  header.writeUInt16LE(challenge.userNumber & 0xffff, 4);
  header.writeUInt8(challenge.macAlgorithm & 0xff, 6);
  header.writeUInt8(challenge.reason & 0xff, 7);

  const hmac = createHmac(spec.hash, key);
  hmac.update(header);
  hmac.update(challenge.challengeData);
  hmac.update(criticalAsdu);
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
 * Update Keys, issues challenges with fresh nonces, and verifies replies.
 *
 * This is the fully-implemented, unit-testable core. Wiring it into the APDU
 * pipeline (deciding which function codes are "critical", emitting g120v1/v2
 * objects on the wire) lives in index.ts and is documented as partial there.
 */
export class Sav5Outstation {
  /** userNumber -> Update Key */
  private keys = new Map<number, Buffer>();
  /** pending challenge per userNumber awaiting a reply */
  private pending = new Map<number, { challenge: Sav5Challenge; criticalAsdu: Buffer; issuedAt: number }>();
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
    this.defaultAlgorithm = opts?.defaultAlgorithm ?? SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16;
    this.challengeTimeoutMs = opts?.challengeTimeoutMs ?? 5000;
  }

  /** Provision (or rotate) the Update Key for a user. */
  setUpdateKey(userNumber: number, key: Buffer): void {
    if (key.length < 16) {
      throw new Error('SAv5 Update Key must be at least 16 bytes');
    }
    this.keys.set(userNumber, Buffer.from(key));
  }

  hasUser(userNumber: number): boolean {
    return this.keys.has(userNumber);
  }

  /**
   * Issue a challenge for a critical ASDU received from `userNumber`. Stores the
   * pending challenge + the exact critical bytes so the reply can be verified.
   *
   * @param nonce optional fixed nonce (test injection); otherwise random
   * @param now epoch ms (injected for deterministic expiry tests)
   */
  issueChallenge(
    userNumber: number,
    criticalAsdu: Buffer,
    opts?: { nonce?: Buffer; algorithm?: Sav5MacAlgorithm; now?: number },
  ): Sav5Challenge {
    if (!this.keys.has(userNumber)) {
      throw new Error(`SAv5: unknown user ${userNumber}`);
    }
    const challenge: Sav5Challenge = {
      challengeSeq: ++this.csqCounter >>> 0,
      userNumber,
      macAlgorithm: opts?.algorithm ?? this.defaultAlgorithm,
      reason: SAV5_CHALLENGE_REASON.CRITICAL,
      challengeData: opts?.nonce ?? randomBytes(this.nonceBytes),
    };
    this.pending.set(userNumber, {
      challenge,
      criticalAsdu: Buffer.from(criticalAsdu),
      issuedAt: opts?.now ?? Date.now(),
    });
    return challenge;
  }

  /**
   * Verify a master's reply against the outstanding challenge for its user.
   * Returns a result describing success/failure and the verified critical ASDU
   * (so the caller can now safely execute the control). The challenge is
   * consumed on any verification attempt (single-use nonce).
   *
   * @param now epoch ms (injected for deterministic expiry tests)
   */
  verifyReply(reply: Sav5Reply, now: number = Date.now()): Sav5VerifyResult {
    const pending = this.pending.get(reply.userNumber);
    if (!pending) {
      return { ok: false, error: 'no-pending-challenge' };
    }
    // Single-use: consume regardless of outcome.
    this.pending.delete(reply.userNumber);

    if (pending.challenge.challengeSeq !== reply.challengeSeq) {
      return { ok: false, error: 'csq-mismatch' };
    }
    if (now - pending.issuedAt > this.challengeTimeoutMs) {
      return { ok: false, error: 'challenge-expired' };
    }
    const key = this.keys.get(reply.userNumber);
    if (!key) {
      return { ok: false, error: 'unknown-user' };
    }
    const expected = computeMac(key, pending.challenge, pending.criticalAsdu);
    if (!macEquals(expected, reply.mac)) {
      return { ok: false, error: 'mac-mismatch' };
    }
    return { ok: true, criticalAsdu: pending.criticalAsdu, userNumber: reply.userNumber };
  }

  /** Whether a challenge is currently outstanding for a user. */
  hasPending(userNumber: number): boolean {
    return this.pending.has(userNumber);
  }
}

export type Sav5VerifyResult =
  | { ok: true; criticalAsdu: Buffer; userNumber: number }
  | { ok: false; error: 'no-pending-challenge' | 'csq-mismatch' | 'challenge-expired' | 'unknown-user' | 'mac-mismatch' };

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
// Minimal wire encoding used by the integration seam in index.ts. Sufficient
// for round-trip tests; full object-header framing is handled by the APDU
// assembler.

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
  if (buf.length < 8) throw new Error('SAv5 challenge object too short');
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
  if (buf.length < 6) throw new Error('SAv5 reply object too short');
  return {
    challengeSeq: buf.readUInt32LE(0),
    userNumber: buf.readUInt16LE(4),
    mac: Buffer.from(buf.subarray(6)),
  };
}
