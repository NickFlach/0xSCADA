/**
 * Deployment-configuration tests (#464).
 *
 * The listener is the dangerous part of this feature, so its configuration must
 * fail closed in every direction: off unless explicitly armed, loopback unless
 * explicitly moved, no routable bind without an allowlist, no wildcard
 * allowlist, and no plant-output controls without either SAv5 or a written-down
 * acceptance that there is no authentication at all.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Dnp3OutstationConfigError,
  describeDnp3OutstationConfig,
  isDnp3OutstationEnabled,
  loadDnp3OutstationConfig,
  loadDnp3PointMapFile,
} from "../config";
import { DNP3_MAX_LINK_FRAME_BYTES } from "../server";

const KEY = "00112233445566778899aabbccddeeff"; // 16 octets

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DNP3_OUTSTATION_ENABLED: "true",
    DNP3_OUTSTATION_SITE_ID: "site-1",
    DNP3_OUTSTATION_POINT_MAP_FILE: "/etc/0xscada/dnp3-points.json",
    ...extra,
  };
}

describe("isDnp3OutstationEnabled", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(isDnp3OutstationEnabled({})).toBe(false);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: "" })).toBe(false);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: "1" })).toBe(false);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: "TRUE" })).toBe(false);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: "yes" })).toBe(false);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: " true " })).toBe(true);
    expect(isDnp3OutstationEnabled({ DNP3_OUTSTATION_ENABLED: "true" })).toBe(true);
  });
});

describe("loadDnp3OutstationConfig", () => {
  it("defaults to a loopback, read-only listener on port 20000", () => {
    const config = loadDnp3OutstationConfig(baseEnv());
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(20000);
    expect(config.allowedPeers).toEqual(["127.0.0.0/8", "::1/128"]);
    expect(config.allowControls).toBe(false);
    expect(config.allowUnauthenticatedControls).toBe(false);
    expect(config.unsolicitedEnabled).toBe(false);
    expect(config.maxConnections).toBe(2);
    expect(config.socketTimeoutMs).toBe(60_000);
    expect(config.localAddress).toBe(10);
    expect(config.sav5UpdateKeyHex).toBeUndefined();
  });

  it("requires a site id and a point map file", () => {
    expect(() =>
      loadDnp3OutstationConfig({
        DNP3_OUTSTATION_ENABLED: "true",
        DNP3_OUTSTATION_POINT_MAP_FILE: "/x.json",
      }),
    ).toThrow(Dnp3OutstationConfigError);
    expect(() =>
      loadDnp3OutstationConfig({
        DNP3_OUTSTATION_ENABLED: "true",
        DNP3_OUTSTATION_SITE_ID: "site-1",
      }),
    ).toThrow(/pointMapFile/);
  });

  it("refuses a non-loopback bind with no peer allowlist", () => {
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_BIND_HOST: "0.0.0.0" })),
    ).toThrow(/DNP3_OUTSTATION_ALLOWED_PEERS must list the DNP3 masters/);
  });

  it("accepts a non-loopback bind once masters are named", () => {
    const config = loadDnp3OutstationConfig(
      baseEnv({
        DNP3_OUTSTATION_BIND_HOST: "10.4.0.9",
        DNP3_OUTSTATION_ALLOWED_PEERS: "10.4.1.0/24, 10.4.2.7",
      }),
    );
    expect(config.host).toBe("10.4.0.9");
    expect(config.allowedPeers).toEqual(["10.4.1.0/24", "10.4.2.7"]);
  });

  it("refuses a wildcard allowlist", () => {
    expect(() =>
      loadDnp3OutstationConfig(
        baseEnv({
          DNP3_OUTSTATION_BIND_HOST: "10.4.0.9",
          DNP3_OUTSTATION_ALLOWED_PEERS: "0.0.0.0/0",
        }),
      ),
    ).toThrow(/allows every peer/);
  });

  it("refuses an unparseable allowlist entry", () => {
    expect(() =>
      loadDnp3OutstationConfig(
        baseEnv({
          DNP3_OUTSTATION_BIND_HOST: "10.4.0.9",
          DNP3_OUTSTATION_ALLOWED_PEERS: "10.4.1.0/24,not-an-address",
        }),
      ),
    ).toThrow(Dnp3OutstationConfigError);
  });

  it("refuses controls with no SAv5 key unless that is explicitly accepted", () => {
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_ALLOW_CONTROLS: "true" })),
    ).toThrow(/no\s+cryptographic authentication/);

    const accepted = loadDnp3OutstationConfig(
      baseEnv({
        DNP3_OUTSTATION_ALLOW_CONTROLS: "true",
        DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS: "true",
      }),
    );
    expect(accepted.allowControls).toBe(true);
    expect(accepted.sav5UpdateKeyHex).toBeUndefined();

    const keyed = loadDnp3OutstationConfig(
      baseEnv({
        DNP3_OUTSTATION_ALLOW_CONTROLS: "true",
        DNP3_OUTSTATION_SAV5_UPDATE_KEY: KEY,
        DNP3_OUTSTATION_SAV5_USER: "7",
      }),
    );
    expect(keyed.sav5UpdateKeyHex).toBe(KEY);
    expect(keyed.sav5UserNumber).toBe(7);
  });

  it("refuses an SAv5 key that is not usable key material", () => {
    for (const bad of ["zz112233445566778899aabbccddeeff", "00112233", "0011223"]) {
      expect(() =>
        loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_SAV5_UPDATE_KEY: bad })),
        `key ${bad}`,
      ).toThrow(Dnp3OutstationConfigError);
    }
  });

  it("refuses a receive-buffer bound that cannot hold one link frame", () => {
    expect(() =>
      loadDnp3OutstationConfig(
        baseEnv({
          DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES: String(DNP3_MAX_LINK_FRAME_BYTES - 1),
        }),
      ),
    ).toThrow(Dnp3OutstationConfigError);
    expect(
      loadDnp3OutstationConfig(
        baseEnv({
          DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES: String(DNP3_MAX_LINK_FRAME_BYTES),
        }),
      ).maxRxBufferBytes,
    ).toBe(DNP3_MAX_LINK_FRAME_BYTES);
  });

  it("defaults and validates the transmit-queue bound", () => {
    expect(loadDnp3OutstationConfig(baseEnv()).maxTxQueueBytes).toBe(1_048_576);
    expect(
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES: "65536" }))
        .maxTxQueueBytes,
    ).toBe(65_536);
    // Too small to hold even a handful of maximum-size fragments, and absurdly
    // large, are both refused rather than clamped.
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES: "1024" })),
    ).toThrow(Dnp3OutstationConfigError);
    expect(() =>
      loadDnp3OutstationConfig(
        baseEnv({ DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES: "134217728" }),
      ),
    ).toThrow(Dnp3OutstationConfigError);
  });

  it("refuses out-of-range numeric settings rather than clamping them", () => {
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_PORT: "70000" })),
    ).toThrow(Dnp3OutstationConfigError);
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_MAX_CONNECTIONS: "0" })),
    ).toThrow(Dnp3OutstationConfigError);
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_POLL_INTERVAL_MS: "10" })),
    ).toThrow(Dnp3OutstationConfigError);
    expect(() =>
      loadDnp3OutstationConfig(baseEnv({ DNP3_OUTSTATION_LINK_ADDRESS: "abc" })),
    ).toThrow(Dnp3OutstationConfigError);
  });

  it("treats blank values as unset, so an .env template still boots", () => {
    const config = loadDnp3OutstationConfig(
      baseEnv({
        DNP3_OUTSTATION_BIND_HOST: "   ",
        DNP3_OUTSTATION_PORT: "",
        DNP3_OUTSTATION_ALLOWED_PEERS: " , ",
        DNP3_OUTSTATION_SAV5_UPDATE_KEY: "",
      }),
    );
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(20000);
    expect(config.allowedPeers).toEqual(["127.0.0.0/8", "::1/128"]);
  });
});

describe("describeDnp3OutstationConfig", () => {
  it("summarises the posture without leaking key material", () => {
    const config = loadDnp3OutstationConfig(
      baseEnv({
        DNP3_OUTSTATION_ALLOW_CONTROLS: "true",
        DNP3_OUTSTATION_SAV5_UPDATE_KEY: KEY,
      }),
    );
    const summary = describeDnp3OutstationConfig(config);
    expect(summary).toContain("controls=ENABLED");
    expect(summary).toContain("sav5=user 1");
    expect(summary).toContain("bind=127.0.0.1:20000");
    expect(summary).not.toContain(KEY);
  });
});

describe("loadDnp3PointMapFile", () => {
  const goodMap = {
    points: [
      { tagId: "pump.run", type: "binaryInput", index: 0, eventClass: 1 },
      { tagId: "valve.cmd", type: "binaryOutput", index: 0, writable: true },
    ],
  };

  it("parses a valid map, preserving the writable opt-in", () => {
    const parsed = loadDnp3PointMapFile("map.json", () => JSON.stringify(goodMap));
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[1].writable).toBe(true);
    expect(parsed.points[0].writable).toBeUndefined();
  });

  it("reads a real file from disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dnp3-pointmap-"));
    const file = path.join(dir, "points.json");
    writeFileSync(file, JSON.stringify(goodMap), "utf8");
    expect(loadDnp3PointMapFile(file).points).toHaveLength(2);
  });

  it("names the file when it cannot be read", () => {
    const missing = path.join(tmpdir(), "definitely-not-here-dnp3.json");
    expect(() => loadDnp3PointMapFile(missing)).toThrow(Dnp3OutstationConfigError);
    expect(() => loadDnp3PointMapFile(missing)).toThrow(new RegExp(escape(missing)));
  });

  it("rejects invalid JSON", () => {
    expect(() => loadDnp3PointMapFile("map.json", () => "{ nope")).toThrow(
      /not valid JSON/,
    );
  });

  it("rejects a map that does not match the point schema", () => {
    expect(() =>
      loadDnp3PointMapFile("map.json", () => JSON.stringify({ points: [{ tagId: "x" }] })),
    ).toThrow(/not a valid point map/);
    expect(() => loadDnp3PointMapFile("map.json", () => JSON.stringify([]))).toThrow(
      /not a valid point map/,
    );
  });

  it("rejects a duplicated (type,index) pair", () => {
    expect(() =>
      loadDnp3PointMapFile("map.json", () =>
        JSON.stringify({
          points: [
            { tagId: "a", type: "binaryInput", index: 0 },
            { tagId: "b", type: "binaryInput", index: 0 },
          ],
        }),
      ),
    ).toThrow(/maps binaryInput:0 more than once/);
  });
});

/** Escape a path for use inside a RegExp. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
