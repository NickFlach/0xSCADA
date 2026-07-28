/**
 * DNP3 TCP listener tests (#464) — real loopback sockets, real DNP3 framing.
 *
 * The maintainer's review said the outstation "is also never wired into the
 * server". Wiring it in means giving it a listener that is safe to expose, so
 * these tests exercise the listener itself over the wire rather than the pure
 * functions underneath it:
 *
 *   - it binds loopback by default;
 *   - a peer outside the allowlist is dropped at accept time;
 *   - the connection cap and the idle timeout are enforced;
 *   - frames survive being split one byte at a time, arriving several per
 *     segment, following garbage, or following a bogus LENGTH;
 *   - the receive buffer is bounded;
 *   - Class 0 reflects live tag values and Class 1/2/3 return real events;
 *   - controls are refused with the correct CommandStatus until opted in;
 *   - shutdown leaves nothing behind.
 *
 * No mocks: every byte here goes through a kernel socket.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { Dnp3Outstation } from "../index";
import { InMemoryDnp3TagStore, createTagStoreControlSink } from "../tag-store-bridge";
import { PeerRuleError } from "../../peer-allowlist";
import { buildLinkFrame } from "../link-layer";
import { DNP3_COMMAND_STATUS, DNP3_FUNCTION, DNP3_IIN } from "../app-objects";
import {
  MasterConnection,
  classRead,
  confirm,
  crobRequest,
  masterFrame,
} from "./master-helpers";

const T0 = 0x0000_00ab_cdef; // a fixed DNP3 timestamp, epoch ms

const POINTS = [
  { tagId: "pump.run", type: "binaryInput" as const, index: 0, eventClass: 1 as const },
  { tagId: "pump.fault", type: "binaryInput" as const, index: 1, eventClass: 1 as const },
  { tagId: "flow.total", type: "counter" as const, index: 0, eventClass: 2 as const },
  {
    tagId: "tank.level",
    type: "analogInput" as const,
    index: 0,
    eventClass: 3 as const,
    encoding: "float32" as const,
  },
  { tagId: "valve.cmd", type: "binaryOutput" as const, index: 0, writable: true },
  { tagId: "vent.cmd", type: "binaryOutput" as const, index: 1 },
];

let outstation: Dnp3Outstation | null = null;
const clients: MasterConnection[] = [];

async function startOutstation(
  config: Partial<ConstructorParameters<typeof Dnp3Outstation>[0]> = {},
): Promise<Dnp3Outstation> {
  const os = new Dnp3Outstation({ port: 0, pointMap: { points: POINTS }, ...config });
  await os.start();
  outstation = os;
  return os;
}

async function connect(os: Dnp3Outstation): Promise<MasterConnection> {
  const client = await MasterConnection.open(os.listeningPort!);
  clients.push(client);
  return client;
}

/**
 * Poll a predicate. The master observes its socket closing slightly before the
 * outstation's own 'close' handler runs, so bookkeeping assertions must wait for
 * the server side rather than assume both happen in the same tick.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await outstation?.stop();
  outstation = null;
});

describe("listener admission control", () => {
  it("binds loopback by default and reports the ephemeral port", async () => {
    const os = await startOutstation();
    expect(os.config.host).toBe("127.0.0.1");
    expect(os.listeningPort).toBeGreaterThan(0);
    expect(os.connectionCount).toBe(0);
  });

  it("refuses to start when the peer allowlist is a wildcard", async () => {
    const os = new Dnp3Outstation({
      port: 0,
      allowedPeers: ["0.0.0.0/0"],
      pointMap: { points: POINTS },
    });
    await expect(os.start()).rejects.toThrow(PeerRuleError);
    expect(os.listeningPort).toBeNull();
  });

  it("drops a peer that is not in the allowlist, before any protocol byte", async () => {
    const os = await startOutstation({ allowedPeers: ["10.1.2.3/32"] });
    const client = await connect(os);
    await client.awaitClose();
    await waitFor(() => os.rejectedConnectionCount === 1);
    expect(os.connectionCount).toBe(0);
  });

  it("enforces the connection cap", async () => {
    const os = await startOutstation({ maxConnections: 1 });
    const first = await connect(os);
    // A request proves the first connection really was admitted.
    first.send(classRead(0));
    await first.next();
    expect(os.connectionCount).toBe(1);

    const second = await connect(os);
    await second.awaitClose();
    await waitFor(() => os.rejectedConnectionCount === 1);
    expect(os.connectionCount).toBe(1);
  });

  it("closes an idle socket after the socket timeout", async () => {
    const os = await startOutstation({ socketTimeoutMs: 120 });
    const client = await connect(os);
    await client.awaitClose(3000);
    await waitFor(() => os.connectionCount === 0);
  });
});

describe("link-frame reassembly on the wire", () => {
  it("answers a request delivered one byte per TCP write", async () => {
    const os = await startOutstation();
    const client = await connect(os);
    client.sendByteByByte(classRead(0));
    const fragment = await client.next();
    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
  });

  it("answers every request in a segment that carries several frames", async () => {
    const os = await startOutstation();
    const client = await connect(os);
    client.writeRaw(
      Buffer.concat([
        masterFrame(classRead(0, 0)),
        masterFrame(classRead(0, 1)),
        masterFrame(classRead(0, 2)),
      ]),
    );
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const fragment = await client.next();
      expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
      seqs.push(fragment[0] & 0x0f);
    }
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("resynchronises after garbage and after a bogus LENGTH", async () => {
    const os = await startOutstation();
    const client = await connect(os);
    // Garbage, then a start pattern whose header CRC cannot verify, then a real
    // request. Only the request may produce a response.
    client.writeRaw(
      Buffer.concat([
        Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x05, 0x64, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]),
        masterFrame(classRead(0)),
      ]),
    );
    const fragment = await client.next();
    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
    await client.expectSilence(150);
  });

  it("drops a frame whose user-data CRC is wrong, and keeps serving", async () => {
    const os = await startOutstation();
    const client = await connect(os);

    const corrupt = masterFrame(classRead(0));
    corrupt[12] ^= 0xff; // flip a user-data octet; its block CRC no longer matches
    client.writeRaw(corrupt);
    await client.expectSilence(150);

    client.send(classRead(0));
    const fragment = await client.next();
    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);
  });

  it("closes a connection that exceeds the receive-buffer bound", async () => {
    const os = await startOutstation({ maxRxBufferBytes: 292 });
    const client = await connect(os);
    // A valid header promising a 292-octet frame, then far more bytes than the
    // bound allows, without ever completing it.
    const frame = buildLinkFrame({
      control: 0xc4,
      destination: 10,
      source: 1,
      payload: Buffer.alloc(250, 0x5a),
    });
    client.writeRaw(frame.subarray(0, 200));
    client.writeRaw(Buffer.alloc(200, 0x5a));
    await client.awaitClose();
    await waitFor(() => os.connectionCount === 0);
    // The listener itself survives; a fresh master is still served.
    const next = await connect(os);
    next.send(classRead(0));
    expect((await next.next())[1]).toBe(DNP3_FUNCTION.RESPONSE);
  });

  it("bounds a peer that pipelines Class 0 reads and never drains its socket", async () => {
    // The receive bound does not bound memory on its own: a 17-octet Class 0
    // READ asks for the entire static database, so a peer can buy hundreds of
    // full responses with one bounded read and then simply stop reading. Every
    // request below fits inside the receive bound, so nothing here is refused
    // on the way in — only the transmit bound can stop it.
    const os = await startOutstation({ maxRxBufferBytes: 8192, maxTxQueueBytes: 4096 });
    const socket = net.createConnection({
      port: os.listeningPort!,
      host: "127.0.0.1",
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("error", () => undefined);
    socket.pause(); // never read a single response octet

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const burst = Buffer.concat(
      Array.from({ length: 400 }, (_, i) => masterFrame(classRead(0, i % 16))),
    );
    expect(burst.length).toBeLessThan(8192);

    const deadline = Date.now() + 4000;
    const pump = setInterval(() => {
      if (socket.destroyed || Date.now() > deadline) {
        clearInterval(pump);
        return;
      }
      socket.write(burst);
    }, 5);

    await expect(closed).resolves.toBeUndefined();
    clearInterval(pump);
    socket.destroy();

    // The listener itself is unharmed and still serves a well-behaved master.
    await waitFor(() => os.connectionCount === 0);
    const next = await connect(os);
    next.send(classRead(0));
    expect((await next.next())[1]).toBe(DNP3_FUNCTION.RESPONSE);
  });
});

describe("reads over a real socket", () => {
  it("returns live tag values for a Class 0 integrity poll", async () => {
    const os = await startOutstation();
    os.updateTag("pump.run", { value: true, quality: "good", timestamp: T0 });
    os.updateTag("pump.fault", { value: false, quality: "good", timestamp: T0 });
    os.updateTag("flow.total", { value: 1234, quality: "good", timestamp: T0 });
    os.updateTag("tank.level", { value: 12.5, quality: "good", timestamp: T0 });

    const client = await connect(os);
    client.send(classRead(0));
    const fragment = await client.next();

    expect(fragment[0]).toBe(0xc0); // FIR|FIN, sequence 0, CON clear
    expect(fragment[1]).toBe(DNP3_FUNCTION.RESPONSE);

    const objects = fragment.subarray(4);
    // g1v2 binary inputs 0..1: ONLINE|STATE for the true point, ONLINE for false.
    expect([...objects.subarray(0, 7)]).toEqual([0x01, 0x02, 0x00, 0x00, 0x01, 0x81, 0x01]);

    // g10v2 binary output status 0..1 — never sampled, so still the seeded
    // offline placeholder (COMM_LOST) rather than a fabricated value.
    const bo = objects.subarray(7, 14);
    expect([...bo.subarray(0, 5)]).toEqual([0x0a, 0x02, 0x00, 0x00, 0x01]);

    // g20v1 counter 0 = 1234, then g30v5 analog input 0 = 12.5.
    const counter = objects.subarray(14, 24);
    expect([...counter.subarray(0, 5)]).toEqual([0x14, 0x01, 0x00, 0x00, 0x00]);
    expect(counter.readUInt32LE(6)).toBe(1234);

    const analog = objects.subarray(24, 34);
    expect([...analog.subarray(0, 5)]).toEqual([0x1e, 0x05, 0x00, 0x00, 0x00]);
    expect(analog.readFloatLE(6)).toBeCloseTo(12.5, 5);
  });

  it("returns the Class 1 binary event #601 encodes, and clears it on CONFIRM", async () => {
    const os = await startOutstation();
    os.updateTag("pump.run", { value: true, quality: "good", timestamp: T0 });
    expect(os.ctx.eventBuffer.classSize(1)).toBe(1);

    const client = await connect(os);
    client.send(classRead(1));
    const fragment = await client.next();

    expect([...fragment]).toEqual([
      0xe0, // FIR|FIN|CON, sequence 0
      DNP3_FUNCTION.RESPONSE,
      0x82, 0x00, // IIN1: CLASS1_EVENTS | DEVICE_RESTART
      0x02, 0x02, 0x17, 0x01, // g2v2, index-prefixed qualifier, count 1
      0x00, // index 0
      0x81, // ONLINE|STATE
      0xef, 0xcd, 0xab, 0x00, 0x00, 0x00, // DNP3 time T0
    ]);

    // Events leave the buffer only on CONFIRM.
    expect(os.ctx.eventBuffer.classSize(1)).toBe(1);
    client.send(confirm(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(os.ctx.eventBuffer.classSize(1)).toBe(0);
  });

  it("returns Class 2 counter and Class 3 analog events", async () => {
    const os = await startOutstation();
    os.updateTag("flow.total", { value: 4242, quality: "good", timestamp: T0 });
    os.updateTag("tank.level", { value: -3.5, quality: "good", timestamp: T0 });
    expect(os.ctx.eventBuffer.classSize(2)).toBe(1);
    expect(os.ctx.eventBuffer.classSize(3)).toBe(1);

    const client = await connect(os);

    client.send(classRead(2));
    const counterFragment = await client.next();
    const counterIin = counterFragment.readUInt16LE(2);
    expect(counterIin & DNP3_IIN.CLASS2_EVENTS).toBeTruthy();
    // g22v5 (counter event with absolute time), qualifier 0x17, count 1, index 0.
    expect([...counterFragment.subarray(4, 9)]).toEqual([0x16, 0x05, 0x17, 0x01, 0x00]);
    expect(counterFragment.readUInt32LE(10)).toBe(4242);

    client.send(classRead(3, 1));
    const analogFragment = await client.next();
    expect(analogFragment.readUInt16LE(2) & DNP3_IIN.CLASS3_EVENTS).toBeTruthy();
    // g32v7 (float analog input event with absolute time).
    expect([...analogFragment.subarray(4, 9)]).toEqual([0x20, 0x07, 0x17, 0x01, 0x00]);
    expect(analogFragment.readFloatLE(10)).toBeCloseTo(-3.5, 5);
  });
});

describe("controls over a real socket", () => {
  it("refuses SELECT and OPERATE with NOT_SUPPORTED while controls are off", async () => {
    const os = await startOutstation();
    expect(os.controlsWritable).toBe(false);
    const client = await connect(os);

    client.send(crobRequest({ func: DNP3_FUNCTION.SELECT, index: 0, seq: 0 }));
    const selectResponse = await client.next();
    expect(selectResponse[selectResponse.length - 1]).toBe(
      DNP3_COMMAND_STATUS.NOT_SUPPORTED,
    );

    client.send(crobRequest({ func: DNP3_FUNCTION.OPERATE, index: 0, seq: 1 }));
    const operateResponse = await client.next();
    expect(operateResponse[operateResponse.length - 1]).toBe(
      DNP3_COMMAND_STATUS.NOT_SUPPORTED,
    );

    client.send(crobRequest({ func: DNP3_FUNCTION.DIRECT_OPERATE, index: 0, seq: 2 }));
    const directResponse = await client.next();
    expect(directResponse[directResponse.length - 1]).toBe(
      DNP3_COMMAND_STATUS.NOT_SUPPORTED,
    );
  });

  it("executes a SELECT/OPERATE pair through the tag store once opted in", async () => {
    const os = await startOutstation({ controls: { enabled: true } });
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: os.ctx.pointMap, store });
    os.setControlSink(sink);
    expect(os.controlsWritable).toBe(true);

    const client = await connect(os);
    client.send(crobRequest({ func: DNP3_FUNCTION.SELECT, index: 0, seq: 0 }));
    const selectResponse = await client.next();
    expect(selectResponse[selectResponse.length - 1]).toBe(DNP3_COMMAND_STATUS.SUCCESS);
    // A SELECT arms; it must not have touched the store.
    expect(store.peek("valve.cmd")).toBeUndefined();

    client.send(crobRequest({ func: DNP3_FUNCTION.OPERATE, index: 0, seq: 1 }));
    const operateResponse = await client.next();
    expect(operateResponse[operateResponse.length - 1]).toBe(DNP3_COMMAND_STATUS.SUCCESS);

    await sink.settled();
    expect(store.peek("valve.cmd")?.value).toBe(true);
  });

  it("refuses a mapped output that the point map does not mark writable", async () => {
    const os = await startOutstation({ controls: { enabled: true } });
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: os.ctx.pointMap, store });
    os.setControlSink(sink);

    const client = await connect(os);
    // Index 1 is `vent.cmd`, mapped but not writable.
    client.send(crobRequest({ func: DNP3_FUNCTION.DIRECT_OPERATE, index: 1, seq: 0 }));
    const response = await client.next();
    expect(response[response.length - 1]).toBe(DNP3_COMMAND_STATUS.NOT_SUPPORTED);
    await sink.settled();
    expect(store.peek("vent.cmd")).toBeUndefined();
  });
});

describe("shutdown", () => {
  it("closes every connection and releases the port", async () => {
    const os = await startOutstation();
    const client = await connect(os);
    client.send(classRead(0));
    await client.next();
    const port = os.listeningPort!;
    expect(os.connectionCount).toBe(1);

    await os.stop();
    outstation = null;

    await client.awaitClose();
    expect(os.connectionCount).toBe(0);
    expect(os.listeningPort).toBeNull();

    // The port is genuinely free again — binding it succeeds.
    const probe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("is idempotent and safe to call before start()", async () => {
    const os = new Dnp3Outstation({ port: 0, pointMap: { points: POINTS } });
    await expect(os.stop()).resolves.toBeUndefined();
    await os.start();
    await os.stop();
    await expect(os.stop()).resolves.toBeUndefined();
    expect(os.listeningPort).toBeNull();
  });
});
