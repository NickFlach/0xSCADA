import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentEdgeTransport,
  MemoryEdgeQueue,
  StoreAndForwardService,
  type EdgeUpstreamTransport,
} from "../store-and-forward";
import {
  EdgeStoreAndForwardRuntime,
  type EdgeStoreAndForwardBindings,
} from "../store-and-forward-runtime";

function transport(): EdgeUpstreamTransport {
  return {
    isReachable: async () => false,
    forward: async () => {
      throw new Error("offline");
    },
  };
}

describe("edge store-and-forward production runtime", () => {
  it("installs a real transport before the shared service starts", async () => {
    const configure = vi.fn(
      (
        config: ConstructorParameters<typeof StoreAndForwardService>[0],
        dependencies: ConstructorParameters<typeof StoreAndForwardService>[1],
      ) => new StoreAndForwardService(config, dependencies),
    );
    const runtime = new EdgeStoreAndForwardRuntime(configure);
    const upstream = transport();
    runtime.configure({
      config: { storagePath: "unused-in-composition-test.json" },
      transport: upstream,
      dependencies: { queue: new MemoryEdgeQueue() },
    });

    await runtime.initialize();

    expect(runtime.isInitialized()).toBe(true);
    expect(runtime.bindings().transport).toBe(upstream);
    expect(configure).toHaveBeenCalledOnce();
    expect(configure.mock.calls[0]?.[1]).toMatchObject({
      transport: upstream,
    });
  });

  it("fails closed when the upstream transport contract is incomplete", () => {
    const incomplete = {
      transport: { isReachable: async () => true },
    } as unknown as EdgeStoreAndForwardBindings;
    expect(() => new EdgeStoreAndForwardRuntime().configure(incomplete)).toThrow(
      /upstream transport/,
    );
  });

  it("refuses the environment-only simulation transport in production", async () => {
    const runtime = new EdgeStoreAndForwardRuntime();
    runtime.configure({ transport: new EnvironmentEdgeTransport() });
    await expect(runtime.initialize()).rejects.toThrow(
      /cannot use EnvironmentEdgeTransport/,
    );
  });
});
