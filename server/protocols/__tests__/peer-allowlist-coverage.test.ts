/**
 * Wildcard allowlists spelled as a union of narrower rules.
 *
 * `parsePeerRule` refuses a single `/0`, but that check is per-entry: a set like
 * `0.0.0.0/1,128.0.0.0/1` slipped through while admitting every IPv4 peer. Both
 * the Modbus TCP server (#462) and the DNP3 outstation (#464) serve protocols
 * with no client authentication and treat this allowlist as the control in front
 * of a listener that can write live tags, so "a wildcard, spelled differently"
 * has to fail closed too.
 */
import { describe, it, expect } from "vitest";
import { PeerRuleError, parsePeerRules, isPeerAllowed } from "../peer-allowlist";

describe("peer allowlist — unions that cover a whole address family", () => {
  it("refuses two /1 rules that between them admit every IPv4 peer", () => {
    expect(() => parsePeerRules(["0.0.0.0/1", "128.0.0.0/1"])).toThrow(PeerRuleError);
    expect(() => parsePeerRules(["0.0.0.0/1", "128.0.0.0/1"])).toThrow(
      /together allow every IPv4 peer/,
    );
  });

  it("refuses the same trick at greater depth (four /2s, eight /3s)", () => {
    const quarters = ["0.0.0.0/2", "64.0.0.0/2", "128.0.0.0/2", "192.0.0.0/2"];
    expect(() => parsePeerRules(quarters)).toThrow(/together allow every IPv4 peer/);

    const eighths = Array.from({ length: 8 }, (_, i) => `${i * 32}.0.0.0/3`);
    expect(() => parsePeerRules(eighths)).toThrow(/together allow every IPv4 peer/);
  });

  it("refuses a full cover assembled out of order and with overlaps", () => {
    // Same coverage, deliberately unsorted and redundant.
    expect(() =>
      parsePeerRules(["128.0.0.0/1", "10.0.0.0/8", "0.0.0.0/1"]),
    ).toThrow(/together allow every IPv4 peer/);
  });

  it("refuses a union that covers the whole IPv6 space", () => {
    expect(() => parsePeerRules(["::/1", "8000::/1"])).toThrow(
      /together allow every IPv6 peer/,
    );
  });

  it("names the offending rules so an operator can see which set did it", () => {
    expect(() => parsePeerRules(["0.0.0.0/1", "128.0.0.0/1"])).toThrow(
      /\[0\.0\.0\.0\/1, 128\.0\.0\.0\/1\]/,
    );
  });

  it("still accepts a genuinely partial allowlist, including a near-miss", () => {
    // 0.0.0.0/1 plus 128.0.0.0/2 covers three quarters of IPv4 — broad, but not
    // everything, so it is the operator's call and must not be refused.
    const rules = parsePeerRules(["0.0.0.0/1", "128.0.0.0/2"]);
    expect(rules).toHaveLength(2);
    expect(isPeerAllowed("10.0.0.1", rules)).toBe(true);
    expect(isPeerAllowed("200.0.0.1", rules)).toBe(false);
  });

  it("does not conflate the two families: full IPv4 cover is still refused when IPv6 rules are present", () => {
    expect(() =>
      parsePeerRules(["0.0.0.0/1", "128.0.0.0/1", "2001:db8::/32"]),
    ).toThrow(/together allow every IPv4 peer/);
  });

  it("leaves ordinary control-network allowlists working", () => {
    const rules = parsePeerRules(["127.0.0.0/8", "10.4.0.0/16", "2001:db8::/32"]);
    expect(rules).toHaveLength(3);
    expect(isPeerAllowed("10.4.7.9", rules)).toBe(true);
    expect(isPeerAllowed("192.168.1.1", rules)).toBe(false);
  });

  it("still refuses a literal /0 on its own", () => {
    expect(() => parsePeerRules(["0.0.0.0/0"])).toThrow(PeerRuleError);
    expect(() => parsePeerRules(["::/0"])).toThrow(PeerRuleError);
  });
});
