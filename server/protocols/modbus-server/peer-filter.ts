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
 * The implementation is protocol-neutral and now lives in
 * `server/protocols/peer-allowlist.ts`, because the DNP3 outstation listener
 * (#464) needs exactly the same accept-time control and duplicating an address
 * matcher is how the two copies drift apart. This module re-exports it verbatim
 * so `modbus-server`'s public surface and every existing import path are
 * unchanged.
 */

export {
  isLoopbackHost,
  isPeerAllowed,
  LOOPBACK_PEER_RULES,
  normalizeAddress,
  parsePeerRule,
  parsePeerRules,
  PeerRuleError,
  type IpFamily,
  type NormalizedAddress,
  type PeerRule,
} from "../peer-allowlist";
