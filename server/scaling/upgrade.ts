import { hash64 } from "./hash";

export interface VersionTransition {
  from: string;
  to: string;
  compatible: boolean;
  reason?: string;
}

/**
 * Explicit upgrade compatibility matrix. Missing transitions fail closed;
 * callers must deliberately certify every rolling-upgrade edge.
 */
export class VersionCompatibilityMatrix {
  private readonly transitions = new Map<string, VersionTransition>();

  constructor(transitions: readonly VersionTransition[]) {
    for (const transition of transitions) {
      parseVersion(transition.from);
      parseVersion(transition.to);
      const key = transitionKey(transition.from, transition.to);
      if (this.transitions.has(key)) {
        throw new Error(`duplicate compatibility transition ${transition.from} -> ${transition.to}`);
      }
      this.transitions.set(key, { ...transition });
    }
  }

  check(from: string, to: string): { compatible: boolean; reason?: string } {
    parseVersion(from);
    parseVersion(to);
    if (from === to) {
      return { compatible: true };
    }
    const transition = this.transitions.get(transitionKey(from, to));
    if (!transition) {
      return {
        compatible: false,
        reason: `uncertified version transition ${from} -> ${to}`,
      };
    }
    return {
      compatible: transition.compatible,
      reason:
        transition.reason ??
        (transition.compatible
          ? undefined
          : `version transition ${from} -> ${to} is incompatible`),
    };
  }

  assertCompatible(from: string, to: string): void {
    const result = this.check(from, to);
    if (!result.compatible) {
      throw new Error(result.reason);
    }
  }
}

export interface FeatureFlagContext {
  subjectId: string;
  siteId?: string;
  attributes?: Readonly<Record<string, string>>;
}

export interface FeatureFlagDefinition<T> {
  defaultValue: T;
  validate(value: unknown): value is T;
}

export interface FeatureFlagRollout<T> {
  enabled: boolean;
  value: T;
  percentage: number;
  includeSubjects?: readonly string[];
  excludeSubjects?: readonly string[];
  sites?: readonly string[];
}

type Definitions<Schema extends Record<string, unknown>> = {
  [Key in keyof Schema]: FeatureFlagDefinition<Schema[Key]>;
};

/**
 * Compile-time keyed and runtime validated feature flags. Rollout assignment is
 * stable across processes because it hashes flag + subject into 10,000 buckets.
 */
export class TypedFeatureFlags<Schema extends Record<string, unknown>> {
  private readonly rollouts = new Map<keyof Schema, FeatureFlagRollout<unknown>>();

  constructor(private readonly definitions: Definitions<Schema>) {}

  configure<Key extends keyof Schema>(
    key: Key,
    rollout: FeatureFlagRollout<Schema[Key]>,
  ): void {
    const definition = this.definitions[key];
    if (!definition) {
      throw new Error(`unknown feature flag: ${String(key)}`);
    }
    if (!definition.validate(rollout.value)) {
      throw new Error(`invalid value for feature flag: ${String(key)}`);
    }
    if (
      !Number.isFinite(rollout.percentage) ||
      rollout.percentage < 0 ||
      rollout.percentage > 100
    ) {
      throw new Error("feature flag percentage must be between 0 and 100");
    }
    this.rollouts.set(key, structuredClone(rollout));
  }

  evaluate<Key extends keyof Schema>(
    key: Key,
    context: FeatureFlagContext,
  ): Schema[Key] {
    const definition = this.definitions[key];
    if (!definition) {
      throw new Error(`unknown feature flag: ${String(key)}`);
    }
    const rollout = this.rollouts.get(key) as
      | FeatureFlagRollout<Schema[Key]>
      | undefined;
    if (!rollout?.enabled || !context.subjectId) {
      return structuredClone(definition.defaultValue);
    }
    if (rollout.excludeSubjects?.includes(context.subjectId)) {
      return structuredClone(definition.defaultValue);
    }
    if (
      rollout.sites?.length &&
      (!context.siteId || !rollout.sites.includes(context.siteId))
    ) {
      return structuredClone(definition.defaultValue);
    }
    if (rollout.includeSubjects?.includes(context.subjectId)) {
      return structuredClone(rollout.value);
    }
    const bucket = Number(
      hash64(`${String(key)}\0${context.subjectId}`) % 10_000n,
    );
    return bucket < Math.round(rollout.percentage * 100)
      ? structuredClone(rollout.value)
      : structuredClone(definition.defaultValue);
  }

  snapshot(): Partial<{ [Key in keyof Schema]: FeatureFlagRollout<Schema[Key]> }> {
    return Object.fromEntries(
      [...this.rollouts.entries()].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
    ) as Partial<{ [Key in keyof Schema]: FeatureFlagRollout<Schema[Key]> }>;
  }
}

export interface DatabaseMigration<Context> {
  id: string;
  up(context: Context): Promise<void>;
  down(context: Context): Promise<void>;
}

export type MigrationJournalStatus =
  | "started"
  | "applied"
  | "failed"
  | "rollback-started"
  | "rolled-back"
  | "rollback-failed";

export interface MigrationJournalEntry {
  migrationId: string;
  status: MigrationJournalStatus;
  sequence: number;
  timestamp: Date;
  error?: string;
}

export interface MigrationJournal {
  entries(): Promise<readonly MigrationJournalEntry[]>;
  append(
    entry: Omit<MigrationJournalEntry, "sequence" | "timestamp">,
  ): Promise<MigrationJournalEntry>;
}

/** Durable implementations can back this contract with an append-only table. */
export class InMemoryMigrationJournal implements MigrationJournal {
  private readonly log: MigrationJournalEntry[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async entries(): Promise<readonly MigrationJournalEntry[]> {
    return structuredClone(this.log);
  }

  async append(
    entry: Omit<MigrationJournalEntry, "sequence" | "timestamp">,
  ): Promise<MigrationJournalEntry> {
    const recorded: MigrationJournalEntry = {
      ...entry,
      sequence: this.log.length + 1,
      timestamp: this.now(),
    };
    this.log.push(recorded);
    return structuredClone(recorded);
  }
}

export class MigrationExecutionError extends Error {
  constructor(
    message: string,
    readonly failedMigration: string,
    readonly rollbackFailures: readonly string[],
  ) {
    super(message);
    this.name = "MigrationExecutionError";
  }
}

/**
 * Applies migrations once and automatically runs `down` in reverse order when
 * an `up` fails. Every transition is journaled for crash recovery/audit.
 */
export class ReversibleMigrationRunner<Context> {
  constructor(private readonly journal: MigrationJournal) {}

  async run(
    migrations: readonly DatabaseMigration<Context>[],
    context: Context,
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const migration of migrations) {
      if (!migration.id.trim() || ids.has(migration.id)) {
        throw new Error(`migration ids must be non-empty and unique: ${migration.id}`);
      }
      ids.add(migration.id);
    }
    const existing = await this.journal.entries();
    const appliedPreviously = currentAppliedMigrations(existing);
    const appliedThisRun: DatabaseMigration<Context>[] = [];

    for (const migration of migrations) {
      if (appliedPreviously.has(migration.id)) {
        continue;
      }
      await this.journal.append({
        migrationId: migration.id,
        status: "started",
      });
      try {
        await migration.up(context);
        await this.journal.append({
          migrationId: migration.id,
          status: "applied",
        });
        appliedThisRun.push(migration);
      } catch (error) {
        await this.journal.append({
          migrationId: migration.id,
          status: "failed",
          error: errorMessage(error),
        });
        // `up` may have made partial changes before throwing, so its `down`
        // participates in recovery as well as all prior migrations.
        const rollbackFailures = await this.rollback(
          [...appliedThisRun, migration],
          context,
        );
        throw new MigrationExecutionError(
          `migration ${migration.id} failed: ${errorMessage(error)}`,
          migration.id,
          rollbackFailures,
        );
      }
    }
    return appliedThisRun.map((migration) => migration.id);
  }

  async rollback(
    migrations: readonly DatabaseMigration<Context>[],
    context: Context,
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const migration of [...migrations].reverse()) {
      await this.journal.append({
        migrationId: migration.id,
        status: "rollback-started",
      });
      try {
        await migration.down(context);
        await this.journal.append({
          migrationId: migration.id,
          status: "rolled-back",
        });
      } catch (error) {
        const failure = `${migration.id}: ${errorMessage(error)}`;
        failures.push(failure);
        await this.journal.append({
          migrationId: migration.id,
          status: "rollback-failed",
          error: errorMessage(error),
        });
      }
    }
    return failures;
  }
}

export interface DeploymentInstance {
  id: string;
  version: string;
  healthy: boolean;
  zone?: string;
}

export interface DeploymentAdapter {
  instances(): Promise<readonly DeploymentInstance[]>;
  drain(instanceId: string): Promise<void>;
  deploy(instanceId: string, version: string): Promise<void>;
  waitUntilHealthy(
    instanceId: string,
    version: string,
    timeoutMs: number,
  ): Promise<boolean>;
  restoreTraffic(instanceId: string): Promise<void>;
  rollback(instanceId: string, version: string): Promise<void>;
}

export interface RollingUpgradePlan {
  targetVersion: string;
  canaryCount: number;
  batchSize: number;
  healthTimeoutMs: number;
}

export type UpgradeStage =
  | "canary"
  | "rolling"
  | "rollback"
  | "complete";

export interface UpgradeEvent {
  stage: UpgradeStage;
  instanceId?: string;
  fromVersion?: string;
  toVersion?: string;
  outcome: "started" | "healthy" | "failed" | "restored";
  error?: string;
}

export interface UpgradeResult {
  succeeded: boolean;
  targetVersion: string;
  upgraded: string[];
  events: UpgradeEvent[];
  failure?: string;
  rollbackFailures: string[];
}

/**
 * Canary-first rolling orchestrator. The compatibility matrix is checked before
 * any drain/deploy side effect. A failed health gate rolls every changed node
 * back to its original version.
 */
export class RollingCanaryOrchestrator {
  constructor(
    private readonly adapter: DeploymentAdapter,
    private readonly compatibility: VersionCompatibilityMatrix,
  ) {}

  async execute(plan: RollingUpgradePlan): Promise<UpgradeResult> {
    validateUpgradePlan(plan);
    parseVersion(plan.targetVersion);
    const instances = [...(await this.adapter.instances())].sort(
      stableInstanceOrder,
    );
    if (instances.length === 0) {
      throw new Error("cannot run an upgrade without deployment instances");
    }
    if (instances.some((instance) => !instance.healthy)) {
      throw new Error("all deployment instances must be healthy before upgrade");
    }
    for (const instance of instances) {
      this.compatibility.assertCompatible(instance.version, plan.targetVersion);
    }

    const originals = new Map(
      instances.map((instance) => [instance.id, instance.version]),
    );
    const pending = instances.filter(
      (instance) => instance.version !== plan.targetVersion,
    );
    const canaryCount = Math.min(plan.canaryCount, pending.length);
    const canaries = pending.slice(0, canaryCount);
    const remainder = pending.slice(canaryCount);
    const changed: string[] = [];
    const events: UpgradeEvent[] = [];

    const applyBatch = async (
      batch: readonly DeploymentInstance[],
      stage: "canary" | "rolling",
    ): Promise<void> => {
      for (const instance of batch) {
        events.push({
          stage,
          instanceId: instance.id,
          fromVersion: instance.version,
          toVersion: plan.targetVersion,
          outcome: "started",
        });
        // Draining itself can fail after removing a node from only part of the
        // traffic plane, so the node becomes rollback-eligible first.
        changed.push(instance.id);
        try {
          await this.adapter.drain(instance.id);
          await this.adapter.deploy(instance.id, plan.targetVersion);
          const healthy = await this.adapter.waitUntilHealthy(
            instance.id,
            plan.targetVersion,
            plan.healthTimeoutMs,
          );
          if (!healthy) {
            throw new Error(`health gate timed out for ${instance.id}`);
          }
          await this.adapter.restoreTraffic(instance.id);
          events.push({
            stage,
            instanceId: instance.id,
            fromVersion: instance.version,
            toVersion: plan.targetVersion,
            outcome: "healthy",
          });
        } catch (error) {
          events.push({
            stage,
            instanceId: instance.id,
            fromVersion: instance.version,
            toVersion: plan.targetVersion,
            outcome: "failed",
            error: errorMessage(error),
          });
          throw error;
        }
      }
    };

    try {
      await applyBatch(canaries, "canary");
      for (let index = 0; index < remainder.length; index += plan.batchSize) {
        await applyBatch(remainder.slice(index, index + plan.batchSize), "rolling");
      }
      events.push({ stage: "complete", outcome: "healthy" });
      return {
        succeeded: true,
        targetVersion: plan.targetVersion,
        upgraded: [...changed],
        events,
        rollbackFailures: [],
      };
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const instanceId of [...changed].reverse()) {
        const original = originals.get(instanceId)!;
        events.push({
          stage: "rollback",
          instanceId,
          fromVersion: plan.targetVersion,
          toVersion: original,
          outcome: "started",
        });
        try {
          await this.adapter.rollback(instanceId, original);
          await this.adapter.restoreTraffic(instanceId);
          events.push({
            stage: "rollback",
            instanceId,
            fromVersion: plan.targetVersion,
            toVersion: original,
            outcome: "restored",
          });
        } catch (rollbackError) {
          const failure = `${instanceId}: ${errorMessage(rollbackError)}`;
          rollbackFailures.push(failure);
          events.push({
            stage: "rollback",
            instanceId,
            fromVersion: plan.targetVersion,
            toVersion: original,
            outcome: "failed",
            error: errorMessage(rollbackError),
          });
        }
      }
      return {
        succeeded: false,
        targetVersion: plan.targetVersion,
        upgraded: [...changed],
        events,
        failure: errorMessage(error),
        rollbackFailures,
      };
    }
  }
}

function currentAppliedMigrations(
  entries: readonly MigrationJournalEntry[],
): Set<string> {
  const states = new Map<string, MigrationJournalStatus>();
  for (const entry of [...entries].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    states.set(entry.migrationId, entry.status);
  }
  return new Set(
    [...states.entries()]
      .filter(([, status]) => status === "applied")
      .map(([id]) => id),
  );
}

function validateUpgradePlan(plan: RollingUpgradePlan): void {
  if (
    !Number.isInteger(plan.canaryCount) ||
    plan.canaryCount < 1 ||
    !Number.isInteger(plan.batchSize) ||
    plan.batchSize < 1 ||
    !Number.isFinite(plan.healthTimeoutMs) ||
    plan.healthTimeoutMs <= 0
  ) {
    throw new Error("canaryCount, batchSize, and healthTimeoutMs must be positive");
  }
}

function stableInstanceOrder(
  left: DeploymentInstance,
  right: DeploymentInstance,
): number {
  const leftHash = hash64(`${left.zone ?? ""}\0${left.id}`);
  const rightHash = hash64(`${right.zone ?? ""}\0${right.id}`);
  return Number(leftHash - rightHash) || left.id.localeCompare(right.id);
}

function transitionKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function parseVersion(version: string): readonly [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    throw new Error(`invalid semantic version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
