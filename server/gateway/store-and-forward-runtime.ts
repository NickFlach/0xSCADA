import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EnvironmentEdgeTransport,
  JsonFileEdgeQueue,
  configureStoreAndForwardService,
  type EdgeUpstreamTransport,
  type LocalEdgeProcessor,
  type StoreAndForwardConfig,
  type StoreAndForwardDependencies,
  type StoreAndForwardService,
} from "./store-and-forward";

export interface EdgeStoreAndForwardBindings {
  config?: Partial<StoreAndForwardConfig>;
  transport: EdgeUpstreamTransport;
  localProcessors?: readonly LocalEdgeProcessor[];
  dependencies?: Omit<
    StoreAndForwardDependencies,
    "transport" | "localProcessors"
  >;
}

export interface EdgeStoreAndForwardFactories {
  JsonFileEdgeQueue: typeof JsonFileEdgeQueue;
}

interface BindingsModule {
  default?: EdgeStoreAndForwardBindings;
  edgeStoreAndForwardBindings?: EdgeStoreAndForwardBindings;
  createEdgeStoreAndForwardBindings?: (
    factories: EdgeStoreAndForwardFactories,
  ) =>
    | EdgeStoreAndForwardBindings
    | Promise<EdgeStoreAndForwardBindings>;
}

type StoreAndForwardConfigurator = (
  config: Partial<StoreAndForwardConfig>,
  dependencies: StoreAndForwardDependencies,
) => StoreAndForwardService;

export const edgeStoreAndForwardFactories: EdgeStoreAndForwardFactories = {
  JsonFileEdgeQueue,
};

/**
 * Production composition root for the durable edge queue.
 *
 * The queue remains available with its local durable defaults, but explicitly
 * enabling production synchronization requires a deployment module that
 * supplies a real upstream transport. Startup fails closed if that binding is
 * absent or still uses the environment-only simulation transport.
 */
export class EdgeStoreAndForwardRuntime {
  private configured?: EdgeStoreAndForwardBindings;
  private initialized = false;
  private enabledByConfiguration = false;

  constructor(
    private readonly configureService: StoreAndForwardConfigurator =
      configureStoreAndForwardService,
  ) {}

  configure(bindings: EdgeStoreAndForwardBindings): void {
    if (this.initialized) {
      throw new Error("edge store-and-forward runtime is already initialized");
    }
    validateBindings(bindings);
    this.configured = bindings;
    this.enabledByConfiguration = true;
  }

  isEnabled(): boolean {
    return (
      this.enabledByConfiguration ||
      process.env.EDGE_STORE_FORWARD_ENABLED === "true"
    );
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized || !this.isEnabled()) return;
    const bindings = this.configured ?? (await this.loadBindingsModule());
    validateBindings(bindings);
    if (bindings.transport instanceof EnvironmentEdgeTransport) {
      throw new Error(
        "production edge synchronization cannot use EnvironmentEdgeTransport",
      );
    }
    this.configureService(bindings.config ?? {}, {
      ...(bindings.dependencies ?? {}),
      transport: bindings.transport,
      localProcessors: bindings.localProcessors,
    });
    this.configured = bindings;
    this.initialized = true;
  }

  bindings(): Readonly<EdgeStoreAndForwardBindings> {
    if (!this.initialized || !this.configured) {
      throw new Error("edge store-and-forward runtime is not initialized");
    }
    return this.configured;
  }

  private async loadBindingsModule(): Promise<EdgeStoreAndForwardBindings> {
    const modulePath = process.env.EDGE_STORE_FORWARD_BINDINGS_MODULE;
    if (!modulePath) {
      throw new Error(
        "EDGE_STORE_FORWARD_BINDINGS_MODULE is required when production edge synchronization is enabled",
      );
    }
    const loaded = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as BindingsModule;
    const bindings = loaded.createEdgeStoreAndForwardBindings
      ? await loaded.createEdgeStoreAndForwardBindings(
          edgeStoreAndForwardFactories,
        )
      : loaded.edgeStoreAndForwardBindings ?? loaded.default;
    if (!bindings) {
      throw new Error(
        "edge bindings module must export createEdgeStoreAndForwardBindings, edgeStoreAndForwardBindings, or default",
      );
    }
    return bindings;
  }
}

function validateBindings(
  bindings: EdgeStoreAndForwardBindings,
): asserts bindings is EdgeStoreAndForwardBindings {
  const transport = bindings?.transport as unknown;
  if (
    !transport ||
    typeof transport !== "object" ||
    typeof (transport as Record<string, unknown>).isReachable !== "function" ||
    typeof (transport as Record<string, unknown>).forward !== "function"
  ) {
    throw new Error(
      "edge store-and-forward bindings require an upstream transport",
    );
  }
}

export const edgeStoreAndForwardRuntime =
  new EdgeStoreAndForwardRuntime();
