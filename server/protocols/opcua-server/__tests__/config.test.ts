/**
 * Tests for OPC-UA server configuration (#461).
 *
 * These lock in the fail-closed posture the maintainer's review demanded: no
 * wildcard/routable bind without an explicit opt-in, no anonymous access by
 * default in any environment, and no silent fallback on ambiguous input.
 */
import { describe, test, expect } from "vitest";
import {
  DEFAULT_OPCUA_ENDPOINT,
  DEFAULT_OPCUA_HOST,
  endpointUrl,
  isLoopbackHost,
  isWildcardHost,
  loadOpcuaServerConfig,
  loadOpcuaServerConfigFromEnv,
  OpcuaServerConfigError,
  parseEnvBoolean,
} from "../config";

describe("loadOpcuaServerConfig defaults", () => {
  test("is disabled, loopback-bound, encrypted and non-anonymous", () => {
    const config = loadOpcuaServerConfig();
    expect(config.enabled).toBe(false);
    expect(config.host).toBe(DEFAULT_OPCUA_HOST);
    expect(config.host).not.toBe("0.0.0.0");
    expect(config.allowRemoteBind).toBe(false);
    expect(config.port).toBe(4840);
    expect(config.resourcePath).toBe("/0xscada");
    expect(config.securityPolicy).toBe("Basic256Sha256");
    expect(config.allowAnonymous).toBe(false);
    expect(config.trustUnknownClientCertificates).toBe(false);
  });

  test("defaults env to the most restrictive value", () => {
    expect(loadOpcuaServerConfig().env).toBe("production");
  });

  test("default endpoint is loopback", () => {
    expect(endpointUrl(loadOpcuaServerConfig())).toBe(DEFAULT_OPCUA_ENDPOINT);
    expect(DEFAULT_OPCUA_ENDPOINT).toBe("opc.tcp://127.0.0.1:4840/0xscada");
  });
});

describe("bind-address rules", () => {
  test.each(["0.0.0.0", "::", "*", "10.0.0.5", "192.168.1.9"])(
    "refuses %s without allowRemoteBind",
    (host) => {
      expect(() => loadOpcuaServerConfig({ host })).toThrow(
        OpcuaServerConfigError,
      );
    },
  );

  test("accepts a routable bind when explicitly acknowledged", () => {
    const config = loadOpcuaServerConfig({
      host: "10.0.0.5",
      allowRemoteBind: true,
    });
    expect(config.host).toBe("10.0.0.5");
  });

  test("accepts the wildcard only as a deliberate act", () => {
    expect(
      loadOpcuaServerConfig({ host: "0.0.0.0", allowRemoteBind: true }).host,
    ).toBe("0.0.0.0");
  });

  test("names the opt-in flag in the refusal message", () => {
    expect(() => loadOpcuaServerConfig({ host: "0.0.0.0" })).toThrow(
      /OPCUA_SERVER_ALLOW_REMOTE_BIND/,
    );
  });

  test("ephemeral ports are loopback-only", () => {
    expect(loadOpcuaServerConfig({ port: 0 }).port).toBe(0);
    expect(() =>
      loadOpcuaServerConfig({
        port: 0,
        host: "10.0.0.5",
        allowRemoteBind: true,
      }),
    ).toThrow(OpcuaServerConfigError);
  });
});

describe("isLoopbackHost", () => {
  test.each(["127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "%s is loopback",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  test.each(["0.0.0.0", "10.0.0.1", "::", "128.0.0.1", "999.0.0.1"])(
    "%s is not loopback",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );

  test("a hostname is never treated as loopback (resolution is not ours to trust)", () => {
    expect(isLoopbackHost("localhost")).toBe(false);
  });

  test("wildcards are recognised", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });
});

describe("security rules", () => {
  test("anonymous access is refused by default in development", () => {
    expect(loadOpcuaServerConfig({ env: "development" }).allowAnonymous).toBe(
      false,
    );
  });

  test("anonymous access is available on loopback only as an explicit opt-in", () => {
    const config = loadOpcuaServerConfig({
      env: "development",
      allowAnonymous: true,
    });
    expect(config.allowAnonymous).toBe(true);
  });

  test.each(["production", "staging"] as const)(
    "anonymous access is refused outright in %s",
    (env) => {
      expect(() => loadOpcuaServerConfig({ env, allowAnonymous: true })).toThrow(
        /Anonymous access is not permitted/,
      );
    },
  );

  test("SecurityPolicy None is refused on a non-loopback bind", () => {
    expect(() =>
      loadOpcuaServerConfig({
        env: "development",
        securityPolicy: "None",
        host: "10.0.0.5",
        allowRemoteBind: true,
      }),
    ).toThrow(/only permitted on a loopback bind/);
  });

  test("anonymous + None on a non-loopback bind is refused", () => {
    expect(() =>
      loadOpcuaServerConfig({
        env: "development",
        securityPolicy: "None",
        allowAnonymous: true,
        host: "10.0.0.5",
        allowRemoteBind: true,
      }),
    ).toThrow(OpcuaServerConfigError);
  });

  test.each(["production", "staging"] as const)(
    "SecurityPolicy None is refused in %s",
    (env) => {
      expect(() => loadOpcuaServerConfig({ env, securityPolicy: "None" })).toThrow(
        /not permitted when env=/,
      );
    },
  );

  test("auto-trusting unknown client certificates is loopback-only", () => {
    expect(
      loadOpcuaServerConfig({
        trustUnknownClientCertificates: true,
        env: "test",
      }).trustUnknownClientCertificates,
    ).toBe(true);
    expect(() =>
      loadOpcuaServerConfig({
        trustUnknownClientCertificates: true,
        host: "10.0.0.5",
        allowRemoteBind: true,
      }),
    ).toThrow(/loopback bind/);
  });
});

describe("input validation", () => {
  test("coerces and range-checks the port", () => {
    expect(loadOpcuaServerConfig({ port: "5840" }).port).toBe(5840);
    expect(() => loadOpcuaServerConfig({ port: 99999 })).toThrow(
      OpcuaServerConfigError,
    );
    expect(() => loadOpcuaServerConfig({ port: -1 })).toThrow(
      OpcuaServerConfigError,
    );
  });

  test("rejects an unknown env", () => {
    expect(() => loadOpcuaServerConfig({ env: "prod" })).toThrow(
      OpcuaServerConfigError,
    );
  });

  test("rejects an unknown security policy", () => {
    expect(() =>
      loadOpcuaServerConfig({ securityPolicy: "Basic128Rsa15" }),
    ).toThrow(OpcuaServerConfigError);
  });

  test("rejects unknown keys so a typo cannot silently default to permissive", () => {
    expect(() =>
      loadOpcuaServerConfig({ allowAnonymus: true, env: "development" }),
    ).toThrow(OpcuaServerConfigError);
  });

  test("enforces minimum sampling interval", () => {
    expect(() => loadOpcuaServerConfig({ minSamplingIntervalMs: 1 })).toThrow(
      OpcuaServerConfigError,
    );
    expect(
      loadOpcuaServerConfig({ minSamplingIntervalMs: 250 })
        .minSamplingIntervalMs,
    ).toBe(250);
  });

  test("endpointUrl normalises a path missing a leading slash", () => {
    const config = loadOpcuaServerConfig({
      resourcePath: "uaserver",
      port: 4841,
    });
    expect(endpointUrl(config)).toBe("opc.tcp://127.0.0.1:4841/uaserver");
  });
});

describe("parseEnvBoolean", () => {
  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
  ] as const)("parses %s", (raw, expected) => {
    expect(parseEnvBoolean("FLAG", raw, !expected)).toBe(expected);
  });

  test("falls back when unset or blank", () => {
    expect(parseEnvBoolean("FLAG", undefined, false)).toBe(false);
    expect(parseEnvBoolean("FLAG", "  ", true)).toBe(true);
  });

  test("throws on an ambiguous value rather than guessing", () => {
    expect(() => parseEnvBoolean("FLAG", "maybe", false)).toThrow(
      OpcuaServerConfigError,
    );
    // A non-empty string must never be read as truthy.
    expect(() => parseEnvBoolean("FLAG", "enabled", false)).toThrow(
      OpcuaServerConfigError,
    );
  });
});

describe("loadOpcuaServerConfigFromEnv", () => {
  test("an empty environment yields the disabled, closed defaults", () => {
    const config = loadOpcuaServerConfigFromEnv({});
    expect(config.enabled).toBe(false);
    expect(config.host).toBe(DEFAULT_OPCUA_HOST);
    expect(config.allowAnonymous).toBe(false);
    expect(config.securityPolicy).toBe("Basic256Sha256");
    expect(config.env).toBe("production");
  });

  test("a development NODE_ENV still refuses anonymous access", () => {
    const config = loadOpcuaServerConfigFromEnv({
      NODE_ENV: "development",
      OPCUA_SERVER_ENABLED: "true",
    });
    expect(config.enabled).toBe(true);
    expect(config.env).toBe("development");
    expect(config.allowAnonymous).toBe(false);
    expect(config.host).toBe(DEFAULT_OPCUA_HOST);
  });

  test("an unrecognised NODE_ENV falls back to the hardened default", () => {
    expect(loadOpcuaServerConfigFromEnv({ NODE_ENV: "qa" }).env).toBe(
      "production",
    );
  });

  test("OPCUA_SERVER_ENABLED is the single enable flag", () => {
    expect(
      loadOpcuaServerConfigFromEnv({ OPCUA_SERVER_ENABLED: "true" }).enabled,
    ).toBe(true);
    expect(loadOpcuaServerConfigFromEnv({}).enabled).toBe(false);
  });

  test("a routable OPCUA_SERVER_HOST needs OPCUA_SERVER_ALLOW_REMOTE_BIND", () => {
    expect(() =>
      loadOpcuaServerConfigFromEnv({
        OPCUA_SERVER_ENABLED: "true",
        OPCUA_SERVER_HOST: "0.0.0.0",
      }),
    ).toThrow(OpcuaServerConfigError);

    const config = loadOpcuaServerConfigFromEnv({
      OPCUA_SERVER_ENABLED: "true",
      OPCUA_SERVER_HOST: "0.0.0.0",
      OPCUA_SERVER_ALLOW_REMOTE_BIND: "true",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.securityPolicy).toBe("Basic256Sha256");
    expect(config.allowAnonymous).toBe(false);
  });

  test("an ambiguous boolean fails the boot", () => {
    expect(() =>
      loadOpcuaServerConfigFromEnv({ OPCUA_SERVER_ALLOW_ANONYMOUS: "sure" }),
    ).toThrow(OpcuaServerConfigError);
  });
});
