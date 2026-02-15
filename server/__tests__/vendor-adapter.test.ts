/**
 * Vendor Adapter System Tests
 *
 * Tests for adapter registry, manager, certification, and reference adapters.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AdapterRegistry,
  getAdapterRegistry,
  resetAdapterRegistry,
} from "../adapters/adapter-registry";
import {
  AdapterManager,
  getAdapterManager,
  resetAdapterManager,
} from "../adapters/adapter-manager";
import { SiemensS7Adapter } from "../adapters/vendors/siemens-s7";
import { RockwellCIPAdapter } from "../adapters/vendors/rockwell-cip";
import { GenericModbusAdapter } from "../adapters/vendors/generic-modbus";
import { AdapterCertification } from "../adapters/adapter-certification";
import type { BaseAdapter, AdapterManifest, AdapterState, AdapterContext, AdapterHealthStatus } from "../../shared/types/vendor-adapter";

// =============================================================================
// HELPERS
// =============================================================================

class MinimalTestAdapter implements BaseAdapter {
  readonly manifest: AdapterManifest = {
    id: "test-adapter",
    name: "Test Adapter",
    vendor: "Test",
    version: "1.0.0",
    type: "feature",
    capabilities: [
      { id: "test-cap", name: "Test", category: "custom", required: true },
    ],
  };

  private _state: AdapterState = "registered";
  get state() { return this._state; }

  async initialize(ctx: AdapterContext) { this._state = "ready"; }
  hasCapability(id: string) { return this.manifest.capabilities.some(c => c.id === id); }
  async healthCheck(): Promise<AdapterHealthStatus> {
    return {
      adapterId: this.manifest.id, state: this._state,
      healthy: true, lastHealthCheck: new Date(), uptime: 1000, errorCount: 0,
    };
  }
  async dispose() { this._state = "disposed"; }
}

// =============================================================================
// REGISTRY TESTS
// =============================================================================

describe("AdapterRegistry", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    resetAdapterRegistry();
    registry = getAdapterRegistry();
  });

  it("registers and retrieves adapters", () => {
    const adapter = new MinimalTestAdapter();
    registry.register(adapter);
    expect(registry.has("test-adapter")).toBe(true);
    expect(registry.get("test-adapter")).toBe(adapter);
    expect(registry.size).toBe(1);
  });

  it("rejects duplicate registration", () => {
    registry.register(new MinimalTestAdapter());
    expect(() => registry.register(new MinimalTestAdapter())).toThrow(/already registered/);
  });

  it("unregisters adapters", () => {
    registry.register(new MinimalTestAdapter());
    expect(registry.unregister("test-adapter")).toBe(true);
    expect(registry.has("test-adapter")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("filters by type", () => {
    registry.register(new MinimalTestAdapter());
    registry.register(new GenericModbusAdapter());
    expect(registry.getAll("protocol").length).toBe(1);
    expect(registry.getAll("feature").length).toBe(1);
    expect(registry.getAll().length).toBe(2);
  });

  it("finds by capability", () => {
    registry.register(new SiemensS7Adapter());
    registry.register(new RockwellCIPAdapter());
    registry.register(new MinimalTestAdapter());

    const withDiscovery = registry.findByCapability("device-discovery");
    expect(withDiscovery.length).toBe(2);

    const withTestCap = registry.findByCapability("test-cap");
    expect(withTestCap.length).toBe(1);
  });

  it("lists manifests", () => {
    registry.register(new SiemensS7Adapter());
    const manifests = registry.listManifests();
    expect(manifests.length).toBe(1);
    expect(manifests[0].id).toBe("siemens-s7");
  });

  it("provides type-safe getters", () => {
    registry.register(new GenericModbusAdapter());
    expect(registry.getProtocol("generic-modbus")).toBeDefined();
    expect(registry.getDevice("generic-modbus")).toBeUndefined();
  });
});

// =============================================================================
// MANAGER TESTS
// =============================================================================

describe("AdapterManager", () => {
  let manager: AdapterManager;

  beforeEach(() => {
    resetAdapterRegistry();
    resetAdapterManager();
    manager = new AdapterManager({ autoInitialize: true });
  });

  afterEach(async () => {
    await manager.stop();
  });

  it("registers and initializes adapters", async () => {
    const adapter = new SiemensS7Adapter();
    await manager.registerAdapter(adapter);
    expect(adapter.state).toBe("ready");
  });

  it("runs health checks", async () => {
    await manager.registerAdapter(new SiemensS7Adapter());
    await manager.registerAdapter(new RockwellCIPAdapter());
    const statuses = await manager.runHealthChecks();
    expect(statuses.size).toBe(2);
    for (const status of statuses.values()) {
      expect(status.healthy).toBe(true);
    }
  });

  it("hot-reloads adapters", async () => {
    const adapter1 = new GenericModbusAdapter();
    await manager.registerAdapter(adapter1);
    expect(adapter1.state).toBe("ready");

    const adapter2 = new GenericModbusAdapter();
    await manager.reloadAdapter(adapter2);
    expect(adapter1.state).toBe("disposed");
    expect(adapter2.state).toBe("ready");
  });

  it("disposes all on stop", async () => {
    const s7 = new SiemensS7Adapter();
    const cip = new RockwellCIPAdapter();
    await manager.registerAdapter(s7);
    await manager.registerAdapter(cip);
    await manager.stop();
    expect(s7.state).toBe("disposed");
    expect(cip.state).toBe("disposed");
  });
});

// =============================================================================
// REFERENCE ADAPTER TESTS
// =============================================================================

describe("SiemensS7Adapter", () => {
  it("connects and reads tags", async () => {
    const adapter = new SiemensS7Adapter();
    await adapter.initialize({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      emit: () => {},
      platform: { getAdapter: () => undefined, getAdaptersByType: () => [], getStorage: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] }) },
    });

    const conn = await adapter.connect({ address: "192.168.1.10" });
    expect(conn.connected).toBe(true);

    const result = await conn.read("DB1.DBD0");
    expect(result.quality).toBe("GOOD");
    expect(typeof result.value).toBe("number");

    await conn.disconnect();
    expect(conn.connected).toBe(false);
    await adapter.dispose();
  });

  it("discovers devices", async () => {
    const adapter = new SiemensS7Adapter();
    const devices = await adapter.discover!();
    expect(devices.length).toBeGreaterThan(0);
    expect(devices[0].vendor).toBe("Siemens");
  });

  it("provides diagnostics", async () => {
    const adapter = new SiemensS7Adapter();
    const diag = await adapter.getDiagnostics!("test");
    expect(diag.status).toBe("ok");
    expect(diag.vendorSpecific?.cpuState).toBe("RUN");
  });
});

describe("RockwellCIPAdapter", () => {
  it("connects and reads CIP tags", async () => {
    const adapter = new RockwellCIPAdapter();
    await adapter.initialize({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      emit: () => {},
      platform: { getAdapter: () => undefined, getAdaptersByType: () => [], getStorage: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] }) },
    });

    const conn = await adapter.connect({ address: "192.168.1.100" });
    const result = await conn.read("Program:MainProgram.Temperature");
    expect(result.quality).toBe("GOOD");

    await conn.disconnect();
    await adapter.dispose();
  });

  it("supports correct device families", () => {
    const adapter = new RockwellCIPAdapter();
    expect(adapter.supportsDevice({
      address: "10.0.0.1",
      vendor: "Rockwell Automation",
      protocols: ["cip"],
    })).toBe(true);
    expect(adapter.supportsDevice({
      address: "10.0.0.2",
      vendor: "Siemens",
      protocols: ["s7"],
    })).toBe(false);
  });
});

describe("GenericModbusAdapter", () => {
  it("wraps modbus as adapter", async () => {
    const adapter = new GenericModbusAdapter();
    await adapter.initialize({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      config: {},
      emit: () => {},
      platform: { getAdapter: () => undefined, getAdaptersByType: () => [], getStorage: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => [] }) },
    });

    expect(adapter.protocols).toContain("modbus-tcp");
    const conn = await adapter.connect({ address: "192.168.1.50:502" });
    const batch = await conn.readBatch(["HR:100", "HR:101", "C:0"]);
    expect(batch.length).toBe(3);

    await conn.disconnect();
    await adapter.dispose();
  });
});

// =============================================================================
// CERTIFICATION TESTS
// =============================================================================

describe("AdapterCertification", () => {
  it("certifies SiemensS7Adapter", async () => {
    const result = await AdapterCertification.certify(new SiemensS7Adapter());
    expect(result.passed).toBe(true);
    expect(result.failedTests).toBe(0);
  });

  it("certifies RockwellCIPAdapter", async () => {
    const result = await AdapterCertification.certify(new RockwellCIPAdapter());
    expect(result.passed).toBe(true);
    expect(result.failedTests).toBe(0);
  });

  it("certifies GenericModbusAdapter", async () => {
    const result = await AdapterCertification.certify(new GenericModbusAdapter());
    expect(result.passed).toBe(true);
    expect(result.failedTests).toBe(0);
  });
});
