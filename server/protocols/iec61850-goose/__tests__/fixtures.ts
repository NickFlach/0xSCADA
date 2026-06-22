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
