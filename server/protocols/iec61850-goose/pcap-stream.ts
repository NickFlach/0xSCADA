/**
 * Incremental (streaming) classic-libpcap decoder.
 *
 * {@link ./pcap.js#parsePcap} needs the whole capture in one Buffer, which is
 * fine for a file but useless for a live capture: `dumpcap -w -` / `tcpdump -w -`
 * write pcap to a pipe, and a pipe hands Node arbitrary chunk boundaries. A
 * chunk can end in the middle of the 24-byte global header, in the middle of a
 * 16-byte record header, or in the middle of packet data — at ANY byte offset.
 *
 * This decoder keeps the undecodable residue and resumes from it, so the byte
 * stream is decoded identically no matter how it is sliced. The record layout
 * and byte-order handling are NOT duplicated here: both come from
 * {@link decodePcapRecordHeader} / {@link readPcapGlobalHeader} in pcap.ts, so a
 * whole-buffer parse and a streaming parse cannot drift apart.
 *
 * BOUNDED BY CONSTRUCTION. A capture tool that is faster than the consumer, a
 * corrupted stream, or a hostile process on the other end of the pipe must not
 * be able to grow the internal buffer without limit:
 *
 *   - `maxRecordBytes` rejects a record header whose `incl_len` is larger than
 *     any frame the capture could legitimately contain. It is checked the
 *     instant the record header is readable, i.e. BEFORE the body is buffered.
 *   - `maxBufferedBytes` bounds the residue that survives a decode pass.
 *
 * Either bound trips {@link PcapStreamOverflowError} and puts the decoder into a
 * permanent failed state: a pcap stream has no resynchronisation marker, so
 * once the framing is lost, every subsequent byte is meaningless. Failing
 * closed is the only honest option.
 *
 * SNAPLEN TRUNCATION. When the capture was snapped (`incl_len < orig_len`) the
 * stored bytes are a prefix of the real frame. The record still decodes — it is
 * a valid pcap record — but it is flagged {@link StreamedPcapPacket.truncated}
 * so the consumer can reject it instead of handing a cut-off GOOSE APDU to a
 * BER decoder that would either throw or, worse, decode a partial dataset.
 *
 * Issue: #465
 */

import {
  PCAP_GLOBAL_HEADER_LENGTH,
  PCAP_RECORD_HEADER_LENGTH,
  PcapParseError,
  decodePcapRecordHeader,
  readPcapGlobalHeader,
  type PcapGlobalHeader,
  type PcapPacket,
} from "./pcap.js";

/**
 * Largest single record accepted by default: 262 144 bytes, which is dumpcap's
 * own default snapshot length. Anything larger is a corrupt or hostile
 * `incl_len`, not a captured frame.
 */
export const DEFAULT_MAX_RECORD_BYTES = 262_144;

/**
 * Largest undecodable residue kept between chunks by default. Reached only if a
 * record header promises a large body that never fully arrives; the record
 * bound normally trips first.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Thrown when a stream exceeds one of the decoder's hard bounds. */
export class PcapStreamOverflowError extends PcapParseError {
  constructor(message: string) {
    super(message);
    this.name = "PcapStreamOverflowError";
  }
}

/** A packet decoded from a stream, with its stream position and snap state. */
export interface StreamedPcapPacket extends PcapPacket {
  /** 0-based index of this record within the stream. */
  index: number;
  /**
   * True when the capture stored fewer bytes than the frame had on the wire
   * (`incl_len < orig_len`), i.e. the snapshot length cut the frame short.
   * `data` then holds only the first {@link PcapPacket.capturedLength} bytes.
   */
  truncated: boolean;
}

export interface PcapStreamDecoderOptions {
  /** Reject any record whose `incl_len` exceeds this. Default {@link DEFAULT_MAX_RECORD_BYTES}. */
  maxRecordBytes?: number;
  /** Reject when the undecodable residue exceeds this. Default {@link DEFAULT_MAX_BUFFERED_BYTES}. */
  maxBufferedBytes?: number;
  /**
   * Called once, during the {@link PcapStreamDecoder.push} that completes the
   * global header. Throwing from it aborts that push and fails the decoder —
   * which is how a consumer rejects an unusable link type before any packet is
   * delivered.
   */
  onHeader?: (header: PcapGlobalHeader) => void;
}

const EMPTY = Buffer.alloc(0);

/**
 * Feed bytes in with {@link push}; get complete packets back out.
 *
 * ```ts
 * const decoder = new PcapStreamDecoder({ maxRecordBytes: 65535 });
 * child.stdout.on("data", (chunk: Buffer) => {
 *   for (const packet of decoder.push(chunk)) { ... }
 * });
 * ```
 */
export class PcapStreamDecoder {
  private readonly maxRecordBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly onHeader?: (header: PcapGlobalHeader) => void;

  /** Bytes received but not yet decoded into a packet. */
  private pending: Buffer = EMPTY;
  private header: PcapGlobalHeader | null = null;
  private packetIndex = 0;
  private totalBytes = 0;
  /** Set once the stream is unusable; every later call rethrows it. */
  private failure: Error | null = null;

  constructor(options: PcapStreamDecoderOptions = {}) {
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.onHeader = options.onHeader;
    if (!(this.maxRecordBytes > 0)) {
      throw new PcapParseError(`maxRecordBytes must be > 0, got ${this.maxRecordBytes}`);
    }
    if (!(this.maxBufferedBytes > 0)) {
      throw new PcapParseError(`maxBufferedBytes must be > 0, got ${this.maxBufferedBytes}`);
    }
  }

  /** The global header, once enough bytes have arrived to decode it. */
  getHeader(): PcapGlobalHeader | null {
    return this.header;
  }

  /** Bytes currently held back waiting for the rest of their record. */
  getBufferedBytes(): number {
    return this.pending.length;
  }

  /** Total bytes handed to {@link push}. */
  getTotalBytes(): number {
    return this.totalBytes;
  }

  /** Number of complete records emitted so far. */
  getPacketCount(): number {
    return this.packetIndex;
  }

  /** The error that put the decoder into its permanent failed state, if any. */
  getFailure(): Error | null {
    return this.failure;
  }

  /**
   * Absorb a chunk and return every record that became complete because of it.
   *
   * A chunk that fails yields nothing at all, including any records that
   * decoded before the failure: the stream is finished either way, and the
   * consumer's next action is to stop the producer, not to process a partial
   * batch from a stream it has just declared corrupt.
   *
   * @throws {PcapParseError} on malformed input, {@link PcapStreamOverflowError}
   *   when a bound is exceeded. Both are permanent — the decoder cannot
   *   resynchronise and rethrows on every subsequent call.
   */
  push(chunk: Buffer): StreamedPcapPacket[] {
    if (this.failure) throw this.failure;
    this.totalBytes += chunk.length;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    try {
      const packets = this.drain();
      if (this.pending.length > this.maxBufferedBytes) {
        throw new PcapStreamOverflowError(
          `pcap stream buffered ${this.pending.length} undecodable bytes, ` +
            `over the ${this.maxBufferedBytes}-byte limit`,
        );
      }
      return packets;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  /**
   * Declare the stream finished. Throws when the stream stopped part-way
   * through a record or before the global header — a caller that deliberately
   * killed the producer (e.g. `close()`) should skip this or ignore the throw.
   */
  end(): void {
    if (this.failure) throw this.failure;
    if (this.header === null) {
      const err = new PcapParseError(
        this.totalBytes === 0
          ? "pcap stream ended without producing any output"
          : `pcap stream ended after ${this.totalBytes} bytes, before the ` +
            `${PCAP_GLOBAL_HEADER_LENGTH}-byte global header was complete`,
      );
      this.fail(err);
      throw err;
    }
    if (this.pending.length > 0) {
      const err = new PcapParseError(
        `pcap stream ended mid-record: ${this.pending.length} trailing bytes after ` +
          `${this.packetIndex} complete packet(s)`,
      );
      this.fail(err);
      throw err;
    }
  }

  /** Decode as much of `pending` as is complete. */
  private drain(): StreamedPcapPacket[] {
    const packets: StreamedPcapPacket[] = [];

    for (;;) {
      if (this.header === null) {
        if (this.pending.length < PCAP_GLOBAL_HEADER_LENGTH) break;
        // readPcapGlobalHeader detects byte order + timestamp resolution from the
        // magic and rejects pcapng/unknown magics with an actionable message.
        this.header = readPcapGlobalHeader(this.pending.subarray(0, PCAP_GLOBAL_HEADER_LENGTH));
        this.consume(PCAP_GLOBAL_HEADER_LENGTH);
        this.onHeader?.(this.header);
        continue;
      }

      if (this.pending.length < PCAP_RECORD_HEADER_LENGTH) break;
      const record = decodePcapRecordHeader(this.pending, 0, this.header, this.packetIndex);

      // Bound BEFORE buffering the body: a corrupt or hostile incl_len must not
      // be able to reserve memory just by being announced.
      if (record.capturedLength > this.maxRecordBytes) {
        throw new PcapStreamOverflowError(
          `packet ${this.packetIndex}: incl_len ${record.capturedLength} exceeds the ` +
            `${this.maxRecordBytes}-byte record limit — the stream is corrupt or the ` +
            "capture tool ignored the configured snapshot length",
        );
      }

      const total = PCAP_RECORD_HEADER_LENGTH + record.capturedLength;
      if (this.pending.length < total) break; // body still in flight

      packets.push({
        timestampMs: record.timestampMs,
        seconds: record.seconds,
        subSeconds: record.subSeconds,
        capturedLength: record.capturedLength,
        originalLength: record.originalLength,
        // Copy: `pending` is sliced and reassigned, and the caller keeps the frame.
        data: Buffer.from(this.pending.subarray(PCAP_RECORD_HEADER_LENGTH, total)),
        index: this.packetIndex,
        truncated: record.capturedLength < record.originalLength,
      });
      this.packetIndex += 1;
      this.consume(total);
    }

    return packets;
  }

  private consume(bytes: number): void {
    // subarray is a view, so consuming never copies the remainder.
    this.pending = bytes >= this.pending.length ? EMPTY : this.pending.subarray(bytes);
  }

  /**
   * Enter the permanent failed state. A pcap stream carries no framing marker
   * to resynchronise on, so anything after a framing error is noise.
   */
  private fail(err: unknown): void {
    if (this.failure) return;
    this.failure = err instanceof Error ? err : new PcapParseError(String(err));
    this.pending = EMPTY;
  }
}
