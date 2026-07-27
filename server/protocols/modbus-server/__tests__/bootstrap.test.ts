/**
 * Bootstrap tests (#462): `startModbusServer` is the real, explicitly opt-in
 * startup path `server/index.ts` calls — this file exercises it end to end over
 * genuine TCP sockets.
 *
 * What is asserted here is exactly the safety contract the maintainer rejected
 * the first cut for:
 *   - nothing happens at all unless MODBUS_SERVER_ENABLED=true;
 *   - invalid configuration refuses to start instead of falling back;
 *   - the listener binds loopback by default;
 *   - a peer outside the allowlist is dropped at accept time;
 *   - writes are answered with exception 0x01 unless writes were opted into;
 *   - once opted in, only addresses marked `writable` reach the tag store;
 *   - a plain read still works over a real socket.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { startModbusServer, type RegisterMapLoader } from "../index";
import type { ModbusTcpServer } from "../server";
import { ModbusServerConfigError } from "../config";
import { RegisterMap } from "../register-map";
import { InMemoryTagStore } from "../tag-store-bridge";
import { EXCEPTION_FLAG, FunctionCode, encodeMbapHeader } from "../codec";

/**
 * The register map used by these tests. `pump.speed` is deliberately the ONLY
 * writable address, so "writes land only where the map says" is observable.
 */
const registerMap = (): RegisterMap =>
  RegisterMap.fromConfig({
    siteId: "site-1",
    unitId: 1,
    entries: [
      {
        tagId: "tank.level",
        area: "holdingRegister",
        address: 0,
        dataType: "uint16",
      },
      {
        tagId: "pump.speed",
        area: "holdingRegister",
        address: 1,
        dataType: "uint16",
        writable: true,
      },
    ],
  });

const loadRegisterMap: RegisterMapLoader = async () => registerMap();

/** Reserve a free TCP port so the tests never need privileged port 502. */
function freePort(): Promise<number> {
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

function baseEnv(port: number): NodeJS.ProcessEnv {
  return {
    MODBUS_SERVER_ENABLED: "true",
    MODBUS_SERVER_SITE_ID: "site-1",
    MODBUS_SERVER_PORT: String(port),
  };
}

/** Build a request frame on the wire. */
function frame(txId: number, fc: number, data: Buffer): Buffer {
  const header = encodeMbapHeader(
    { transactionId: txId, protocolId: 0, unitId: 1 },
    1 + data.length,
  );
  return Buffer.concat([header, Buffer.from([fc]), data]);
}

/** Send one frame, resolve with the first `expectedBytes` of response. */
function exchange(
  port: number,
  request: Buffer,
  expectedBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let received = Buffer.alloc(0);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= expectedBytes) {
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

/** Connect and report whether the peer was served or dropped without a reply. */
function probeAdmission(
  port: number,
  request: Buffer,
): Promise<{ served: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    let bytes = 0;
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      socket.destroy();
      resolve({ served: true });
    });
    // A refused peer is destroyed at accept time: the connection closes (or
    // resets) with no protocol bytes ever delivered.
    socket.on("close", () => resolve({ served: bytes > 0 }));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" || err.code === "EPIPE") {
        resolve({ served: false });
        return;
      }
      reject(err);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
  });
}

const readTankLevel = frame(
  0x0001,
  FunctionCode.READ_HOLDING_REGISTERS,
  Buffer.from([0x00, 0x00, 0x00, 0x01]),
);

describe("startModbusServer gating", () => {
  let server: ModbusTcpServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("does nothing at all when MODBUS_SERVER_ENABLED is unset", async () => {
    server = await startModbusServer({ env: {}, loadRegisterMap });
    expect(server).toBeNull();
  });

  it("does nothing for a non-'true' enable flag", async () => {
    server = await startModbusServer({
      env: { MODBUS_SERVER_ENABLED: "1", MODBUS_SERVER_SITE_ID: "site-1" },
      loadRegisterMap,
    });
    expect(server).toBeNull();
  });

  it("refuses to start when the site id is missing", async () => {
    await expect(
      startModbusServer({
        env: { MODBUS_SERVER_ENABLED: "true" },
        loadRegisterMap,
      }),
    ).rejects.toBeInstanceOf(ModbusServerConfigError);
  });

  it("refuses to start when exposed without a peer allowlist", async () => {
    await expect(
      startModbusServer({
        env: {
          MODBUS_SERVER_ENABLED: "true",
          MODBUS_SERVER_SITE_ID: "site-1",
          MODBUS_SERVER_BIND_HOST: "0.0.0.0",
        },
        loadRegisterMap,
      }),
    ).rejects.toThrow(/MODBUS_SERVER_ALLOWED_PEERS must list/);
  });

  it("refuses to start on a wildcard peer allowlist", async () => {
    await expect(
      startModbusServer({
        env: {
          MODBUS_SERVER_ENABLED: "true",
          MODBUS_SERVER_SITE_ID: "site-1",
          MODBUS_SERVER_BIND_HOST: "0.0.0.0",
          MODBUS_SERVER_ALLOWED_PEERS: "0.0.0.0/0",
        },
        loadRegisterMap,
      }),
    ).rejects.toBeInstanceOf(ModbusServerConfigError);
  });

  it("propagates a register-map load failure instead of listening", async () => {
    const port = await freePort();
    await expect(
      startModbusServer({
        env: baseEnv(port),
        loadRegisterMap: async () => {
          throw new Error("no rows for site-1");
        },
      }),
    ).rejects.toThrow(/no rows for site-1/);

    // Nothing is holding the port: it can be bound by an unrelated listener.
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = net.createServer();
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
      }),
    ).resolves.toBeUndefined();
  });
});

describe("startModbusServer listener", () => {
  let server: ModbusTcpServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("binds loopback by default and serves a read over a real socket", async () => {
    const port = await freePort();
    const store = new InMemoryTagStore();
    store.seed("tank.level", 0xbeef);

    server = await startModbusServer({
      env: baseEnv(port),
      loadRegisterMap,
      tagStore: store,
    });
    expect(server).not.toBeNull();
    expect(server!.isListening).toBe(true);
    expect(server!.address()!.address).toBe("127.0.0.1");
    expect(server!.writesAllowed).toBe(false);

    // 7-byte MBAP + FC + byte count + 2 data bytes.
    const response = await exchange(port, readTankLevel, 11);
    expect(response.readUInt16BE(0)).toBe(0x0001); // transaction id echoed
    expect(response.readUInt8(7)).toBe(FunctionCode.READ_HOLDING_REGISTERS);
    expect(response.readUInt16BE(9)).toBe(0xbeef);
  });

  it("drops a peer outside the allowlist at accept time", async () => {
    const port = await freePort();
    server = await startModbusServer({
      env: {
        ...baseEnv(port),
        // The loopback client used by this test is deliberately NOT in here.
        MODBUS_SERVER_ALLOWED_PEERS: "10.99.0.1/32",
      },
      loadRegisterMap,
      tagStore: new InMemoryTagStore(),
    });

    const result = await probeAdmission(port, readTankLevel);
    expect(result.served).toBe(false);
    expect(server!.rejectedConnectionCount).toBe(1);
    expect(server!.connectionCount).toBe(0);
  });

  it("still serves an allowlisted peer on the same listener config", async () => {
    const port = await freePort();
    const store = new InMemoryTagStore();
    store.seed("tank.level", 7);
    server = await startModbusServer({
      env: { ...baseEnv(port), MODBUS_SERVER_ALLOWED_PEERS: "127.0.0.1/32" },
      loadRegisterMap,
      tagStore: store,
    });

    const response = await exchange(port, readTankLevel, 11);
    expect(response.readUInt16BE(9)).toBe(7);
    expect(server!.rejectedConnectionCount).toBe(0);
  });

  it("caps simultaneous master connections", async () => {
    const port = await freePort();
    server = await startModbusServer({
      env: { ...baseEnv(port), MODBUS_SERVER_MAX_CONNECTIONS: "1" },
      loadRegisterMap,
      tagStore: new InMemoryTagStore(),
    });

    const first = net.createConnection({ port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      first.once("connect", () => resolve());
      first.once("error", reject);
    });

    try {
      const second = await probeAdmission(port, readTankLevel);
      expect(second.served).toBe(false);
      expect(server!.rejectedConnectionCount).toBe(1);
    } finally {
      first.destroy();
    }
  });
});

describe("startModbusServer write gating", () => {
  let server: ModbusTcpServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  /** FC06 write of 0x0064 to holding register 1 (`pump.speed`). */
  const writePumpSpeed = frame(
    0x0010,
    FunctionCode.WRITE_SINGLE_REGISTER,
    Buffer.from([0x00, 0x01, 0x00, 0x64]),
  );

  it("answers a write with exception 0x01 and mutates nothing when writes are off", async () => {
    const port = await freePort();
    const store = new InMemoryTagStore();
    server = await startModbusServer({
      env: baseEnv(port),
      loadRegisterMap,
      tagStore: store,
    });

    // MBAP(7) + (FC|0x80) + exception byte.
    const response = await exchange(port, writePumpSpeed, 9);
    expect(response.readUInt8(7)).toBe(
      FunctionCode.WRITE_SINGLE_REGISTER | EXCEPTION_FLAG,
    );
    expect(response.readUInt8(8)).toBe(0x01); // Illegal Function
    expect(store.peek("pump.speed")).toBeUndefined();
  });

  it("refuses FC05/FC15/FC16 too, not just FC06", async () => {
    const port = await freePort();
    server = await startModbusServer({
      env: baseEnv(port),
      loadRegisterMap,
      tagStore: new InMemoryTagStore(),
    });

    for (const fc of [
      FunctionCode.WRITE_SINGLE_COIL,
      FunctionCode.WRITE_MULTIPLE_COILS,
      FunctionCode.WRITE_MULTIPLE_REGISTERS,
    ]) {
      const response = await exchange(
        port,
        frame(0x0011, fc, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x02, 0x00, 0x00])),
        9,
      );
      expect(response.readUInt8(7)).toBe(fc | EXCEPTION_FLAG);
      expect(response.readUInt8(8)).toBe(0x01);
    }
  });

  it("lands a write on an explicitly writable address once writes are opted in", async () => {
    const port = await freePort();
    const store = new InMemoryTagStore();
    server = await startModbusServer({
      env: { ...baseEnv(port), MODBUS_SERVER_ALLOW_WRITES: "true" },
      loadRegisterMap,
      tagStore: store,
    });
    expect(server!.writesAllowed).toBe(true);

    // FC06 echoes the request: MBAP(7) + FC + 4 bytes = 12.
    const response = await exchange(port, writePumpSpeed, 12);
    expect(response.readUInt8(7)).toBe(FunctionCode.WRITE_SINGLE_REGISTER);
    expect(store.peek("pump.speed")).toBe(0x0064);
  });

  it("still refuses a write to a mapped-but-not-writable address when writes are on", async () => {
    const port = await freePort();
    const store = new InMemoryTagStore();
    server = await startModbusServer({
      env: { ...baseEnv(port), MODBUS_SERVER_ALLOW_WRITES: "true" },
      loadRegisterMap,
      tagStore: store,
    });

    // Holding register 0 is `tank.level`, mapped but never marked writable.
    const writeTankLevel = frame(
      0x0012,
      FunctionCode.WRITE_SINGLE_REGISTER,
      Buffer.from([0x00, 0x00, 0x00, 0x2a]),
    );
    const response = await exchange(port, writeTankLevel, 9);
    expect(response.readUInt8(7)).toBe(
      FunctionCode.WRITE_SINGLE_REGISTER | EXCEPTION_FLAG,
    );
    expect(response.readUInt8(8)).toBe(0x03); // Illegal Data Value
    expect(store.peek("tank.level")).toBeUndefined();
  });
});
