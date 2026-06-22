/**
 * Modbus TCP server — `net.Server` listener wiring.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * Standard Modbus masters (pymodbus, legacy HMIs, integrators) connect over TCP
 * and poll 0xSCADA tags. This module owns ONLY the transport concerns:
 *   - listening on a configurable host/port (default 0.0.0.0:502),
 *   - reassembling TCP byte streams into complete Modbus frames,
 *   - delegating each frame to the pure handler layer,
 *   - writing the response back.
 *
 * All protocol/data logic lives in `codec.ts`, `handlers.ts`, and the data
 * model, so this file is intentionally thin. Note: binding to port 502 requires
 * elevated privileges on most OSes; configure a high port (e.g. 1502) for
 * unprivileged/dev runs via `MODBUS_SERVER_PORT`.
 */

import net from "node:net";
import { decodeRequest, ModbusFrameError } from "./codec";
import type { ModbusDataModel } from "./data-model";
import { processRequest } from "./handlers";
import { log, logError, logWarn } from "../../logger";

export interface ModbusServerConfig {
  /** Bind host. Default 0.0.0.0. */
  host?: string;
  /** Bind port. Default 502 (override for unprivileged runs). */
  port?: number;
  /**
   * Modbus unit id this server answers for. Requests for a different unit id
   * are still processed (single-server model); set for documentation/routing.
   */
  unitId?: number;
  /** Max bytes buffered per connection before the connection is dropped. */
  maxBufferBytes?: number;
  /** Idle socket timeout in ms (0 disables). Default 60_000. */
  socketTimeoutMs?: number;
}

const DEFAULT_PORT = 502;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_MAX_BUFFER = 64 * 1024;
const DEFAULT_SOCKET_TIMEOUT = 60_000;

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
  private readonly sockets = new Set<net.Socket>();
  private listening = false;

  constructor(
    private readonly model: ModbusDataModel,
    config: ModbusServerConfig = {},
  ) {
    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_PORT;
    this.maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT;
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
          `🔌 Modbus TCP server listening on ${this.host}:${this.port}`,
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

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    if (this.socketTimeoutMs > 0) {
      socket.setTimeout(this.socketTimeoutMs);
    }
    log(
      `Modbus client connected: ${socket.remoteAddress}:${socket.remotePort}`,
      "modbus-server",
    );

    // Per-connection receive buffer; TCP may split or coalesce frames.
    let buffer = Buffer.alloc(0);
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
      draining = draining.then(async () => {
        buffer = await this.drain(socket, buffer);
      });
    });

    socket.on("timeout", () => {
      log(`Modbus client idle timeout: ${socket.remoteAddress}`, "modbus-server");
      socket.destroy();
    });

    socket.on("error", (err) => {
      logWarn(`Modbus client socket error: ${err.message}`, "modbus-server");
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

      try {
        const response = await processRequest(decoded.request, this.model);
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
