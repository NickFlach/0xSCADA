/**
 * Peer allowlist for the Modbus TCP listener.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * Modbus TCP has NO authentication in the protocol itself — there is no
 * credential, no handshake, and no integrity protection on the wire. Anything
 * that can open a TCP connection to the listener is, protocol-wise, a fully
 * privileged master. The only place 0xSCADA can compensate is the deployment
 * boundary, so the listener refuses connections from any peer that is not
 * explicitly allowlisted by IP or CIDR, checked at accept time before a single
 * byte is read.
 *
 * This module is pure (no sockets, no I/O) so every parsing and matching rule
 * is unit-testable. IPv4, IPv6, and IPv4-mapped IPv6 (`::ffff:10.0.0.1`, which
 * is what a dual-stack listener reports for an IPv4 client) all normalise to
 * the same comparison form.
 */

import net from "node:net";

/** Address family of a normalised address or rule. */
export type IpFamily = 4 | 6;

/** A parsed, normalised address. */
export interface NormalizedAddress {
  family: IpFamily;
  /** 4 bytes for IPv4, 16 for IPv6. */
  bytes: Uint8Array;
}

/** A parsed allowlist rule: a network address plus a prefix length. */
export interface PeerRule extends NormalizedAddress {
  /** Prefix length in bits (1..32 for IPv4, 1..128 for IPv6). */
  prefix: number;
  /** The literal the rule was parsed from, for logging. */
  source: string;
}

/** Raised when an allowlist entry cannot be parsed into a usable rule. */
export class PeerRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerRuleError";
  }
}

function ipv4ToBytes(addr: string): Uint8Array | null {
  if (!net.isIPv4(addr)) return null;
  const parts = addr.split(".");
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    bytes[i] = Number(parts[i]) & 0xff;
  }
  return bytes;
}

function ipv6ToBytes(addr: string): Uint8Array | null {
  if (!net.isIPv6(addr)) return null;

  const doubleColon = addr.indexOf("::");
  const head =
    doubleColon >= 0
      ? addr.slice(0, doubleColon).split(":").filter((g) => g !== "")
      : addr.split(":");
  const tail =
    doubleColon >= 0
      ? addr.slice(doubleColon + 2).split(":").filter((g) => g !== "")
      : [];

  const expand = (groups: string[]): number[] | null => {
    const words: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        // Embedded IPv4 form, e.g. ::ffff:192.0.2.1 — occupies two words.
        const v4 = ipv4ToBytes(group);
        if (!v4) return null;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      const word = Number.parseInt(group, 16);
      if (!Number.isFinite(word) || word < 0 || word > 0xffff) return null;
      words.push(word);
    }
    return words;
  };

  const headWords = expand(head);
  const tailWords = expand(tail);
  if (!headWords || !tailWords) return null;

  const missing = 8 - headWords.length - tailWords.length;
  if (missing < 0) return null;
  if (doubleColon < 0 && missing !== 0) return null;

  const words = [...headWords, ...new Array<number>(missing).fill(0), ...tailWords];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (words[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = words[i] & 0xff;
  }
  return bytes;
}

/** True if 16 bytes encode an IPv4-mapped IPv6 address (::ffff:a.b.c.d). */
function isV4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0x00) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse an address literal into its normalised comparison form.
 *
 * A trailing IPv6 zone id (`fe80::1%eth0`) is stripped, and IPv4-mapped IPv6
 * collapses to plain IPv4 so a `10.0.0.0/8` rule matches a dual-stack socket
 * that reports `::ffff:10.0.0.1`. Returns `null` for anything unparseable —
 * callers must treat that as "not allowed".
 */
export function normalizeAddress(input: string): NormalizedAddress | null {
  const addr = input.split("%")[0].trim();
  if (addr === "") return null;

  const v4 = ipv4ToBytes(addr);
  if (v4) return { family: 4, bytes: v4 };

  const v6 = ipv6ToBytes(addr);
  if (!v6) return null;
  if (isV4Mapped(v6)) {
    return { family: 4, bytes: v6.slice(12) };
  }
  return { family: 6, bytes: v6 };
}

/**
 * Parse one allowlist entry: a bare address (`127.0.0.1`, treated as a host
 * route) or CIDR notation (`10.4.0.0/16`).
 *
 * A prefix length of 0 is rejected on purpose: `0.0.0.0/0` and `::/0` allow
 * every peer on the internet, which is not an allowlist. Modbus TCP cannot
 * authenticate the peers such a rule would admit, so it fails closed here
 * rather than silently degrading to "anyone may write to the plant".
 *
 * @throws {PeerRuleError} when the entry is not a usable rule.
 */
export function parsePeerRule(entry: string): PeerRule {
  const source = entry.trim();
  if (source === "") {
    throw new PeerRuleError("empty allowlist entry");
  }

  const slash = source.lastIndexOf("/");
  const addrPart = slash >= 0 ? source.slice(0, slash) : source;
  const prefixPart = slash >= 0 ? source.slice(slash + 1) : undefined;

  const normalized = normalizeAddress(addrPart);
  if (!normalized) {
    throw new PeerRuleError(`"${source}" is not a valid IPv4/IPv6 address or CIDR`);
  }

  const maxPrefix = normalized.family === 4 ? 32 : 128;
  let prefix = maxPrefix;

  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) {
      throw new PeerRuleError(`"${source}" has a non-numeric prefix length`);
    }
    prefix = Number.parseInt(prefixPart, 10);

    // `::ffff:10.0.0.0/104` was normalised to IPv4; rebase its prefix onto the
    // 32-bit IPv4 space so the two notations mean the same network.
    if (normalized.family === 4 && net.isIPv6(addrPart.split("%")[0].trim())) {
      if (prefix < 96) {
        throw new PeerRuleError(
          `"${source}" maps into the IPv4 space; its prefix must be >= 96`,
        );
      }
      prefix -= 96;
    }

    if (prefix > maxPrefix) {
      throw new PeerRuleError(
        `"${source}" prefix length ${prefixPart} exceeds /${maxPrefix}`,
      );
    }
  }

  if (prefix === 0) {
    throw new PeerRuleError(
      `"${source}" allows every peer. Modbus TCP has no client authentication, ` +
        "so a wildcard allowlist is refused; list the specific master IPs or subnets.",
    );
  }

  return { ...normalized, prefix, source };
}

/** Parse a whole allowlist. Throws on the first unusable entry. */
export function parsePeerRules(entries: readonly string[]): PeerRule[] {
  return entries.map(parsePeerRule);
}

/** True if `addr` falls inside `rule`'s network. */
function matches(addr: NormalizedAddress, rule: PeerRule): boolean {
  if (addr.family !== rule.family) return false;

  const fullBytes = rule.prefix >> 3;
  for (let i = 0; i < fullBytes; i++) {
    if ((addr.bytes[i] ^ rule.bytes[i]) !== 0) return false;
  }
  const remainingBits = rule.prefix & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((addr.bytes[fullBytes] ^ rule.bytes[fullBytes]) & mask) === 0;
}

/**
 * Decide whether a connecting peer is allowed.
 *
 * Fails closed: an absent, empty, or unparseable `remoteAddress`, or an empty
 * rule set, all deny.
 */
export function isPeerAllowed(
  remoteAddress: string | undefined,
  rules: readonly PeerRule[],
): boolean {
  if (!remoteAddress || rules.length === 0) return false;
  const addr = normalizeAddress(remoteAddress);
  if (!addr) return false;
  return rules.some((rule) => matches(addr, rule));
}

/** Loopback rules used as the default allowlist for a loopback bind. */
export const LOOPBACK_PEER_RULES: readonly string[] = ["127.0.0.0/8", "::1/128"];

/** True if a bind host is a loopback address (or the loopback hostname). */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  const addr = normalizeAddress(host);
  if (!addr) return false;
  if (addr.family === 4) return addr.bytes[0] === 127;
  // ::1
  return addr.bytes.every((b, i) => (i === 15 ? b === 1 : b === 0));
}
