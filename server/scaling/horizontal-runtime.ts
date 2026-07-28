import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConsistentHashRing,
  PartitionedEventFanout,
  PartitionedHistorian,
  ServerLoadBalancer,
} from "./horizontal";

export interface HorizontalRuntimeHealth {
  healthy: boolean;
  degraded?: boolean;
  message?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface HorizontalScaleBindings {
  gatewayRing: ConsistentHashRing;
  loadBalancer: ServerLoadBalancer;
  historian: PartitionedHistorian;
  eventFanout: PartitionedEventFanout;
  healthCheck: () =>
    | HorizontalRuntimeHealth
    | Promise<HorizontalRuntimeHealth>;
}

export interface HorizontalScaleFactories {
  ConsistentHashRing: typeof ConsistentHashRing;
  ServerLoadBalancer: typeof ServerLoadBalancer;
  PartitionedHistorian: typeof PartitionedHistorian;
  PartitionedEventFanout: typeof PartitionedEventFanout;
}

interface BindingsModule {
  default?: HorizontalScaleBindings;
  horizontalScaleBindings?: HorizontalScaleBindings;
  createHorizontalScaleBindings?: (
    factories: HorizontalScaleFactories,
  ) => HorizontalScaleBindings | Promise<HorizontalScaleBindings>;
}

export const horizontalScaleFactories: HorizontalScaleFactories = {
  ConsistentHashRing,
  ServerLoadBalancer,
  PartitionedHistorian,
  PartitionedEventFanout,
};

/**
 * Production composition root for horizontal scaling.
 *
 * Enabling the feature requires a deployment bindings module. Missing or
 * incomplete database, message-bus, and health bindings stop startup rather
 * than falling back to an in-memory topology.
 */
export class HorizontalScaleRuntime {
  private configured?: HorizontalScaleBindings;
  private initialized = false;
  private enabledByConfiguration = false;

  configure(bindings: HorizontalScaleBindings): void {
    if (this.initialized) {
      throw new Error("horizontal scaling runtime is already initialized");
    }
    validateBindings(bindings);
    this.configured = bindings;
    this.enabledByConfiguration = true;
  }

  isEnabled(): boolean {
    return (
      this.enabledByConfiguration ||
      process.env.HORIZONTAL_SCALING_ENABLED === "true"
    );
  }

  isRequired(): boolean {
    return process.env.HORIZONTAL_SCALING_REQUIRED === "true";
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized || !this.isEnabled()) return;
    const bindings = this.configured ?? (await this.loadBindingsModule());
    validateBindings(bindings);
    this.configured = bindings;
    this.initialized = true;
  }

  bindings(): Readonly<HorizontalScaleBindings> {
    if (!this.initialized || !this.configured) {
      throw new Error("horizontal scaling runtime is not initialized");
    }
    return this.configured;
  }

  async health(): Promise<HorizontalRuntimeHealth> {
    if (!this.isEnabled()) return { healthy: true, message: "disabled" };
    if (!this.initialized || !this.configured) {
      return { healthy: false, message: "enabled but not initialized" };
    }
    try {
      return await this.configured.healthCheck();
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async loadBindingsModule(): Promise<HorizontalScaleBindings> {
    const modulePath = process.env.HORIZONTAL_SCALING_BINDINGS_MODULE;
    if (!modulePath) {
      throw new Error(
        "HORIZONTAL_SCALING_BINDINGS_MODULE is required when horizontal scaling is enabled",
      );
    }
    const loaded = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as BindingsModule;
    const bindings = loaded.createHorizontalScaleBindings
      ? await loaded.createHorizontalScaleBindings(horizontalScaleFactories)
      : loaded.horizontalScaleBindings ?? loaded.default;
    if (!bindings) {
      throw new Error(
        "horizontal scaling bindings module must export createHorizontalScaleBindings, horizontalScaleBindings, or default",
      );
    }
    return bindings;
  }
}

function validateBindings(
  bindings: HorizontalScaleBindings,
): asserts bindings is HorizontalScaleBindings {
  requireMethods(bindings?.gatewayRing, ["owner"], "gateway ring");
  requireMethods(bindings?.loadBalancer, ["acquire"], "server load balancer");
  requireMethods(bindings?.historian, ["write", "query"], "partitioned historian");
  requireMethods(
    bindings?.eventFanout,
    ["publish", "subscribe"],
    "partitioned event fan-out",
  );
  if (typeof bindings?.healthCheck !== "function") {
    throw new Error("horizontal scaling binding requires a health check");
  }
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
    throw new Error(`horizontal scaling bindings require ${name}`);
  }
}

export const horizontalScaleRuntime = new HorizontalScaleRuntime();
