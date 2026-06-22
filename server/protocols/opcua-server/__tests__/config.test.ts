/**
 * Tests for OPC-UA server config (#461).
 */
import { describe, test, expect } from "vitest";
import {
  loadOpcuaServerConfig,
  endpointUrl,
  DEFAULT_OPCUA_ENDPOINT,
} from "../config";

describe("loadOpcuaServerConfig", () => {
  test("applies acceptance-criteria defaults", () => {
    const c = loadOpcuaServerConfig();
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(4840);
    expect(c.resourcePath).toBe("/0xscada");
    expect(c.env).toBe("development");
    expect(c.enabled).toBe(false);
  });

  test("default endpoint matches the issue spec", () => {
    expect(endpointUrl(loadOpcuaServerConfig())).toBe(DEFAULT_OPCUA_ENDPOINT);
  });

  test("coerces and validates port", () => {
    expect(loadOpcuaServerConfig({ port: "5840" }).port).toBe(5840);
    expect(() => loadOpcuaServerConfig({ port: 0 })).toThrow();
    expect(() => loadOpcuaServerConfig({ port: 99999 })).toThrow();
  });

  test("rejects an unknown env", () => {
    expect(() => loadOpcuaServerConfig({ env: "prod" })).toThrow();
  });

  test("endpointUrl normalises a path missing a leading slash", () => {
    const c = loadOpcuaServerConfig({ resourcePath: "uaserver", port: 4841 });
    expect(endpointUrl(c)).toBe("opc.tcp://0.0.0.0:4841/uaserver");
  });

  test("enforces minimum sampling interval", () => {
    expect(() => loadOpcuaServerConfig({ minSamplingIntervalMs: 1 })).toThrow();
    expect(loadOpcuaServerConfig({ minSamplingIntervalMs: 250 }).minSamplingIntervalMs).toBe(
      250,
    );
  });
});
