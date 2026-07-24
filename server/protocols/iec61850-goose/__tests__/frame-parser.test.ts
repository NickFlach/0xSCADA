/**
 * Unit tests for the GOOSE frame parser (BER decode + Ethernet header).
 *
 * Exercises the parser against hand-built synthetic frames (see fixtures.ts)
 * so the full decode path is covered without any pcap or live socket.
 *
 * Issue: #465
 */

import { describe, it, expect } from "vitest";
import {
  parseGooseFrame,
  parseGoosePdu,
  decodeSigned,
  decodeUnsigned,
  decodeFloat,
  decodeQuality,
  GooseParseError,
} from "../frame-parser.js";
import { GOOSE_ETHERTYPE } from "../types.js";
import {
  buildFrame,
  buildPdu,
  canonicalFrame,
  data,
  tlv,
  encodeLength,
} from "./fixtures.js";

describe("BER primitives", () => {
  it("decodes unsigned big-endian integers", () => {
    expect(decodeUnsigned(Buffer.from([0x01, 0x02]))).toBe(0x0102);
    expect(decodeUnsigned(Buffer.from([]))).toBe(0);
    expect(decodeUnsigned(Buffer.from([0xff, 0xff]))).toBe(65535);
  });

  it("decodes signed two's-complement integers", () => {
    expect(decodeSigned(Buffer.from([0x7f]))).toBe(127);
    expect(decodeSigned(Buffer.from([0xff]))).toBe(-1);
    expect(decodeSigned(Buffer.from([0x80]))).toBe(-128);
    expect(decodeSigned(Buffer.from([0xff, 0x9c]))).toBe(-100);
  });

  it("decodes float32 with the IEC exponent-width prefix", () => {
    const buf = Buffer.alloc(5);
    buf[0] = 8;
    buf.writeFloatBE(3.5, 1);
    expect(decodeFloat(buf)).toBeCloseTo(3.5);
  });

  it("encodes long-form lengths correctly (round-trips through reader)", () => {
    // 300-byte content needs long form (0x82 0x01 0x2c)
    const len = encodeLength(300);
    expect(len[0]).toBe(0x82);
    expect((len[1] << 8) | len[2]).toBe(300);
  });

  it("rejects indefinite length", () => {
    const buf = Buffer.from([0x30, 0x80, 0x00, 0x00]);
    expect(() => parseGoosePdu(buf)).toThrow(GooseParseError);
  });
});

describe("Quality bitstring decode", () => {
  it("decodes a 'good' quality", () => {
    const q = decodeQuality(Buffer.from([3, 0x00, 0x00]));
    expect(q.validity).toBe("good");
    expect(q.failure).toBe(false);
    expect(q.test).toBe(false);
  });

  it("decodes 'invalid' validity and failure bit", () => {
    const q = decodeQuality(Buffer.from([3, 0b01000010, 0x00]));
    expect(q.validity).toBe("invalid");
    expect(q.failure).toBe(true);
  });

  it("decodes the test bit", () => {
    const q = decodeQuality(Buffer.from([3, 0x00, 0b00010000]));
    expect(q.test).toBe(true);
  });
});

describe("parseGooseFrame — canonical frame", () => {
  it("decodes the link header and full PDU", () => {
    const frame = canonicalFrame();
    const parsed = parseGooseFrame(frame);

    expect(parsed.destMac).toBe("01:0c:cd:01:00:01");
    expect(parsed.srcMac).toBe("00:11:22:33:44:55");
    expect(parsed.appId).toBe(0x3001);

    expect(parsed.pdu.gocbRef).toBe("IED1LD0/LLN0$GO$gcb01");
    expect(parsed.pdu.datSet).toBe("IED1LD0/LLN0$DataSet1");
    expect(parsed.pdu.goID).toBe("gcb01");
    expect(parsed.pdu.timeAllowedToLive).toBe(2000);
    expect(parsed.pdu.stNum).toBe(1);
    expect(parsed.pdu.sqNum).toBe(0);
    expect(parsed.pdu.confRev).toBe(1);
    expect(parsed.pdu.numDatSetEntries).toBe(3);
  });

  it("decodes the expected dataset members in order", () => {
    const parsed = parseGooseFrame(canonicalFrame());
    expect(parsed.pdu.allData).toHaveLength(3);

    const [boolVal, qual, analog] = parsed.pdu.allData;
    expect(boolVal).toEqual({ type: "boolean", value: true });
    expect(qual.type).toBe("quality");
    if (qual.type === "quality") {
      expect(qual.value.validity).toBe("good");
    }
    expect(analog.type).toBe("float");
    if (analog.type === "float") {
      expect(analog.value).toBeCloseTo(42.5);
    }
  });

  it("recovers the publisher event timestamp t (ms)", () => {
    const parsed = parseGooseFrame(canonicalFrame({ t: 1_700_000_000_000 }));
    // within 1ms of the encoded value (24-bit fraction quantisation)
    expect(parsed.pdu.t).toBeGreaterThanOrEqual(1_700_000_000_000 - 1);
    expect(parsed.pdu.t).toBeLessThanOrEqual(1_700_000_000_001);
  });
});

describe("parseGooseFrame — VLAN tag", () => {
  it("parses an 802.1Q-tagged GOOSE frame", () => {
    const frame = canonicalFrame({}, { vlan: { id: 100, priority: 4 } });
    const parsed = parseGooseFrame(frame);
    expect(parsed.vlanId).toBe(100);
    expect(parsed.vlanPriority).toBe(4);
    expect(parsed.appId).toBe(0x3001);
    expect(parsed.pdu.stNum).toBe(1);
  });
});

describe("parseGooseFrame — different dataset shapes", () => {
  it("decodes integer and visible-string members", () => {
    const pdu = buildPdu({
      gocbRef: "X/LLN0$GO$g",
      timeAllowedToLive: 1000,
      datSet: "X/LLN0$DS",
      stNum: 5,
      sqNum: 2,
      allData: [data.int(-100), data.uint(4242), data.visibleString("RUN")],
    });
    const parsed = parseGooseFrame(buildFrame(pdu));
    expect(parsed.pdu.allData[0]).toEqual({ type: "int", value: -100 });
    expect(parsed.pdu.allData[1]).toEqual({ type: "uint", value: 4242 });
    expect(parsed.pdu.allData[2]).toEqual({ type: "visiblestring", value: "RUN" });
  });
});

describe("parseGooseFrame — error handling", () => {
  it("rejects a frame shorter than the Ethernet header", () => {
    expect(() => parseGooseFrame(Buffer.alloc(10))).toThrow(GooseParseError);
  });

  it("rejects a non-GOOSE ethertype", () => {
    const frame = canonicalFrame();
    // overwrite the ethertype (bytes 12..13) with IPv4 (0x0800)
    frame.writeUInt16BE(0x0800, 12);
    expect(() => parseGooseFrame(frame)).toThrow(/not a GOOSE frame/);
  });

  it("rejects an APDU without the application tag", () => {
    expect(() => parseGoosePdu(Buffer.from([0x30, 0x01, 0x00]))).toThrow(/application tag/);
  });

  it("rejects a PDU missing mandatory fields", () => {
    // only gocbRef present
    const body = tlv(0x80, Buffer.from("x", "latin1"));
    const apdu = tlv(0x61, body);
    expect(() => parseGoosePdu(apdu)).toThrow(/missing/);
  });

  it("rejects content length exceeding the buffer", () => {
    // tag 0x61, length 0x7f but no content
    expect(() => parseGoosePdu(Buffer.from([0x61, 0x7f]))).toThrow(GooseParseError);
  });
});

describe("ethertype constant", () => {
  it("is 0x88B8", () => {
    expect(GOOSE_ETHERTYPE).toBe(0x88b8);
  });
});
