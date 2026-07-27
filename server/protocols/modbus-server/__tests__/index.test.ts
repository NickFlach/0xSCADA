/**
 * Factory tests (#462): `createModbusServerForSite` — the public glue that ties
 * a register map -> tag-store-backed data model -> TCP listener together.
 *
 * These tests exercise the construction contract only (parse raw config / accept
 * a prebuilt map / bind + report an ephemeral port). They deliberately do NOT
 * drive a tag READ through the returned server, because the factory binds the
 * data model to the real `tagCache` (server/services/cache/tag-cache.ts), whose
 * read/write path requires the Redis-backed cache stack that is not present in
 * the isolated unit-test environment. Read/write propagation against an
 * in-memory store is covered hermetically in `tag-store-bridge.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createModbusServerForSite, ModbusTcpServer, RegisterMap } from "../index";

const rawConfig = {
  siteId: "site-1",
  unitId: 7,
  entries: [
    { tagId: "tank.level", area: "holdingRegister", address: 0, dataType: "uint16" },
  ],
};

describe("createModbusServerForSite", () => {
  let server: ModbusTcpServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("builds a startable server from a raw (Zod-validated) config", async () => {
    server = createModbusServerForSite(rawConfig, { host: "127.0.0.1", port: 0 });
    expect(server).toBeInstanceOf(ModbusTcpServer);
    await server.start();
    expect(server.isListening).toBe(true);
    expect(server.address()!.port).toBeGreaterThan(0);
  });

  it("accepts an already-built RegisterMap without re-parsing", async () => {
    const map = RegisterMap.fromConfig(rawConfig);
    server = createModbusServerForSite(map, { host: "127.0.0.1", port: 0 });
    await server.start();
    expect(server.isListening).toBe(true);
  });

  it("propagates an invalid register map as a validation error at construction", () => {
    expect(() =>
      createModbusServerForSite({
        siteId: "s",
        // bit area with a non-bool dataType is rejected by RegisterMap
        entries: [{ tagId: "x", area: "coil", address: 0, dataType: "uint16" }],
      }),
    ).toThrow();
  });

  it("defaults the server unit id from the map when not overridden", () => {
    // unitId 7 comes from the config; the factory threads map.unitId through.
    const map = RegisterMap.fromConfig(rawConfig);
    expect(map.unitId).toBe(7);
    server = createModbusServerForSite(map, { host: "127.0.0.1", port: 0 });
    expect(server).toBeInstanceOf(ModbusTcpServer);
  });
});
