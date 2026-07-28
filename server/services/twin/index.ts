/**
 * Digital Twin Service
 * ADR-0013 [13.3] — Issue #214
 *
 * Singleton wrapper: drives running models on their time step, feeds live
 * tag updates into the runtime (numeric, good-quality readings only), and
 * exposes health. Read-only toward the plant — predictions never become
 * control writes here.
 *
 * #550: the model registry and one committed checkpoint per model are durable.
 * `initialize()` reloads them, always in a stopped/idle state — a restart never
 * resumes stepping or live-data assimilation on its own. Registry mutations go
 * through `PersistentTwinRegistry`, which keeps storage and the in-memory
 * registry inside the same transaction.
 */

import { EventEmitter } from 'events';

export * from './solver';
export * from './engine';
export * from './persistence';
export * from './registry';

import type {
  ProcessModel,
  SimulationState,
  TwinCheckpoint,
  TwinRestoreReport,
} from '@shared/types/digital-twin';
import { TwinRuntime } from './engine';
import { twinStore, type TwinPersistence, type TwinStoreBackend } from './persistence';
import { PersistentTwinRegistry } from './registry';

export interface TwinTagUpdateInput {
  tagName: string;
  value: number | string | boolean;
  timestamp: string | number;
  quality?: 'good' | 'bad' | 'uncertain';
}

/**
 * What the twin can say about its durable state, for `/api/twin/status`.
 *
 * `configured: false` means this instance was constructed without a store and
 * keeps nothing across a restart. It is reported rather than implied, because
 * a twin that silently forgets its models is the defect #550 removed.
 */
export interface TwinPersistenceStatus {
  configured: boolean;
  backend: TwinStoreBackend;
  /** Set when the last restore attempt could not read storage at all. */
  error?: string;
  lastRestore?: TwinRestoreReport;
}

export class DigitalTwinService extends EventEmitter {
  readonly runtime = new TwinRuntime();
  private readonly registry: PersistentTwinRegistry | null;

  private initialized = false;
  private stepTimer: NodeJS.Timeout | null = null;
  private readonly stepIntervalMs: number;
  private restoreError: string | undefined;

  /**
   * @param persistence durable store, or null for an ephemeral runtime — the
   *   default, so constructing a service never opens a database handle.
   */
  constructor(
    stepIntervalMs = 100,
    private readonly persistence: TwinPersistence | null = null,
  ) {
    super();
    this.stepIntervalMs = stepIntervalMs;
    this.registry = persistence ? new PersistentTwinRegistry(this.runtime, persistence) : null;
    this.runtime.on('model-error', (e) => this.emit('model-error', e));
    this.runtime.on('model-warnings', (e) => this.emit('model-warnings', e));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.registry) {
      try {
        const report = await this.registry.restore();
        this.restoreError = undefined;
        if (report.failed.length > 0) {
          this.emit('restore-failures', { failures: report.failed });
        }
      } catch (error) {
        // Reads degrade visibly rather than silently: the runtime starts
        // empty, and every later registry mutation still goes through the
        // store, so it fails loudly instead of pretending to persist.
        this.restoreError = error instanceof Error ? error.message : String(error);
        this.emit('restore-error', { error: this.restoreError });
      }
    }
    this.stepTimer = setInterval(() => {
      try {
        const now = Date.now();
        this.runtime.syncRunningFromLive(now);
        this.runtime.stepRunning(now);
      } catch {
        /* per-model errors surface via 'model-error' */
      }
    }, this.stepIntervalMs);
    this.stepTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.stepTimer) {
      clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
    this.initialized = false;
    if (this.persistence) await this.persistence.close();
  }

  /**
   * Register a model. With a store configured, the definition and its initial
   * checkpoint are committed in the same transaction as the in-memory
   * registration, so a failure leaves neither behind.
   */
  async registerModel(model: ProcessModel): Promise<SimulationState> {
    if (!this.registry) return this.runtime.registerModel(model);
    return this.registry.registerModel(model);
  }

  /** Remove a model from the runtime and storage atomically. */
  async removeModel(modelId: string): Promise<boolean> {
    if (!this.registry) return this.runtime.removeModel(modelId);
    return this.registry.removeModel(modelId);
  }

  /**
   * Commit the model's current simulation state as its durable checkpoint —
   * the state a restart would restore, always brought back idle.
   */
  async commitCheckpoint(modelId: string): Promise<TwinCheckpoint> {
    if (!this.registry) {
      throw new Error('Digital twin persistence is not configured; cannot commit a checkpoint');
    }
    return this.registry.commitCheckpoint(modelId);
  }

  persistenceStatus(): TwinPersistenceStatus {
    const lastRestore = this.registry?.lastRestore();
    return {
      configured: this.registry !== null,
      backend: this.persistence?.backend() ?? 'unopened',
      ...(this.restoreError !== undefined ? { error: this.restoreError } : {}),
      ...(lastRestore !== undefined ? { lastRestore } : {}),
    };
  }

  /** Feed a live tag update — non-numeric or non-good readings are ignored */
  ingestTagUpdate(update: TwinTagUpdateInput): void {
    if (update.quality !== undefined && update.quality !== 'good') return;
    if (typeof update.value === 'boolean') return;
    if (typeof update.value === 'string' && update.value.trim() === '') return;
    const value = typeof update.value === 'number' ? update.value : Number(update.value);
    if (!Number.isFinite(value)) return;
    const timestamp =
      typeof update.timestamp === 'number'
        ? update.timestamp
        : new Date(update.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return;
    this.runtime.ingestActual(update.tagName, value, timestamp);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const status = this.runtime.getStatus();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Digital twin running: ${status.models} models (${status.running} live), ${status.boundTags} bound tags`
        : 'Digital twin service not initialized',
    };
  }
}

export const digitalTwinService = new DigitalTwinService(100, twinStore);
