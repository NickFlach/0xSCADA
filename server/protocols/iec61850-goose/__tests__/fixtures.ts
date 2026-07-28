/**
 * Synthetic GOOSE frame builders for unit tests.
 *
 * These hand-encode IEC 61850-8-1 GOOSE frames (Ethernet link header + BER
 * APDU) so the parser can be exercised against known raw bytes WITHOUT any
 * captured pcap or live network. The encoders here are deliberately the
 * inverse of the decoder in frame-parser.ts and are test-only.
 *
 * Issue: #465
 */

import { GOOSE_ETHERTYPE, VLAN_TPID } from "../types.js";

// ── Minimal BER encoders ─────────────────────────────────────────────────────

/** Encode a definite BER length (short or long form). */
export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Encode a TLV with the given tag byte and content. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

/** Encode an unsigned integer into minimal big-endian octets. */
export function uintBytes(value: number): Buffer {
  if (value === 0) return Buffer.from([0]);
  const bytes: number[] = [];
  let n = value;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from(bytes);
}

// ── GOOSE Data CHOICE members ────────────────────────────────────────────────

export const data = {
  boolean(v: boolean): Buffer {
    return tlv(0x83, Buffer.from([v ? 0x01 : 0x00]));
  },
  int(v: number): Buffer {
    // two's complement minimal
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(v);
    let start = 0;
    while (start < 3 && buf[start] === (buf[start + 1] & 0x80 ? 0xff : 0x00)) {
      // trim redundant sign bytes
      if ((buf[start] === 0x00 && (buf[start + 1] & 0x80) === 0) ||
          (buf[start] === 0xff && (buf[start + 1] & 0x80) !== 0)) {
        start++;
      } else break;
    }
    return tlv(0x85, buf.subarray(start));
  },
  uint(v: number): Buffer {
    return tlv(0x86, uintBytes(v));
  },
  float32(v: number): Buffer {
    const buf = Buffer.alloc(5);
    buf[0] = 8; // exponent width in bits
    buf.writeFloatBE(v, 1);
    return tlv(0x87, buf);
  },
  /** Quality bitstring (3 content octets: unusedBits + 13 bits). */
  quality(opts: { validity?: "good" | "invalid" | "questionable" | "reserved"; test?: boolean; failure?: boolean } = {}): Buffer {
    // 13 significant bits in 2 data octets; 3 unused bits.
    let b0 = 0;
    let b1 = 0;
    const validity = opts.validity ?? "good";
    // bits 0..1 validity (MSB-first of b0)
    if (validity === "invalid") b0 |= 0b01000000;
    else if (validity === "reserved") b0 |= 0b10000000;
    else if (validity === "questionable") b0 |= 0b11000000;
    if (opts.failure) b0 |= 0b00000010; // bit 6
    if (opts.test) b1 |= 0b00010000; // bit 11 -> b1 bit (11-8=3 from MSB) => 0b00010000
    return tlv(0x84, Buffer.from([3, b0, b1]));
  },
  visibleString(s: string): Buffer {
    return tlv(0x8a, Buffer.from(s, "latin1"));
  },
};

// ── IECGoosePdu ──────────────────────────────────────────────────────────────

export interface PduFields {
  gocbRef: string;
  timeAllowedToLive: number;
  datSet: string;
  goID?: string;
  /** event time in ms since epoch */
  t?: number;
  stNum: number;
  sqNum: number;
  simulation?: boolean;
  confRev?: number;
  ndsCom?: boolean;
  numDatSetEntries?: number;
  /** pre-encoded Data members */
  allData: Buffer[];
}

/** Encode an IEC UTCTime (8 octets) from ms-since-epoch. */
function utcTime(ms: number): Buffer {
  const seconds = Math.floor(ms / 1000);
  const fraction = Math.round(((ms % 1000) / 1000) * 0x1000000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(seconds >>> 0, 0);
  buf[4] = (fraction >> 16) & 0xff;
  buf[5] = (fraction >> 8) & 0xff;
  buf[6] = fraction & 0xff;
  buf[7] = 0x0a; // time quality (10 bits accuracy)
  return buf;
}

/** Build the IECGoosePdu APDU buffer (tag 0x61). */
export function buildPdu(f: PduFields): Buffer {
  const parts: Buffer[] = [
    tlv(0x80, Buffer.from(f.gocbRef, "latin1")),
    tlv(0x81, uintBytes(f.timeAllowedToLive)),
    tlv(0x82, Buffer.from(f.datSet, "latin1")),
    tlv(0x83, Buffer.from(f.goID ?? "", "latin1")),
    tlv(0x84, utcTime(f.t ?? Date.now())),
    tlv(0x85, uintBytes(f.stNum)),
    tlv(0x86, uintBytes(f.sqNum)),
    tlv(0x87, Buffer.from([f.simulation ? 0x01 : 0x00])),
    tlv(0x88, uintBytes(f.confRev ?? 1)),
    tlv(0x89, Buffer.from([f.ndsCom ? 0x01 : 0x00])),
    tlv(0x8a, uintBytes(f.numDatSetEntries ?? f.allData.length)),
    tlv(0xab, Buffer.concat(f.allData)),
  ];
  return tlv(0x61, Buffer.concat(parts));
}

// ── Full Ethernet frame ──────────────────────────────────────────────────────

function macBytes(mac: string): Buffer {
  return Buffer.from(mac.split(":").map((h) => parseInt(h, 16)));
}

export interface FrameOptions {
  destMac?: string;
  srcMac?: string;
  appId?: number;
  vlan?: { id: number; priority: number };
}

/** Build a complete GOOSE Ethernet frame around an APDU. */
export function buildFrame(apdu: Buffer, opts: FrameOptions = {}): Buffer {
  const dest = macBytes(opts.destMac ?? "01:0c:cd:01:00:01");
  const src = macBytes(opts.srcMac ?? "00:11:22:33:44:55");
  const appId = opts.appId ?? 0x3001;

  const header: Buffer[] = [dest, src];

  if (opts.vlan) {
    const tci = ((opts.vlan.priority & 0x07) << 13) | (opts.vlan.id & 0x0fff);
    header.push(u16(VLAN_TPID), u16(tci));
  }
  header.push(u16(GOOSE_ETHERTYPE));

  // GOOSE link header: APPID, Length, Reserved1, Reserved2
  const length = 8 + apdu.length; // header (from APPID) + apdu
  header.push(u16(appId), u16(length), u16(0), u16(0));

  return Buffer.concat([...header, apdu]);
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff);
  return b;
}

/**
 * Convenience: a canonical, fully-specified GOOSE frame with a 3-member
 * dataset (boolean stVal, quality, float analog) used by multiple tests.
 */
export function canonicalFrame(
  overrides: Partial<PduFields> = {},
  frameOpts: FrameOptions = {},
): Buffer {
  const pdu = buildPdu({
    gocbRef: "IED1LD0/LLN0$GO$gcb01",
    timeAllowedToLive: 2000,
    datSet: "IED1LD0/LLN0$DataSet1",
    goID: "gcb01",
    t: 1_700_000_000_000,
    stNum: 1,
    sqNum: 0,
    confRev: 1,
    allData: [data.boolean(true), data.quality({ validity: "good" }), data.float32(42.5)],
    ...overrides,
  });
  return buildFrame(pdu, frameOpts);
}

// ── Non-GOOSE background traffic ─────────────────────────────────────────────

/**
 * A well-formed ARP request (EtherType 0x0806), padded to the 60-byte Ethernet
 * minimum. Substation LANs carry this alongside GOOSE, so the replay fixture
 * contains one to prove the backend's EtherType filter actually filters.
 */
export function buildArpRequestFrame(
  senderMac = "00:11:22:33:44:66",
  senderIp = [10, 0, 0, 1],
  targetIp = [10, 0, 0, 2],
): Buffer {
  const sha = macBytes(senderMac);
  const arp = Buffer.concat([
    u16(0x0001), // htype: Ethernet
    u16(0x0800), // ptype: IPv4
    Buffer.from([6, 4]), // hlen, plen
    u16(0x0001), // oper: request
    sha,
    Buffer.from(senderIp),
    Buffer.alloc(6), // tha: unknown
    Buffer.from(targetIp),
  ]);
  const frame = Buffer.concat([
    macBytes("ff:ff:ff:ff:ff:ff"),
    sha,
    u16(0x0806),
    arp,
  ]);
  // Ethernet minimum payload padding (14 + 28 = 42 → 60).
  return Buffer.concat([frame, Buffer.alloc(Math.max(0, 60 - frame.length))]);
}

// ── Replay capture scenario ──────────────────────────────────────────────────

/** Control block published by the replay scenario. */
export const REPLAY_GOCB_REF = "IED1LD0/LLN0$GO$gcb01";
export const REPLAY_DAT_SET = "IED1LD0/LLN0$DataSet1";
export const REPLAY_APP_ID = 0x3001;
export const REPLAY_DEST_MAC = "01:0c:cd:01:00:01";
export const REPLAY_SRC_MAC = "00:11:22:33:44:55";
export const REPLAY_TIME_ALLOWED_TO_LIVE = 2000;
export const REPLAY_CONF_REV = 1;
/** Absolute capture time of the first packet. */
export const REPLAY_START_MS = 1_700_000_000_000;
/**
 * Publish→capture latency baked into every frame: each PDU's `t` is 2 ms before
 * the packet's capture timestamp, so `goose_round_trip_us` observes ~2000 µs —
 * inside the sub-4 ms GOOSE budget the issue asks to verify.
 */
export const REPLAY_PUBLISH_LATENCY_MS = 2;

export interface ReplayScenarioPacket {
  /** Absolute capture timestamp (ms since epoch). */
  timestampMs: number;
  /** Link-layer bytes. */
  data: Buffer;
  /** What this packet is for, mirrored into the generator's console output. */
  description: string;
}

function replayFrame(
  offsetMs: number,
  description: string,
  pdu: Partial<PduFields>,
  frameOpts: FrameOptions = {},
): ReplayScenarioPacket {
  const timestampMs = REPLAY_START_MS + offsetMs;
  const apdu = buildPdu({
    gocbRef: REPLAY_GOCB_REF,
    timeAllowedToLive: REPLAY_TIME_ALLOWED_TO_LIVE,
    datSet: REPLAY_DAT_SET,
    goID: "gcb01",
    confRev: REPLAY_CONF_REV,
    t: timestampMs - REPLAY_PUBLISH_LATENCY_MS,
    stNum: 1,
    sqNum: 0,
    allData: [],
    ...pdu,
  });
  return {
    timestampMs,
    description,
    data: buildFrame(apdu, {
      destMac: REPLAY_DEST_MAC,
      srcMac: REPLAY_SRC_MAC,
      appId: REPLAY_APP_ID,
      ...frameOpts,
    }),
  };
}

/**
 * The exact packet sequence stored in `fixtures/goose-replay.pcap`.
 *
 * It is a *synthetic* capture — hand-encoded by {@link buildPdu}/{@link
 * buildFrame}, not sniffed from a real IED — because no relay is available to
 * this repository. It is nonetheless a real, standards-shaped GOOSE trace: the
 * committed `.pcap` is byte-for-byte `encodePcap(buildReplayScenario())`, which
 * `pcap-replay.test.ts` asserts, so the binary fixture can never drift from
 * this source.
 *
 * Sequence (offsets in ms from the first packet):
 *
 *   0   stNum=1 sqNum=0  breaker open, quality good     → accepted
 *   80  stNum=1 sqNum=1  retransmission, same state     → accepted
 *   160 ARP request (not GOOSE)                         → filtered by the backend
 *   200 stNum=2 sqNum=0  breaker CLOSED (state change)  → accepted
 *   260 stNum=3 sqNum=0  quality → invalid + failure    → accepted, tag quality "bad"
 *   300 stNum=2 sqNum=0  stale frame replayed on to the bus → rejected (stnum_regression)
 *   340 stNum=4 sqNum=0  simulation bit set             → accepted, simulated=true
 *   400 stNum=5 sqNum=0  802.1Q tagged (vid 100, pcp 4) → accepted
 *   440 a different control block / APPID               → rejected (no_subscription)
 */
export function buildReplayScenario(): ReplayScenarioPacket[] {
  const openState = [data.boolean(false), data.quality({ validity: "good" }), data.float32(41)];
  const closedState = [data.boolean(true), data.quality({ validity: "good" }), data.float32(42.5)];

  return [
    replayFrame(0, "stNum=1 sqNum=0 — breaker open, quality good", {
      stNum: 1,
      sqNum: 0,
      allData: openState,
    }),
    replayFrame(80, "stNum=1 sqNum=1 — retransmission of the same state", {
      stNum: 1,
      sqNum: 1,
      allData: openState,
    }),
    {
      timestampMs: REPLAY_START_MS + 160,
      description: "ARP request — non-GOOSE background traffic, must be filtered",
      data: buildArpRequestFrame(),
    },
    replayFrame(200, "stNum=2 sqNum=0 — breaker closed (state change)", {
      stNum: 2,
      sqNum: 0,
      allData: closedState,
    }),
    replayFrame(260, "stNum=3 sqNum=0 — quality degrades to invalid+failure", {
      stNum: 3,
      sqNum: 0,
      allData: [
        data.boolean(true),
        data.quality({ validity: "invalid", failure: true }),
        data.float32(42.5),
      ],
    }),
    replayFrame(300, "stNum=2 sqNum=0 — stale frame re-injected, must be rejected", {
      stNum: 2,
      sqNum: 0,
      allData: closedState,
    }),
    replayFrame(340, "stNum=4 sqNum=0 — simulation bit set", {
      stNum: 4,
      sqNum: 0,
      simulation: true,
      allData: [data.boolean(false), data.quality({ validity: "good" }), data.float32(0)],
    }),
    replayFrame(
      400,
      "stNum=5 sqNum=0 — 802.1Q tagged (vid 100, pcp 4)",
      {
        stNum: 5,
        sqNum: 0,
        allData: [data.boolean(true), data.quality({ validity: "good" }), data.float32(43.25)],
      },
      { vlan: { id: 100, priority: 4 } },
    ),
    replayFrame(
      440,
      "a different control block on APPID 0x3002 — no matching subscription",
      {
        gocbRef: "IED2LD0/LLN0$GO$gcb09",
        datSet: "IED2LD0/LLN0$DataSet1",
        stNum: 7,
        sqNum: 0,
        allData: [data.boolean(true)],
      },
      { appId: 0x3002 },
    ),
  ];
}
