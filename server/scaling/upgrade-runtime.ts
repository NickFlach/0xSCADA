import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  JsonFileUpgradeJournal,
  ReversibleMigrationRunner,
  RollingCanaryOrchestrator,
  TypedFeatureFlags,
  VersionCompatibilityMatrix,
  type UpgradeJournal,
} from "./upgrade";

export interface UpgradeRuntimeHealth {
  healthy: boolean;
  degraded?: boolean;
  message?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface ZeroDowntimeUpgradeBindings {
  orchestrator: RollingCanaryOrchestrator;
  compatibility: VersionCompatibilityMatrix;
  journal: UpgradeJournal;
  /** Deployment-owned services that run schema changes and evaluate rollouts. */
  migrations: unknown;
  featureFlags: unknown;
  healthCheck: () =>
    | UpgradeRuntimeHealth
    | Promise<UpgradeRuntimeHealth>;
}

export interface ZeroDowntimeUpgradeFactories {
  VersionCompatibilityMatrix: typeof VersionCompatibilityMatrix;
  ReversibleMigrationRunner: typeof ReversibleMigrationRunner;
  TypedFeatureFlags: typeof TypedFeatureFlags;
  RollingCanaryOrchestrator: typeof RollingCanaryOrchestrator;
  JsonFileUpgradeJournal: typeof JsonFileUpgradeJournal;
}

interface BindingsModule {
  default?: ZeroDowntimeUpgradeBindings;
  zeroDowntimeUpgradeBindings?: ZeroDowntimeUpgradeBindings;
  createZeroDowntimeUpgradeBindings?: (
    factories: ZeroDowntimeUpgradeFactories,
  ) =>
    | ZeroDowntimeUpgradeBindings
    | Promise<ZeroDowntimeUpgradeBindings>;
}

export const zeroDowntimeUpgradeFactories: ZeroDowntimeUpgradeFactories = {
  VersionCompatibilityMatrix,
  ReversibleMigrationRunner,
  TypedFeatureFlags,
  RollingCanaryOrchestrator,
  JsonFileUpgradeJournal,
};

/**
 * Production composition root for zero-downtime upgrade services.
 *
 * An enabled deployment must supply an adapter-backed orchestrator, the exact
 * durable journal used by that orchestrator, migration and feature-flag
 * services, and an operational health probe. Incomplete bindings stop startup.
 */
export class ZeroDowntimeUpgradeRuntime {
  private configured?: ZeroDowntimeUpgradeBindings;
  private initialized = false;
  private enabledByConfiguration = false;

  configure(bindings: ZeroDowntimeUpgradeBindings): void {
    if (this.initialized) {
      throw new Error("zero-downtime upgrade runtime is already initialized");
    }
    validateBindings(bindings);
    this.configured = bindings;
    this.enabledByConfiguration = true;
  }

  isEnabled(): boolean {
    return (
      this.enabledByConfiguration ||
      process.env.ZERO_DOWNTIME_UPGRADES_ENABLED === "true"
    );
  }

  isRequired(): boolean {
    return process.env.ZERO_DOWNTIME_UPGRADES_REQUIRED === "true";
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

  bindings(): Readonly<ZeroDowntimeUpgradeBindings> {
    if (!this.initialized || !this.configured) {
      throw new Error("zero-downtime upgrade runtime is not initialized");
    }
    return this.configured;
  }

  async health(): Promise<UpgradeRuntimeHealth> {
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

  private async loadBindingsModule(): Promise<ZeroDowntimeUpgradeBindings> {
    const modulePath = process.env.ZERO_DOWNTIME_UPGRADES_BINDINGS_MODULE;
    if (!modulePath) {
      throw new Error(
        "ZERO_DOWNTIME_UPGRADES_BINDINGS_MODULE is required when zero-downtime upgrades are enabled",
      );
    }
    const loaded = (await import(
      pathToFileURL(resolve(modulePath)).href
    )) as BindingsModule;
    const bindings = loaded.createZeroDowntimeUpgradeBindings
      ? await loaded.createZeroDowntimeUpgradeBindings(
          zeroDowntimeUpgradeFactories,
        )
      : loaded.zeroDowntimeUpgradeBindings ?? loaded.default;
    if (!bindings) {
      throw new Error(
        "zero-downtime upgrade bindings module must export createZeroDowntimeUpgradeBindings, zeroDowntimeUpgradeBindings, or default",
      );
    }
    return bindings;
  }
}

function validateBindings(
  bindings: ZeroDowntimeUpgradeBindings,
): asserts bindings is ZeroDowntimeUpgradeBindings {
  requireMethods(bindings?.orchestrator, ["execute", "usesJournal"], "orchestrator");
  requireMethods(
    bindings?.compatibility,
    ["assertCompatible"],
    "version compatibility matrix",
  );
  requireMethods(bindings?.journal, ["entries", "append"], "upgrade journal");
  if (!bindings?.journal.durable) {
    throw new Error(
      "zero-downtime upgrade bindings require a durable journal",
    );
  }
  if (!bindings.orchestrator.usesJournal(bindings.journal)) {
    throw new Error(
      "upgrade orchestrator must use the configured durable journal",
    );
  }
  requireMethods(bindings?.migrations, ["run"], "migration service");
  requireMethods(bindings?.featureFlags, ["evaluate"], "feature-flag service");
  if (typeof bindings?.healthCheck !== "function") {
    throw new Error(
      "zero-downtime upgrade binding requires a health check",
    );
  }
}

function requireMethods(
  value: unknown,
  methods: readonly string[],
  name: string,
): void {
  if (
    !value ||
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some(
      (method) =>
        typeof (value as Record<string, unknown>)[method] !== "function",
    )
  ) {
    throw new Error(`zero-downtime upgrade bindings require ${name}`);
  }
}

export const zeroDowntimeUpgradeRuntime =
  new ZeroDowntimeUpgradeRuntime();
