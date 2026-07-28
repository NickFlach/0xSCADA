import { describe, expect, it } from "vitest";
import {
  ConsistentHashRing,
  PartitionedEventFanout,
  PartitionedHistorian,
  ServerLoadBalancer,
} from "../horizontal";
import {
  HorizontalScaleRuntime,
  type HorizontalScaleBindings,
} from "../horizontal-runtime";

function bindings(): HorizontalScaleBindings {
  return {
    gatewayRing: new ConsistentHashRing([{ id: "gateway-a" }]),
    loadBalancer: new ServerLoadBalancer([{ id: "api-a" }]),
    historian: new PartitionedHistorian([
      {
        id: "history-a",
        write: async () => undefined,
        query: async () => [],
      },
    ]),
    eventFanout: new PartitionedEventFanout(2),
    healthCheck: async () => ({
      healthy: true,
      details: { generation: 4 },
    }),
  };
}

describe("horizontal scaling production runtime", () => {
  it("binds production adapters and exposes their health", async () => {
    const runtime = new HorizontalScaleRuntime();
    runtime.configure(bindings());
    await runtime.initialize();

    expect(runtime.isInitialized()).toBe(true);
    expect(runtime.bindings().gatewayRing.owner("site/tag")).toBe("gateway-a");
    await expect(runtime.health()).resolves.toEqual({
      healthy: true,
      details: { generation: 4 },
    });
  });

  it("fails closed when any required production adapter is missing", () => {
    const incomplete = bindings() as unknown as Record<string, unknown>;
    delete incomplete.historian;
    expect(() =>
      new HorizontalScaleRuntime().configure(
        incomplete as unknown as HorizontalScaleBindings,
      ),
    ).toThrow(/partitioned historian/);
  });

  it("turns binding health exceptions into unhealthy status", async () => {
    const runtime = new HorizontalScaleRuntime();
    runtime.configure({
      ...bindings(),
      healthCheck: () => {
        throw new Error("message bus unavailable");
      },
    });
    await runtime.initialize();
    await expect(runtime.health()).resolves.toMatchObject({
      healthy: false,
      message: "message bus unavailable",
    });
  });
});
