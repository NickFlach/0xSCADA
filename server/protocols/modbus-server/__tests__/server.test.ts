/**
 * Server transport tests (#462): real loopback TCP socket exercises framing,
 * partial-frame reassembly, and request/response over the wire.
 *
 * Uses only Node's built-in `net` (no external Modbus dependency).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { ModbusTcpServer } from "../server";
import { InMemoryDataModel, type ModbusDataModel } from "../data-model";
import {
  EXCEPTION_FLAG,
  FunctionCode,
  encodeMbapHeader,
} from "../codec";

/** Build a request frame on the wire. */
function frame(txId: number, unitId: number, fc: number, data: Buffer): Buffer {
  const header = encodeMbapHeader(
    { transactionId: txId, protocolId: 0, unitId },
    1 + data.length,
  );
  return Buffer.concat([header, Buffer.from([fc]), data]);
}

/** Connect, send `payload` (possibly in chunks), resolve with first response. */
function exchange(
  port: number,
  chunks: Buffer[],
  expectedResponseBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let received = Buffer.alloc(0);
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
    });
    socket.on("data", (d) => {
      received = Buffer.concat([received, d]);
      if (received.length >= expectedResponseBytes) {
        socket.end();
        resolve(received);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
  });
}

describe("ModbusTcpServer over loopback TCP", () => {
  let model: InMemoryDataModel;
  let server: ModbusTcpServer;
  let port: number;

  beforeEach(async () => {
    model = new InMemoryDataModel({
      coils: 100,
      holdingRegisters: 100,
    });
    // Port 0 => OS assigns a free port; keeps the test unprivileged.
    server = new ModbusTcpServer(model, { host: "127.0.0.1", port: 0 });
    await server.start();
    port = server.address()!.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("binds to an ephemeral port and reports it", () => {
    expect(server.isListening).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it("answers an FC03 read with the correct value", async () => {
    await model.writeHoldingRegisters(0, [0xcafe]);
    const req = frame(0x0001, 1, FunctionCode.READ_HOLDING_REGISTERS,
      Buffer.from([0x00, 0x00, 0x00, 0x01]));
    // Response: 7-byte MBAP + FC + byteCount + 2 data = 11 bytes
    const resp = await exchange(port, [req], 11);
    expect(resp.readUInt16BE(0)).toBe(0x0001); // tx id echoed
    expect(resp.readUInt8(7)).toBe(FunctionCode.READ_HOLDING_REGISTERS);
    expect(resp.readUInt8(8)).toBe(2); // byte count
    expect(resp.readUInt16BE(9)).toBe(0xcafe);
  });

  it("rejects network writes by default without mutating the model", async () => {
    const write = frame(
      0x0002,
      1,
      FunctionCode.WRITE_SINGLE_REGISTER,
      Buffer.from([0x00, 0x05, 0x12, 0x34]),
    );
    const resp = await exchange(port, [write], 9);
    expect(resp.readUInt8(7)).toBe(
      FunctionCode.WRITE_SINGLE_REGISTER | EXCEPTION_FLAG,
    );
    expect(resp.readUInt8(8)).toBe(0x01); // Illegal Function
    expect(await model.readHoldingRegisters(5, 1)).toEqual([0]);
  });

  it("write (FC06) then read (FC03) works only with explicit opt-in", async () => {
    await server.stop();
    server = new ModbusTcpServer(model, {
      host: "127.0.0.1",
      port: 0,
      allowWrites: true,
    });
    await server.start();
    port = server.address()!.port;

    const write = frame(0x0002, 1, FunctionCode.WRITE_SINGLE_REGISTER,
      Buffer.from([0x00, 0x05, 0x12, 0x34]));
    const read = frame(0x0003, 1, FunctionCode.READ_HOLDING_REGISTERS,
      Buffer.from([0x00, 0x05, 0x00, 0x01]));
    // FC06 echo response (12) + FC03 read response (11) = 23 bytes
    const resp = await exchange(port, [write, read], 23);
    // Second response begins at byte 12
    const readResp = resp.subarray(12);
    expect(readResp.readUInt16BE(9)).toBe(0x1234);
  });

  it("reassembles a frame split across two TCP chunks", async () => {
    await model.writeHoldingRegisters(0, [0x0042]);
    const req = frame(0x0004, 1, FunctionCode.READ_HOLDING_REGISTERS,
      Buffer.from([0x00, 0x00, 0x00, 0x01]));
    // Split mid-frame: header partial, then the rest.
    const resp = await exchange(
      port,
      [req.subarray(0, 4), req.subarray(4)],
      11,
    );
    expect(resp.readUInt16BE(9)).toBe(0x0042);
  });

  it("returns an exception frame for an unsupported function code", async () => {
    const req = frame(0x0005, 1, 0x63, Buffer.from([0x00, 0x00, 0x00, 0x01]));
    const resp = await exchange(port, [req], 9);
    expect((resp.readUInt8(7) & EXCEPTION_FLAG) !== 0).toBe(true);
    expect(resp.readUInt8(8)).toBe(0x01); // Illegal Function
  });
});

/**
 * A model whose reads take real wall-clock time, the way the live tag store
 * does (Redis round-trip). The earlier tests all use a model that resolves
 * within a microtask, so a `data` event can never land mid-request there.
 */
function slowModel(delayMs: number, value: number): ModbusDataModel {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    async readCoils(_a, q) {
      await wait();
      return new Array<boolean>(q).fill(false);
    },
    async readDiscreteInputs(_a, q) {
      await wait();
      return new Array<boolean>(q).fill(false);
    },
    async readHoldingRegisters(_a, q) {
      await wait();
      return new Array<number>(q).fill(value);
    },
    async readInputRegisters(_a, q) {
      await wait();
      return new Array<number>(q).fill(value);
    },
    async writeCoils() {
      await wait();
    },
    async writeHoldingRegisters() {
      await wait();
    },
  };
}

describe("ModbusTcpServer request pipelining", () => {
  let server: ModbusTcpServer;

  afterEach(async () => {
    await server.stop();
  });

  // Regression: a master that sends a second request while the first is still
  // awaiting the data model must still get both answers. Assigning the drain's
  // return value straight back to the receive buffer discarded every byte that
  // arrived during the await, silently swallowing the second request.
  it("answers a request that arrives while the previous one is in flight", async () => {
    server = new ModbusTcpServer(slowModel(60, 0x0042), {
      host: "127.0.0.1",
      port: 0,
    });
    await server.start();
    const port = server.address()!.port;

    const read = (txId: number) =>
      frame(txId, 1, FunctionCode.READ_HOLDING_REGISTERS,
        Buffer.from([0x00, 0x00, 0x00, 0x01]));

    const seen = await new Promise<number[]>((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      const txIds: number[] = [];
      let received = Buffer.alloc(0);
      const finish = () => {
        clearTimeout(deadline);
        socket.destroy();
        resolve(txIds);
      };
      const deadline = setTimeout(finish, 1500);
      socket.on("connect", () => {
        socket.write(read(0x0001));
        // Lands while the first read is still inside the 60 ms model call.
        setTimeout(() => socket.write(read(0x0002)), 20);
      });
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        while (received.length >= 11) {
          txIds.push(received.readUInt16BE(0));
          received = received.subarray(11);
        }
        if (txIds.length === 2) finish();
      });
      socket.on("error", (err) => {
        clearTimeout(deadline);
        reject(err);
      });
    });

    expect(seen).toEqual([0x0001, 0x0002]);
  });
});
