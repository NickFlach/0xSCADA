import { describe, expect, it } from "vitest";
import { EnvironmentEdgeTransport } from "../../gateway/store-and-forward";
import {
  FederatedAlarmView,
  FederatedReporting,
  FederatedSiteDiscovery,
  ReplicatedConfiguration,
} from "../federation";
import {
  ConsistentHashRing,
  PartitionedEventFanout,
  PartitionedHistorian,
  ServerLoadBalancer,
} from "../horizontal";
import {
  ProductionScaleRuntime,
  type ProductionScaleBindings,
} from "../runtime";
import {
  type UpgradeJournal,
  RollingCanaryOrchestrator,
  VersionCompatibilityMatrix,
} from "../upgrade";

function bindings(): ProductionScaleBindings {
  const compatibility = new VersionCompatibilityMatrix([]);
  let sequence = 0;
  const entries: Awaited<ReturnType<UpgradeJournal["entries"]>> = [];
  const journal: UpgradeJournal = {
    durable: true,
    entries: async () => structuredClone(entries),
    append: async (entry) => {
      const recorded = {
        ...entry,
        sequence: ++sequence,
        timestamp: new Date(),
      };
      (entries as Array<typeof recorded>).push(recorded);
      return structuredClone(recorded);
    },
  };
  return {
    horizontal: {
      gatewayRing: new ConsistentHashRing([{ id: "gateway-a" }]),
      loadBalancer: new ServerLoadBalancer([{ id: "api-a" }]),
      historian: new PartitionedHistorian([
        {
          id: "history-a",
          write: async () => undefined,
          query: async () => [],
        },
      ]),
      eventFanout: new PartitionedEventFanout(1),
      healthCheck: async () => ({ healthy: true }),
    },
    federation: {
      discovery: new FederatedSiteDiscovery([], {
        verify: () => ({ accepted: false }),
      }),
      alarms: new FederatedAlarmView([]),
      reporting: new FederatedReporting([]),
      configuration: new ReplicatedConfiguration("site-a"),
      healthCheck: async () => ({ healthy: true }),
    },
    upgrades: {
      orchestrator: new RollingCanaryOrchestrator(
        {
          instances: async () => [],
          drain: async () => undefined,
          deploy: async () => undefined,
          waitUntilHealthy: async () => true,
          restoreTraffic: async () => undefined,
          rollback: async () => undefined,
        },
        compatibility,
        journal,
      ),
      compatibility,
      journal,
      migrations: {},
      featureFlags: {},
      healthCheck: async () => ({ healthy: true }),
    },
    edge: {
      transport: {
        isReachable: async () => false,
        forward: async () => {
          throw new Error("offline");
        },
      },
    },
  };
}

describe("production-scale composition root", () => {
  it("binds every runtime component and exposes health", async () => {
    const runtime = new ProductionScaleRuntime();
    runtime.configure(bindings());
    await runtime.initialize();

    expect(runtime.isInitialized()).toBe(true);
    expect(runtime.bindings().horizontal.gatewayRing.owner("tag")).toBe(
      "gateway-a",
    );
    await expect(runtime.health("horizontal")).resolves.toMatchObject({
      healthy: true,
    });
    await expect(runtime.health("edge")).resolves.toMatchObject({
      healthy: false,
      degraded: false,
    });
  });

  it("refuses the environment-only edge transport when explicitly enabled", async () => {
    const runtime = new ProductionScaleRuntime();
    const configured = bindings();
    configured.edge.transport = new EnvironmentEdgeTransport();
    runtime.configure(configured);
    await expect(runtime.initialize()).rejects.toThrow(
      /cannot use EnvironmentEdgeTransport/,
    );
  });
});
