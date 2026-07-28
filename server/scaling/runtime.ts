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
} from "../gateway/store-and-forward";
import {
  FederatedAlarmView,
  FederatedReporting,
  FederatedSiteDiscovery,
  ReplicatedConfiguration,
} from "./federation";
import {
  ConsistentHashRing,
  PartitionedEventFanout,
  PartitionedHistorian,
  ServerLoadBalancer,
} from "./horizontal";
import {
  JsonFileUpgradeJournal,
  ReversibleMigrationRunner,
  RollingCanaryOrchestrator,
  TypedFeatureFlags,
  VersionCompatibilityMatrix,
  type UpgradeJournal,
} from "./upgrade";

export interface RuntimeHealth {
  healthy: boolean;
  degraded?: boolean;
  message?: string;
  details?: Readonly<Record<string, unknown>>;
}

export type RuntimeHealthProbe = () =>
  | RuntimeHealth
  | Promise<RuntimeHealth>;

export interface HorizontalScaleBindings {
  gatewayRing: ConsistentHashRing;
  loadBalancer: ServerLoadBalancer;
  historian: PartitionedHistorian;
  eventFanout: PartitionedEventFanout;
  healthCheck: RuntimeHealthProbe;
}

export interface FederationBindings {
  discovery: FederatedSiteDiscovery;
  alarms: FederatedAlarmView;
  reporting: FederatedReporting;
  configuration: ReplicatedConfiguration;
  healthCheck: RuntimeHealthProbe;
}

export interface UpgradeBindings {
  orchestrator: RollingCanaryOrchestrator;
  compatibility: VersionCompatibilityMatrix;
  journal: UpgradeJournal;
  /** Deployment-specific migration runner and feature-flag registry. */
  migrations: unknown;
  featureFlags: unknown;
  healthCheck: RuntimeHealthProbe;
}

export interface EdgeBindings {
  config?: Partial<StoreAndForwardConfig>;
  transport: EdgeUpstreamTransport;
  localProcessors?: readonly LocalEdgeProcessor[];
  dependencies?: Omit<
    StoreAndForwardDependencies,
    "transport" | "localProcessors"
  >;
}

export interface ProductionScaleBindings {
  horizontal: HorizontalScaleBindings;
  federation: FederationBindings;
  upgrades: UpgradeBindings;
  edge: EdgeBindings;
}

export type ProductionScaleComponent =
  | "horizontal"
  | "federation"
  | "upgrades"
  | "edge";

interface BindingsModule {
  default?: ProductionScaleBindings;
  productionScaleBindings?: ProductionScaleBindings;
  createProductionScaleBindings?: (
    factories: ProductionScaleFactories,
  ) =>
    | ProductionScaleBindings
    | Promise<ProductionScaleBindings>;
}

export interface ProductionScaleFactories {
  horizontal: {
    ConsistentHashRing: typeof ConsistentHashRing;
    ServerLoadBalancer: typeof ServerLoadBalancer;
    PartitionedHistorian: typeof PartitionedHistorian;
    PartitionedEventFanout: typeof PartitionedEventFanout;
  };
  federation: {
    FederatedSiteDiscovery: typeof FederatedSiteDiscovery;
    FederatedAlarmView: typeof FederatedAlarmView;
    FederatedReporting: typeof FederatedReporting;
    ReplicatedConfiguration: typeof ReplicatedConfiguration;
  };
  upgrades: {
    VersionCompatibilityMatrix: typeof VersionCompatibilityMatrix;
    ReversibleMigrationRunner: typeof ReversibleMigrationRunner;
    TypedFeatureFlags: typeof TypedFeatureFlags;
    RollingCanaryOrchestrator: typeof RollingCanaryOrchestrator;
    JsonFileUpgradeJournal: typeof JsonFileUpgradeJournal;
  };
  edge: {
    JsonFileEdgeQueue: typeof JsonFileEdgeQueue;
  };
}

export const productionScaleFactories: ProductionScaleFactories = {
  horizontal: {
    ConsistentHashRing,
    ServerLoadBalancer,
    PartitionedHistorian,
    PartitionedEventFanout,
  },
  federation: {
    FederatedSiteDiscovery,
    FederatedAlarmView,
    FederatedReporting,
    ReplicatedConfiguration,
  },
  upgrades: {
    VersionCompatibilityMatrix,
    ReversibleMigrationRunner,
    TypedFeatureFlags,
    RollingCanaryOrchestrator,
    JsonFileUpgradeJournal,
  },
  edge: {
    JsonFileEdgeQueue,
  },
};

/**
 * Application composition root for ADR-0014 runtime services.
 *
 * Production enables it with `PRODUCTION_SCALE_ENABLED=true` and supplies a
 * local bindings module through `PRODUCTION_SCALE_BINDINGS_MODULE`. Missing or
 * incomplete production bindings stop startup instead of silently installing
 * in-memory/fake transports.
 */
export class ProductionScaleRuntime {
  private configured?: ProductionScaleBindings;
  private edgeService?: StoreAndForwardService;
  private initialized = false;
  private enabledByConfiguration = false;

  configure(bindings: ProductionScaleBindings): void {
    if (this.initialized) {
      throw new Error("production-scale runtime is already initialized");
    }
    validateBindings(bindings);
    this.configured = bindings;
    this.enabledByConfiguration = true;
  }

  isEnabled(): boolean {
    return (
      this.enabledByConfiguration ||
      process.env.PRODUCTION_SCALE_ENABLED === "true"
    );
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isRequired(): boolean {
    return process.env.PRODUCTION_SCALE_REQUIRED === "true";
  }

  async initialize(): Promise<void> {
    if (this.initialized || !this.isEnabled()) {
      return;
    }
    const bindings = this.configured ?? (await this.loadBindingsModule());
    validateBindings(bindings);
    if (bindings.edge.transport instanceof EnvironmentEdgeTransport) {
      throw new Error(
        "production-scale edge binding cannot use EnvironmentEdgeTransport",
      );
    }
    this.edgeService = configureStoreAndForwardService(
      bindings.edge.config ?? {},
      {
        ...(bindings.edge.dependencies ?? {}),
        transport: bindings.edge.transport,
        localProcessors: bindings.edge.localProcessors,
      },
    );
    this.configured = bindings;
    this.initialized = true;
  }

  bindings(): Readonly<ProductionScaleBindings> {
    if (!this.initialized || !this.configured) {
      throw new Error("production-scale runtime is not initialized");
    }
    return this.configured;
  }

  async health(component: ProductionScaleComponent): Promise<RuntimeHealth> {
    if (!this.isEnabled()) {
      return { healthy: true, message: "disabled" };
    }
    if (!this.initialized || !this.configured) {
      return { healthy: false, message: "enabled but not initialized" };
    }
    try {
      if (component === "edge") {
        const health = await this.edgeService!.healthCheck();
        return {
          healthy: health.healthy,
          degraded: health.degraded,
          message: health.message,
          details: {
            degraded: health.degraded,
            ...this.edgeService!.getStatus(),
          },
        };
      }
      return await this.configured[component].healthCheck();
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async loadBindingsModule(): Promise<ProductionScaleBindings> {
    const modulePath = process.env.PRODUCTION_SCALE_BINDINGS_MODULE;
    if (!modulePath) {
      throw new Error(
        "PRODUCTION_SCALE_BINDINGS_MODULE is required when production scale is enabled",
      );
    }
    const location = pathToFileURL(resolve(modulePath)).href;
    const loaded = (await import(location)) as BindingsModule;
    const bindings = loaded.createProductionScaleBindings
      ? await loaded.createProductionScaleBindings(productionScaleFactories)
      : loaded.productionScaleBindings ?? loaded.default;
    if (!bindings) {
      throw new Error(
        "production-scale bindings module must export createProductionScaleBindings, productionScaleBindings, or default",
      );
    }
    return bindings;
  }
}

function validateBindings(
  bindings: ProductionScaleBindings,
): asserts bindings is ProductionScaleBindings {
  if (!bindings || typeof bindings !== "object") {
    throw new Error("production-scale bindings are required");
  }
  requireMethods(bindings.horizontal?.gatewayRing, ["owner"], "gateway ring");
  requireMethods(
    bindings.horizontal?.loadBalancer,
    ["acquire"],
    "server load balancer",
  );
  requireMethods(
    bindings.horizontal?.historian,
    ["write", "query"],
    "partitioned historian",
  );
  requireMethods(
    bindings.horizontal?.eventFanout,
    ["publish", "subscribe"],
    "partitioned event fan-out",
  );
  requireHealth(bindings.horizontal?.healthCheck, "horizontal scaling");

  requireMethods(
    bindings.federation?.discovery,
    ["discover"],
    "federated discovery",
  );
  requireMethods(bindings.federation?.alarms, ["query"], "federated alarms");
  requireMethods(
    bindings.federation?.reporting,
    ["generate"],
    "federated reporting",
  );
  requireMethods(
    bindings.federation?.configuration,
    ["merge", "value"],
    "replicated configuration",
  );
  requireHealth(bindings.federation?.healthCheck, "federation");

  requireMethods(
    bindings.upgrades?.orchestrator,
    ["execute"],
    "upgrade orchestrator",
  );
  requireMethods(
    bindings.upgrades?.compatibility,
    ["assertCompatible"],
    "version compatibility matrix",
  );
  requireMethods(bindings.upgrades?.journal, ["entries", "append"], "upgrade journal");
  if (!bindings.upgrades?.journal.durable) {
    throw new Error("production upgrade bindings require a durable journal");
  }
  if (
    !bindings.upgrades.orchestrator.usesJournal(bindings.upgrades.journal)
  ) {
    throw new Error(
      "upgrade orchestrator must use the configured durable journal",
    );
  }
  if (!bindings.upgrades?.migrations || !bindings.upgrades?.featureFlags) {
    throw new Error(
      "upgrade bindings require migration and feature-flag services",
    );
  }
  requireHealth(bindings.upgrades?.healthCheck, "upgrades");

  requireMethods(
    bindings.edge?.transport,
    ["isReachable", "forward"],
    "edge upstream transport",
  );
}

function requireMethods(
  value: unknown,
  methods: readonly string[],
  name: string,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    methods.some(
      (method) =>
        typeof (value as Record<string, unknown>)[method] !== "function",
    )
  ) {
    throw new Error(`production-scale bindings require ${name}`);
  }
}

function requireHealth(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new Error(`${name} binding requires a health check`);
  }
}

export const productionScaleRuntime = new ProductionScaleRuntime();
