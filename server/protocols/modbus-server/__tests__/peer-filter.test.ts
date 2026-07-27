/**
 * Peer allowlist tests (#462): the accept-time control that compensates for
 * Modbus TCP having no client authentication.
 */
import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  isPeerAllowed,
  normalizeAddress,
  parsePeerRule,
  parsePeerRules,
  PeerRuleError,
} from "../peer-filter";

describe("normalizeAddress", () => {
  it("parses IPv4", () => {
    expect(normalizeAddress("192.0.2.7")).toEqual({
      family: 4,
      bytes: new Uint8Array([192, 0, 2, 7]),
    });
  });

  it("collapses IPv4-mapped IPv6 to IPv4 (what a dual-stack accept reports)", () => {
    expect(normalizeAddress("::ffff:10.1.2.3")).toEqual({
      family: 4,
      bytes: new Uint8Array([10, 1, 2, 3]),
    });
  });

  it("expands compressed IPv6", () => {
    const normalized = normalizeAddress("2001:db8::1");
    expect(normalized?.family).toBe(6);
    expect(Array.from(normalized!.bytes)).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it("strips an IPv6 zone id", () => {
    expect(normalizeAddress("::1%eth0")).toEqual(normalizeAddress("::1"));
  });

  it("returns null for junk", () => {
    expect(normalizeAddress("not-an-ip")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("999.1.1.1")).toBeNull();
  });
});

describe("parsePeerRule", () => {
  it("treats a bare address as a host route", () => {
    expect(parsePeerRule("10.0.0.5")).toMatchObject({ family: 4, prefix: 32 });
    expect(parsePeerRule("::1")).toMatchObject({ family: 6, prefix: 128 });
  });

  it("parses CIDR notation", () => {
    expect(parsePeerRule("10.4.0.0/16")).toMatchObject({ family: 4, prefix: 16 });
    expect(parsePeerRule("2001:db8::/32")).toMatchObject({ family: 6, prefix: 32 });
  });

  it("rebases an IPv4-mapped CIDR onto the IPv4 space", () => {
    expect(parsePeerRule("::ffff:10.4.0.0/112")).toMatchObject({
      family: 4,
      prefix: 16,
    });
  });

  it("rejects a wildcard rule — an allowlist that allows everything is not one", () => {
    expect(() => parsePeerRule("0.0.0.0/0")).toThrow(PeerRuleError);
    expect(() => parsePeerRule("::/0")).toThrow(PeerRuleError);
  });

  it("rejects malformed entries", () => {
    expect(() => parsePeerRule("10.0.0.0/33")).toThrow(PeerRuleError);
    expect(() => parsePeerRule("10.0.0.0/abc")).toThrow(PeerRuleError);
    expect(() => parsePeerRule("nonsense")).toThrow(PeerRuleError);
    expect(() => parsePeerRule("   ")).toThrow(PeerRuleError);
  });
});

describe("isPeerAllowed", () => {
  const rules = parsePeerRules(["127.0.0.0/8", "10.4.0.0/16", "2001:db8::/32"]);

  it("admits an address inside an allowed network", () => {
    expect(isPeerAllowed("127.0.0.1", rules)).toBe(true);
    expect(isPeerAllowed("10.4.200.9", rules)).toBe(true);
    expect(isPeerAllowed("2001:db8::dead", rules)).toBe(true);
  });

  it("admits an IPv4 peer arriving as IPv4-mapped IPv6", () => {
    expect(isPeerAllowed("::ffff:10.4.0.9", rules)).toBe(true);
  });

  it("refuses an address outside every allowed network", () => {
    expect(isPeerAllowed("10.5.0.1", rules)).toBe(false);
    expect(isPeerAllowed("203.0.113.9", rules)).toBe(false);
    expect(isPeerAllowed("2001:dbf::1", rules)).toBe(false);
  });

  it("does not match an IPv6 peer against an IPv4 rule", () => {
    expect(isPeerAllowed("::1", parsePeerRules(["127.0.0.1"]))).toBe(false);
  });

  it("fails closed on a missing/unparseable peer or an empty rule set", () => {
    expect(isPeerAllowed(undefined, rules)).toBe(false);
    expect(isPeerAllowed("garbage", rules)).toBe(false);
    expect(isPeerAllowed("127.0.0.1", [])).toBe(false);
  });

  it("respects sub-byte prefix boundaries", () => {
    const narrow = parsePeerRules(["192.0.2.128/25"]);
    expect(isPeerAllowed("192.0.2.129", narrow)).toBe(true);
    expect(isPeerAllowed("192.0.2.127", narrow)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback binds", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.5.5")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("recognises routable binds", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("10.0.0.4")).toBe(false);
  });
});
