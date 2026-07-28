/**
 * Unit tests for the incremental pcap decoder.
 *
 * The point of this decoder is that a live capture arrives in arbitrary chunks,
 * so the tests are deliberately exhaustive about chunk boundaries: every
 * possible one-cut and two-cut split of a multi-packet capture, plus a
 * byte-at-a-time feed, must all decode to exactly what `parsePcap()` produces
 * from the same bytes. Boundaries inside the global header, inside a record
 * header and inside packet data are therefore all covered by construction.
 *
 * Issue: #465
 */

import { describe, it, expect } from "vitest";
import {
  PcapStreamDecoder,
  PcapStreamOverflowError,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_BUFFERED_BYTES,
  type StreamedPcapPacket,
} from "../pcap-stream.js";
import {
  encodePcap,
  parsePcap,
  PcapParseError,
  PCAP_GLOBAL_HEADER_LENGTH,
  PCAP_RECORD_HEADER_LENGTH,
  LINKTYPE_ETHERNET,
  type PcapByteOrder,
} from "../pcap.js";
import { canonicalFrame, buildArpRequestFrame } from "./fixtures.js";

const START_MS = 1_700_000_000_000;

/** A three-packet Ethernet capture: two GOOSE frames around one ARP frame. */
function threePacketCapture(
  options: { byteOrder?: PcapByteOrder; nanosecondPrecision?: boolean } = {},
): Buffer {
  return encodePcap(
    [
      { timestampMs: START_MS, data: canonicalFrame({ stNum: 1, sqNum: 0 }) },
      { timestampMs: START_MS + 40, data: buildArpRequestFrame() },
      { timestampMs: START_MS + 80.5, data: canonicalFrame({ stNum: 2, sqNum: 0 }) },
    ],
    options,
  );
}

/** A deliberately tiny capture, so an O(n²) split sweep stays fast. */
function tinyCapture(): Buffer {
  return encodePcap([
    { timestampMs: START_MS, data: Buffer.from("aabbcc", "hex") },
    { timestampMs: START_MS + 1, data: Buffer.from("dd", "hex") },
  ]);
}

function splitAt(buf: Buffer, ...cuts: number[]): Buffer[] {
  const bounds = [0, ...cuts, buf.length];
  const chunks: Buffer[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const chunk = buf.subarray(bounds[i], bounds[i + 1]);
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks;
}

function feed(chunks: Buffer[], decoder = new PcapStreamDecoder()): StreamedPcapPacket[] {
  const packets: StreamedPcapPacket[] = [];
  for (const chunk of chunks) packets.push(...decoder.push(chunk));
  decoder.end();
  return packets;
}

function summarise(packets: readonly StreamedPcapPacket[]): string {
  return packets.map((p) => `${p.index}:${p.timestampMs}:${p.data.toString("hex")}`).join("|");
}

describe("PcapStreamDecoder — whole-stream equivalence", () => {
  it("decodes a capture pushed as one chunk exactly like parsePcap", () => {
    const capture = threePacketCapture();
    const packets = feed([capture]);
    const reference = parsePcap(capture);

    expect(packets).toHaveLength(reference.packets.length);
    packets.forEach((packet, i) => {
      expect(packet.timestampMs).toBe(reference.packets[i].timestampMs);
      expect(packet.seconds).toBe(reference.packets[i].seconds);
      expect(packet.subSeconds).toBe(reference.packets[i].subSeconds);
      expect(packet.capturedLength).toBe(reference.packets[i].capturedLength);
      expect(packet.originalLength).toBe(reference.packets[i].originalLength);
      expect(packet.data.equals(reference.packets[i].data)).toBe(true);
      expect(packet.index).toBe(i);
      expect(packet.truncated).toBe(false);
    });
  });

  it("exposes the decoded global header", () => {
    const decoder = new PcapStreamDecoder();
    expect(decoder.getHeader()).toBeNull();
    decoder.push(threePacketCapture());
    expect(decoder.getHeader()).toMatchObject({
      byteOrder: "little",
      nanosecondPrecision: false,
      linkType: LINKTYPE_ETHERNET,
    });
    expect(decoder.getPacketCount()).toBe(3);
    expect(decoder.getBufferedBytes()).toBe(0);
    expect(decoder.getTotalBytes()).toBe(threePacketCapture().length);
  });
});

describe("PcapStreamDecoder — chunk boundaries", () => {
  const capture = threePacketCapture();
  const expected = summarise(feed([capture]));

  it("decodes identically for every single split point in the stream", () => {
    for (let cut = 0; cut <= capture.length; cut++) {
      expect(summarise(feed(splitAt(capture, cut)))).toBe(expected);
    }
  });

  it("decodes identically one byte at a time", () => {
    const chunks: Buffer[] = [];
    for (let i = 0; i < capture.length; i++) chunks.push(capture.subarray(i, i + 1));
    expect(summarise(feed(chunks))).toBe(expected);
  });

  it("survives a split inside the global header at every offset", () => {
    for (let cut = 1; cut < PCAP_GLOBAL_HEADER_LENGTH; cut++) {
      const decoder = new PcapStreamDecoder();
      expect(decoder.push(capture.subarray(0, cut))).toHaveLength(0);
      expect(decoder.getHeader()).toBeNull();
      const rest = decoder.push(capture.subarray(cut));
      decoder.end();
      expect(decoder.getHeader()).not.toBeNull();
      expect(summarise(rest)).toBe(expected);
    }
  });

  it("survives a split inside the first record header at every offset", () => {
    for (let inner = 1; inner < PCAP_RECORD_HEADER_LENGTH; inner++) {
      const cut = PCAP_GLOBAL_HEADER_LENGTH + inner;
      const decoder = new PcapStreamDecoder();
      expect(decoder.push(capture.subarray(0, cut))).toHaveLength(0);
      expect(decoder.getBufferedBytes()).toBe(inner);
      const rest = decoder.push(capture.subarray(cut));
      decoder.end();
      expect(summarise(rest)).toBe(expected);
    }
  });

  it("decodes identically for every pair of split points", () => {
    const tiny = tinyCapture();
    const reference = summarise(feed([tiny]));
    for (let first = 0; first <= tiny.length; first++) {
      for (let second = first; second <= tiny.length; second++) {
        expect(summarise(feed(splitAt(tiny, first, second)))).toBe(reference);
      }
    }
  });

  it("emits each packet on the push that completes it, not before", () => {
    const decoder = new PcapStreamDecoder();
    const firstRecordEnd =
      PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH + parsePcap(capture).packets[0].data.length;

    expect(decoder.push(capture.subarray(0, firstRecordEnd - 1))).toHaveLength(0);
    expect(decoder.push(capture.subarray(firstRecordEnd - 1, firstRecordEnd))).toHaveLength(1);
    expect(decoder.push(capture.subarray(firstRecordEnd))).toHaveLength(2);
    decoder.end();
  });
});

describe("PcapStreamDecoder — byte order and timestamp resolution", () => {
  const cases: Array<{ byteOrder: PcapByteOrder; nanosecondPrecision: boolean }> = [
    { byteOrder: "little", nanosecondPrecision: false },
    { byteOrder: "big", nanosecondPrecision: false },
    { byteOrder: "little", nanosecondPrecision: true },
    { byteOrder: "big", nanosecondPrecision: true },
  ];

  for (const options of cases) {
    it(`decodes a ${options.byteOrder}-endian ${
      options.nanosecondPrecision ? "ns" : "µs"
    } stream fed one byte at a time`, () => {
      const capture = threePacketCapture(options);
      const chunks: Buffer[] = [];
      for (let i = 0; i < capture.length; i++) chunks.push(capture.subarray(i, i + 1));

      const decoder = new PcapStreamDecoder();
      const packets = feed(chunks, decoder);
      expect(decoder.getHeader()).toMatchObject(options);
      expect(packets.map((p) => p.timestampMs)).toEqual([START_MS, START_MS + 40, START_MS + 80.5]);
    });
  }

  it("rejects a sub-second field impossible for the declared resolution", () => {
    const capture = threePacketCapture();
    // Corrupt the first record's ts_usec to more than one second of microseconds.
    capture.writeUInt32LE(2_000_000, PCAP_GLOBAL_HEADER_LENGTH + 4);
    const decoder = new PcapStreamDecoder();
    expect(() => decoder.push(capture)).toThrow(/packet 0: sub-second field/i);
  });
});

describe("PcapStreamDecoder — snaplen truncation", () => {
  it("flags a record whose captured length is short of the wire length", () => {
    const frame = canonicalFrame();
    const capture = encodePcap([
      { timestampMs: START_MS, data: frame.subarray(0, 40), originalLength: frame.length },
      { timestampMs: START_MS + 10, data: frame },
    ]);

    const packets = feed([capture]);
    expect(packets[0].truncated).toBe(true);
    expect(packets[0].capturedLength).toBe(40);
    expect(packets[0].originalLength).toBe(frame.length);
    expect(packets[0].data).toHaveLength(40);
    // A snapped record must not stall or corrupt the records after it.
    expect(packets[1].truncated).toBe(false);
    expect(packets[1].data.equals(frame)).toBe(true);
  });
});

describe("PcapStreamDecoder — bounds", () => {
  it("has bounds enabled by default", () => {
    expect(DEFAULT_MAX_RECORD_BYTES).toBe(262_144);
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(8 * 1024 * 1024);
  });

  it("rejects an oversized incl_len before buffering the body", () => {
    const capture = threePacketCapture();
    capture.writeUInt32LE(50_000_000, PCAP_GLOBAL_HEADER_LENGTH + 8); // incl_len
    const decoder = new PcapStreamDecoder();
    expect(() => decoder.push(capture)).toThrow(PcapStreamOverflowError);
    expect(decoder.getBufferedBytes()).toBe(0);
  });

  it("honours a caller-supplied record bound", () => {
    const decoder = new PcapStreamDecoder({ maxRecordBytes: 32 });
    expect(() => decoder.push(threePacketCapture())).toThrow(/exceeds the 32-byte record limit/i);
  });

  it("rejects an undecodable residue larger than the buffered bound", () => {
    // A record that promises 500 bytes but only 30 arrive: under the record
    // bound, over the buffered bound.
    const capture = encodePcap([{ timestampMs: START_MS, data: Buffer.alloc(500) }]);
    const decoder = new PcapStreamDecoder({ maxRecordBytes: 1000, maxBufferedBytes: 40 });
    expect(() =>
      decoder.push(capture.subarray(0, PCAP_GLOBAL_HEADER_LENGTH + PCAP_RECORD_HEADER_LENGTH + 30)),
    ).toThrow(/undecodable bytes, over the 40-byte limit/i);
  });

  it("rejects nonsensical bounds at construction", () => {
    expect(() => new PcapStreamDecoder({ maxRecordBytes: 0 })).toThrow(PcapParseError);
    expect(() => new PcapStreamDecoder({ maxBufferedBytes: -1 })).toThrow(PcapParseError);
  });
});

describe("PcapStreamDecoder — failing closed", () => {
  it("rethrows the original failure on every later push", () => {
    const junk = Buffer.alloc(PCAP_GLOBAL_HEADER_LENGTH);
    junk.writeUInt32BE(0x12345678, 0);
    const decoder = new PcapStreamDecoder();

    expect(() => decoder.push(junk)).toThrow(/unknown magic/i);
    // pcap has no resynchronisation marker: everything after a framing error is
    // noise, so the decoder must not pretend to recover.
    expect(() => decoder.push(threePacketCapture())).toThrow(/unknown magic/i);
    expect(() => decoder.end()).toThrow(/unknown magic/i);
    expect(decoder.getFailure()).toBeInstanceOf(PcapParseError);
  });

  it("rejects a pcapng stream with an actionable message", () => {
    const pcapng = Buffer.alloc(PCAP_GLOBAL_HEADER_LENGTH);
    pcapng.writeUInt32BE(0x0a0d0d0a, 0);
    expect(() => new PcapStreamDecoder().push(pcapng)).toThrow(/pcapng/i);
  });

  it("propagates and latches an onHeader rejection", () => {
    const decoder = new PcapStreamDecoder({
      onHeader: (header) => {
        if (header.linkType === LINKTYPE_ETHERNET) throw new Error("link type refused by consumer");
      },
    });
    expect(() => decoder.push(threePacketCapture())).toThrow(/refused by consumer/);
    expect(() => decoder.push(Buffer.alloc(4))).toThrow(/refused by consumer/);
  });

  it("does not deliver packets from the chunk that failed", () => {
    const capture = threePacketCapture();
    capture.writeUInt32LE(50_000_000, PCAP_GLOBAL_HEADER_LENGTH + 8);
    const decoder = new PcapStreamDecoder();
    let delivered: StreamedPcapPacket[] = [];
    try {
      delivered = decoder.push(capture);
    } catch {
      // expected
    }
    expect(delivered).toHaveLength(0);
  });
});

describe("PcapStreamDecoder — end of stream", () => {
  it("accepts a stream that ends on a record boundary", () => {
    const decoder = new PcapStreamDecoder();
    decoder.push(threePacketCapture());
    expect(() => decoder.end()).not.toThrow();
  });

  it("reports a stream that ends mid-record", () => {
    const capture = threePacketCapture();
    const decoder = new PcapStreamDecoder();
    decoder.push(capture.subarray(0, capture.length - 5));
    expect(() => decoder.end()).toThrow(
      /ended mid-record: \d+ trailing bytes after 2 complete packet\(s\)/i,
    );
  });

  it("reports a stream that ends before the global header", () => {
    const decoder = new PcapStreamDecoder();
    decoder.push(threePacketCapture().subarray(0, 10));
    expect(() => decoder.end()).toThrow(/before the 24-byte global header/i);
  });

  it("reports a stream that produced no output at all", () => {
    expect(() => new PcapStreamDecoder().end()).toThrow(/without producing any output/i);
  });
});
