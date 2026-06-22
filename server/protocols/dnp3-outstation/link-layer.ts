/**
 * DNP3 Data Link Layer — Framing + CRC
 * Issue #464: DNP3 Outstation Mode
 *
 * PARTIAL (substantial). The CRC-DNP and the link-header struct (de)serialise
 * are FULLY implemented + unit tested. Multi-block payload CRC interleaving on
 * receive and full secondary-link-confirm state machine are marked TODO.
 *
 * DNP3 link frame layout (IEEE 1815 §9):
 *   start  : 0x05 0x64           (2)
 *   length : count of octets from CONTROL through end of user data, max 255 (1)
 *   control: DIR/PRM/FCB/FCV/func (1)
 *   dest   : 16-bit LE link address (2)
 *   src    : 16-bit LE link address (2)
 *   header CRC                    (2)
 *   then user data in 16-octet blocks, each followed by a 2-octet CRC.
 */

/** Link-layer function codes (PRM=1, master->outstation). */
export const DNP3_LINK_FUNCTION = {
  RESET_LINK: 0x0,
  TEST_LINK: 0x2,
  CONFIRMED_USER_DATA: 0x3,
  UNCONFIRMED_USER_DATA: 0x4,
  REQUEST_LINK_STATUS: 0x9,
  // Secondary (PRM=0)
  ACK: 0x0,
  NACK: 0x1,
  LINK_STATUS: 0xb,
} as const;

export const DNP3_START_BYTES = Buffer.from([0x05, 0x64]);
export const DNP3_BLOCK_SIZE = 16;

/** Parsed link-layer header. */
export interface Dnp3LinkHeader {
  length: number;
  control: number;
  /** DIR bit — 1 = master->outstation */
  dir: boolean;
  /** PRM bit — 1 = primary message */
  prm: boolean;
  /** FCB — frame count bit */
  fcb: boolean;
  /** FCV — frame count valid */
  fcv: boolean;
  /** link function code (low nibble of control) */
  func: number;
  destination: number;
  source: number;
}

/**
 * Precomputed CRC-DNP lookup table (polynomial 0x3D65, reflected, init 0x0000,
 * final XOR 0xFFFF). This is the standard DNP3 block CRC.
 */
const CRC_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  const poly = 0xa6bc; // reflected form of 0x3D65
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1;
    }
    table[i] = crc & 0xffff;
  }
  return table;
})();

/**
 * Compute the DNP3 CRC over a buffer. The final value is bit-inverted as the
 * standard requires. Returns a 16-bit unsigned integer.
 */
export function dnp3Crc(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    const idx = (crc ^ data[i]) & 0xff;
    crc = (crc >>> 8) ^ CRC_TABLE[idx];
  }
  return (~crc) & 0xffff;
}

/** Append a little-endian DNP3 CRC to a data block, returning block||crc. */
export function appendCrc(block: Buffer): Buffer {
  const crc = dnp3Crc(block);
  const out = Buffer.alloc(block.length + 2);
  block.copy(out, 0);
  out.writeUInt16LE(crc, block.length);
  return out;
}

/** Verify a block whose final two octets are its little-endian CRC. */
export function verifyBlockCrc(blockWithCrc: Buffer): boolean {
  if (blockWithCrc.length < 2) return false;
  const body = blockWithCrc.subarray(0, blockWithCrc.length - 2);
  const got = blockWithCrc.readUInt16LE(blockWithCrc.length - 2);
  return dnp3Crc(body) === got;
}

/** Parse a 10-octet link header (start..header-CRC). Verifies the header CRC. */
export function parseLinkHeader(buf: Buffer): Dnp3LinkHeader | null {
  if (buf.length < 10) return null;
  if (buf[0] !== 0x05 || buf[1] !== 0x64) return null;
  const header = buf.subarray(0, 8);
  const headerCrc = buf.readUInt16LE(8);
  if (dnp3Crc(header) !== headerCrc) return null;

  const control = buf[3];
  return {
    length: buf[2],
    control,
    dir: (control & 0x80) !== 0,
    prm: (control & 0x40) !== 0,
    fcb: (control & 0x20) !== 0,
    fcv: (control & 0x10) !== 0,
    func: control & 0x0f,
    destination: buf.readUInt16LE(4),
    source: buf.readUInt16LE(6),
  };
}

/**
 * Build a complete DNP3 link frame from a user-data payload (the transport
 * segment). Splits the payload into 16-octet CRC blocks and prepends the
 * header with its own CRC.
 */
export function buildLinkFrame(opts: {
  control: number;
  destination: number;
  source: number;
  payload: Buffer;
}): Buffer {
  const { control, destination, source, payload } = opts;
  // length counts CONTROL + DEST(2) + SRC(2) + user-data octets (excl. CRCs)
  const length = 5 + payload.length;
  if (length > 255) {
    throw new Error(`DNP3 link frame too long: ${length} (max 255). TODO: caller must segment at transport layer.`);
  }
  const header = Buffer.alloc(8);
  header[0] = 0x05;
  header[1] = 0x64;
  header[2] = length & 0xff;
  header[3] = control & 0xff;
  header.writeUInt16LE(destination & 0xffff, 4);
  header.writeUInt16LE(source & 0xffff, 6);
  const headerBlock = appendCrc(header);

  const blocks: Buffer[] = [headerBlock];
  for (let off = 0; off < payload.length; off += DNP3_BLOCK_SIZE) {
    const block = payload.subarray(off, Math.min(off + DNP3_BLOCK_SIZE, payload.length));
    blocks.push(appendCrc(block));
  }
  return Buffer.concat(blocks);
}

/**
 * Extract the user-data payload from a full link frame, verifying every block
 * CRC. Returns null if any CRC fails or the frame is malformed.
 *
 * TODO: this assumes the whole frame is present in one buffer. The TCP receive
 * path in index.ts must reassemble across segment boundaries before calling.
 */
export function extractPayload(frame: Buffer): { header: Dnp3LinkHeader; payload: Buffer } | null {
  const header = parseLinkHeader(frame);
  if (!header) return null;
  const userDataLen = header.length - 5; // octets of user data (excl. CRCs)
  if (userDataLen < 0) return null;

  let off = 10; // past header block (8 + 2 CRC)
  const chunks: Buffer[] = [];
  let remaining = userDataLen;
  while (remaining > 0) {
    const take = Math.min(DNP3_BLOCK_SIZE, remaining);
    const blockWithCrc = frame.subarray(off, off + take + 2);
    if (blockWithCrc.length < take + 2) return null;
    if (!verifyBlockCrc(blockWithCrc)) return null;
    chunks.push(blockWithCrc.subarray(0, take));
    off += take + 2;
    remaining -= take;
  }
  return { header, payload: Buffer.concat(chunks) };
}

/** Build the CONTROL octet for an outstation response (DIR=0, PRM=1). */
export function buildResponseControl(func: number, opts?: { fcb?: boolean; fcv?: boolean }): number {
  let control = func & 0x0f;
  control |= 0x40; // PRM (outstation initiating link service)
  if (opts?.fcb) control |= 0x20;
  if (opts?.fcv) control |= 0x10;
  return control & 0xff;
}
