import { describe, expect, it } from "vitest";
import {
  FederatedAlarmView,
  FederatedReporting,
  FederatedSiteDiscovery,
  ReplicatedConfiguration,
} from "../federation";
import {
  FederationRuntime,
  type FederationBindings,
} from "../federation-runtime";

function bindings(): FederationBindings {
  return {
    discovery: new FederatedSiteDiscovery([], {
      verify: () => ({ accepted: false }),
    }),
    alarms: new FederatedAlarmView([]),
    reporting: new FederatedReporting([]),
    configuration: new ReplicatedConfiguration("site-a"),
    healthCheck: async () => ({
      healthy: true,
      details: { connectedSites: 0 },
    }),
  };
}

describe("multi-site federation production runtime", () => {
  it("binds federation services and exposes their health", async () => {
    const runtime = new FederationRuntime();
    runtime.configure(bindings());
    await runtime.initialize();

    expect(runtime.isInitialized()).toBe(true);
    await expect(runtime.bindings().discovery.discover()).resolves.toEqual({
      sites: [],
      rejected: [],
    });
    await expect(runtime.health()).resolves.toEqual({
      healthy: true,
      details: { connectedSites: 0 },
    });
  });

  it("fails closed when any required production service is missing", () => {
    const incomplete = bindings() as unknown as Record<string, unknown>;
    delete incomplete.reporting;
    expect(() =>
      new FederationRuntime().configure(
        incomplete as unknown as FederationBindings,
      ),
    ).toThrow(/federated reporting/);
  });

  it("surfaces federation health-check failures", async () => {
    const runtime = new FederationRuntime();
    runtime.configure({
      ...bindings(),
      healthCheck: () => {
        throw new Error("registry unavailable");
      },
    });
    await runtime.initialize();
    await expect(runtime.health()).resolves.toMatchObject({
      healthy: false,
      message: "registry unavailable",
    });
  });
});
