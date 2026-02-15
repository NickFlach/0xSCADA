/**
 * Adapter Certification Suite
 *
 * Validates that vendor adapters comply with the 0xSCADA adapter specification.
 * Run this against any adapter before deployment to ensure compatibility.
 */

import type {
  BaseAdapter,
  ProtocolAdapter,
  DeviceAdapter,
  FeatureAdapter,
  CertificationResult,
  CertificationTestResult,
  AdapterContext,
  AdapterLogger,
  PlatformServices,
  AdapterStorage,
} from "../../shared/types/vendor-adapter";

// =============================================================================
// CERTIFICATION RUNNER
// =============================================================================

export class AdapterCertification {
  /**
   * Run full certification suite on an adapter.
   */
  static async certify(adapter: BaseAdapter): Promise<CertificationResult> {
    const results: CertificationTestResult[] = [];
    const startTime = Date.now();

    // Base adapter tests
    results.push(...(await this.runBaseTests(adapter)));

    // Type-specific tests
    switch (adapter.manifest.type) {
      case "protocol":
        results.push(...(await this.runProtocolTests(adapter as ProtocolAdapter)));
        break;
      case "device":
        results.push(...(await this.runDeviceTests(adapter as DeviceAdapter)));
        break;
      case "feature":
        results.push(...(await this.runFeatureTests(adapter as FeatureAdapter)));
        break;
    }

    const passed = results.filter((r) => r.passed).length;
    return {
      adapterId: adapter.manifest.id,
      passed: results.every((r) => r.passed),
      timestamp: new Date(),
      totalTests: results.length,
      passedTests: passed,
      failedTests: results.length - passed,
      results,
    };
  }

  // ===========================================================================
  // BASE TESTS
  // ===========================================================================

  private static async runBaseTests(adapter: BaseAdapter): Promise<CertificationTestResult[]> {
    const results: CertificationTestResult[] = [];

    // Test: manifest.id exists
    results.push(this.test("base-manifest-id", "Manifest has valid ID", () => {
      if (!adapter.manifest.id || typeof adapter.manifest.id !== "string") {
        throw new Error("Manifest ID must be a non-empty string");
      }
    }));

    // Test: manifest.name exists
    results.push(this.test("base-manifest-name", "Manifest has name", () => {
      if (!adapter.manifest.name) throw new Error("Missing manifest name");
    }));

    // Test: manifest.vendor exists
    results.push(this.test("base-manifest-vendor", "Manifest has vendor", () => {
      if (!adapter.manifest.vendor) throw new Error("Missing manifest vendor");
    }));

    // Test: manifest.version is valid semver-like
    results.push(this.test("base-manifest-version", "Manifest has version", () => {
      if (!adapter.manifest.version) throw new Error("Missing manifest version");
      if (!/^\d+\.\d+\.\d+/.test(adapter.manifest.version)) {
        throw new Error(`Version "${adapter.manifest.version}" doesn't look like semver`);
      }
    }));

    // Test: manifest.type is valid
    results.push(this.test("base-manifest-type", "Manifest has valid type", () => {
      if (!["protocol", "device", "feature"].includes(adapter.manifest.type)) {
        throw new Error(`Invalid type: ${adapter.manifest.type}`);
      }
    }));

    // Test: capabilities array exists
    results.push(this.test("base-capabilities", "Has capabilities array", () => {
      if (!Array.isArray(adapter.manifest.capabilities)) {
        throw new Error("Capabilities must be an array");
      }
    }));

    // Test: hasCapability works
    results.push(this.test("base-has-capability", "hasCapability() works", () => {
      const result = adapter.hasCapability("nonexistent-capability-xyz");
      if (result !== false) {
        throw new Error("hasCapability should return false for unknown capabilities");
      }
      if (adapter.manifest.capabilities.length > 0) {
        const first = adapter.manifest.capabilities[0];
        if (!adapter.hasCapability(first.id)) {
          throw new Error(`hasCapability should return true for declared capability "${first.id}"`);
        }
      }
    }));

    // Test: initialize works
    results.push(await this.asyncTest("base-initialize", "initialize() succeeds", async () => {
      const ctx = createTestContext();
      await adapter.initialize(ctx);
    }));

    // Test: state is ready after init
    results.push(this.test("base-state-after-init", "State is 'ready' after initialize", () => {
      if (adapter.state !== "ready") {
        throw new Error(`Expected state 'ready', got '${adapter.state}'`);
      }
    }));

    // Test: healthCheck works
    results.push(await this.asyncTest("base-health-check", "healthCheck() returns valid status", async () => {
      const status = await adapter.healthCheck();
      if (!status.adapterId) throw new Error("Health status missing adapterId");
      if (typeof status.healthy !== "boolean") throw new Error("Health status missing 'healthy'");
    }));

    // Test: dispose works
    results.push(await this.asyncTest("base-dispose", "dispose() succeeds", async () => {
      await adapter.dispose();
    }));

    // Test: state after dispose
    results.push(this.test("base-state-after-dispose", "State is 'disposed' after dispose", () => {
      if (adapter.state !== "disposed") {
        throw new Error(`Expected state 'disposed', got '${adapter.state}'`);
      }
    }));

    return results;
  }

  // ===========================================================================
  // PROTOCOL TESTS
  // ===========================================================================

  private static async runProtocolTests(adapter: ProtocolAdapter): Promise<CertificationTestResult[]> {
    const results: CertificationTestResult[] = [];

    results.push(this.test("protocol-protocols-array", "Has protocols array", () => {
      if (!Array.isArray(adapter.protocols) || adapter.protocols.length === 0) {
        throw new Error("Protocol adapter must declare supported protocols");
      }
    }));

    results.push(this.test("protocol-connect-method", "Has connect() method", () => {
      if (typeof adapter.connect !== "function") {
        throw new Error("Protocol adapter must have connect()");
      }
    }));

    return results;
  }

  // ===========================================================================
  // DEVICE TESTS
  // ===========================================================================

  private static async runDeviceTests(adapter: DeviceAdapter): Promise<CertificationTestResult[]> {
    const results: CertificationTestResult[] = [];

    results.push(this.test("device-families-array", "Has deviceFamilies array", () => {
      if (!Array.isArray(adapter.deviceFamilies) || adapter.deviceFamilies.length === 0) {
        throw new Error("Device adapter must declare supported device families");
      }
    }));

    results.push(this.test("device-supports-method", "Has supportsDevice() method", () => {
      if (typeof adapter.supportsDevice !== "function") {
        throw new Error("Device adapter must have supportsDevice()");
      }
    }));

    return results;
  }

  // ===========================================================================
  // FEATURE TESTS
  // ===========================================================================

  private static async runFeatureTests(adapter: FeatureAdapter): Promise<CertificationTestResult[]> {
    const results: CertificationTestResult[] = [];

    results.push(this.test("feature-api-method", "Has getFeatureAPI() method", () => {
      if (typeof adapter.getFeatureAPI !== "function") {
        throw new Error("Feature adapter must have getFeatureAPI()");
      }
    }));

    return results;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private static test(
    testId: string,
    name: string,
    fn: () => void
  ): CertificationTestResult {
    const start = Date.now();
    try {
      fn();
      return { testId, name, passed: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        testId,
        name,
        passed: false,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  private static async asyncTest(
    testId: string,
    name: string,
    fn: () => Promise<void>
  ): Promise<CertificationTestResult> {
    const start = Date.now();
    try {
      await fn();
      return { testId, name, passed: true, durationMs: Date.now() - start };
    } catch (err) {
      return {
        testId,
        name,
        passed: false,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
}

// =============================================================================
// TEST CONTEXT FACTORY
// =============================================================================

function createTestContext(): AdapterContext {
  const store = new Map<string, unknown>();
  const storage: AdapterStorage = {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => Array.from(store.keys()),
  };

  const logger: AdapterLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const platform: PlatformServices = {
    getAdapter: () => undefined,
    getAdaptersByType: () => [],
    getStorage: () => storage,
  };

  return { log: logger, config: {}, emit: () => {}, platform };
}

export { createTestContext };
