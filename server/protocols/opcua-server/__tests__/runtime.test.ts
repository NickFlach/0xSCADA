/**
 * Tests for the OPC-UA Server Mode startup path (#461).
 *
 * The point of these is the gating contract that `server/index.ts` depends on:
 * the subsystem stays off unless one documented flag is set, and when it is set
 * but cannot be started safely it throws instead of coming up permissive.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";

const databaseType = { value: "postgres" as "postgres" | "sqlite" };

vi.mock("../../../storage", () => ({
  getDatabase: () => {
    throw new Error("database access is not expected in this test");
  },
  getDatabaseType: () => databaseType.value,
}));

vi.mock("../../../websocket/tag-stream", () => ({
  tagStreamServer: { onTagUpdate: () => () => undefined },
}));

import { loadOpcuaServerConfig, OpcuaServerConfigError } from "../config";
import {
  getOpcuaServer,
  OPCUA_SERVER_ENABLED_ENV,
  startOpcuaServer,
  stopOpcuaServer,
} from "../runtime";

describe("startOpcuaServer gating", () => {
  beforeEach(async () => {
    databaseType.value = "postgres";
    await stopOpcuaServer();
  });

  test("is off with an empty environment", async () => {
    await expect(startOpcuaServer({ env: {} })).resolves.toBeNull();
    expect(getOpcuaServer()).toBeNull();
  });

  test("stays off for every environment unless the flag is set", async () => {
    for (const NODE_ENV of ["development", "test", "staging", "production"]) {
      await expect(startOpcuaServer({ env: { NODE_ENV } })).resolves.toBeNull();
    }
    expect(getOpcuaServer()).toBeNull();
  });

  test("the enable flag is the documented one", () => {
    expect(OPCUA_SERVER_ENABLED_ENV).toBe("OPCUA_SERVER_ENABLED");
  });

  test("an invalid configuration fails the start instead of relaxing it", async () => {
    await expect(
      startOpcuaServer({
        env: {
          OPCUA_SERVER_ENABLED: "true",
          OPCUA_SERVER_HOST: "0.0.0.0",
        },
      }),
    ).rejects.toBeInstanceOf(OpcuaServerConfigError);
    expect(getOpcuaServer()).toBeNull();
  });

  test("an ambiguous boolean fails the start", async () => {
    await expect(
      startOpcuaServer({
        env: {
          OPCUA_SERVER_ENABLED: "true",
          OPCUA_SERVER_ALLOW_ANONYMOUS: "probably",
        },
      }),
    ).rejects.toBeInstanceOf(OpcuaServerConfigError);
    expect(getOpcuaServer()).toBeNull();
  });

  test("refuses to serve from the SQLite development fallback", async () => {
    databaseType.value = "sqlite";
    await expect(
      startOpcuaServer({
        config: loadOpcuaServerConfig({
          enabled: true,
          env: "development",
          port: 0,
        }),
      }),
    ).rejects.toThrow(/requires the PostgreSQL backend/);
    expect(getOpcuaServer()).toBeNull();
  });

  test("stopOpcuaServer is a no-op when nothing was started", async () => {
    await expect(stopOpcuaServer()).resolves.toBeUndefined();
  });
});
