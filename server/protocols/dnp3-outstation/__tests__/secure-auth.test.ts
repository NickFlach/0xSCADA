/**
 * Tests for DNP3 Secure Authentication v5 HMAC challenge/response (#464).
 */
import { describe, test, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  Sav5Outstation,
  computeMac,
  macEquals,
  isCriticalFunction,
  encodeChallengeObject,
  decodeChallengeObject,
  encodeReplyObject,
  decodeReplyObject,
  SAV5_MAC_ALGORITHM,
  SAV5_CHALLENGE_REASON,
  type Sav5Challenge,
} from '../secure-auth';
import { DNP3_FUNCTION } from '../app-objects';

const KEY = Buffer.alloc(16, 0xab);
const ASDU = Buffer.from([0xc0, 0x05, 0x0c, 0x01, 0x17, 0x01, 0x00, 0x41]); // a fake OPERATE

describe('computeMac', () => {
  test('matches an independent HMAC-SHA256 truncation', () => {
    const challenge = {
      challengeSeq: 7,
      userNumber: 1,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16 as const,
      reason: SAV5_CHALLENGE_REASON.CRITICAL,
      challengeData: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    };
    const got = computeMac(KEY, challenge, ASDU);

    // Reproduce the canonical input independently.
    const header = Buffer.alloc(8);
    header.writeUInt32LE(7, 0);
    header.writeUInt16LE(1, 4);
    header.writeUInt8(SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16, 6);
    header.writeUInt8(SAV5_CHALLENGE_REASON.CRITICAL, 7);
    const h = createHmac('sha256', KEY);
    h.update(header);
    h.update(challenge.challengeData);
    h.update(ASDU);
    const expected = h.digest().subarray(0, 16);

    expect(got.equals(expected)).toBe(true);
    expect(got.length).toBe(16);
  });

  test('different ASDU produces different MAC', () => {
    const c: Sav5Challenge = {
      challengeSeq: 1,
      userNumber: 1,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_8,
      reason: 1,
      challengeData: Buffer.from([0xaa]),
    };
    const a = computeMac(KEY, c, ASDU);
    const b = computeMac(KEY, c, Buffer.concat([ASDU, Buffer.from([0x00])]));
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(8);
  });

  test('rejects an unknown algorithm', () => {
    const c = {
      challengeSeq: 1,
      userNumber: 1,
      macAlgorithm: 99 as never,
      reason: 1,
      challengeData: Buffer.alloc(0),
    };
    expect(() => computeMac(KEY, c, ASDU)).toThrow(/Unsupported/);
  });
});

describe('macEquals', () => {
  test('true for identical, false for differing or mismatched length', () => {
    expect(macEquals(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(macEquals(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
    expect(macEquals(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(false);
    expect(macEquals(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe('Sav5Outstation challenge/response flow', () => {
  function setup() {
    const os = new Sav5Outstation({ challengeTimeoutMs: 1000 });
    os.setUpdateKey(1, KEY);
    return os;
  }

  test('legitimate master reply is accepted', () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASDU, { nonce: Buffer.from([9, 9, 9, 9]), now: 1000 });
    expect(os.hasPending(1)).toBe(true);

    // Master computes the MAC with the shared key.
    const mac = computeMac(KEY, challenge, ASDU);
    const result = os.verifyReply({ challengeSeq: challenge.challengeSeq, userNumber: 1, mac }, 1100);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.criticalAsdu.equals(ASDU)).toBe(true);
    expect(os.hasPending(1)).toBe(false); // single-use
  });

  test('wrong key (impostor) is rejected with mac-mismatch', () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASDU, { nonce: Buffer.from([1]), now: 0 });
    const badMac = computeMac(Buffer.alloc(16, 0x00), challenge, ASDU);
    const result = os.verifyReply({ challengeSeq: challenge.challengeSeq, userNumber: 1, mac: badMac }, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('mac-mismatch');
  });

  test('tampered ASDU is rejected (MAC bound to challenged data)', () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASDU, { nonce: Buffer.from([2]), now: 0 });
    // Master honestly MACs a DIFFERENT asdu than the one challenged.
    const mac = computeMac(KEY, challenge, Buffer.from([0xde, 0xad]));
    const result = os.verifyReply({ challengeSeq: challenge.challengeSeq, userNumber: 1, mac }, 10);
    expect(result.ok).toBe(false);
  });

  test('CSQ mismatch rejected', () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASDU, { nonce: Buffer.from([3]), now: 0 });
    const mac = computeMac(KEY, challenge, ASDU);
    const result = os.verifyReply({ challengeSeq: challenge.challengeSeq + 1, userNumber: 1, mac }, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('csq-mismatch');
  });

  test('expired challenge rejected', () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASDU, { nonce: Buffer.from([4]), now: 0 });
    const mac = computeMac(KEY, challenge, ASDU);
    const result = os.verifyReply({ challengeSeq: challenge.challengeSeq, userNumber: 1, mac }, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('challenge-expired');
  });

  test('reply with no outstanding challenge rejected', () => {
    const os = setup();
    const result = os.verifyReply({ challengeSeq: 1, userNumber: 1, mac: Buffer.alloc(16) }, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no-pending-challenge');
  });

  test('rejects update key shorter than 16 bytes', () => {
    const os = new Sav5Outstation();
    expect(() => os.setUpdateKey(1, Buffer.alloc(8))).toThrow();
  });

  test('issueChallenge for unknown user throws', () => {
    const os = new Sav5Outstation();
    expect(() => os.issueChallenge(99, ASDU)).toThrow();
  });

  test('challenge sequence numbers increment', () => {
    const os = setup();
    const c1 = os.issueChallenge(1, ASDU, { now: 0 });
    os.verifyReply({ challengeSeq: c1.challengeSeq, userNumber: 1, mac: Buffer.alloc(16) }, 0);
    const c2 = os.issueChallenge(1, ASDU, { now: 0 });
    expect(c2.challengeSeq).toBe(c1.challengeSeq + 1);
  });
});

describe('critical function classification', () => {
  test('OPERATE / SELECT / WRITE are critical; READ is not', () => {
    expect(isCriticalFunction(DNP3_FUNCTION.OPERATE)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.SELECT)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.WRITE)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.READ)).toBe(false);
  });
});

describe('g120 object (de)serialisation round-trip', () => {
  test('challenge object round-trips', () => {
    const c: Sav5Challenge = {
      challengeSeq: 0x11223344,
      userNumber: 0x0102,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16,
      reason: 1,
      challengeData: Buffer.from([1, 2, 3, 4, 5]),
    };
    const decoded = decodeChallengeObject(encodeChallengeObject(c));
    expect(decoded.challengeSeq).toBe(c.challengeSeq);
    expect(decoded.userNumber).toBe(c.userNumber);
    expect(decoded.macAlgorithm).toBe(c.macAlgorithm);
    expect(decoded.challengeData.equals(c.challengeData)).toBe(true);
  });

  test('reply object round-trips', () => {
    const r = { challengeSeq: 42, userNumber: 1, mac: Buffer.from([9, 8, 7, 6]) };
    const decoded = decodeReplyObject(encodeReplyObject(r));
    expect(decoded.challengeSeq).toBe(42);
    expect(decoded.mac.equals(r.mac)).toBe(true);
  });
});
