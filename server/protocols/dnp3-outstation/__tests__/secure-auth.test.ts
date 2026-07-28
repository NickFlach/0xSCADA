/**
 * Tests for DNP3 Secure Authentication v5 HMAC challenge/response (#464).
 */
import { describe, test, expect } from "vitest";
import { createHmac } from "crypto";
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
} from "../secure-auth";
import { DNP3_FUNCTION } from "../app-objects";

const KEY = Buffer.alloc(16, 0xab);
const ASDU = Buffer.from([0xc0, 0x05, 0x0c, 0x01, 0x17, 0x01, 0x00, 0x41]); // a fake OPERATE
const ASSOCIATION = 42;

function challengeFragment(challenge: Sav5Challenge): Buffer {
  const body = encodeChallengeObject(challenge);
  const header = Buffer.from([
    0xc0,
    DNP3_FUNCTION.AUTH_RESPONSE,
    0,
    0,
    120,
    1,
    0x5b,
    1,
    body.length,
    0,
  ]);
  return Buffer.concat([header, body]);
}

function bindChallenge(
  os: Sav5Outstation,
  challenge: Sav5Challenge,
  associationId = ASSOCIATION,
): Buffer {
  const fragment = challengeFragment(challenge);
  os.bindChallengeFragment(associationId, fragment);
  return fragment;
}

describe("computeMac", () => {
  test("matches an independent SAv5 wire transcript golden vector", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const criticalAsdu = Buffer.from(
      "c1040c011701000301000000000000000000",
      "hex",
    );
    const challengeApdu = Buffer.from(
      "c183000078015b010c000100000000000401deadbeef",
      "hex",
    );
    const challenge = decodeChallengeObject(challengeApdu.subarray(10));
    const mac = computeMac(key, challenge, challengeApdu, criticalAsdu);

    expect(challenge).toMatchObject({
      challengeSeq: 1,
      userNumber: 0,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16,
      reason: SAV5_CHALLENGE_REASON.CRITICAL,
    });
    expect(mac.toString("hex")).toBe("4a268258cbc5addb3dc9bfb0d14ab28b");

    const replyBody = encodeReplyObject({
      challengeSeq: 1,
      userNumber: 7,
      mac,
    });
    const replyApdu = Buffer.concat([
      Buffer.from("c12078025b011600", "hex"),
      replyBody,
    ]);
    expect(replyApdu.toString("hex")).toBe(
      "c12078025b0116000100000007004a268258cbc5addb3dc9bfb0d14ab28b",
    );
  });

  test("matches an independent HMAC-SHA256 truncation", () => {
    const challenge = {
      challengeSeq: 7,
      userNumber: 1,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_16 as const,
      reason: SAV5_CHALLENGE_REASON.CRITICAL,
      challengeData: Buffer.from([0x01, 0x02, 0x03, 0x04]),
    };
    const fragment = challengeFragment(challenge);
    const got = computeMac(KEY, challenge, fragment, ASDU);

    // IEEE 1815 Table A-3: complete challenge fragment, then critical ASDU.
    const h = createHmac("sha256", KEY);
    h.update(fragment);
    h.update(ASDU);
    const expected = h.digest().subarray(0, 16);

    expect(got.equals(expected)).toBe(true);
    expect(got.length).toBe(16);
  });

  test("different ASDU produces different MAC", () => {
    const c: Sav5Challenge = {
      challengeSeq: 1,
      userNumber: 1,
      macAlgorithm: SAV5_MAC_ALGORITHM.HMAC_SHA256_TRUNC_8,
      reason: 1,
      challengeData: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
    };
    const fragment = challengeFragment(c);
    const a = computeMac(KEY, c, fragment, ASDU);
    const b = computeMac(
      KEY,
      c,
      fragment,
      Buffer.concat([ASDU, Buffer.from([0x00])]),
    );
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBe(8);
  });

  test("rejects an unknown algorithm", () => {
    const c = {
      challengeSeq: 1,
      userNumber: 1,
      macAlgorithm: 99 as never,
      reason: 1,
      challengeData: Buffer.alloc(0),
    };
    expect(() => computeMac(KEY, c, Buffer.from([0xc0]), ASDU)).toThrow(
      /Unsupported/,
    );
  });
});

describe("macEquals", () => {
  test("true for identical, false for differing or mismatched length", () => {
    expect(macEquals(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(
      true,
    );
    expect(macEquals(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(
      false,
    );
    expect(macEquals(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toBe(false);
    expect(macEquals(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("Sav5Outstation challenge/response flow", () => {
  function setup() {
    const os = new Sav5Outstation({ challengeTimeoutMs: 1000 });
    os.setControlDirectionKey(1, KEY);
    return os;
  }

  test("legitimate master reply is accepted", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([9, 9, 9, 9]),
      now: 1000,
    });
    expect(challenge.userNumber).toBe(0);
    expect(os.hasPending(ASSOCIATION)).toBe(true);

    // Master computes the MAC with the shared Control Direction Session Key.
    const fragment = bindChallenge(os, challenge);
    const mac = computeMac(KEY, challenge, fragment, ASDU);
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 1, mac },
      ASSOCIATION,
      0,
      1100,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.criticalAsdu.equals(ASDU)).toBe(true);
    expect(os.hasPending(ASSOCIATION)).toBe(false); // single-use
  });

  test("wrong key (impostor) is rejected with mac-mismatch", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([1, 1, 1, 1]),
      now: 0,
    });
    const fragment = bindChallenge(os, challenge);
    const badMac = computeMac(
      Buffer.alloc(16, 0x00),
      challenge,
      fragment,
      ASDU,
    );
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 1, mac: badMac },
      ASSOCIATION,
      0,
      10,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("mac-mismatch");
  });

  test("tampered ASDU is rejected (MAC bound to challenged data)", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([2, 2, 2, 2]),
      now: 0,
    });
    const fragment = bindChallenge(os, challenge);
    // Master honestly MACs a DIFFERENT asdu than the one challenged.
    const mac = computeMac(KEY, challenge, fragment, Buffer.from([0xde, 0xad]));
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 1, mac },
      ASSOCIATION,
      0,
      10,
    );
    expect(result.ok).toBe(false);
  });

  test("CSQ mismatch rejected", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([3, 3, 3, 3]),
      now: 0,
    });
    const fragment = bindChallenge(os, challenge);
    const mac = computeMac(KEY, challenge, fragment, ASDU);
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq + 1, userNumber: 1, mac },
      ASSOCIATION,
      0,
      10,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("csq-mismatch");
    expect(os.hasPending(ASSOCIATION)).toBe(false);
  });

  test("application-sequence mismatch rejects and consumes the reply state", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([6, 6, 6, 6]),
      now: 0,
      appSeq: 0,
    });
    const fragment = bindChallenge(os, challenge);
    const mac = computeMac(KEY, challenge, fragment, ASDU);
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 1, mac },
      ASSOCIATION,
      1,
      10,
    );
    expect(result).toEqual({ ok: false, error: "app-seq-mismatch" });
    expect(os.hasPending(ASSOCIATION)).toBe(false);
  });

  test("expired challenge rejected", () => {
    const os = setup();
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, {
      nonce: Buffer.from([4, 4, 4, 4]),
      now: 0,
    });
    const fragment = bindChallenge(os, challenge);
    const mac = computeMac(KEY, challenge, fragment, ASDU);
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 1, mac },
      ASSOCIATION,
      0,
      5000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("challenge-expired");
  });

  test("reply with no outstanding challenge rejected", () => {
    const os = setup();
    const result = os.verifyReply(
      { challengeSeq: 1, userNumber: 1, mac: Buffer.alloc(16) },
      ASSOCIATION,
      0,
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no-pending-challenge");
  });

  test("a lost reply expires so a later critical request can be challenged", () => {
    const os = setup();
    os.issueChallenge(1, ASSOCIATION, ASDU, { now: 0 });
    expect(os.isWaiting(ASSOCIATION, 999)).toBe(true);
    expect(os.isWaiting(ASSOCIATION, 1001)).toBe(false);
    expect(() =>
      os.issueChallenge(1, ASSOCIATION, ASDU, { now: 1001 }),
    ).not.toThrow();
  });

  test("a second critical ASDU cannot replace a pending association challenge", () => {
    const os = setup();
    os.issueChallenge(1, ASSOCIATION, ASDU, { now: 0 });
    expect(() =>
      os.issueChallenge(1, ASSOCIATION, Buffer.from([0xc1, 0x04]), { now: 1 }),
    ).toThrow(/already waiting/);
    expect(os.hasPending(ASSOCIATION)).toBe(true);
  });

  test("a reply naming the wrong user is rejected and consumes the pending challenge", () => {
    const os = setup();
    os.setControlDirectionKey(2, Buffer.alloc(16, 0xcd));
    const challenge = os.issueChallenge(1, ASSOCIATION, ASDU, { now: 0 });
    const fragment = bindChallenge(os, challenge);
    const mac = computeMac(KEY, challenge, fragment, ASDU);
    const result = os.verifyReply(
      { challengeSeq: challenge.challengeSeq, userNumber: 2, mac },
      ASSOCIATION,
      0,
      1,
    );
    expect(result).toEqual({ ok: false, error: "unexpected-user" });
    expect(os.hasPending(ASSOCIATION)).toBe(false);
  });

  test("rejects control-direction session key shorter than 16 bytes", () => {
    const os = new Sav5Outstation();
    expect(() => os.setControlDirectionKey(1, Buffer.alloc(8))).toThrow();
  });

  test("issueChallenge for unknown user throws", () => {
    const os = new Sav5Outstation();
    expect(() => os.issueChallenge(99, ASSOCIATION, ASDU)).toThrow();
  });

  test("challenge sequence numbers increment", () => {
    const os = setup();
    const c1 = os.issueChallenge(1, ASSOCIATION, ASDU, { now: 0 });
    bindChallenge(os, c1);
    os.verifyReply(
      { challengeSeq: c1.challengeSeq, userNumber: 1, mac: Buffer.alloc(16) },
      ASSOCIATION,
      0,
      0,
    );
    const c2 = os.issueChallenge(1, ASSOCIATION, ASDU, { now: 0 });
    expect(c2.challengeSeq).toBe(c1.challengeSeq + 1);
  });
});

describe("critical function classification", () => {
  test("OPERATE / SELECT / WRITE are critical; READ is not", () => {
    expect(isCriticalFunction(DNP3_FUNCTION.OPERATE)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.SELECT)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.WRITE)).toBe(true);
    expect(isCriticalFunction(DNP3_FUNCTION.READ)).toBe(false);
  });
});

describe("g120 object (de)serialisation round-trip", () => {
  test("challenge object round-trips", () => {
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

  test("reply object round-trips", () => {
    const r = {
      challengeSeq: 42,
      userNumber: 1,
      mac: Buffer.from([9, 8, 7, 6]),
    };
    const decoded = decodeReplyObject(encodeReplyObject(r));
    expect(decoded.challengeSeq).toBe(42);
    expect(decoded.mac.equals(r.mac)).toBe(true);
  });
});
