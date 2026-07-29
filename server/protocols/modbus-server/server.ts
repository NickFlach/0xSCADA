/**
 * Modbus TCP server — `net.Server` listener wiring.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * Standard Modbus masters (pymodbus, legacy HMIs, integrators) connect over TCP
 * and poll 0xSCADA tags. This module owns ONLY the transport concerns:
 *   - listening on a configurable host/port (default 127.0.0.1:502),
 *   - refusing connections from peers outside the allowlist, at accept time,
 *   - capping the number of simultaneous masters,
 *   - reassembling TCP byte streams into complete Modbus frames,
 *   - delegating each frame to the pure handler layer,
 *   - writing the response back.
 *
 * All protocol/data logic lives in `codec.ts`, `handlers.ts`, and the data
 * model, so this file is intentionally thin. Note: binding to port 502 requires
 * elevated privileges on most OSes; configure a high port (e.g. 1502) for
 * unprivileged/dev runs via `MODBUS_SERVER_PORT`.
 *
 * SAFETY. Modbus TCP carries no authentication whatsoever — no credential, no
 * handshake, no integrity check. This class therefore fails closed on both axes
 * it can control:
 *   - the default bind host is loopback, never 0.0.0.0, and there is no
 *     "allow everyone" peer rule (see `peer-filter.ts`);
 *   - write function codes are refused with exception 0x01 (Illegal Function)
 *     unless `allowWrites` was explicitly turned on, and even then only entries
 *     the register map marks `writable` can mutate a live tag.
 */

import net from "node:net";
import {
  decodeRequest,
  encodeExceptionResponse,
  ExceptionCode,
  FunctionCode,
  ModbusFrameError,
} from "./codec";
import type { ModbusDataModel } from "./data-model";
import { processRequest } from "./handlers";
import {
  isPeerAllowed,
  LOOPBACK_PEER_RULES,
  parsePeerRules,
  type PeerRule,
} from "./peer-filter";
import { log, logError, logWarn } from "../../logger";

export interface ModbusServerConfig {
  /** Bind host. Default 127.0.0.1 — exposing the listener is deliberate. */
  host?: string;
  /** Bind port. Default 502 (override for unprivileged runs). */
  port?: number;
  /**
   * Modbus unit id this server answers for. Requests for a different unit id
   * are still processed (single-server model); set for documentation/routing.
   */
  unitId?: number;
  /**
   * Peer IPs/CIDRs permitted to connect, enforced at accept time. Defaults to
   * loopback only. `/0` wildcards are rejected — see `peer-filter.ts`.
   */
  allowedPeers?: readonly string[];
  /** Hard cap on simultaneous master connections. Default 4. */
  maxConnections?: number;
  /** Max bytes buffered per connection before the connection is dropped. */
  maxBufferBytes?: number;
  /** Idle socket timeout in ms (0 disables). Default 60_000. */
  socketTimeoutMs?: number;
  /**
   * Permit network clients to use Modbus write function codes.
   *
   * Defaults to false. This is a fail-closed capability gate, not client
   * authentication; deployments must still supply an explicit network/access
   * control policy before enabling it.
   */
  allowWrites?: boolean;
}

const DEFAULT_PORT = 502;
/**
 * Loopback, deliberately. Binding a protocol with no authentication to every
 * interface must never be something a deployment gets by omission.
 */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BUFFER = 64 * 1024;
const DEFAULT_SOCKET_TIMEOUT = 60_000;
const DEFAULT_MAX_CONNECTIONS = 4;
const WRITE_FUNCTION_CODES = new Set<number>([
  FunctionCode.WRITE_SINGLE_COIL,
  FunctionCode.WRITE_SINGLE_REGISTER,
  FunctionCode.WRITE_MULTIPLE_COILS,
  FunctionCode.WRITE_MULTIPLE_REGISTERS,
]);

/**
 * A running (or runnable) Modbus TCP server backed by a `ModbusDataModel`.
 * The data model is injected so the same server class works against the live
 * tag-store bridge in production and an in-memory model in tests.
 */
export class ModbusTcpServer {
  private readonly server: net.Server;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBufferBytes: number;
  private readonly socketTimeoutMs: number;
  private readonly allowWrites: boolean;
  private readonly maxConnections: number;
  private readonly peerRules: PeerRule[];
  private readonly sockets = new Set<net.Socket>();
  private listening = false;
  private rejectedConnections = 0;

  /**
   * @throws {PeerRuleError} if any allowlist entry is unusable. Construction
   *   failing is intentional: there is no safe fallback for "the operator's
   *   peer allowlist did not parse".
   */
  constructor(
    private readonly model: ModbusDataModel,
    config: ModbusServerConfig = {},
  ) {
    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_PORT;
    this.maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT;
    this.allowWrites = config.allowWrites ?? false;
    this.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.peerRules = parsePeerRules(config.allowedPeers ?? LOOPBACK_PEER_RULES);
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) =>
      logError(err, "Modbus TCP server socket error"),
    );
  }

  /** Start listening. Resolves once the listen socket is bound. */
  start(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.listening = true;
        log(
          `🔌 Modbus TCP server listening on ${this.host}:${this.port} ` +
            `(writes ${this.allowWrites ? "ENABLED" : "disabled"}, ` +
            `peers [${this.peerRules.map((r) => r.source).join(", ")}], ` +
            `max ${this.maxConnections} connections)`,
          "modbus-server",
        );
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
  }

  /** Stop listening and forcibly close all open connections. */
  stop(): Promise<void> {
    if (!this.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      this.server.close(() => {
        this.listening = false;
        log("⏸️  Modbus TCP server stopped", "modbus-server");
        resolve();
      });
    });
  }

  /** The actual bound address (useful in tests with port 0). */
  address(): net.AddressInfo | null {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr : null;
  }

  get isListening(): boolean {
    return this.listening;
  }

  /** Whether write function codes are served on this listener. */
  get writesAllowed(): boolean {
    return this.allowWrites;
  }

  /** Current number of accepted, still-open master connections. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /** Connections refused since start (allowlist misses + cap overflow). */
  get rejectedConnectionCount(): number {
    return this.rejectedConnections;
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
        `Modbus TCP connection refused: peer ${peer ?? "<unknown>"} is not in ` +
          `the allowlist [${this.peerRules.map((r) => r.source).join(", ")}]`,
        "modbus-server",
      );
      socket.destroy();
      return false;
    }

    if (this.sockets.size >= this.maxConnections) {
      this.rejectedConnections++;
      logWarn(
        `Modbus TCP connection refused: peer ${peer} exceeds the ` +
          `${this.maxConnections}-connection limit`,
        "modbus-server",
      );
      socket.destroy();
      return false;
    }

    return true;
  }

  private onConnection(socket: net.Socket): void {
    if (!this.admit(socket)) return;

    this.sockets.add(socket);
    if (this.socketTimeoutMs > 0) {
      socket.setTimeout(this.socketTimeoutMs);
    }
    log(
      `Modbus client connected: ${socket.remoteAddress}:${socket.remotePort}`,
      "modbus-server",
    );

    // Per-connection receive buffer; TCP may split or coalesce frames.
    let buffer: Buffer = Buffer.alloc(0);
    // Serialize draining so overlapping `data` events don't reorder responses
    // or race on `buffer`.
    let draining: Promise<void> = Promise.resolve();

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (buffer.length > this.maxBufferBytes) {
        logWarn(
          `Modbus client ${socket.remoteAddress} exceeded buffer limit; closing`,
          "modbus-server",
        );
        socket.destroy();
        return;
      }

      // Drain as many complete frames as the buffer currently holds, chaining
      // onto any in-flight drain so frames are answered strictly in order.
      //
      // The buffer is taken and cleared before the (awaiting) drain, and the
      // unconsumed remainder is put back in FRONT of whatever arrived while it
      // ran. Assigning the drain's return value straight back to `buffer` would
      // discard every byte a pipelining master sent during the await — the
      // second request would be silently swallowed and never answered.
      draining = draining.then(async () => {
        const pending = buffer;
        buffer = Buffer.alloc(0);
        const remainder = await this.drain(socket, pending);
        buffer = remainder.length > 0 ? Buffer.concat([remainder, buffer]) : buffer;
      });
    });

    socket.on("timeout", () => {
      log(`Modbus client idle timeout: ${socket.remoteAddress}`, "modbus-server");
      socket.destroy();
    });

    socket.on("error", (err) => {
      logWarn("Modbus client socket error", "modbus-server", { errorMessage: err.message });
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
      log(`Modbus client disconnected: ${socket.remoteAddress}`, "modbus-server");
    });
  }

  /**
   * Pull complete frames out of `buffer` and respond to each, returning the
   * unconsumed remainder. Frames are processed sequentially to preserve
   * response ordering and to avoid interleaving model writes from one client.
   */
  private async drain(socket: net.Socket, buffer: Buffer): Promise<Buffer> {
    while (buffer.length > 0 && !socket.destroyed) {
      let decoded;
      try {
        decoded = decodeRequest(buffer);
      } catch (err) {
        if (err instanceof ModbusFrameError) {
          // Unrecoverable framing error — drop the connection.
          logWarn(
            `Malformed Modbus frame from ${socket.remoteAddress}: ${err.message}`,
            "modbus-server",
          );
          socket.destroy();
          return Buffer.alloc(0);
        }
        throw err;
      }

      if (!decoded) {
        break; // incomplete frame — wait for more bytes
      }

      buffer = buffer.subarray(decoded.bytesConsumed);

      const writeRefused =
        !this.allowWrites &&
        WRITE_FUNCTION_CODES.has(decoded.request.functionCode);
      if (writeRefused) {
        // A read-only listener must not silently accept a write. Answering with
        // 0x01 Illegal Function is the spec-correct way to tell the master the
        // function is not implemented here.
        logWarn(
          `Modbus write FC 0x${decoded.request.functionCode.toString(16)} from ` +
            `${socket.remoteAddress} refused: this listener is read-only ` +
            "(set MODBUS_SERVER_ALLOW_WRITES=true to serve writes)",
          "modbus-server",
        );
      }

      try {
        const response = writeRefused
          ? encodeExceptionResponse(
              decoded.request.header,
              decoded.request.functionCode,
              ExceptionCode.ILLEGAL_FUNCTION,
            )
          : await processRequest(decoded.request, this.model);
        if (!socket.destroyed) {
          socket.write(response);
        }
      } catch (err) {
        // processRequest never throws, but guard the socket write regardless.
        logError(err, "Modbus request processing failed");
      }
    }
    return buffer;
  }
}
