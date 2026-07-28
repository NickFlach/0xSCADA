import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FederatedAlarmView,
  FederatedReporting,
  FederatedSiteDiscovery,
  ReplicatedConfiguration,
} from "./federation";

export interface FederationRuntimeHealth {
  healthy: boolean;
  degraded?: boolean;
  message?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface FederationBindings {
  discovery: FederatedSiteDiscovery;
  alarms: FederatedAlarmView;
  reporting: FederatedReporting;
  configuration: ReplicatedConfiguration;
  healthCheck: () =>
    | FederationRuntimeHealth
    | Promise<FederationRuntimeHealth>;
}

export interface FederationFactories {
  FederatedSiteDiscovery: typeof FederatedSiteDiscovery;
  FederatedAlarmView: typeof FederatedAlarmView;
  FederatedReporting: typeof FederatedReporting;
  ReplicatedConfiguration: typeof ReplicatedConfiguration;
}

interface BindingsModule {
  default?: FederationBindings;
  federationBindings?: FederationBindings;
  createFederationBindings?: (
    factories: FederationFactories,
  ) => FederationBindings | Promise<FederationBindings>;
}

export const federationFactories: FederationFactories = {
  FederatedSiteDiscovery,
  FederatedAlarmView,
  FederatedReporting,
  ReplicatedConfiguration,
};

/**
 * Production composition root for multi-site federation. Production discovery
 * and query clients are mandatory when enabled; no unauthenticated or in-memory
 * peer source is installed as a fallback.
 */
export class FederationRuntime {
  private configured?: FederationBindings;
  private initialized = false;
  private enabledByConfiguration = false;

  configure(bindings: FederationBindings): void {
    if (this.initialized) {
      throw new Error("federation runtime is already initialized");
    }
    validateBindings(bindings);
    this.configured = bindings;
    this.enabledByConfiguration = true;
  }

  isEnabled(): boolean {
    return (
      this.enabledByConfiguration ||
      process.env.MULTI_SITE_FEDERATION_ENABLED === "true"
    );
  }

  isRequired(): boolean {
    return process.env.MULTI_SITE_FEDERATION_REQUIRED === "true";
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

  bindings(): Readonly<FederationBindings> {
    if (!this.initialized || !this.configured) {
      throw new Error("federation runtime is not initialized");
    }
    return this.configured;
  }

  async health(): Promise<FederationRuntimeHealth> {
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

  private async loadBindingsModule(): Promise<FederationBindings> {
    const modulePath = process.env.MULTI_SITE_FEDERATION_BINDINGS_MODULE;
    if (!modulePath) {
      throw new Error(
        "MULTI_SITE_FEDERATION_BINDINGS_MODULE is required when federation is enabled",
      );
    }
    const loaded = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as BindingsModule;
    const bindings = loaded.createFederationBindings
      ? await loaded.createFederationBindings(federationFactories)
      : loaded.federationBindings ?? loaded.default;
    if (!bindings) {
      throw new Error(
        "federation bindings module must export createFederationBindings, federationBindings, or default",
      );
    }
    return bindings;
  }
}

function validateBindings(
  bindings: FederationBindings,
): asserts bindings is FederationBindings {
  requireMethods(bindings?.discovery, ["discover"], "site discovery");
  requireMethods(bindings?.alarms, ["query"], "federated alarm view");
  requireMethods(bindings?.reporting, ["generate"], "federated reporting");
  requireMethods(
    bindings?.configuration,
    ["merge", "value"],
    "replicated configuration",
  );
  if (typeof bindings?.healthCheck !== "function") {
    throw new Error("federation binding requires a health check");
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
    throw new Error(`federation bindings require ${name}`);
  }
}

export const federationRuntime = new FederationRuntime();
