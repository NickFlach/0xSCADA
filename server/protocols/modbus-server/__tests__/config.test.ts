/**
 * Deployment-configuration tests (#462).
 *
 * The listener is off by default, binds loopback by default, refuses to be
 * exposed without a peer allowlist, and refuses to serve writes unless writes
 * were separately opted into. Every invalid combination must raise
 * `ModbusServerConfigError` rather than degrade to a permissive listener.
 */
import { describe, it, expect } from "vitest";
import {
  describeModbusServerConfig,
  isModbusServerEnabled,
  loadModbusServerConfig,
  ModbusServerConfigError,
} from "../config";

/** Minimal valid environment: enabled, everything else defaulted. */
const baseEnv: NodeJS.ProcessEnv = {
  MODBUS_SERVER_ENABLED: "true",
  MODBUS_SERVER_SITE_ID: "site-1",
};

describe("isModbusServerEnabled", () => {
  it("is off when unset", () => {
    expect(isModbusServerEnabled({})).toBe(false);
  });

  it("is off for anything other than the exact string 'true'", () => {
    expect(isModbusServerEnabled({ MODBUS_SERVER_ENABLED: "1" })).toBe(false);
    expect(isModbusServerEnabled({ MODBUS_SERVER_ENABLED: "TRUE" })).toBe(false);
    expect(isModbusServerEnabled({ MODBUS_SERVER_ENABLED: "yes" })).toBe(false);
  });

  it("is on only for 'true'", () => {
    expect(isModbusServerEnabled({ MODBUS_SERVER_ENABLED: "true" })).toBe(true);
  });
});

describe("loadModbusServerConfig defaults", () => {
  it("binds loopback and refuses writes by default", () => {
    const config = loadModbusServerConfig(baseEnv);
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowWrites).toBe(false);
    expect(config.allowedPeers).toEqual(["127.0.0.0/8", "::1/128"]);
    expect(config.maxConnections).toBeGreaterThan(0);
    expect(config.port).toBe(502);
  });

  it("never defaults the bind host to a routable address", () => {
    expect(loadModbusServerConfig(baseEnv).host).not.toBe("0.0.0.0");
    expect(loadModbusServerConfig(baseEnv).host).not.toBe("::");
  });

  it("treats blank template values as unset rather than as failures", () => {
    // `.env.example` ships these keys with empty values.
    const config = loadModbusServerConfig({
      ...baseEnv,
      MODBUS_SERVER_ALLOWED_PEERS: "",
      MODBUS_SERVER_BIND_HOST: "",
      MODBUS_SERVER_PORT: "",
      MODBUS_SERVER_MAX_CONNECTIONS: "",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.allowedPeers).toEqual(["127.0.0.0/8", "::1/128"]);
    expect(config.port).toBe(502);
  });

  it("still refuses an exposed bind whose allowlist is blank", () => {
    expect(() =>
      loadModbusServerConfig({
        ...baseEnv,
        MODBUS_SERVER_BIND_HOST: "0.0.0.0",
        MODBUS_SERVER_ALLOWED_PEERS: "  ,  ",
      }),
    ).toThrow(/MODBUS_SERVER_ALLOWED_PEERS must list/);
  });

  it("enables writes only on the explicit separate opt-in", () => {
    expect(
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_ALLOW_WRITES: "1" })
        .allowWrites,
    ).toBe(false);
    expect(
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_ALLOW_WRITES: "true" })
        .allowWrites,
    ).toBe(true);
  });
});

describe("loadModbusServerConfig failure modes", () => {
  it("refuses to start without a site id", () => {
    expect(() =>
      loadModbusServerConfig({ MODBUS_SERVER_ENABLED: "true" }),
    ).toThrow(ModbusServerConfigError);
  });

  it("refuses a routable bind with no peer allowlist", () => {
    expect(() =>
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_BIND_HOST: "0.0.0.0" }),
    ).toThrow(/MODBUS_SERVER_ALLOWED_PEERS must list/);
  });

  it("refuses a wildcard peer allowlist", () => {
    expect(() =>
      loadModbusServerConfig({
        ...baseEnv,
        MODBUS_SERVER_BIND_HOST: "0.0.0.0",
        MODBUS_SERVER_ALLOWED_PEERS: "0.0.0.0/0",
      }),
    ).toThrow(ModbusServerConfigError);
  });

  it("refuses an unparseable peer allowlist entry", () => {
    expect(() =>
      loadModbusServerConfig({
        ...baseEnv,
        MODBUS_SERVER_ALLOWED_PEERS: "10.0.0.0/16, not-an-ip",
      }),
    ).toThrow(ModbusServerConfigError);
  });

  it("refuses an out-of-range port", () => {
    expect(() =>
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_PORT: "70000" }),
    ).toThrow(ModbusServerConfigError);
    expect(() =>
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_PORT: "nope" }),
    ).toThrow(ModbusServerConfigError);
  });

  it("refuses a non-numeric or zero connection cap", () => {
    expect(() =>
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_MAX_CONNECTIONS: "0" }),
    ).toThrow(ModbusServerConfigError);
  });

  it("refuses an out-of-range unit id", () => {
    expect(() =>
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_UNIT_ID: "256" }),
    ).toThrow(ModbusServerConfigError);
  });
});

describe("loadModbusServerConfig explicit exposure", () => {
  it("accepts a routable bind when the masters are named", () => {
    const config = loadModbusServerConfig({
      ...baseEnv,
      MODBUS_SERVER_BIND_HOST: "0.0.0.0",
      MODBUS_SERVER_ALLOWED_PEERS: "10.4.0.0/16, 10.9.9.9",
      MODBUS_SERVER_PORT: "1502",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.allowedPeers).toEqual(["10.4.0.0/16", "10.9.9.9"]);
    expect(config.port).toBe(1502);
  });
});

describe("describeModbusServerConfig", () => {
  it("makes a writable listener obvious in the boot log", () => {
    const summary = describeModbusServerConfig(
      loadModbusServerConfig({ ...baseEnv, MODBUS_SERVER_ALLOW_WRITES: "true" }),
    );
    expect(summary).toContain("writes=ENABLED");
    expect(summary).toContain("bind=127.0.0.1:502");
  });

  it("reports a read-only listener as such", () => {
    expect(describeModbusServerConfig(loadModbusServerConfig(baseEnv))).toContain(
      "writes=disabled",
    );
  });
});
