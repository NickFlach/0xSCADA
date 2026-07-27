/**
 * Classic libpcap ("savefile") reader/writer.
 *
 * This is the minimum of the format needed to replay a captured GOOSE trace
 * offline, and to produce the committed test capture. It is deliberately NOT a
 * pcapng implementation — pcapng (`.pcapng`, magic 0x0a0d0d0a) has a completely
 * different block structure and is rejected with a clear error.
 *
 * File layout (libpcap-1.x, `pcap/pcap.h`):
 *
 *   Global header (24 bytes)
 *     magic          u32   0xa1b2c3d4 (µs) or 0xa1b23c4d (ns)
 *     version_major  u16   normally 2
 *     version_minor  u16   normally 4
 *     thiszone       i32   GMT-to-local correction, in practice always 0
 *     sigfigs        u32   timestamp accuracy, in practice always 0
 *     snaplen        u32   max captured length per packet
 *     network        u32   LINKTYPE_* (1 = Ethernet)
 *
 *   Then, repeated until EOF, per packet:
 *     ts_sec         u32   seconds since the Unix epoch
 *     ts_subsec      u32   microseconds (or nanoseconds, per the magic)
 *     incl_len       u32   bytes of packet data present in the file
 *     orig_len       u32   length of the packet as it appeared on the wire
 *     data           incl_len bytes
 *
 * BYTE ORDER: the writer of the file uses its own host byte order and the
 * reader detects it from the magic number, so all four magic byte sequences
 * below have to be accepted:
 *
 *   a1 b2 c3 d4   big-endian,    microsecond timestamps
 *   d4 c3 b2 a1   little-endian, microsecond timestamps
 *   a1 b2 3c 4d   big-endian,    nanosecond timestamps
 *   4d 3c b2 a1   little-endian, nanosecond timestamps
 *
 * Issue: #465
 */

/** Standard libpcap magic, microsecond timestamp resolution. */
export const PCAP_MAGIC_MICROSECONDS = 0xa1b2c3d4;
/** libpcap magic used by nanosecond-resolution captures. */
export const PCAP_MAGIC_NANOSECONDS = 0xa1b23c4d;
/** pcapng section-header-block type, used only to produce a clear error. */
const PCAPNG_BLOCK_TYPE_SHB = 0x0a0d0d0a;

/** LINKTYPE_ETHERNET — the only link type a GOOSE capture can use. */
export const LINKTYPE_ETHERNET = 1;

export const PCAP_GLOBAL_HEADER_LENGTH = 24;
export const PCAP_RECORD_HEADER_LENGTH = 16;

/** Thrown for any malformed or unsupported capture file. */
export class PcapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PcapParseError";
  }
}

export type PcapByteOrder = "big" | "little";

export interface PcapGlobalHeader {
  /** Byte order the file was written in, detected from the magic number. */
  byteOrder: PcapByteOrder;
  /** True when packet sub-second fields are nanoseconds rather than microseconds. */
  nanosecondPrecision: boolean;
  versionMajor: number;
  versionMinor: number;
  /**
   * `thiszone` — GMT-to-local correction in seconds. libpcap has always written
   * 0 here and Wireshark ignores it; we surface the recorded value but, like
   * every other implementation, do NOT apply it to packet timestamps.
   */
  thisZone: number;
  /** `sigfigs` — declared timestamp accuracy. In practice always 0. */
  sigFigs: number;
  /** Maximum number of bytes captured per packet. */
  snapLen: number;
  /** LINKTYPE_* value describing the link-layer of every packet. */
  linkType: number;
}

export interface PcapPacket {
  /**
   * Absolute capture time as milliseconds since the Unix epoch, fractional.
   * Sub-microsecond detail from nanosecond captures is not representable in a
   * double at epoch magnitudes; `seconds`/`subSeconds` keep the exact record.
   */
  timestampMs: number;
  /** Exact `ts_sec` field. */
  seconds: number;
  /** Exact `ts_subsec` field (µs or ns per {@link PcapGlobalHeader.nanosecondPrecision}). */
  subSeconds: number;
  /** Number of bytes stored in the file for this packet. */
  capturedLength: number;
  /** Length of the packet on the wire; larger than `capturedLength` if snapped. */
  originalLength: number;
  /** The captured bytes (a copy, not a view into the source buffer). */
  data: Buffer;
}

export interface PcapFile {
  header: PcapGlobalHeader;
  packets: PcapPacket[];
}

function readU32(buf: Buffer, offset: number, order: PcapByteOrder): number {
  return order === "big" ? buf.readUInt32BE(offset) : buf.readUInt32LE(offset);
}

function readU16(buf: Buffer, offset: number, order: PcapByteOrder): number {
  return order === "big" ? buf.readUInt16BE(offset) : buf.readUInt16LE(offset);
}

function readI32(buf: Buffer, offset: number, order: PcapByteOrder): number {
  return order === "big" ? buf.readInt32BE(offset) : buf.readInt32LE(offset);
}

/**
 * Decode the 24-byte global header, detecting byte order and timestamp
 * resolution from the magic number.
 */
export function readPcapGlobalHeader(buf: Buffer): PcapGlobalHeader {
  if (buf.length < PCAP_GLOBAL_HEADER_LENGTH) {
    throw new PcapParseError(
      `pcap file too short: ${buf.length} bytes < ${PCAP_GLOBAL_HEADER_LENGTH}-byte global header`,
    );
  }

  const magicBE = buf.readUInt32BE(0);
  const magicLE = buf.readUInt32LE(0);

  let byteOrder: PcapByteOrder;
  let nanosecondPrecision: boolean;

  if (magicBE === PCAP_MAGIC_MICROSECONDS) {
    byteOrder = "big";
    nanosecondPrecision = false;
  } else if (magicLE === PCAP_MAGIC_MICROSECONDS) {
    byteOrder = "little";
    nanosecondPrecision = false;
  } else if (magicBE === PCAP_MAGIC_NANOSECONDS) {
    byteOrder = "big";
    nanosecondPrecision = true;
  } else if (magicLE === PCAP_MAGIC_NANOSECONDS) {
    byteOrder = "little";
    nanosecondPrecision = true;
  } else if (magicBE === PCAPNG_BLOCK_TYPE_SHB) {
    throw new PcapParseError(
      "this is a pcapng file, not a classic pcap file — re-save it as pcap " +
        "(Wireshark: File > Save As > Wireshark/tcpdump/... pcap)",
    );
  } else {
    throw new PcapParseError(
      `not a pcap file: unknown magic 0x${magicBE.toString(16).padStart(8, "0")}`,
    );
  }

  return {
    byteOrder,
    nanosecondPrecision,
    versionMajor: readU16(buf, 4, byteOrder),
    versionMinor: readU16(buf, 6, byteOrder),
    thisZone: readI32(buf, 8, byteOrder),
    sigFigs: readU32(buf, 12, byteOrder),
    snapLen: readU32(buf, 16, byteOrder),
    linkType: readU32(buf, 20, byteOrder),
  };
}

/**
 * Parse a complete classic-pcap buffer into its header and packet records.
 *
 * Throws {@link PcapParseError} on a truncated record — a half-written capture
 * is reported rather than silently returning the packets that happened to be
 * complete.
 */
export function parsePcap(buf: Buffer): PcapFile {
  const header = readPcapGlobalHeader(buf);
  const packets: PcapPacket[] = [];
  const subSecondsPerSecond = header.nanosecondPrecision ? 1_000_000_000 : 1_000_000;

  let offset = PCAP_GLOBAL_HEADER_LENGTH;
  while (offset < buf.length) {
    if (offset + PCAP_RECORD_HEADER_LENGTH > buf.length) {
      throw new PcapParseError(
        `truncated packet record header at offset ${offset} ` +
          `(${buf.length - offset} of ${PCAP_RECORD_HEADER_LENGTH} bytes)`,
      );
    }
    const seconds = readU32(buf, offset, header.byteOrder);
    const subSeconds = readU32(buf, offset + 4, header.byteOrder);
    const capturedLength = readU32(buf, offset + 8, header.byteOrder);
    const originalLength = readU32(buf, offset + 12, header.byteOrder);
    offset += PCAP_RECORD_HEADER_LENGTH;

    if (subSeconds >= subSecondsPerSecond) {
      throw new PcapParseError(
        `packet ${packets.length}: sub-second field ${subSeconds} exceeds ` +
          `${subSecondsPerSecond} — byte order or magic is wrong`,
      );
    }
    if (offset + capturedLength > buf.length) {
      throw new PcapParseError(
        `truncated packet ${packets.length}: incl_len ${capturedLength} at offset ` +
          `${offset} exceeds the ${buf.length}-byte file`,
      );
    }

    packets.push({
      timestampMs: seconds * 1000 + (subSeconds / subSecondsPerSecond) * 1000,
      seconds,
      subSeconds,
      capturedLength,
      originalLength,
      data: Buffer.from(buf.subarray(offset, offset + capturedLength)),
    });
    offset += capturedLength;
  }

  return { header, packets };
}

export interface PcapPacketInput {
  /** Absolute capture time in milliseconds since the Unix epoch. */
  timestampMs: number;
  /** Link-layer bytes (a full Ethernet frame for LINKTYPE_ETHERNET). */
  data: Buffer;
  /** On-the-wire length, if the packet was snapped. Defaults to `data.length`. */
  originalLength?: number;
}

export interface PcapEncodeOptions {
  /** Byte order to write. Default "little" (what x86 libpcap produces). */
  byteOrder?: PcapByteOrder;
  /** Write nanosecond timestamps (magic 0xa1b23c4d). Default false. */
  nanosecondPrecision?: boolean;
  /** `snaplen` field. Default 65535. */
  snapLen?: number;
  /** `network` field. Default {@link LINKTYPE_ETHERNET}. */
  linkType?: number;
}

/**
 * Encode packets into a classic-pcap buffer.
 *
 * This is the exact inverse of {@link parsePcap} and exists for two real
 * reasons: it generates the committed GOOSE replay fixture (so the fixture is
 * reproducible from source rather than an opaque binary blob), and it lets
 * operators bundle a capture they built themselves for regression replay.
 */
export function encodePcap(
  packets: readonly PcapPacketInput[],
  options: PcapEncodeOptions = {},
): Buffer {
  const byteOrder: PcapByteOrder = options.byteOrder ?? "little";
  const nanosecondPrecision = options.nanosecondPrecision ?? false;
  const snapLen = options.snapLen ?? 65535;
  const linkType = options.linkType ?? LINKTYPE_ETHERNET;
  const subSecondsPerSecond = nanosecondPrecision ? 1_000_000_000 : 1_000_000;

  const writeU32 = (target: Buffer, offset: number, value: number): void => {
    if (byteOrder === "big") target.writeUInt32BE(value >>> 0, offset);
    else target.writeUInt32LE(value >>> 0, offset);
  };
  const writeU16 = (target: Buffer, offset: number, value: number): void => {
    if (byteOrder === "big") target.writeUInt16BE(value & 0xffff, offset);
    else target.writeUInt16LE(value & 0xffff, offset);
  };

  const globalHeader = Buffer.alloc(PCAP_GLOBAL_HEADER_LENGTH);
  writeU32(globalHeader, 0, nanosecondPrecision ? PCAP_MAGIC_NANOSECONDS : PCAP_MAGIC_MICROSECONDS);
  writeU16(globalHeader, 4, 2); // version_major
  writeU16(globalHeader, 6, 4); // version_minor
  writeU32(globalHeader, 8, 0); // thiszone — always 0, as libpcap writes
  writeU32(globalHeader, 12, 0); // sigfigs — always 0, as libpcap writes
  writeU32(globalHeader, 16, snapLen);
  writeU32(globalHeader, 20, linkType);

  const chunks: Buffer[] = [globalHeader];
  for (const packet of packets) {
    if (!Number.isFinite(packet.timestampMs) || packet.timestampMs < 0) {
      throw new PcapParseError(`packet timestampMs must be a non-negative number`);
    }
    // Split seconds from sub-seconds without ever multiplying an epoch-scale
    // millisecond value by 1e6, which would exceed Number.MAX_SAFE_INTEGER.
    let seconds = Math.floor(packet.timestampMs / 1000);
    let subSeconds = Math.round(
      (packet.timestampMs - seconds * 1000) * (subSecondsPerSecond / 1000),
    );
    if (subSeconds >= subSecondsPerSecond) {
      seconds += 1;
      subSeconds -= subSecondsPerSecond;
    }

    const recordHeader = Buffer.alloc(PCAP_RECORD_HEADER_LENGTH);
    writeU32(recordHeader, 0, seconds);
    writeU32(recordHeader, 4, subSeconds);
    writeU32(recordHeader, 8, packet.data.length);
    writeU32(recordHeader, 12, packet.originalLength ?? packet.data.length);
    chunks.push(recordHeader, packet.data);
  }

  return Buffer.concat(chunks);
}
