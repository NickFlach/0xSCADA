/**
 * IEC 61850 GOOSE frame parser.
 *
 * Fully implements:
 *   - Ethernet II / 802.1Q link-layer header parsing
 *   - GOOSE link header (APPID / Length / Reserved1 / Reserved2)
 *   - ASN.1 BER decode of the IECGoosePdu (application tag 0x61)
 *   - Decode of the `allData` SEQUENCE OF Data CHOICE into typed values
 *
 * This module is PURE (no sockets, no globals) and fully unit-testable from a
 * raw byte buffer — see __tests__/frame-parser.test.ts for a synthetic fixture.
 *
 * References:
 *   - IEC 61850-8-1 Annex A (IECGoosePdu ASN.1)
 *   - IEC 61850-7-3 (Quality CDC bitstring layout)
 *   - ITU-T X.690 (ASN.1 BER)
 *
 * Issue: #465
 */

import {
  GOOSE_ETHERTYPE,
  VLAN_TPID,
  type GooseDataValue,
  type GooseFrame,
  type GoosePdu,
  type GooseQuality,
} from "./types.js";

/** Thrown when a frame/PDU cannot be decoded. */
export class GooseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GooseParseError";
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ASN.1 BER primitives
// ───────────────────────────────────────────────────────────────────────────

/** A decoded BER TLV (tag-length-value). */
export interface BerTlv {
  /** Full tag byte(s) collapsed to the leading tag octet (we only use low-tag-number form). */
  tag: number;
  /** True if the constructed (0x20) bit is set. */
  constructed: boolean;
  /** Value bytes (content octets only — header already stripped). */
  content: Buffer;
  /** Offset in the parent buffer immediately after this TLV. */
  end: number;
}

/**
 * Read a single BER TLV starting at `offset`.
 * Supports definite-length short and long forms. Indefinite length is rejected
 * (GOOSE uses definite length only).
 */
export function readTlv(buf: Buffer, offset: number): BerTlv {
  if (offset >= buf.length) {
    throw new GooseParseError(`BER: read past end of buffer at offset ${offset}`);
  }

  const firstTagByte = buf[offset];
  let cursor = offset + 1;

  // High-tag-number form (low 5 bits all set) — not used by GOOSE, reject early
  // rather than mis-decode.
  if ((firstTagByte & 0x1f) === 0x1f) {
    throw new GooseParseError("BER: high-tag-number form is not supported");
  }

  if (cursor >= buf.length) {
    throw new GooseParseError("BER: truncated before length octet");
  }

  const lengthByte = buf[cursor];
  cursor += 1;

  let length: number;
  if ((lengthByte & 0x80) === 0) {
    // short form
    length = lengthByte;
  } else {
    const numLenOctets = lengthByte & 0x7f;
    if (numLenOctets === 0) {
      throw new GooseParseError("BER: indefinite length is not supported");
    }
    if (numLenOctets > 4) {
      throw new GooseParseError(`BER: length encoded in ${numLenOctets} octets is unsupported`);
    }
    if (cursor + numLenOctets > buf.length) {
      throw new GooseParseError("BER: truncated length octets");
    }
    length = 0;
    for (let i = 0; i < numLenOctets; i++) {
      length = (length << 8) | buf[cursor + i];
    }
    cursor += numLenOctets;
  }

  const contentStart = cursor;
  const contentEnd = contentStart + length;
  if (contentEnd > buf.length) {
    throw new GooseParseError(
      `BER: content length ${length} at offset ${contentStart} exceeds buffer (${buf.length})`,
    );
  }

  return {
    tag: firstTagByte,
    constructed: (firstTagByte & 0x20) !== 0,
    content: buf.subarray(contentStart, contentEnd),
    end: contentEnd,
  };
}

/** Iterate every child TLV within a constructed value buffer. */
export function readChildren(content: Buffer): BerTlv[] {
  const out: BerTlv[] = [];
  let offset = 0;
  while (offset < content.length) {
    const tlv = readTlv(content, offset);
    out.push(tlv);
    offset = tlv.end;
  }
  return out;
}

/** Decode an unsigned big-endian integer from up to 6 content octets. */
export function decodeUnsigned(content: Buffer): number {
  if (content.length === 0) return 0;
  if (content.length > 6) {
    throw new GooseParseError(`integer too large to decode safely (${content.length} octets)`);
  }
  let value = 0;
  for (const byte of content) {
    value = value * 256 + byte;
  }
  return value;
}

/** Decode a signed (two's complement) big-endian integer. */
export function decodeSigned(content: Buffer): number {
  if (content.length === 0) return 0;
  if (content.length > 6) {
    throw new GooseParseError(`integer too large to decode safely (${content.length} octets)`);
  }
  let value = 0;
  for (const byte of content) {
    value = value * 256 + byte;
  }
  // Sign-extend if the top bit of the first octet is set.
  if ((content[0] & 0x80) !== 0) {
    value -= Math.pow(2, 8 * content.length);
  }
  return value;
}

/** Decode a BER BOOLEAN (any non-zero octet is true). */
export function decodeBoolean(content: Buffer): boolean {
  return content.length > 0 && content.some((b) => b !== 0);
}

/**
 * Decode an IEC 61850 FloatingPoint dataset member.
 * Encoding: 1 leading octet = exponent width in bits (commonly 8), followed by
 * the IEEE-754 value. 5 bytes total => float32, 9 bytes total => float64.
 */
export function decodeFloat(content: Buffer): number {
  if (content.length === 5) {
    return content.readFloatBE(1);
  }
  if (content.length === 9) {
    return content.readDoubleBE(1);
  }
  // Some publishers omit the leading exponent-width octet.
  if (content.length === 4) return content.readFloatBE(0);
  if (content.length === 8) return content.readDoubleBE(0);
  throw new GooseParseError(`unsupported FloatingPoint length ${content.length}`);
}

// ───────────────────────────────────────────────────────────────────────────
// IEC 61850 Quality (61850-7-3) — 13-bit BITSTRING
// ───────────────────────────────────────────────────────────────────────────

/**
 * Decode the Quality bitstring. BER BITSTRING content = [unusedBits][bytes...].
 * Bit 0 is the most-significant bit of the first content byte.
 */
export function decodeQuality(content: Buffer): GooseQuality {
  if (content.length < 1) {
    throw new GooseParseError("Quality bitstring is empty");
  }
  const dataBytes = content.subarray(1);
  const bit = (n: number): boolean => {
    const byteIndex = Math.floor(n / 8);
    const bitIndex = 7 - (n % 8);
    if (byteIndex >= dataBytes.length) return false;
    return ((dataBytes[byteIndex] >> bitIndex) & 1) === 1;
  };

  // Validity is a 2-bit field (bits 0..1).
  const validityCode = (bit(0) ? 2 : 0) | (bit(1) ? 1 : 0);
  const validity = (["good", "invalid", "reserved", "questionable"] as const)[validityCode];

  return {
    validity,
    overflow: bit(2),
    outOfRange: bit(3),
    badReference: bit(4),
    oscillatory: bit(5),
    failure: bit(6),
    oldData: bit(7),
    inconsistent: bit(8),
    inaccurate: bit(9),
    source: bit(10) ? "substituted" : "process",
    test: bit(11),
    operatorBlocked: bit(12),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// allData (SEQUENCE OF Data CHOICE)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Context-specific tags within the `Data` CHOICE (IEC 61850-8-1 Annex A).
 * Application/context class bits are masked off; we compare the low tag number.
 */
const DATA_TAG = {
  ARRAY: 0xa1,
  STRUCTURE: 0xa2,
  BOOLEAN: 0x83,
  BIT_STRING: 0x84,
  INTEGER: 0x85,
  UNSIGNED: 0x86,
  FLOATING_POINT: 0x87,
  REAL: 0x88,
  OCTET_STRING: 0x89,
  VISIBLE_STRING: 0x8a,
  BINARY_TIME: 0x8c,
  BCD: 0x8d,
  BOOLEAN_ARRAY: 0x8e,
  UTC_TIME: 0x91,
} as const;

/** Heuristic: a 13-bit bitstring (3 content octets) is treated as Quality. */
function looksLikeQuality(content: Buffer): boolean {
  // 1 unused-bits octet + up to 2 data octets, unused bits in [0,7].
  return content.length >= 2 && content.length <= 3 && content[0] <= 7;
}

/** Decode a single `Data` CHOICE member into a typed value. */
export function decodeDataValue(tlv: BerTlv): GooseDataValue {
  switch (tlv.tag) {
    case DATA_TAG.BOOLEAN:
      return { type: "boolean", value: decodeBoolean(tlv.content) };
    case DATA_TAG.INTEGER:
      return { type: "int", value: decodeSigned(tlv.content) };
    case DATA_TAG.UNSIGNED:
      return { type: "uint", value: decodeUnsigned(tlv.content) };
    case DATA_TAG.FLOATING_POINT:
    case DATA_TAG.REAL:
      return { type: "float", value: decodeFloat(tlv.content) };
    case DATA_TAG.BIT_STRING: {
      if (looksLikeQuality(tlv.content)) {
        return { type: "quality", value: decodeQuality(tlv.content) };
      }
      const unusedBits = tlv.content.length > 0 ? tlv.content[0] : 0;
      const bits: boolean[] = [];
      const dataBytes = tlv.content.subarray(1);
      const totalBits = dataBytes.length * 8 - unusedBits;
      for (let i = 0; i < totalBits; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8);
        bits.push(((dataBytes[byteIndex] >> bitIndex) & 1) === 1);
      }
      return { type: "bitstring", value: { bits, unusedBits } };
    }
    case DATA_TAG.OCTET_STRING:
      return { type: "octetstring", value: Buffer.from(tlv.content) };
    case DATA_TAG.VISIBLE_STRING:
      return { type: "visiblestring", value: tlv.content.toString("latin1") };
    case DATA_TAG.UTC_TIME:
      return { type: "utctime", value: decodeUtcTime(tlv.content) };
    case DATA_TAG.ARRAY:
    case DATA_TAG.STRUCTURE:
      return { type: "structure", value: readChildren(tlv.content).map(decodeDataValue) };
    default:
      // TODO(#465): BINARY_TIME, BCD, BOOLEAN_ARRAY not yet decoded — surfaced raw.
      return { type: "unknown", tag: tlv.tag, raw: Buffer.from(tlv.content) };
  }
}

/**
 * Decode an IEC 61850 UTCTime (8 octets): 4-byte seconds-since-epoch,
 * 3-byte fraction of a second, 1-byte time quality.
 */
export function decodeUtcTime(content: Buffer): { seconds: number; fraction: number; quality: number } {
  if (content.length < 8) {
    throw new GooseParseError(`UTCTime requires 8 octets, got ${content.length}`);
  }
  const seconds = content.readUInt32BE(0);
  const fraction = (content[4] << 16) | (content[5] << 8) | content[6];
  const quality = content[7];
  return { seconds, fraction, quality };
}

// ───────────────────────────────────────────────────────────────────────────
// IECGoosePdu
// ───────────────────────────────────────────────────────────────────────────

/** Context tags inside the IECGoosePdu SEQUENCE (IEC 61850-8-1 Annex A). */
const PDU_TAG = {
  GOCB_REF: 0x80,
  TIME_ALLOWED_TO_LIVE: 0x81,
  DAT_SET: 0x82,
  GO_ID: 0x83,
  T: 0x84,
  ST_NUM: 0x85,
  SQ_NUM: 0x86,
  SIMULATION: 0x87,
  CONF_REV: 0x88,
  NDS_COM: 0x89,
  NUM_DATSET_ENTRIES: 0x8a,
  ALL_DATA: 0xab,
} as const;

const PDU_APPLICATION_TAG = 0x61; // [APPLICATION 1] IMPLICIT SEQUENCE

/**
 * Decode an IECGoosePdu from its APDU bytes (must start with the 0x61 tag).
 */
export function parseGoosePdu(apdu: Buffer): GoosePdu {
  const root = readTlv(apdu, 0);
  if (root.tag !== PDU_APPLICATION_TAG) {
    throw new GooseParseError(
      `expected IECGoosePdu application tag 0x61, got 0x${root.tag.toString(16)}`,
    );
  }

  const pdu: Partial<GoosePdu> = {
    goID: "",
    simulation: false,
    ndsCom: false,
    confRev: 0,
    t: 0,
    allData: [],
  };

  for (const child of readChildren(root.content)) {
    switch (child.tag) {
      case PDU_TAG.GOCB_REF:
        pdu.gocbRef = child.content.toString("latin1");
        break;
      case PDU_TAG.TIME_ALLOWED_TO_LIVE:
        pdu.timeAllowedToLive = decodeUnsigned(child.content);
        break;
      case PDU_TAG.DAT_SET:
        pdu.datSet = child.content.toString("latin1");
        break;
      case PDU_TAG.GO_ID:
        pdu.goID = child.content.toString("latin1");
        break;
      case PDU_TAG.T:
        pdu.t = decodeUtcTimeToMs(child.content);
        break;
      case PDU_TAG.ST_NUM:
        pdu.stNum = decodeUnsigned(child.content);
        break;
      case PDU_TAG.SQ_NUM:
        pdu.sqNum = decodeUnsigned(child.content);
        break;
      case PDU_TAG.SIMULATION:
        pdu.simulation = decodeBoolean(child.content);
        break;
      case PDU_TAG.CONF_REV:
        pdu.confRev = decodeUnsigned(child.content);
        break;
      case PDU_TAG.NDS_COM:
        pdu.ndsCom = decodeBoolean(child.content);
        break;
      case PDU_TAG.NUM_DATSET_ENTRIES:
        pdu.numDatSetEntries = decodeUnsigned(child.content);
        break;
      case PDU_TAG.ALL_DATA:
        pdu.allData = readChildren(child.content).map(decodeDataValue);
        break;
      default:
        // Unknown/optional field — skip per BER forward-compatibility.
        break;
    }
  }

  // Mandatory fields per the standard.
  if (pdu.gocbRef === undefined) throw new GooseParseError("IECGoosePdu missing gocbRef");
  if (pdu.timeAllowedToLive === undefined) {
    throw new GooseParseError("IECGoosePdu missing timeAllowedToLive");
  }
  if (pdu.datSet === undefined) throw new GooseParseError("IECGoosePdu missing datSet");
  if (pdu.stNum === undefined) throw new GooseParseError("IECGoosePdu missing stNum");
  if (pdu.sqNum === undefined) throw new GooseParseError("IECGoosePdu missing sqNum");

  if (pdu.numDatSetEntries === undefined) {
    pdu.numDatSetEntries = pdu.allData!.length;
  }

  return pdu as GoosePdu;
}

/** Convert an IEC UTCTime (8 octets) to milliseconds since epoch. */
function decodeUtcTimeToMs(content: Buffer): number {
  if (content.length < 4) return 0;
  const { seconds, fraction } = decodeUtcTime(
    content.length >= 8 ? content : Buffer.concat([content, Buffer.alloc(8 - content.length)]),
  );
  // fraction is a 24-bit binary fraction of a second.
  const fracMs = (fraction / 0x1000000) * 1000;
  return seconds * 1000 + fracMs;
}

// ───────────────────────────────────────────────────────────────────────────
// Full Ethernet frame
// ───────────────────────────────────────────────────────────────────────────

function formatMac(buf: Buffer, offset: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push(buf[offset + i].toString(16).padStart(2, "0"));
  }
  return parts.join(":");
}

/**
 * Parse a complete GOOSE Ethernet frame, starting at the destination MAC.
 * Handles an optional single 802.1Q VLAN tag. Throws GooseParseError on any
 * malformed input or non-GOOSE ethertype.
 */
export function parseGooseFrame(frame: Buffer): GooseFrame {
  if (frame.length < 14) {
    throw new GooseParseError(`frame too short (${frame.length} bytes)`);
  }

  const destMac = formatMac(frame, 0);
  const srcMac = formatMac(frame, 6);

  let offset = 12;
  let vlanId: number | undefined;
  let vlanPriority: number | undefined;

  let etherType = frame.readUInt16BE(offset);
  if (etherType === VLAN_TPID) {
    if (frame.length < offset + 4) {
      throw new GooseParseError("truncated 802.1Q VLAN tag");
    }
    const tci = frame.readUInt16BE(offset + 2);
    vlanPriority = (tci >> 13) & 0x07;
    vlanId = tci & 0x0fff;
    offset += 4;
    etherType = frame.readUInt16BE(offset);
  }
  offset += 2;

  if (etherType !== GOOSE_ETHERTYPE) {
    throw new GooseParseError(
      `not a GOOSE frame: ethertype 0x${etherType.toString(16)} != 0x88b8`,
    );
  }

  // GOOSE link header: APPID(2) Length(2) Reserved1(2) Reserved2(2)
  if (frame.length < offset + 8) {
    throw new GooseParseError("truncated GOOSE link header");
  }
  const appId = frame.readUInt16BE(offset);
  const length = frame.readUInt16BE(offset + 2);
  offset += 8; // skip APPID, Length, Reserved1, Reserved2

  const apdu = frame.subarray(offset);
  const pdu = parseGoosePdu(apdu);

  return { destMac, srcMac, vlanId, vlanPriority, appId, length, pdu };
}
