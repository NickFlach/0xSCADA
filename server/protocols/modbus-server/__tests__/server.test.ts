/**
 * Server transport tests (#462): real loopback TCP socket exercises framing,
 * partial-frame reassembly, and request/response over the wire.
 *
 * Uses only Node's built-in `net` (no external Modbus dependency).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { ModbusTcpServer } from "../server";
import { InMemoryDataModel } from "../data-model";
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

  it("write (FC06) then read (FC03) round-trips over the socket", async () => {
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
