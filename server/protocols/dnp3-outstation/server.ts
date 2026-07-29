/**
 * DNP3 outstation — `net.Server` listener and link-frame reassembly.
 *
 * Issue #464: DNP3 Outstation Mode. The protocol cores (link CRC, transport
 * segmentation, APDU parse, event encoding, controls, SAv5) already existed and
 * are untouched here; what was missing was a listener that is safe to expose and
 * a stream reader that can actually recover a link frame from a TCP byte
 * stream. This module owns ONLY those transport concerns:
 *
 *   - listening on a configurable host/port (default 127.0.0.1:20000),
 *   - refusing connections from peers outside the allowlist, at accept time,
 *   - capping simultaneous masters and timing out idle sockets,
 *   - reassembling the TCP byte stream into complete, CRC-validated link frames,
 *   - driving the transport reassembler and handing application fragments to an
 *     injected `Dnp3ApplicationDispatcher`,
 *   - framing responses back onto the wire.
 *
 * SAFETY. DNP3 over TCP carries no authentication of its own. Secure
 * Authentication v5 authenticates *critical function codes* when a Control
 * Direction Session Key is provisioned (see `secure-auth.ts`); it does not authenticate the TCP peer,
 * and it does not protect reads. So anything that can open this socket can read
 * every mapped point. The compensations this class can apply are the deployment
 * ones, and each fails closed:
 *   - the default bind host is loopback, never 0.0.0.0, and there is no
 *     "allow everyone" peer rule (see `../peer-allowlist.ts`);
 *   - the per-connection receive buffer is hard-bounded, so a hostile or stuck
 *     peer cannot grow outstation memory by dribbling or blasting bytes;
 *   - the per-connection *transmit* queue is bounded too, which matters more
 *     here than in most protocols: a 17-octet Class 0 READ asks for the entire
 *     static database, so a peer that pipelines requests and never reads its
 *     socket gets enormous amplification for free. Responses therefore pause
 *     the read side when the kernel stops accepting them (resumed on 'drain'),
 *     and a connection whose unflushed queue passes `maxTxQueueBytes` is
 *     dropped the same way an oversized receive buffer is.
 *
 * ── Framing on a byte stream ────────────────────────────────────────────────
 * DNP3 has a resynchronisation marker, which pcap-style protocols do not: every
 * link frame starts 0x05 0x64 and the 8-octet header is covered by its own
 * CRC-DNP. `Dnp3LinkFrameReader` therefore never trusts a LENGTH octet it has
 * not CRC-validated:
 *
 *   1. scan forward to the next 0x05 0x64 (bytes before it are discarded),
 *   2. wait until the whole 10-octet header block is present,
 *   3. verify the header CRC via `parseLinkHeader`; on failure skip the two
 *      start octets and resynchronise on the next candidate,
 *   4. reject an implausible LENGTH (< 5, i.e. a negative user-data length) the
 *      same way — LENGTH is one octet, so the upper bound is structural: a frame
 *      can never exceed `DNP3_MAX_LINK_FRAME_BYTES`,
 *   5. only hand the caller a frame once every octet of it has arrived.
 *
 * Block CRCs on the user data are verified downstream by `extractPayload`; a
 * frame that fails there is dropped (the header CRC already fixed its length, so
 * there is nothing to resynchronise).
 */

import net from "node:net";
import { log, logError, logWarn } from "../../logger";
import {
  buildLinkFrame,
  buildResponseControl,
  extractPayload,
  parseLinkHeader,
  DNP3_BLOCK_SIZE,
  DNP3_LINK_FUNCTION,
  DNP3_START_BYTES,
} from "./link-layer";
import { segment, TransportReassembler, TRANSPORT_SEQ_MASK } from "./transport";
import { parseRequest, type ParsedRequest } from "./app-layer";
import { DNP3_FUNCTION } from "./app-objects";
import {
  createSession,
  type Dnp3ResponseFragment,
  type OutstationSession,
} from "./session";
import {
  isPeerAllowed,
  LOOPBACK_PEER_RULES,
  parsePeerRules,
  type PeerRule,
} from "../peer-allowlist";

const LOG_SCOPE = "dnp3-outstation";

/** Octets of the link header block: 8 header octets + its 2-octet CRC. */
export const DNP3_LINK_HEADER_BYTES = 10;

/**
 * Largest possible link frame: LENGTH is a single octet capped at 255, of which
 * 5 are CONTROL+DEST+SRC, leaving 250 user-data octets carried in 16 blocks of
 * 16 (the last short) each followed by a 2-octet CRC.
 */
export const DNP3_MAX_LINK_FRAME_BYTES =
  DNP3_LINK_HEADER_BYTES + 250 + Math.ceil(250 / DNP3_BLOCK_SIZE) * 2; // 292

/** Default per-connection receive-buffer bound (~28 maximum-size frames). */
export const DEFAULT_MAX_RX_BUFFER_BYTES = 8192;
/**
 * Default per-connection bound on response octets buffered by Node but not yet
 * accepted by the kernel (~512 maximum-size application fragments). Reaching it
 * means the peer has stopped reading while continuing to ask for data.
 */
export const DEFAULT_MAX_TX_QUEUE_BYTES = 1_048_576;
/** Loopback, deliberately: never expose an unauthenticated protocol by omission. */
export const DEFAULT_BIND_HOST = "127.0.0.1";
/** IEEE 1815 registered DNP3 port. */
export const DEFAULT_PORT = 20000;
export const DEFAULT_MAX_CONNECTIONS = 1;
export const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;

/** What one `push()` produced. */
export interface FrameReadResult {
  /** complete link frames, in arrival order (header CRC already verified) */
  frames: Buffer[];
  /**
   * True when the bounded receive buffer was exceeded. The reader has dropped
   * its buffer; the caller must close the connection.
   */
  overflow: boolean;
}

/**
 * Turns a TCP byte stream into complete DNP3 link frames.
 *
 * Handles frames split across segments at any offset, several frames in one
 * segment, garbage before a start pattern, a corrupt or implausible LENGTH, and
 * a peer that dribbles one byte at a time. The buffer it retains is bounded.
 */
export class Dnp3LinkFrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private discarded = 0;
  private rejectedHeaders = 0;

  constructor(
    private readonly maxBufferBytes: number = DEFAULT_MAX_RX_BUFFER_BYTES,
  ) {
    if (maxBufferBytes < DNP3_MAX_LINK_FRAME_BYTES) {
      throw new Error(
        `DNP3 receive buffer bound ${maxBufferBytes} is smaller than one maximum ` +
          `link frame (${DNP3_MAX_LINK_FRAME_BYTES}); it could never accept a full frame`,
      );
    }
  }

  /** Octets thrown away while resynchronising (diagnostics/tests). */
  get discardedBytes(): number {
    return this.discarded;
  }

  /** Candidate start patterns rejected by header CRC or LENGTH (diagnostics). */
  get rejectedHeaderCount(): number {
    return this.rejectedHeaders;
  }

  /** Bytes currently held awaiting the rest of a frame. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Feed received bytes; returns every frame that completed. */
  push(chunk: Buffer): FrameReadResult {
    // Bound first. A single hostile write larger than the bound is refused
    // outright rather than being concatenated and then measured.
    if (this.buffer.length + chunk.length > this.maxBufferBytes) {
      this.buffer = Buffer.alloc(0);
      return { frames: [], overflow: true };
    }
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    return { frames: this.drain(), overflow: false };
  }

  /** Discard all buffered bytes (e.g. on link reset). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  private drain(): Buffer[] {
    const frames: Buffer[] = [];

    for (;;) {
      if (this.buffer.length < 2) {
        // A lone trailing 0x05 may be the first half of a split start pattern,
        // so it is kept; anything else at this point is not a frame start.
        if (
          this.buffer.length === 1 &&
          this.buffer[0] !== DNP3_START_BYTES[0]
        ) {
          this.discarded += 1;
          this.buffer = Buffer.alloc(0);
        }
        return frames;
      }

      const start = this.buffer.indexOf(DNP3_START_BYTES);
      if (start === -1) {
        // No start pattern anywhere. Keep only a trailing 0x05.
        const keep =
          this.buffer[this.buffer.length - 1] === DNP3_START_BYTES[0] ? 1 : 0;
        this.discarded += this.buffer.length - keep;
        this.buffer =
          keep === 1
            ? this.buffer.subarray(this.buffer.length - 1)
            : Buffer.alloc(0);
        return frames;
      }
      if (start > 0) {
        this.discarded += start;
        this.buffer = this.buffer.subarray(start);
      }

      if (this.buffer.length < DNP3_LINK_HEADER_BYTES) {
        return frames; // header block not complete yet
      }

      const header = parseLinkHeader(
        this.buffer.subarray(0, DNP3_LINK_HEADER_BYTES),
      );
      // `parseLinkHeader` returns null when the header CRC does not match, so a
      // LENGTH that survives here is one the sender genuinely wrote. LENGTH < 5
      // is still structurally impossible (it counts CONTROL+DEST+SRC and cannot
      // be smaller than those 5 octets); treat it as a false start pattern.
      if (!header || header.length < 5) {
        this.rejectedHeaders += 1;
        this.discarded += 2;
        this.buffer = this.buffer.subarray(2); // resync past this 0x0564
        continue;
      }

      const userDataLen = header.length - 5;
      const blocks = Math.ceil(userDataLen / DNP3_BLOCK_SIZE);
      const total = DNP3_LINK_HEADER_BYTES + userDataLen + blocks * 2;
      if (this.buffer.length < total) {
        return frames; // wait for the rest of this frame
      }

      frames.push(Buffer.from(this.buffer.subarray(0, total)));
      this.buffer = this.buffer.subarray(total);
    }
  }
}

/**
 * The application-layer seam the transport drives. `Dnp3Outstation` implements
 * it; injecting it keeps this module free of any dependency on the outstation's
 * decision logic (and keeps the two files from importing each other).
 */
export interface Dnp3ApplicationDispatcher {
  /**
   * Handle one parsed application request for an association. Returns the
   * fragment octets to transmit, or an empty buffer for "no response".
   */
  dispatch(req: ParsedRequest, session: OutstationSession): Buffer;
  /**
   * Handle a g120v2 Secure-Authentication reply. Returns the fragment octets to
   * transmit, or an empty buffer.
   */
  dispatchSecureAuthReply(
    req: ParsedRequest,
    session: OutstationSession,
  ): Buffer;
  /** Called once per association when its socket closes. */
  onAssociationClosed(session: OutstationSession): void;
}

export interface Dnp3TcpServerConfig {
  /** Bind host. Default 127.0.0.1 — exposing the listener must be deliberate. */
  host?: string;
  /** Bind port. Default 20000; 0 asks the OS for a free port. */
  port?: number;
  /** This outstation's DNP3 link address, used as the source of responses. */
  localAddress?: number;
  /**
   * Peer IPs/CIDRs permitted to connect, enforced at accept time. Defaults to
   * loopback only. `/0` wildcards are rejected — see `../peer-allowlist.ts`.
   */
  allowedPeers?: readonly string[];
  /** Hard cap on simultaneous master connections. Default 2. */
  maxConnections?: number;
  /** Idle socket timeout in ms (0 disables). Default 60_000. */
  socketTimeoutMs?: number;
  /** Max bytes buffered per connection before the connection is dropped. */
  maxRxBufferBytes?: number;
  /**
   * Max response bytes queued for a connection before it is dropped. Guards the
   * read amplification a Class 0 READ gives a peer that stops reading.
   */
  maxTxQueueBytes?: number;
}

/** Per-connection link/transport state. */
interface ConnectionState {
  socket: net.Socket;
  reader: Dnp3LinkFrameReader;
  reassembler: TransportReassembler;
  /** master's link address, learned from the first frame that CRC-validates */
  masterAddress: number;
  /** running transport-function sequence number for transmitted segments */
  transportSeq: number;
  session: OutstationSession;
  /** reads are paused because the peer is not draining its responses */
  paused: boolean;
}

/**
 * A running (or runnable) DNP3 TCP listener in front of an application
 * dispatcher. All protocol decisions belong to the dispatcher; this class owns
 * sockets, admission control, framing and response transmission.
 */
export class Dnp3TcpServer {
  private readonly server: net.Server;
  private readonly host: string;
  private readonly port: number;
  private readonly localAddress: number;
  private readonly maxConnections: number;
  private readonly socketTimeoutMs: number;
  private readonly maxRxBufferBytes: number;
  private readonly maxTxQueueBytes: number;
  private readonly peerRules: PeerRule[];
  private readonly connections = new Set<ConnectionState>();
  private listening = false;
  private rejectedConnections = 0;

  /**
   * @throws {PeerRuleError} if any allowlist entry is unusable. Construction
   *   failing is intentional: there is no safe fallback for "the operator's peer
   *   allowlist did not parse".
   */
  constructor(
    private readonly dispatcher: Dnp3ApplicationDispatcher,
    config: Dnp3TcpServerConfig = {},
  ) {
    this.host = config.host ?? DEFAULT_BIND_HOST;
    this.port = config.port ?? DEFAULT_PORT;
    this.localAddress = config.localAddress ?? 10;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
    this.maxRxBufferBytes =
      config.maxRxBufferBytes ?? DEFAULT_MAX_RX_BUFFER_BYTES;
    this.maxTxQueueBytes = config.maxTxQueueBytes ?? DEFAULT_MAX_TX_QUEUE_BYTES;
    this.peerRules = parsePeerRules(config.allowedPeers ?? LOOPBACK_PEER_RULES);
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) =>
      logError(err, "DNP3 outstation socket error"),
    );
  }

  /** Start listening. Resolves once the listen socket is bound. */
  start(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        this.listening = true;
        log(
          `🔌 DNP3 outstation listening on ${this.host}:${this.boundPort ?? this.port} ` +
            `(link addr ${this.localAddress}, ` +
            `peers [${this.peerRules.map((r) => r.source).join(", ")}], ` +
            `max ${this.maxConnections} connections)`,
          LOG_SCOPE,
        );
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
  }

  /** Stop listening and forcibly close every open connection. */
  stop(): Promise<void> {
    if (!this.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
      for (const conn of this.connections) {
        conn.socket.destroy();
      }
      this.connections.clear();
      this.server.close(() => {
        this.listening = false;
        log("⏸️  DNP3 outstation stopped", LOG_SCOPE);
        resolve();
      });
    });
  }

  /** The actual bound address (useful in tests with port 0). */
  address(): net.AddressInfo | null {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr : null;
  }

  /** The port actually bound, or null when not listening. */
  get boundPort(): number | null {
    return this.address()?.port ?? null;
  }

  get isListening(): boolean {
    return this.listening;
  }

  /** Current number of accepted, still-open master connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Connections refused since start (allowlist misses + cap overflow). */
  get rejectedConnectionCount(): number {
    return this.rejectedConnections;
  }

  /**
   * Transmit an unsolicited fragment to every association that does not already
   * have a response awaiting confirmation (an outstation may have only one
   * outstanding response per association). Returns how many masters it reached.
   */
  broadcastUnsolicited(fragment: Dnp3ResponseFragment): number {
    let sent = 0;
    for (const conn of this.connections) {
      if (conn.session.awaitingConfirm) continue;
      conn.session.awaitingConfirm = fragment;
      this.sendFragment(conn, fragment.bytes);
      sent += 1;
    }
    return sent;
  }

  /**
   * Accept-time admission control, before a single protocol byte is read:
   * unauthorised peers and connections beyond the cap are logged and dropped.
   * Returns false when the socket has been destroyed.
   */
  private admit(socket: net.Socket): boolean {
    const peer = socket.remoteAddress;

    if (!isPeerAllowed(peer, this.peerRules)) {
      this.rejectedConnections++;
      logWarn(
        `DNP3 connection refused: peer ${peer ?? "<unknown>"} is not in the ` +
          `allowlist [${this.peerRules.map((r) => r.source).join(", ")}]`,
        LOG_SCOPE,
      );
      socket.destroy();
      return false;
    }

    if (this.connections.size >= this.maxConnections) {
      this.rejectedConnections++;
      logWarn(
        `DNP3 connection refused: peer ${peer} exceeds the ` +
          `${this.maxConnections}-connection limit`,
        LOG_SCOPE,
      );
      socket.destroy();
      return false;
    }

    return true;
  }

  private onConnection(socket: net.Socket): void {
    if (!this.admit(socket)) return;

    const conn: ConnectionState = {
      socket,
      reader: new Dnp3LinkFrameReader(this.maxRxBufferBytes),
      reassembler: new TransportReassembler(),
      masterAddress: 1,
      transportSeq: 0,
      session: createSession(),
      paused: false,
    };
    this.connections.add(conn);
    if (this.socketTimeoutMs > 0) {
      socket.setTimeout(this.socketTimeoutMs);
    }
    log(
      `DNP3 master connected from ${socket.remoteAddress}:${socket.remotePort}`,
      LOG_SCOPE,
    );

    socket.on("data", (chunk: Buffer) => {
      const { frames, overflow } = conn.reader.push(chunk);
      if (overflow) {
        logWarn(
          `DNP3 master ${socket.remoteAddress} exceeded the ${this.maxRxBufferBytes}-byte ` +
            "receive buffer without completing a link frame; closing",
          LOG_SCOPE,
        );
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (socket.destroyed) return;
        this.processFrame(conn, frame);
      }
    });

    // The peer has taken the responses that paused us; start reading again.
    socket.on("drain", () => {
      if (!conn.paused) return;
      conn.paused = false;
      socket.resume();
    });

    socket.on("timeout", () => {
      log(`DNP3 master idle timeout: ${socket.remoteAddress}`, LOG_SCOPE);
      socket.destroy();
    });

    socket.on("error", (err) => {
      logWarn("DNP3 master socket error", LOG_SCOPE, { errorMessage: err.message });
    });

    socket.on("close", () => {
      this.connections.delete(conn);
      this.dispatcher.onAssociationClosed(conn.session);
      log(`DNP3 master disconnected: ${socket.remoteAddress}`, LOG_SCOPE);
    });
  }

  /** Validate one complete link frame and drive the layers above it. */
  private processFrame(conn: ConnectionState, frame: Buffer): void {
    const extracted = extractPayload(frame);
    if (!extracted) {
      // The header CRC already validated the length, so the failure is in a
      // user-data block: drop this frame only, no resynchronisation needed.
      logWarn(
        "DNP3 outstation: dropped frame with bad user-data CRC",
        LOG_SCOPE,
      );
      return;
    }
    conn.masterAddress = extracted.header.source;

    // Link-layer service frames (no user data) — answer link status, etc.
    if (extracted.payload.length === 0) {
      if (extracted.header.func === DNP3_LINK_FUNCTION.REQUEST_LINK_STATUS) {
        this.sendLinkStatus(conn);
      }
      return;
    }

    const result = conn.reassembler.accept(extracted.payload);
    if (result.error || !result.fragment) return;

    let req: ParsedRequest;
    try {
      req = parseRequest(result.fragment);
    } catch (err) {
      logError(err, "DNP3 outstation: failed to parse application request");
      return;
    }

    let response: Buffer;
    try {
      // Standard SAv5 challenge replies use AUTH_REQUEST (0x20). Function 0x21
      // is reserved for no-ack authentication errors and never authorizes a
      // g120v2 reply.
      response =
        req.func === DNP3_FUNCTION.AUTH_REQUEST
          ? this.dispatcher.dispatchSecureAuthReply(req, conn.session)
          : this.dispatcher.dispatch(req, conn.session);
    } catch (err) {
      logError(err, "DNP3 outstation: request dispatch failed");
      return;
    }

    if (response.length > 0 && !conn.socket.destroyed) {
      this.sendFragment(conn, response);
    }
  }

  /** Frame + send one application response fragment to the master. */
  private sendFragment(conn: ConnectionState, appFragment: Buffer): void {
    const segments = segment(appFragment, conn.transportSeq);
    conn.transportSeq =
      (conn.transportSeq + segments.length) & TRANSPORT_SEQ_MASK;
    for (const seg of segments) {
      const control = buildResponseControl(
        DNP3_LINK_FUNCTION.UNCONFIRMED_USER_DATA,
      );
      this.transmit(
        conn,
        buildLinkFrame({
          control,
          destination: conn.masterAddress,
          source: this.localAddress,
          payload: seg,
        }),
      );
    }
  }

  private sendLinkStatus(conn: ConnectionState): void {
    this.transmit(
      conn,
      buildLinkFrame({
        control: buildResponseControl(DNP3_LINK_FUNCTION.LINK_STATUS),
        destination: conn.masterAddress,
        source: this.localAddress,
        payload: Buffer.alloc(0),
      }),
    );
  }

  /**
   * Write link-frame octets to a master, bounding what a peer that stops
   * reading can make the outstation hold.
   *
   * The receive bound alone does not bound memory here. A Class 0 READ is 17
   * octets on the wire and asks for the whole static database, so a peer may
   * pipeline several hundred of them inside one bounded read and then simply
   * never drain its socket. Node would queue every response indefinitely. Two
   * defences, in the order they engage:
   *
   *   1. when the kernel stops accepting the write, stop reading requests until
   *      the socket drains — the outstation then generates no new responses;
   *   2. if the unflushed queue still passes `maxTxQueueBytes`, drop the
   *      connection, exactly as an oversized receive buffer does.
   */
  private transmit(conn: ConnectionState, bytes: Buffer): void {
    const { socket } = conn;
    if (socket.destroyed) return;

    const flushed = socket.write(bytes);

    if (socket.writableLength > this.maxTxQueueBytes) {
      logWarn(
        `DNP3 master ${socket.remoteAddress} has ${socket.writableLength} bytes of ` +
          `unread responses queued, past the ${this.maxTxQueueBytes}-byte transmit ` +
          "bound; closing",
        LOG_SCOPE,
      );
      socket.destroy();
      return;
    }

    if (!flushed && !conn.paused) {
      conn.paused = true;
      socket.pause();
    }
  }
}
