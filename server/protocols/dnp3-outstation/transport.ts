/**
 * DNP3 Transport Function — Segmentation / Reassembly
 * Issue #464: DNP3 Outstation Mode
 *
 * FULLY IMPLEMENTED + UNIT TESTED.
 *
 * The DNP3 transport function sits between the link layer and the application
 * layer. Each link-layer user-data payload begins with a 1-octet transport
 * header:
 *   bit 7  FIN — final segment of the fragment
 *   bit 6  FIR — first segment of the fragment
 *   bits 5-0  SEQUENCE — wraps mod 64
 *
 * An application fragment that exceeds the per-segment payload limit
 * (default 249 = 250 link user-data octets minus the 1-octet transport header)
 * is split across multiple segments. This module performs that split on TX and
 * the reassembly on RX with sequence validation.
 */

export const TRANSPORT_FIN = 0x80;
export const TRANSPORT_FIR = 0x40;
export const TRANSPORT_SEQ_MASK = 0x3f;

/** Max application bytes per transport segment (link payload 250 - 1 header). */
export const DEFAULT_MAX_SEGMENT_PAYLOAD = 249;

/**
 * Split an application fragment into transport segments. Each returned buffer is
 * a transport segment (1-octet header + chunk) ready to hand to the link layer.
 *
 * @param startSeq initial sequence number (0..63); wraps mod 64.
 */
export function segment(
  appFragment: Buffer,
  startSeq = 0,
  maxPayload = DEFAULT_MAX_SEGMENT_PAYLOAD,
): Buffer[] {
  if (maxPayload <= 0) throw new Error('maxPayload must be positive');
  const segments: Buffer[] = [];
  let seq = startSeq & TRANSPORT_SEQ_MASK;

  if (appFragment.length === 0) {
    // A single empty FIR+FIN segment (e.g. an empty CONFIRM).
    segments.push(Buffer.from([TRANSPORT_FIR | TRANSPORT_FIN | seq]));
    return segments;
  }

  const total = Math.ceil(appFragment.length / maxPayload);
  for (let i = 0; i < total; i++) {
    const chunk = appFragment.subarray(i * maxPayload, (i + 1) * maxPayload);
    let header = seq & TRANSPORT_SEQ_MASK;
    if (i === 0) header |= TRANSPORT_FIR;
    if (i === total - 1) header |= TRANSPORT_FIN;
    const segBuf = Buffer.alloc(1 + chunk.length);
    segBuf.writeUInt8(header, 0);
    chunk.copy(segBuf, 1);
    segments.push(segBuf);
    seq = (seq + 1) & TRANSPORT_SEQ_MASK;
  }
  return segments;
}

/** State of an in-progress reassembly. */
interface ReassemblyState {
  chunks: Buffer[];
  expectedSeq: number;
}

export interface ReassembleResult {
  /** complete application fragment, present only when FIN seen */
  fragment?: Buffer;
  /** true if a sequence error reset the reassembly */
  error?: 'unexpected-sequence' | 'missing-fir';
}

/**
 * Stateful transport reassembler. Feed segments in arrival order; when a FIN
 * segment completes a fragment the full application bytes are returned.
 */
export class TransportReassembler {
  private state: ReassemblyState | null = null;

  /** Parse the transport header of a segment. */
  static parseHeader(seg: Buffer): { fir: boolean; fin: boolean; seq: number } {
    const h = seg[0];
    return { fir: (h & TRANSPORT_FIR) !== 0, fin: (h & TRANSPORT_FIN) !== 0, seq: h & TRANSPORT_SEQ_MASK };
  }

  /** Feed one transport segment. */
  accept(seg: Buffer): ReassembleResult {
    if (seg.length < 1) return { error: 'missing-fir' };
    const { fir, fin, seq } = TransportReassembler.parseHeader(seg);
    const payload = seg.subarray(1);

    if (fir) {
      // New fragment begins; discard any partial state.
      this.state = { chunks: [Buffer.from(payload)], expectedSeq: (seq + 1) & TRANSPORT_SEQ_MASK };
    } else {
      if (!this.state) {
        return { error: 'missing-fir' };
      }
      if (seq !== this.state.expectedSeq) {
        this.state = null;
        return { error: 'unexpected-sequence' };
      }
      this.state.chunks.push(Buffer.from(payload));
      this.state.expectedSeq = (seq + 1) & TRANSPORT_SEQ_MASK;
    }

    if (fin) {
      const fragment = Buffer.concat(this.state!.chunks);
      this.state = null;
      return { fragment };
    }
    return {};
  }

  /** Discard any partial reassembly (e.g. on link reset). */
  reset(): void {
    this.state = null;
  }
}
