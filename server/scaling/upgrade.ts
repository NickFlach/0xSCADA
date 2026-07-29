import { readFile } from "node:fs/promises";
import { writeFileAtomicDurable } from "../atomic-file";
import { canonicalJson, hash64 } from "./hash";

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
  private running = false;

  constructor(private readonly journal: MigrationJournal) {}

  async run(
    migrations: readonly DatabaseMigration<Context>[],
    context: Context,
  ): Promise<string[]> {
    if (this.running) {
      throw new Error("a migration run is already in progress");
    }
    this.running = true;
    try {
      return await this.runExclusive(migrations, context);
    } finally {
      this.running = false;
    }
  }

  private async runExclusive(
    migrations: readonly DatabaseMigration<Context>[],
    context: Context,
  ): Promise<string[]> {
    const definitions = new Map<string, DatabaseMigration<Context>>();
    for (const migration of migrations) {
      if (!migration.id.trim() || definitions.has(migration.id)) {
        throw new Error(`migration ids must be non-empty and unique: ${migration.id}`);
      }
      definitions.set(migration.id, migration);
    }
    await this.recoverIncomplete(definitions, context);
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
        const journalFailures: string[] = [];
        try {
          await this.journal.append({
            migrationId: migration.id,
            status: "failed",
            error: errorMessage(error),
          });
        } catch (journalError) {
          journalFailures.push(
            `${migration.id}: could not journal failure: ${errorMessage(journalError)}`,
          );
        }
        // `up` may have made partial changes before throwing, so its `down`
        // participates in recovery as well as all prior migrations.
        const rollbackFailures = await this.rollback(
          [...appliedThisRun, migration],
          context,
        );
        throw new MigrationExecutionError(
          `migration ${migration.id} failed: ${errorMessage(error)}`,
          migration.id,
          [...journalFailures, ...rollbackFailures],
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
      try {
        await this.journal.append({
          migrationId: migration.id,
          status: "rollback-started",
        });
      } catch (error) {
        failures.push(
          `${migration.id}: could not journal rollback start: ${errorMessage(error)}`,
        );
      }
      try {
        await migration.down(context);
        try {
          await this.journal.append({
            migrationId: migration.id,
            status: "rolled-back",
          });
        } catch (error) {
          failures.push(
            `${migration.id}: rollback completed but could not be journaled: ${errorMessage(error)}`,
          );
        }
      } catch (error) {
        const failure = `${migration.id}: ${errorMessage(error)}`;
        failures.push(failure);
        try {
          await this.journal.append({
            migrationId: migration.id,
            status: "rollback-failed",
            error: errorMessage(error),
          });
        } catch (journalError) {
          failures.push(
            `${migration.id}: could not journal rollback failure: ${errorMessage(journalError)}`,
          );
        }
      }
    }
    return failures;
  }

  private async recoverIncomplete(
    definitions: ReadonlyMap<string, DatabaseMigration<Context>>,
    context: Context,
  ): Promise<void> {
    const entries = await this.journal.entries();
    const latest = latestMigrationStates(entries);
    const incomplete = [...latest.entries()]
      .filter(([, entry]) =>
        (
          [
            "started",
            "failed",
            "rollback-started",
            "rollback-failed",
          ] as MigrationJournalStatus[]
        ).includes(entry.status),
      )
      .sort((left, right) => right[1].sequence - left[1].sequence);

    for (const [migrationId] of incomplete) {
      const migration = definitions.get(migrationId);
      if (!migration) {
        throw new MigrationExecutionError(
          `incomplete migration ${migrationId} cannot be recovered without its definition`,
          migrationId,
          [`${migrationId}: migration definition is unavailable`],
        );
      }
      // `up` or `down` may have crossed its side-effect boundary before the
      // process stopped. Recovery therefore requires an idempotent `down`.
      const failures = await this.rollback([migration], context);
      if (failures.length > 0) {
        throw new MigrationExecutionError(
          `incomplete migration ${migrationId} could not be recovered`,
          migrationId,
          failures,
        );
      }
    }
  }
}

export type UpgradeJournalStatus =
  | "drain-started"
  | "deployed"
  | "healthy"
  | "traffic-restored"
  | "rollback-started"
  | "rolled-back"
  | "rollback-failed";

export interface UpgradeJournalEntry {
  targetVersion: string;
  instanceId: string;
  originalVersion: string;
  status: UpgradeJournalStatus;
  sequence: number;
  timestamp: Date;
  error?: string;
}

export interface UpgradeJournal {
  /** True only when entries survive controller process loss. */
  readonly durable: boolean;
  entries(): Promise<readonly UpgradeJournalEntry[]>;
  append(
    entry: Omit<UpgradeJournalEntry, "sequence" | "timestamp">,
  ): Promise<UpgradeJournalEntry>;
}

export class InMemoryUpgradeJournal implements UpgradeJournal {
  readonly durable = false;
  private readonly log: UpgradeJournalEntry[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async entries(): Promise<readonly UpgradeJournalEntry[]> {
    return structuredClone(this.log);
  }

  async append(
    entry: Omit<UpgradeJournalEntry, "sequence" | "timestamp">,
  ): Promise<UpgradeJournalEntry> {
    const recorded: UpgradeJournalEntry = {
      ...entry,
      sequence: this.log.length + 1,
      timestamp: this.now(),
    };
    validateUpgradeJournalEntry(recorded);
    this.log.push(recorded);
    return structuredClone(recorded);
  }
}

interface SerializedUpgradeJournalEntry
  extends Omit<UpgradeJournalEntry, "timestamp"> {
  timestamp: string;
}

interface UpgradeJournalFile {
  version: 1;
  entries: SerializedUpgradeJournalEntry[];
}

/**
 * Atomic, fsync-backed journal for a single upgrade controller process.
 * Multi-controller deployments should bind `UpgradeJournal` to a transactional
 * database that also provides leader election.
 */
export class JsonFileUpgradeJournal implements UpgradeJournal {
  readonly durable = true;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!path) {
      throw new Error("upgrade journal path is required");
    }
  }

  async entries(): Promise<readonly UpgradeJournalEntry[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(contents) as Partial<UpgradeJournalFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error(`unsupported or corrupt upgrade journal: ${this.path}`);
    }
    const entries = parsed.entries.map((entry) => {
      const deserialized: UpgradeJournalEntry = {
        ...entry,
        timestamp: new Date(entry.timestamp),
      };
      validateUpgradeJournalEntry(deserialized);
      return deserialized;
    });
    entries.forEach((entry, index) => {
      if (entry.sequence !== index + 1) {
        throw new Error(
          `non-contiguous upgrade journal sequence at ${entry.sequence}`,
        );
      }
    });
    return entries;
  }

  append(
    entry: Omit<UpgradeJournalEntry, "sequence" | "timestamp">,
  ): Promise<UpgradeJournalEntry> {
    return this.serialized(async () => {
      const existing = [...(await this.entries())];
      const recorded: UpgradeJournalEntry = {
        ...entry,
        sequence: (existing.at(-1)?.sequence ?? 0) + 1,
        timestamp: this.now(),
      };
      validateUpgradeJournalEntry(recorded);
      await this.save([...existing, recorded]);
      return structuredClone(recorded);
    });
  }

  private async save(entries: readonly UpgradeJournalEntry[]): Promise<void> {
    const payload: UpgradeJournalFile = {
      version: 1,
      entries: entries.map((entry) => ({
        ...entry,
        timestamp: entry.timestamp.toISOString(),
      })),
    };
    // Durability here is the whole point of the journal: recovery after a
    // controller restart during a drain/deploy boundary. `rename` is atomic but
    // its directory entry is not durable until the parent directory is fsynced,
    // so the shared helper owns both syncs rather than each call site.
    await writeFileAtomicDurable(this.path, `${canonicalJson(payload)}\n`);
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export interface DeploymentInstance {
  id: string;
  version: string;
  healthy: boolean;
  zone?: string;
  /** Explicit false means the instance is drained from the traffic plane. */
  trafficEnabled?: boolean;
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
  | "recovery"
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
  private executing = false;

  constructor(
    private readonly adapter: DeploymentAdapter,
    private readonly compatibility: VersionCompatibilityMatrix,
    private readonly journal: UpgradeJournal = new InMemoryUpgradeJournal(),
  ) {}

  usesJournal(journal: UpgradeJournal): boolean {
    return this.journal === journal;
  }

  async execute(plan: RollingUpgradePlan): Promise<UpgradeResult> {
    if (this.executing) {
      throw new Error("an upgrade is already in progress");
    }
    this.executing = true;
    try {
      return await this.executeExclusive(plan);
    } finally {
      this.executing = false;
    }
  }

  private async executeExclusive(
    plan: RollingUpgradePlan,
  ): Promise<UpgradeResult> {
    validateUpgradePlan(plan);
    parseVersion(plan.targetVersion);
    let instances = [...(await this.adapter.instances())].sort(
      stableInstanceOrder,
    );
    validateDeploymentInstances(instances);
    if (instances.length === 0) {
      throw new Error("cannot run an upgrade without deployment instances");
    }
    const events: UpgradeEvent[] = [];
    await this.reconcileInterrupted(instances, plan.healthTimeoutMs, events);
    instances = [...(await this.adapter.instances())].sort(stableInstanceOrder);
    validateDeploymentInstances(instances);
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
        try {
          // Persist intent before crossing the first traffic-plane side effect.
          await this.journal.append({
            targetVersion: plan.targetVersion,
            instanceId: instance.id,
            originalVersion: instance.version,
            status: "drain-started",
          });
          changed.push(instance.id);
          await this.adapter.drain(instance.id);
          await this.adapter.deploy(instance.id, plan.targetVersion);
          await this.journal.append({
            targetVersion: plan.targetVersion,
            instanceId: instance.id,
            originalVersion: instance.version,
            status: "deployed",
          });
          const healthy = await this.adapter.waitUntilHealthy(
            instance.id,
            plan.targetVersion,
            plan.healthTimeoutMs,
          );
          if (!healthy) {
            throw new Error(`health gate timed out for ${instance.id}`);
          }
          await this.journal.append({
            targetVersion: plan.targetVersion,
            instanceId: instance.id,
            originalVersion: instance.version,
            status: "healthy",
          });
          await this.adapter.restoreTraffic(instance.id);
          await this.journal.append({
            targetVersion: plan.targetVersion,
            instanceId: instance.id,
            originalVersion: instance.version,
            status: "traffic-restored",
          });
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
          await this.journal.append({
            targetVersion: plan.targetVersion,
            instanceId,
            originalVersion: original,
            status: "rollback-started",
          });
        } catch (journalError) {
          rollbackFailures.push(
            `${instanceId}: could not journal rollback start: ${errorMessage(journalError)}`,
          );
        }
        try {
          await this.adapter.rollback(instanceId, original);
          await this.adapter.restoreTraffic(instanceId);
          try {
            await this.journal.append({
              targetVersion: plan.targetVersion,
              instanceId,
              originalVersion: original,
              status: "rolled-back",
            });
          } catch (journalError) {
            rollbackFailures.push(
              `${instanceId}: rollback completed but could not be journaled: ${errorMessage(journalError)}`,
            );
          }
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
          try {
            await this.journal.append({
              targetVersion: plan.targetVersion,
              instanceId,
              originalVersion: original,
              status: "rollback-failed",
              error: errorMessage(rollbackError),
            });
          } catch (journalError) {
            rollbackFailures.push(
              `${instanceId}: could not journal rollback failure: ${errorMessage(journalError)}`,
            );
          }
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

  private async reconcileInterrupted(
    instances: readonly DeploymentInstance[],
    healthTimeoutMs: number,
    events: UpgradeEvent[],
  ): Promise<void> {
    const latest = latestUpgradeStates(await this.journal.entries());
    for (const instance of instances) {
      const entry = latest.get(instance.id);
      const incomplete =
        entry &&
        entry.status !== "traffic-restored" &&
        entry.status !== "rolled-back";
      if (!incomplete && instance.trafficEnabled !== false) {
        continue;
      }
      events.push({
        stage: "recovery",
        instanceId: instance.id,
        fromVersion: instance.version,
        toVersion: entry?.targetVersion ?? instance.version,
        outcome: "started",
      });
      try {
        if (!entry) {
          if (!instance.healthy) {
            throw new Error(
              `drained instance ${instance.id} is unhealthy and has no recovery journal`,
            );
          }
          await this.adapter.restoreTraffic(instance.id);
        } else if (
          entry.status === "rollback-started" ||
          entry.status === "rollback-failed"
        ) {
          await this.recoverOriginal(entry);
        } else if (instance.version === entry.targetVersion) {
          const healthy = await this.adapter.waitUntilHealthy(
            instance.id,
            entry.targetVersion,
            healthTimeoutMs,
          );
          if (healthy) {
            await this.journal.append({
              targetVersion: entry.targetVersion,
              instanceId: entry.instanceId,
              originalVersion: entry.originalVersion,
              status: "healthy",
            });
            await this.adapter.restoreTraffic(instance.id);
            await this.journal.append({
              targetVersion: entry.targetVersion,
              instanceId: entry.instanceId,
              originalVersion: entry.originalVersion,
              status: "traffic-restored",
            });
          } else {
            await this.recoverOriginal(entry);
          }
        } else {
          // A crash before/inside deploy left the node at its old or an
          // indeterminate version. Restore the certified original and traffic.
          await this.recoverOriginal(entry);
        }
        events.push({
          stage: "recovery",
          instanceId: instance.id,
          fromVersion: instance.version,
          toVersion: entry?.targetVersion ?? instance.version,
          outcome: "restored",
        });
      } catch (error) {
        events.push({
          stage: "recovery",
          instanceId: instance.id,
          fromVersion: instance.version,
          toVersion: entry?.targetVersion ?? instance.version,
          outcome: "failed",
          error: errorMessage(error),
        });
        throw error;
      }
    }
  }

  private async recoverOriginal(entry: UpgradeJournalEntry): Promise<void> {
    await this.journal.append({
      targetVersion: entry.targetVersion,
      instanceId: entry.instanceId,
      originalVersion: entry.originalVersion,
      status: "rollback-started",
    });
    try {
      await this.adapter.rollback(entry.instanceId, entry.originalVersion);
      await this.adapter.restoreTraffic(entry.instanceId);
      await this.journal.append({
        targetVersion: entry.targetVersion,
        instanceId: entry.instanceId,
        originalVersion: entry.originalVersion,
        status: "rolled-back",
      });
    } catch (error) {
      try {
        await this.journal.append({
          targetVersion: entry.targetVersion,
          instanceId: entry.instanceId,
          originalVersion: entry.originalVersion,
          status: "rollback-failed",
          error: errorMessage(error),
        });
      } catch {
        // Preserve the recovery failure that identifies the side effect.
      }
      throw error;
    }
  }
}

function currentAppliedMigrations(
  entries: readonly MigrationJournalEntry[],
): Set<string> {
  const states = latestMigrationStates(entries);
  return new Set(
    [...states.entries()]
      .filter(([, entry]) => entry.status === "applied")
      .map(([id]) => id),
  );
}

function latestMigrationStates(
  entries: readonly MigrationJournalEntry[],
): Map<string, MigrationJournalEntry> {
  const states = new Map<string, MigrationJournalEntry>();
  for (const entry of [...entries].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    states.set(entry.migrationId, entry);
  }
  return states;
}

function latestUpgradeStates(
  entries: readonly UpgradeJournalEntry[],
): Map<string, UpgradeJournalEntry> {
  const states = new Map<string, UpgradeJournalEntry>();
  for (const entry of [...entries].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    validateUpgradeJournalEntry(entry);
    states.set(entry.instanceId, entry);
  }
  return states;
}

function validateUpgradeJournalEntry(entry: UpgradeJournalEntry): void {
  parseVersion(entry.targetVersion);
  parseVersion(entry.originalVersion);
  if (!entry.instanceId?.trim()) {
    throw new Error("upgrade journal instance id cannot be empty");
  }
  if (
    !Number.isSafeInteger(entry.sequence) ||
    entry.sequence < 1 ||
    !(entry.timestamp instanceof Date) ||
    Number.isNaN(entry.timestamp.getTime())
  ) {
    throw new Error("invalid upgrade journal sequence or timestamp");
  }
  const statuses: readonly UpgradeJournalStatus[] = [
    "drain-started",
    "deployed",
    "healthy",
    "traffic-restored",
    "rollback-started",
    "rolled-back",
    "rollback-failed",
  ];
  if (!statuses.includes(entry.status)) {
    throw new Error(`invalid upgrade journal status: ${String(entry.status)}`);
  }
}

function validateDeploymentInstances(
  instances: readonly DeploymentInstance[],
): void {
  const ids = new Set<string>();
  for (const instance of instances) {
    if (!instance.id?.trim() || ids.has(instance.id)) {
      throw new Error(
        `deployment instance ids must be non-empty and unique: ${instance.id}`,
      );
    }
    ids.add(instance.id);
    parseVersion(instance.version);
  }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
