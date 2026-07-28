/**
 * Link-frame reassembly tests (#464).
 *
 * DNP3 over TCP is a byte stream, so before any of the verified protocol cores
 * can run, something has to recover whole link frames from it. These tests cover
 * the pathological cases a real network produces (and a hostile peer chooses):
 * splits at every offset, one byte per segment, several frames per segment,
 * garbage before a start pattern, a false 0x0564 inside garbage, an implausible
 * LENGTH, and an unbounded write.
 */
import { describe, it, expect } from "vitest";
import {
  Dnp3LinkFrameReader,
  DNP3_MAX_LINK_FRAME_BYTES,
  DEFAULT_MAX_RX_BUFFER_BYTES,
} from "../server";
import { appendCrc, buildLinkFrame, extractPayload } from "../link-layer";
import { segment } from "../transport";
import { DNP3_FUNCTION } from "../app-objects";

/** A complete, valid link frame carrying a Class-1 READ. */
function validFrame(): Buffer {
  const app = Buffer.from([0xc0, DNP3_FUNCTION.READ, 0x3c, 0x02, 0x06]);
  return buildLinkFrame({
    control: 0xc4,
    destination: 10,
    source: 1,
    payload: segment(app)[0],
  });
}

/** Feed a buffer to a reader in chunks of `size` and collect every frame. */
function pushInChunks(reader: Dnp3LinkFrameReader, data: Buffer, size: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < data.length; off += size) {
    const result = reader.push(data.subarray(off, Math.min(off + size, data.length)));
    expect(result.overflow).toBe(false);
    frames.push(...result.frames);
  }
  return frames;
}

describe("Dnp3LinkFrameReader", () => {
  it("rejects a bound too small to ever hold a maximum-size frame", () => {
    expect(() => new Dnp3LinkFrameReader(DNP3_MAX_LINK_FRAME_BYTES - 1)).toThrow(
      /smaller than one maximum link frame/,
    );
    expect(() => new Dnp3LinkFrameReader(DNP3_MAX_LINK_FRAME_BYTES)).not.toThrow();
  });

  it("computes the maximum frame size from the one-octet LENGTH field", () => {
    // 10 header octets + 250 user-data octets + 16 block CRCs.
    expect(DNP3_MAX_LINK_FRAME_BYTES).toBe(292);
  });

  it("returns a whole frame that arrives in one segment", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    const { frames, overflow } = reader.push(frame);
    expect(overflow).toBe(false);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("reassembles a frame split at every possible offset", () => {
    const frame = validFrame();
    for (let split = 1; split < frame.length; split++) {
      const reader = new Dnp3LinkFrameReader();
      const first = reader.push(frame.subarray(0, split));
      expect(first.overflow).toBe(false);
      const second = reader.push(frame.subarray(split));
      const all = [...first.frames, ...second.frames];
      expect(all, `split at ${split}`).toHaveLength(1);
      expect(all[0].equals(frame), `split at ${split}`).toBe(true);
    }
  });

  it("reassembles a frame delivered one byte at a time", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    const frames = pushInChunks(reader, frame, 1);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("returns several frames delivered in a single segment", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    const { frames } = reader.push(Buffer.concat([frame, frame, frame]));
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f.equals(frame)).toBe(true);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("keeps a trailing 0x05 that may be the first half of a start pattern", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    // Garbage that ends in 0x05, then the frame's own 0x05 0x64 in the next push.
    const first = reader.push(Buffer.from([0xaa, 0xbb, 0x05]));
    expect(first.frames).toHaveLength(0);
    expect(reader.bufferedBytes).toBe(1);
    const second = reader.push(frame);
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].equals(frame)).toBe(true);
  });

  it("resynchronises past garbage that precedes a start pattern", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    const garbage = Buffer.from([0x00, 0xff, 0x64, 0x05, 0x11, 0x22]);
    const { frames } = reader.push(Buffer.concat([garbage, frame]));
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
    expect(reader.discardedBytes).toBe(garbage.length);
  });

  it("resynchronises past a false 0x0564 whose header CRC does not verify", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    // A plausible-looking header with a deliberately wrong CRC.
    const impostor = Buffer.from([0x05, 0x64, 0x14, 0xc4, 0x0a, 0x00, 0x01, 0x00, 0x00, 0x00]);
    const { frames } = reader.push(Buffer.concat([impostor, frame]));
    expect(reader.rejectedHeaderCount).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("rejects an implausible LENGTH even when its header CRC is valid", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    // LENGTH counts CONTROL+DEST+SRC and so can never be below 5. This header is
    // internally consistent (correct CRC) but structurally impossible.
    const header = Buffer.from([0x05, 0x64, 0x03, 0xc4, 0x0a, 0x00, 0x01, 0x00]);
    const bogus = appendCrc(header);
    expect(bogus).toHaveLength(10);

    const { frames } = reader.push(Buffer.concat([bogus, frame]));
    expect(reader.rejectedHeaderCount).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("waits rather than emitting a frame whose user data has not arrived", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    const { frames } = reader.push(frame.subarray(0, frame.length - 1));
    expect(frames).toHaveLength(0);
    expect(reader.bufferedBytes).toBe(frame.length - 1);
  });

  it("bounds the read buffer and drops the connection's bytes on overflow", () => {
    const reader = new Dnp3LinkFrameReader(DNP3_MAX_LINK_FRAME_BYTES);
    // A peer that opens a frame and then blasts a huge write.
    const opening = reader.push(Buffer.from([0x05, 0x64]));
    expect(opening.overflow).toBe(false);
    const flood = reader.push(Buffer.alloc(DNP3_MAX_LINK_FRAME_BYTES, 0xaa));
    expect(flood.overflow).toBe(true);
    expect(flood.frames).toHaveLength(0);
    expect(reader.bufferedBytes).toBe(0);
  });

  it("never grows its buffer while a peer dribbles pure garbage", () => {
    const reader = new Dnp3LinkFrameReader(DNP3_MAX_LINK_FRAME_BYTES);
    for (let i = 0; i < DEFAULT_MAX_RX_BUFFER_BYTES; i++) {
      const { frames, overflow } = reader.push(Buffer.from([0xa5]));
      expect(overflow).toBe(false);
      expect(frames).toHaveLength(0);
      // 0xa5 is not 0x05, so nothing is ever retained.
      expect(reader.bufferedBytes).toBe(0);
    }
    expect(reader.discardedBytes).toBe(DEFAULT_MAX_RX_BUFFER_BYTES);
  });

  it("hands downstream frames whose payload the link layer can extract", () => {
    const reader = new Dnp3LinkFrameReader();
    const { frames } = reader.push(validFrame());
    const extracted = extractPayload(frames[0]);
    expect(extracted).not.toBeNull();
    expect(extracted!.header.source).toBe(1);
    expect(extracted!.header.destination).toBe(10);
    // FIR|FIN|seq 0 transport header, then the application fragment.
    expect([...extracted!.payload]).toEqual([
      0xc0, 0xc0, DNP3_FUNCTION.READ, 0x3c, 0x02, 0x06,
    ]);
  });

  it("reassembles a maximum-size frame carried across many small segments", () => {
    const reader = new Dnp3LinkFrameReader();
    const payload = Buffer.alloc(249, 0x5a); // 1 transport header + 248 app bytes
    const frame = buildLinkFrame({
      control: 0xc4,
      destination: 10,
      source: 1,
      payload,
    });
    expect(frame.length).toBeLessThanOrEqual(DNP3_MAX_LINK_FRAME_BYTES);
    const frames = pushInChunks(reader, frame, 7);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("discards everything after reset()", () => {
    const reader = new Dnp3LinkFrameReader();
    const frame = validFrame();
    reader.push(frame.subarray(0, 5));
    expect(reader.bufferedBytes).toBe(5);
    reader.reset();
    expect(reader.bufferedBytes).toBe(0);
    // The tail alone is not a frame, and its bytes must not resurrect one.
    const { frames } = reader.push(frame.subarray(5));
    expect(frames).toHaveLength(0);
  });
});
