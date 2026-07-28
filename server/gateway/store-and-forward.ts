/**
 * Durable edge store-and-forward service.
 *
 * Network and storage mechanisms are ports: production can use the included
 * atomic JSON queue or provide SQLite, NATS, or cloud transports without
 * changing retry, integrity, or conflict semantics.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log, logError } from "../logger";
import {
  canonicalJson,
  merkleRoot,
  sha256Hex,
} from "../scaling/hash";

export interface StoreAndForwardConfig {
  maxLocalStorage: number;
  forwardBatchSize: number;
  heartbeatInterval: number;
  retryInterval: number;
  maxRetryInterval: number;
  storagePath: string;
}

export type EdgeRecordKind = "telemetry" | "configuration";

export interface FieldVersion {
  timestamp: Date;
  origin: string;
}

export interface StoredRecord {
  id: string;
  timestamp: Date;
  data: unknown;
  attempts: number;
  driverId?: string;
  kind: EdgeRecordKind;
  origin: string;
  fieldVersions?: Record<string, FieldVersion>;
  checksum: string;
}

export interface StoreOptions {
  kind?: EdgeRecordKind;
  origin?: string;
  timestamp?: Date;
  fieldVersions?: Readonly<Record<string, FieldVersion>>;
}

export interface ConnectivityStatus {
  isConnected: boolean;
  lastSuccessfulForward: Date | null;
  pendingRecords: number;
  lastError?: string;
  consecutiveFailures: number;
  nextRetryAt: Date | null;
  divergenceCount: number;
}

export interface DurableEdgeQueue {
  load(): Promise<readonly StoredRecord[]>;
  save(records: readonly StoredRecord[]): Promise<void>;
}

interface SerializedRecord
  extends Omit<StoredRecord, "timestamp" | "fieldVersions"> {
  timestamp: string;
  fieldVersions?: Record<string, { timestamp: string; origin: string }>;
}

interface QueueFile {
  version: 1;
  records: SerializedRecord[];
}

/**
 * Crash-safe single-file queue: write complete snapshot, then atomically rename.
 * A database-backed adapter can implement the same contract for larger queues.
 */
export class JsonFileEdgeQueue implements DurableEdgeQueue {
  constructor(readonly path: string) {}

  async load(): Promise<readonly StoredRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(contents) as Partial<QueueFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error(`unsupported or corrupt edge queue: ${this.path}`);
    }
    return parsed.records.map(deserializeRecord);
  }

  async save(records: readonly StoredRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const payload: QueueFile = {
      version: 1,
      records: records.map(serializeRecord),
    };
    await writeFile(temporary, `${canonicalJson(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, this.path);
  }
}

/** Deterministic queue adapter for tests and embedders with their own durability. */
export class MemoryEdgeQueue implements DurableEdgeQueue {
  private records: StoredRecord[];
  constructor(initial: readonly StoredRecord[] = []) {
    this.records = initial.map(cloneRecord);
  }
  async load(): Promise<readonly StoredRecord[]> {
    return this.records.map(cloneRecord);
  }
  async save(records: readonly StoredRecord[]): Promise<void> {
    this.records = records.map(cloneRecord);
  }
}

export interface EdgeReplicaValue {
  data: unknown;
  timestamp: Date;
  origin: string;
  fieldVersions?: Readonly<Record<string, FieldVersion>>;
}

export interface UpstreamConflict {
  recordId: string;
  remote: EdgeReplicaValue;
}

export interface ForwardBatch {
  records: readonly StoredRecord[];
  merkleRoot: string;
}

export interface ForwardBatchResult {
  acknowledgedIds: readonly string[];
  verifiedMerkleRoot: string;
  conflicts?: readonly UpstreamConflict[];
}

export interface EdgeUpstreamTransport {
  isReachable(signal?: AbortSignal): Promise<boolean>;
  forward(
    batch: ForwardBatch,
    signal?: AbortSignal,
  ): Promise<ForwardBatchResult>;
}

/**
 * Backwards-compatible default transport. It has no sockets; deployments should
 * inject their actual HTTP/NATS transport. Environment state only controls the
 * local reference implementation's availability.
 */
export class EnvironmentEdgeTransport implements EdgeUpstreamTransport {
  async isReachable(): Promise<boolean> {
    return (
      process.env.NODE_ENV === "development" ||
      process.env.SIMULATE_CONNECTIVITY === "true"
    );
  }

  async forward(batch: ForwardBatch): Promise<ForwardBatchResult> {
    return {
      acknowledgedIds: batch.records.map((record) => record.id),
      verifiedMerkleRoot: batch.merkleRoot,
    };
  }
}

export interface LocalEdgeProcessor {
  process(record: Readonly<StoredRecord>): void | Promise<void>;
}

export interface DivergenceReporter {
  report(divergence: Readonly<DivergenceReport>): void | Promise<void>;
}

export interface DivergenceReport {
  type: "integrity" | "telemetry-conflict" | "configuration-conflict";
  recordId?: string;
  resolution: "retry-local" | "local-wins" | "remote-wins" | "merged";
  detail: string;
  detectedAt: Date;
}

export interface StoreAndForwardDependencies {
  queue?: DurableEdgeQueue;
  transport?: EdgeUpstreamTransport;
  now?: () => Date;
  idFactory?: () => string;
  localProcessors?: readonly LocalEdgeProcessor[];
  divergenceReporter?: DivergenceReporter;
}

export class QueueCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`edge queue capacity of ${capacity} records has been reached`);
    this.name = "QueueCapacityError";
  }
}

export class QueueIntegrityError extends Error {
  constructor(readonly recordId: string) {
    super(`edge queue integrity verification failed for record ${recordId}`);
    this.name = "QueueIntegrityError";
  }
}

export class StoreAndForwardService extends EventEmitter {
  private readonly localStore = new Map<string, StoredRecord>();
  private isConnected = false;
  private timer?: NodeJS.Timeout;
  private lastSuccessfulForward: Date | null = null;
  private lastError?: string;
  private consecutiveFailures = 0;
  private nextRetryAt: Date | null = null;
  private divergenceCount = 0;
  private initialized = false;
  private stopped = true;
  private operation: Promise<void> = Promise.resolve();
  private readonly config: StoreAndForwardConfig;
  private readonly queue: DurableEdgeQueue;
  private readonly transport: EdgeUpstreamTransport;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly localProcessors: readonly LocalEdgeProcessor[];
  private readonly divergenceReporter?: DivergenceReporter;

  constructor(
    config?: Partial<StoreAndForwardConfig>,
    dependencies: StoreAndForwardDependencies = {},
  ) {
    super();
    this.config = {
      maxLocalStorage: 10_000,
      forwardBatchSize: 100,
      heartbeatInterval: 30_000,
      retryInterval: 1_000,
      maxRetryInterval: 60_000,
      storagePath:
        process.env.STORE_AND_FORWARD_PATH ??
        join(process.cwd(), ".data", "store-and-forward-queue.json"),
      ...config,
    };
    validateConfig(this.config);
    this.queue =
      dependencies.queue ?? new JsonFileEdgeQueue(this.config.storagePath);
    this.transport = dependencies.transport ?? new EnvironmentEdgeTransport();
    this.now = dependencies.now ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
    this.localProcessors = dependencies.localProcessors ?? [];
    this.divergenceReporter = dependencies.divergenceReporter;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const loaded = (await this.queue.load()).map(cloneRecord);
    for (const record of loaded) {
      assertRecordIntegrity(record);
    }
    const ids = new Set<string>();
    for (const record of loaded) {
      if (ids.has(record.id)) {
        throw new Error(`duplicate record ${record.id} in durable edge queue`);
      }
      ids.add(record.id);
    }
    this.localStore.clear();
    for (const record of loaded) {
      this.localStore.set(record.id, record);
    }
    this.initialized = true;
    this.stopped = false;
    log(`Store-and-forward initialized with ${this.localStore.size} queued records`);
    this.emit("initialized");
    await this.runConnectivityCycle();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.operation;
    if (this.initialized) {
      await this.persist();
    }
    this.nextRetryAt = null;
    this.isConnected = false;
    this.initialized = false;
    this.localStore.clear();
    this.emit("shutdown");
  }

  /**
   * Durably commits before local processing or upstream forwarding. Queue
   * pressure is fail-closed: existing industrial data is never evicted.
   */
  async store(
    data: unknown,
    driverId?: string,
    options: StoreOptions = {},
  ): Promise<void> {
    this.assertInitialized();
    await this.serialized(async () => {
      if (this.localStore.size >= this.config.maxLocalStorage) {
        throw new QueueCapacityError(this.config.maxLocalStorage);
      }
      const timestamp = options.timestamp
        ? new Date(options.timestamp)
        : this.now();
      const recordWithoutChecksum: Omit<StoredRecord, "checksum"> = {
        id: this.idFactory(),
        timestamp,
        data: structuredClone(data),
        attempts: 0,
        driverId,
        kind: options.kind ?? "telemetry",
        origin: options.origin ?? driverId ?? "edge",
        fieldVersions: options.fieldVersions
          ? cloneFieldVersions(options.fieldVersions)
          : undefined,
      };
      const record: StoredRecord = {
        ...recordWithoutChecksum,
        checksum: recordChecksum(recordWithoutChecksum),
      };
      this.localStore.set(record.id, record);
      try {
        await this.persist();
      } catch (error) {
        this.localStore.delete(record.id);
        throw error;
      }
      this.emit("stored", cloneRecord(record));
      await this.processLocally(record);
    });

    if (this.isConnected) {
      try {
        await this.synchronizeNow();
        if (!this.isConnected) {
          this.schedule(this.currentBackoffMs());
        }
      } catch (error) {
        this.recordConnectionFailure(error);
        this.schedule(this.currentBackoffMs());
      }
    }
  }

  getStatus(): ConnectivityStatus {
    return {
      isConnected: this.isConnected,
      lastSuccessfulForward: this.lastSuccessfulForward
        ? new Date(this.lastSuccessfulForward)
        : null,
      pendingRecords: this.localStore.size,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt) : null,
      divergenceCount: this.divergenceCount,
    };
  }

  pending(): StoredRecord[] {
    return [...this.localStore.values()].map(cloneRecord);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const pendingCount = this.localStore.size;
    if (pendingCount >= this.config.maxLocalStorage * 0.8) {
      return {
        healthy: false,
        message: `Store-and-forward overloaded: ${pendingCount} pending records`,
      };
    }
    if (this.lastError && this.consecutiveFailures > 0) {
      return {
        healthy: false,
        message: `Store-and-forward disconnected: ${this.lastError}; ${pendingCount} pending records`,
      };
    }
    return {
      healthy: true,
      message: `Store-and-forward healthy: ${pendingCount} pending records`,
    };
  }

  /**
   * One deterministic connectivity/backoff step. Public so schedulers and tests
   * can drive it without waiting on wall-clock timers.
   */
  async runConnectivityCycle(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      const reachable = await this.transport.isReachable(signal);
      if (this.stopped) {
        return false;
      }
      if (!reachable) {
        throw new Error("upstream is unreachable");
      }
      const changed = !this.isConnected;
      this.isConnected = true;
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      if (changed) {
        this.emit("connectivity-changed", true);
      }
      await this.synchronizeNow(signal);
      if (!this.isConnected) {
        this.schedule(this.currentBackoffMs());
        return false;
      }
      this.schedule(this.config.heartbeatInterval);
      return true;
    } catch (error) {
      this.recordConnectionFailure(error);
      this.schedule(this.currentBackoffMs());
      return false;
    }
  }

  async checkConnectivity(signal?: AbortSignal): Promise<boolean> {
    return this.runConnectivityCycle(signal);
  }

  /** Drain available records in bounded batches until empty or a failure occurs. */
  async synchronizeNow(signal?: AbortSignal): Promise<number> {
    this.assertInitialized();
    if (!this.isConnected) {
      return 0;
    }
    let forwarded = 0;
    await this.serialized(async () => {
      while (this.localStore.size > 0 && this.isConnected) {
        const batch = [...this.localStore.values()].slice(
          0,
          this.config.forwardBatchSize,
        );
        const root = merkleRoot(batch.map(integrityPayload));
        let result: ForwardBatchResult;
        try {
          result = await this.transport.forward(
            { records: batch.map(cloneRecord), merkleRoot: root },
            signal,
          );
        } catch (error) {
          for (const record of batch) {
            record.attempts += 1;
            record.checksum = recordChecksum(record);
          }
          await this.persist();
          this.recordConnectionFailure(error);
          break;
        }

        if (result.verifiedMerkleRoot !== root) {
          await this.reportDivergence({
            type: "integrity",
            resolution: "retry-local",
            detail: `upstream verified ${result.verifiedMerkleRoot}, expected ${root}`,
            detectedAt: this.now(),
          });
          for (const record of batch) {
            record.attempts += 1;
            record.checksum = recordChecksum(record);
          }
          await this.persist();
          this.recordConnectionFailure(new Error("upstream Merkle root mismatch"));
          break;
        }

        const batchIds = new Set(batch.map((record) => record.id));
        const conflicts = new Map(
          (result.conflicts ?? []).map((conflict) => [
            conflict.recordId,
            conflict,
          ]),
        );
        const acknowledged = new Set<string>();
        for (const id of result.acknowledgedIds) {
          if (!batchIds.has(id)) {
            throw new Error(`upstream acknowledged unknown record ${id}`);
          }
          if (!conflicts.has(id)) {
            acknowledged.add(id);
          }
        }
        for (const conflict of conflicts.values()) {
          if (!batchIds.has(conflict.recordId)) {
            throw new Error(`upstream reported conflict for unknown record ${conflict.recordId}`);
          }
          await this.reconcileConflict(
            this.localStore.get(conflict.recordId)!,
            conflict.remote,
          );
        }
        for (const id of acknowledged) {
          this.localStore.delete(id);
          forwarded += 1;
        }

        const unresolved = batch.filter(
          (record) =>
            this.localStore.has(record.id) && !conflicts.has(record.id),
        );
        for (const record of unresolved) {
          record.attempts += 1;
          record.checksum = recordChecksum(record);
        }
        await this.persist();
        if (acknowledged.size > 0) {
          this.lastSuccessfulForward = this.now();
          this.emit("forwarded", acknowledged.size);
        }
        if (acknowledged.size === 0 && conflicts.size === 0) {
          this.recordConnectionFailure(
            new Error("upstream made no progress acknowledging batch"),
          );
          break;
        }
        // A merged/local-winning record must be offered again in a later sync.
        // Breaking prevents a peer that repeatedly reports the same conflict
        // from creating an unbounded tight loop.
        if (conflicts.size > 0) {
          break;
        }
      }
    });
    return forwarded;
  }

  private async reconcileConflict(
    local: StoredRecord,
    remote: EdgeReplicaValue,
  ): Promise<void> {
    if (local.kind === "telemetry") {
      const winner = resolveTelemetryConflict(local, remote);
      const localWins =
        winner.origin === local.origin &&
        winner.timestamp.getTime() === local.timestamp.getTime() &&
        canonicalJson(winner.data) === canonicalJson(local.data);
      await this.reportDivergence({
        type: "telemetry-conflict",
        recordId: local.id,
        resolution: localWins ? "local-wins" : "remote-wins",
        detail: `last-writer-wins selected ${winner.origin}`,
        detectedAt: this.now(),
      });
      if (!localWins) {
        this.localStore.delete(local.id);
      } else {
        local.attempts += 1;
        local.checksum = recordChecksum(local);
      }
      return;
    }

    const merged = mergeConfigurationConflict(local, remote);
    local.data = merged.data;
    local.fieldVersions = merged.fieldVersions;
    local.timestamp = merged.timestamp;
    local.origin = merged.origin;
    local.attempts += 1;
    local.checksum = recordChecksum(local);
    await this.reportDivergence({
      type: "configuration-conflict",
      recordId: local.id,
      resolution: "merged",
      detail: `merged ${Object.keys(merged.fieldVersions ?? {}).length} versioned fields`,
      detectedAt: this.now(),
    });
  }

  private async processLocally(record: StoredRecord): Promise<void> {
    const results = await Promise.allSettled(
      this.localProcessors.map((processor) =>
        Promise.resolve().then(() => processor.process(cloneRecord(record))),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        const message = errorMessage(result.reason);
        logError(result.reason, `Local edge processor failed: ${message}`);
        this.emit("local-operation-error", message);
      }
    }
  }

  private recordConnectionFailure(error: unknown): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.consecutiveFailures += 1;
    this.lastError = errorMessage(error);
    if (wasConnected || this.consecutiveFailures === 1) {
      this.emit("connectivity-changed", false);
    }
    logError(error, "Store-and-forward connectivity/sync failure");
  }

  private currentBackoffMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(
      this.config.maxRetryInterval,
      this.config.retryInterval * 2 ** Math.min(exponent, 30),
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.nextRetryAt = this.isConnected
      ? null
      : new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      void this.runConnectivityCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async reportDivergence(report: DivergenceReport): Promise<void> {
    this.divergenceCount += 1;
    this.emit("divergence", structuredClone(report));
    await this.divergenceReporter?.report(structuredClone(report));
  }

  private async persist(): Promise<void> {
    await this.queue.save([...this.localStore.values()].map(cloneRecord));
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("store-and-forward service is not initialized");
    }
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

/** Telemetry uses timestamp LWW, then origin and canonical value as tie-breakers. */
export function resolveTelemetryConflict(
  local: EdgeReplicaValue,
  remote: EdgeReplicaValue,
): EdgeReplicaValue {
  const comparison =
    local.timestamp.getTime() - remote.timestamp.getTime() ||
    local.origin.localeCompare(remote.origin) ||
    canonicalJson(local.data).localeCompare(canonicalJson(remote.data));
  return structuredClone(comparison >= 0 ? local : remote);
}

/**
 * Configuration is merged per leaf using explicit field clocks. This preserves
 * non-conflicting edits from both peers and deterministically resolves the same
 * field by timestamp then origin.
 */
export function mergeConfigurationConflict(
  local: EdgeReplicaValue,
  remote: EdgeReplicaValue,
): EdgeReplicaValue {
  if (!isPlainObject(local.data) || !isPlainObject(remote.data)) {
    throw new Error("configuration conflict values must be objects");
  }
  const localFlat = flatten(local.data);
  const remoteFlat = flatten(remote.data);
  const localVersions = normalizedFieldVersions(local, localFlat);
  const remoteVersions = normalizedFieldVersions(remote, remoteFlat);
  const mergedFlat = new Map<string, unknown>();
  const mergedVersions: Record<string, FieldVersion> = {};
  const paths = new Set([...localFlat.keys(), ...remoteFlat.keys()]);

  for (const path of [...paths].sort()) {
    const localVersion = localVersions[path];
    const remoteVersion = remoteVersions[path];
    if (!localVersion) {
      mergedFlat.set(path, structuredClone(remoteFlat.get(path)));
      mergedVersions[path] = cloneFieldVersion(remoteVersion);
      continue;
    }
    if (!remoteVersion) {
      mergedFlat.set(path, structuredClone(localFlat.get(path)));
      mergedVersions[path] = cloneFieldVersion(localVersion);
      continue;
    }
    const comparison =
      localVersion.timestamp.getTime() - remoteVersion.timestamp.getTime() ||
      localVersion.origin.localeCompare(remoteVersion.origin) ||
      canonicalJson(localFlat.get(path)).localeCompare(
        canonicalJson(remoteFlat.get(path)),
      );
    if (comparison >= 0) {
      mergedFlat.set(path, structuredClone(localFlat.get(path)));
      mergedVersions[path] = cloneFieldVersion(localVersion);
    } else {
      mergedFlat.set(path, structuredClone(remoteFlat.get(path)));
      mergedVersions[path] = cloneFieldVersion(remoteVersion);
    }
  }
  const latest = Object.values(mergedVersions).sort(
    (left, right) =>
      right.timestamp.getTime() - left.timestamp.getTime() ||
      right.origin.localeCompare(left.origin),
  )[0];
  return {
    data: unflatten(mergedFlat),
    fieldVersions: mergedVersions,
    timestamp: latest?.timestamp ?? maxDate(local.timestamp, remote.timestamp),
    origin: latest?.origin ?? [local.origin, remote.origin].sort().at(-1)!,
  };
}

function normalizedFieldVersions(
  value: EdgeReplicaValue,
  fields: ReadonlyMap<string, unknown>,
): Record<string, FieldVersion> {
  const result: Record<string, FieldVersion> = {};
  for (const path of fields.keys()) {
    const explicit = value.fieldVersions?.[path];
    result[path] = explicit
      ? cloneFieldVersion(explicit)
      : { timestamp: new Date(value.timestamp), origin: value.origin };
  }
  return result;
}

function flatten(
  value: Readonly<Record<string, unknown>>,
  prefix = "",
  result = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child) && Object.keys(child).length > 0) {
      flatten(child, path, result);
    } else {
      result.set(path, structuredClone(child));
    }
  }
  return result;
}

function unflatten(fields: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, value] of fields) {
    const segments = path.split(".");
    let cursor = result;
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        cursor[segment] = structuredClone(value);
      } else {
        const child = cursor[segment];
        if (!isPlainObject(child)) {
          cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
      }
    });
  }
  return result;
}

function integrityPayload(record: StoredRecord): unknown {
  const { checksum: _checksum, ...payload } = record;
  return payload;
}

function recordChecksum(record: Omit<StoredRecord, "checksum"> | StoredRecord): string {
  const { checksum: _checksum, ...payload } = record as StoredRecord;
  return sha256Hex(canonicalJson(payload));
}

function assertRecordIntegrity(record: StoredRecord): void {
  if (record.checksum !== recordChecksum(record)) {
    throw new QueueIntegrityError(record.id);
  }
}

function serializeRecord(record: StoredRecord): SerializedRecord {
  return {
    ...structuredClone(record),
    timestamp: record.timestamp.toISOString(),
    fieldVersions: record.fieldVersions
      ? Object.fromEntries(
          Object.entries(record.fieldVersions).map(([path, version]) => [
            path,
            {
              timestamp: version.timestamp.toISOString(),
              origin: version.origin,
            },
          ]),
        )
      : undefined,
  };
}

function deserializeRecord(record: SerializedRecord): StoredRecord {
  if (!record.id || !record.checksum || !record.kind || !record.origin) {
    throw new Error("corrupt edge queue record");
  }
  const timestamp = new Date(record.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`invalid timestamp for edge queue record ${record.id}`);
  }
  return {
    ...record,
    timestamp,
    fieldVersions: record.fieldVersions
      ? Object.fromEntries(
          Object.entries(record.fieldVersions).map(([path, version]) => {
            const parsed = new Date(version.timestamp);
            if (Number.isNaN(parsed.getTime())) {
              throw new Error(`invalid field timestamp for edge queue record ${record.id}`);
            }
            return [path, { timestamp: parsed, origin: version.origin }];
          }),
        )
      : undefined,
  };
}

function cloneRecord(record: StoredRecord): StoredRecord {
  return structuredClone(record);
}

function cloneFieldVersions(
  versions: Readonly<Record<string, FieldVersion>>,
): Record<string, FieldVersion> {
  return Object.fromEntries(
    Object.entries(versions).map(([path, version]) => [
      path,
      cloneFieldVersion(version),
    ]),
  );
}

function cloneFieldVersion(version: FieldVersion): FieldVersion {
  if (!version) {
    throw new Error("missing configuration field version");
  }
  return {
    timestamp: new Date(version.timestamp),
    origin: version.origin,
  };
}

function maxDate(left: Date, right: Date): Date {
  return new Date(Math.max(left.getTime(), right.getTime()));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function validateConfig(config: StoreAndForwardConfig): void {
  for (const [name, value] of Object.entries({
    maxLocalStorage: config.maxLocalStorage,
    forwardBatchSize: config.forwardBatchSize,
    heartbeatInterval: config.heartbeatInterval,
    retryInterval: config.retryInterval,
    maxRetryInterval: config.maxRetryInterval,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (config.maxRetryInterval < config.retryInterval) {
    throw new Error("maxRetryInterval must not be less than retryInterval");
  }
  if (!config.storagePath) {
    throw new Error("storagePath is required");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const storeAndForwardService = new StoreAndForwardService();
