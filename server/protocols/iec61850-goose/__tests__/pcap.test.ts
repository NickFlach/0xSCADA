/**
 * Unit tests for the classic-libpcap reader/writer and the capture-backend
 * EtherType filter.
 *
 * The byte-order/magic matrix is checked against a hand-written little-endian
 * capture whose bytes are spelled out from the libpcap header layout, so the
 * parser is validated against the format itself and not merely against its own
 * encoder.
 *
 * Issue: #465
 */

import { describe, it, expect } from "vitest";
import {
  encodePcap,
  parsePcap,
  readPcapGlobalHeader,
  PcapParseError,
  LINKTYPE_ETHERNET,
  PCAP_MAGIC_MICROSECONDS,
  PCAP_MAGIC_NANOSECONDS,
  PCAP_GLOBAL_HEADER_LENGTH,
  type PcapByteOrder,
} from "../pcap.js";
import { isGooseFrame, readFrameEtherType } from "../capture-backend.js";
import { canonicalFrame, buildArpRequestFrame } from "./fixtures.js";

/**
 * A minimal, hand-assembled libpcap file: little-endian, microsecond
 * timestamps, one 4-byte Ethernet packet captured at 1700000000.500000.
 */
const HAND_WRITTEN_LE_PCAP = Buffer.from(
  [
    // ── global header ──
    0xd4, 0xc3, 0xb2, 0xa1, // magic 0xa1b2c3d4, written little-endian
    0x02, 0x00, // version_major = 2
    0x04, 0x00, // version_minor = 4
    0x00, 0x00, 0x00, 0x00, // thiszone = 0
    0x00, 0x00, 0x00, 0x00, // sigfigs = 0
    0xff, 0xff, 0x00, 0x00, // snaplen = 65535
    0x01, 0x00, 0x00, 0x00, // network = LINKTYPE_ETHERNET
    // ── packet record ──
    0x00, 0xf1, 0x53, 0x65, // ts_sec  = 1700000000
    0x20, 0xa1, 0x07, 0x00, // ts_usec = 500000
    0x04, 0x00, 0x00, 0x00, // incl_len = 4
    0x3c, 0x00, 0x00, 0x00, // orig_len = 60 (snapped capture)
    0xde, 0xad, 0xbe, 0xef,
  ],
);

describe("pcap — global header", () => {
  it("parses a hand-written little-endian microsecond capture", () => {
    const header = readPcapGlobalHeader(HAND_WRITTEN_LE_PCAP);
    expect(header.byteOrder).toBe("little");
    expect(header.nanosecondPrecision).toBe(false);
    expect(header.versionMajor).toBe(2);
    expect(header.versionMinor).toBe(4);
    expect(header.thisZone).toBe(0);
    expect(header.snapLen).toBe(65535);
    expect(header.linkType).toBe(LINKTYPE_ETHERNET);
  });

  it("decodes the hand-written packet record, keeping the snapped length", () => {
    const { packets } = parsePcap(HAND_WRITTEN_LE_PCAP);
    expect(packets).toHaveLength(1);
    expect(packets[0].seconds).toBe(1_700_000_000);
    expect(packets[0].subSeconds).toBe(500_000);
    expect(packets[0].timestampMs).toBe(1_700_000_000_500);
    expect(packets[0].capturedLength).toBe(4);
    expect(packets[0].originalLength).toBe(60);
    expect(packets[0].data.toString("hex")).toBe("deadbeef");
  });

  it("rejects a pcapng file with an actionable message", () => {
    const pcapng = Buffer.alloc(PCAP_GLOBAL_HEADER_LENGTH);
    pcapng.writeUInt32BE(0x0a0d0d0a, 0);
    expect(() => readPcapGlobalHeader(pcapng)).toThrow(PcapParseError);
    expect(() => readPcapGlobalHeader(pcapng)).toThrow(/pcapng/i);
  });

  it("rejects an unknown magic", () => {
    const junk = Buffer.alloc(PCAP_GLOBAL_HEADER_LENGTH);
    junk.writeUInt32BE(0x12345678, 0);
    expect(() => readPcapGlobalHeader(junk)).toThrow(/unknown magic/i);
  });

  it("rejects a file shorter than the global header", () => {
    expect(() => readPcapGlobalHeader(Buffer.alloc(10))).toThrow(/too short/i);
  });
});

describe("pcap — byte order and timestamp resolution matrix", () => {
  const cases: Array<{ byteOrder: PcapByteOrder; nanosecondPrecision: boolean; magic: number }> = [
    { byteOrder: "little", nanosecondPrecision: false, magic: PCAP_MAGIC_MICROSECONDS },
    { byteOrder: "big", nanosecondPrecision: false, magic: PCAP_MAGIC_MICROSECONDS },
    { byteOrder: "little", nanosecondPrecision: true, magic: PCAP_MAGIC_NANOSECONDS },
    { byteOrder: "big", nanosecondPrecision: true, magic: PCAP_MAGIC_NANOSECONDS },
  ];

  for (const { byteOrder, nanosecondPrecision, magic } of cases) {
    it(`round-trips ${byteOrder}-endian ${nanosecondPrecision ? "ns" : "µs"} captures`, () => {
      const packets = [
        { timestampMs: 1_700_000_000_000, data: Buffer.from("aa", "hex") },
        { timestampMs: 1_700_000_000_125.5, data: Buffer.from("bbccdd", "hex") },
      ];
      const encoded = encodePcap(packets, { byteOrder, nanosecondPrecision });

      // The magic is written in the declared byte order.
      const written = byteOrder === "big" ? encoded.readUInt32BE(0) : encoded.readUInt32LE(0);
      expect(written).toBe(magic);

      const parsed = parsePcap(encoded);
      expect(parsed.header.byteOrder).toBe(byteOrder);
      expect(parsed.header.nanosecondPrecision).toBe(nanosecondPrecision);
      expect(parsed.header.linkType).toBe(LINKTYPE_ETHERNET);
      expect(parsed.packets.map((p) => p.timestampMs)).toEqual([
        1_700_000_000_000, 1_700_000_000_125.5,
      ]);
      expect(parsed.packets[1].data.toString("hex")).toBe("bbccdd");
    });
  }

  it("splits sub-second fields without losing precision at epoch magnitudes", () => {
    const encoded = encodePcap([{ timestampMs: 1_700_000_000_999, data: Buffer.alloc(1) }], {
      nanosecondPrecision: true,
    });
    const { packets } = parsePcap(encoded);
    expect(packets[0].seconds).toBe(1_700_000_000);
    expect(packets[0].subSeconds).toBe(999_000_000);
  });
});

describe("pcap — malformed records", () => {
  it("throws on a truncated packet record header", () => {
    const good = encodePcap([{ timestampMs: 1000, data: Buffer.alloc(4) }]);
    const truncated = good.subarray(0, PCAP_GLOBAL_HEADER_LENGTH + 8);
    expect(() => parsePcap(truncated)).toThrow(/truncated packet record header/i);
  });

  it("throws when incl_len runs past the end of the file", () => {
    const good = encodePcap([{ timestampMs: 1000, data: Buffer.alloc(8) }]);
    const truncated = good.subarray(0, good.length - 3);
    expect(() => parsePcap(truncated)).toThrow(/truncated packet 0/i);
  });

  it("throws when the sub-second field is impossible for the declared resolution", () => {
    const encoded = encodePcap([{ timestampMs: 1000, data: Buffer.alloc(1) }]);
    // Corrupt ts_usec to 2_000_000 — more than one second of microseconds.
    encoded.writeUInt32LE(2_000_000, PCAP_GLOBAL_HEADER_LENGTH + 4);
    expect(() => parsePcap(encoded)).toThrow(/exceeds/i);
  });

  it("rejects a negative timestamp at encode time", () => {
    expect(() => encodePcap([{ timestampMs: -1, data: Buffer.alloc(1) }])).toThrow(PcapParseError);
  });
});

describe("capture backend — EtherType filter", () => {
  it("accepts an untagged GOOSE frame", () => {
    const frame = canonicalFrame();
    expect(readFrameEtherType(frame)).toBe(0x88b8);
    expect(isGooseFrame(frame)).toBe(true);
  });

  it("accepts a GOOSE frame behind a single 802.1Q tag", () => {
    const frame = canonicalFrame({}, { vlan: { id: 100, priority: 4 } });
    expect(readFrameEtherType(frame)).toBe(0x88b8);
    expect(isGooseFrame(frame)).toBe(true);
  });

  it("rejects non-GOOSE traffic", () => {
    const arp = buildArpRequestFrame();
    expect(readFrameEtherType(arp)).toBe(0x0806);
    expect(isGooseFrame(arp)).toBe(false);
  });

  it("returns null for a runt shorter than an Ethernet header", () => {
    expect(readFrameEtherType(Buffer.alloc(13))).toBeNull();
    expect(isGooseFrame(Buffer.alloc(13))).toBe(false);
  });

  it("returns null for a frame truncated inside its 802.1Q tag", () => {
    const truncated = Buffer.alloc(16);
    truncated.writeUInt16BE(0x8100, 12);
    expect(readFrameEtherType(truncated)).toBeNull();
  });

  it("does not unwrap a QinQ outer tag (the decoder cannot parse it either)", () => {
    const frame = Buffer.alloc(20);
    frame.writeUInt16BE(0x88a8, 12); // 802.1ad outer TPID
    frame.writeUInt16BE(0x88b8, 18);
    expect(readFrameEtherType(frame)).toBe(0x88a8);
    expect(isGooseFrame(frame)).toBe(false);
  });
});
