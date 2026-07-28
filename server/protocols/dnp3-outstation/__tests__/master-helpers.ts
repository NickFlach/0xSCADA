/**
 * A minimal DNP3 *master* side, used by the listener tests (#464) to drive the
 * outstation over a real TCP socket.
 *
 * This deliberately does NOT use `Dnp3LinkFrameReader` — that is one of the
 * things under test. The receive path here is the same straightforward
 * length-based loop the pre-existing `outstation.test.ts` uses, so a framing bug
 * in the implementation cannot be cancelled out by the same bug in the test.
 *
 * Not a test file: `__tests__/master-helpers.ts` does not match the
 * `*.{test,spec}.ts` include patterns in vitest.config.ts.
 */
import net from "node:net";
import { buildLinkFrame, extractPayload } from "../link-layer";
import { segment, TransportReassembler } from "../transport";
import { DNP3_FUNCTION } from "../app-objects";

/** Frame an application fragment the way a master would (DIR=1, PRM=1, func 4). */
export function masterFrame(
  appFragment: Buffer,
  source = 1,
  destination = 10,
): Buffer {
  return Buffer.concat(
    segment(appFragment).map((seg) =>
      buildLinkFrame({ control: 0xc4, destination, source, payload: seg }),
    ),
  );
}

/** READ of a class object (g60v1..v4 == class 0..3), qualifier 0x06. */
export function classRead(classNumber: 0 | 1 | 2 | 3, seq = 0): Buffer {
  return Buffer.from([
    0xc0 | (seq & 0x0f),
    DNP3_FUNCTION.READ,
    0x3c,
    classNumber + 1,
    0x06,
  ]);
}

/** Application CONFIRM at a given sequence number. */
export function confirm(seq = 0): Buffer {
  return Buffer.from([0xc0 | (seq & 0x0f), DNP3_FUNCTION.CONFIRM]);
}

/**
 * A g12v1 CROB command on `index`, as SELECT / OPERATE / DIRECT-OPERATE.
 * `controlCode` 0x03 is LATCH_ON, 0x04 LATCH_OFF.
 */
export function crobRequest(opts: {
  func: number;
  index: number;
  seq: number;
  controlCode?: number;
}): Buffer {
  const { func, index, seq, controlCode = 0x03 } = opts;
  return Buffer.from([
    0xc0 | (seq & 0x0f),
    func,
    0x0c, // group 12
    0x01, // variation 1 (CROB)
    0x17, // qualifier: 1-octet index prefix, 1-octet count
    0x01, // count
    index & 0xff,
    controlCode,
    0x01, // count field of the CROB
    0x00, 0x00, 0x00, 0x00, // on time
    0x00, 0x00, 0x00, 0x00, // off time
    0x00, // status octet
  ]);
}

/** Reserve a free TCP port so the tests never need the privileged port 20000. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A connected master. Buffers every complete application fragment the outstation
 * sends so a test can await them one at a time without racing the socket.
 */
export class MasterConnection {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly reassembler = new TransportReassembler();
  private readonly fragments: Buffer[] = [];
  private waiter: ((fragment: Buffer) => void) | null = null;
  private framingError: Error | null = null;
  closed = false;

  private constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
    });
    // Errors are expected in the rejection tests (ECONNRESET); swallow them so
    // Node does not turn them into unhandled 'error' events.
    socket.on("error", () => {
      this.closed = true;
    });
  }

  static async open(port: number, host = "127.0.0.1"): Promise<MasterConnection> {
    const socket = net.createConnection({ port, host });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new MasterConnection(socket);
  }

  /** Write raw bytes (already framed, or deliberately malformed). */
  writeRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  /** Frame and send one application fragment. */
  send(appFragment: Buffer): void {
    this.socket.write(masterFrame(appFragment));
  }

  /** Send a framed fragment one octet per write, worst case for reassembly. */
  sendByteByByte(appFragment: Buffer): void {
    for (const byte of masterFrame(appFragment)) {
      this.socket.write(Buffer.from([byte]));
    }
  }

  /** Resolve with the next complete application fragment. */
  next(timeoutMs = 5000): Promise<Buffer> {
    if (this.framingError) return Promise.reject(this.framingError);
    const queued = this.fragments.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("timed out waiting for a DNP3 response fragment"));
      }, timeoutMs);
      this.waiter = (fragment) => {
        clearTimeout(timer);
        resolve(fragment);
      };
    });
  }

  /** Resolve once the outstation closes the connection. */
  awaitClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("connection was not closed by the outstation")),
        timeoutMs,
      );
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Assert nothing arrives within `ms`. */
  async expectSilence(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.fragments.length > 0) {
      throw new Error(
        `expected no response, got ${this.fragments.length} fragment(s)`,
      );
    }
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 10) {
      const userDataLen = this.buffered[2] - 5;
      const blocks = userDataLen > 0 ? Math.ceil(userDataLen / 16) : 0;
      const total = 10 + userDataLen + blocks * 2;
      if (this.buffered.length < total) return;
      const frame = this.buffered.subarray(0, total);
      this.buffered = this.buffered.subarray(total);
      const extracted = extractPayload(frame);
      if (!extracted) {
        this.framingError = new Error("outstation response frame failed CRC");
        return;
      }
      if (extracted.payload.length === 0) continue; // link-layer service frame
      const result = this.reassembler.accept(extracted.payload);
      if (!result.fragment) continue;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(result.fragment);
      } else {
        this.fragments.push(result.fragment);
      }
    }
  }
}
