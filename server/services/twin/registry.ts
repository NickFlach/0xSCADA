/**
 * Transactional digital-twin registry
 * ADR-0013 [13.3] — Issue #550
 *
 * Binds the in-memory `TwinRuntime` to durable storage so the two cannot
 * diverge. Every mutation runs inside one database transaction, and the
 * in-memory mutation happens *inside* that transaction:
 *
 *   - the runtime rejects the model  → nothing was written, nothing changed
 *   - the durable write fails        → the transaction rolls back AND the
 *                                      registry is restored from the snapshot
 *                                      taken before the mutation
 *   - the COMMIT fails               → same rollback, same restore
 *
 * so a caller never observes a model that is registered but not stored, or
 * stored but not registered.
 *
 * Restore is deliberately conservative: models come back IDLE, and a stored
 * row this build cannot decode is refused for that model alone and left in
 * storage untouched. Nothing is repaired, re-seeded or invented on its behalf.
 * It holds the store exclusively while it reads AND while it applies what it
 * read, so a mutation arriving mid-restore is ordered against it instead of
 * being overwritten in memory by rows the restore had already taken.
 */

import type {
  ProcessModel,
  SimulationState,
  TwinCheckpoint,
  TwinRestoreFailure,
  TwinRestoreReport,
} from "@shared/types/digital-twin";
import { TWIN_CHECKPOINT_SCHEMA_VERSION } from "@shared/types/digital-twin";
import type { TwinCheckpointState, TwinEntrySnapshot, TwinRuntime } from "./engine";
import type { TwinPersistence } from "./persistence";

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/** The durable projection of a live simulation state (status excluded). */
function checkpointStateOf(state: SimulationState): TwinCheckpointState {
  return {
    tick: state.tick,
    timeMs: state.timeMs,
    componentStates: state.componentStates,
    ...(state.lastSyncAt !== undefined ? { lastSyncAt: state.lastSyncAt } : {}),
  };
}

export class PersistentTwinRegistry {
  private restoreReport: TwinRestoreReport | undefined;
  /**
   * Ids whose stored rows the last restore refused. They are not in the
   * runtime, but they are still in storage, so a delete must be able to reach
   * them — otherwise an undecodable row would be unremovable.
   */
  private readonly refusedModelIds = new Set<string>();

  constructor(
    private readonly runtime: TwinRuntime,
    private readonly store: TwinPersistence,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last restore pass, or undefined if none has run in this process. */
  lastRestore(): TwinRestoreReport | undefined {
    return this.restoreReport
      ? {
        scanned: this.restoreReport.scanned,
        restored: [...this.restoreReport.restored],
        failed: this.restoreReport.failed.map((failure) => ({ ...failure })),
      }
      : undefined;
  }

  /**
   * Load every stored model and its committed checkpoint into the runtime.
   *
   * Restored simulations are idle: this never starts a timer, never steps and
   * never assimilates live data. An authorized caller must explicitly start or
   * step a model before it does anything.
   *
   * The read and the apply loop run under one exclusive hold on the store. A
   * mutation that committed in between would otherwise be overwritten in
   * memory by the stale rows this pass is still carrying, leaving storage with
   * the new definition and the runtime with the old one — the divergence this
   * class exists to prevent. `load()` takes no store lock of its own, so
   * calling it inside the hold does not deadlock.
   */
  restore(): Promise<TwinRestoreReport> {
    return this.store.exclusive(async () => {
      const loaded = await this.store.load();
      const restored: string[] = [];
      const failed: TwinRestoreFailure[] = [...loaded.failures];

      for (const record of loaded.records) {
        // Validate the definition first so the reported stage is accurate: a
        // model the runtime refuses is a model problem, and anything that
        // fails only once the checkpoint is applied is a checkpoint problem.
        try {
          this.runtime.validateModelDefinition(record.model);
        } catch (error) {
          failed.push({ modelId: record.model.id, stage: "model", reason: describe(error) });
          continue;
        }
        try {
          this.runtime.restoreModel(record.model, record.checkpoint);
          restored.push(record.model.id);
        } catch (error) {
          failed.push({ modelId: record.model.id, stage: "checkpoint", reason: describe(error) });
        }
      }

      this.refusedModelIds.clear();
      for (const failure of failed) this.refusedModelIds.add(failure.modelId);
      this.restoreReport = { scanned: loaded.scanned, restored, failed };
      return this.lastRestore()!;
    });
  }

  /**
   * Register (or replace) a model and commit its current state as the first
   * checkpoint, atomically. A replaced model's previous entry — including its
   * live actuals — is restored verbatim if the durable write fails.
   */
  async registerModel(model: ProcessModel): Promise<SimulationState> {
    const committedAt = this.now();
    // Snapshotted inside the transaction, never before it: the store
    // serialises transactions, so a snapshot taken at request entry can be
    // stale by the time this body runs, and rolling back to it would undo a
    // concurrent mutation that did commit — leaving storage and the registry
    // describing different things, which is exactly what this class prevents.
    let snapshot: TwinEntrySnapshot | undefined;
    let mutated = false;
    try {
      return await this.store.transaction(async (tx) => {
        snapshot = this.runtime.exportEntry(model.id);
        mutated = true;
        const state = this.runtime.registerModel(model);
        // Persist the model exactly as the runtime stored it, so the row and
        // the registry entry can never describe different models.
        const stored = this.runtime.getModel(model.id);
        if (!stored) throw new Error(`Model "${model.id}" vanished during registration`);
        await tx.putModel(stored, checkpointStateOf(state), committedAt);
        this.refusedModelIds.delete(model.id);
        return state;
      });
    } catch (error) {
      // Nothing was touched if the transaction never reached this body.
      if (mutated) this.runtime.restoreEntry(model.id, snapshot);
      throw error;
    }
  }

  /**
   * Remove a model from storage and the runtime atomically. Also removes a
   * model whose stored rows the last restore refused, which is the operator's
   * way to clear an undecodable row.
   */
  async removeModel(modelId: string): Promise<boolean> {
    if (this.runtime.getModel(modelId) === undefined && !this.refusedModelIds.has(modelId)) {
      return false;
    }
    // As in registerModel: the snapshot must be taken inside the transaction,
    // so a rollback restores what was actually there when this body ran.
    let snapshot: TwinEntrySnapshot | undefined;
    let mutated = false;
    try {
      return await this.store.transaction(async (tx) => {
        snapshot = this.runtime.exportEntry(modelId);
        mutated = true;
        const removedFromStorage = await tx.deleteModel(modelId);
        this.runtime.removeModel(modelId);
        this.refusedModelIds.delete(modelId);
        return removedFromStorage || snapshot !== undefined;
      });
    } catch (error) {
      if (mutated) this.runtime.restoreEntry(modelId, snapshot);
      throw error;
    }
  }

  /**
   * Commit the model's state as its checkpoint.
   *
   * This is the state a restart would restore — the runtime keeps advancing
   * afterwards, and those later ticks are not durable until the next commit.
   * Nothing in the runtime changes here, so there is nothing to roll back if
   * the write fails; the caller is simply told the commit did not happen.
   *
   * The state is read inside the transaction, as in `registerModel`: the store
   * serialises transactions, so a concurrent delete either lands before this
   * read — and the model is reported unknown, exactly as if it had never been
   * registered — or after the commit. Reading beforehand let a delete land in
   * between, and the checkpoint write then failed on the model's foreign key,
   * reporting a storage outage for what is really an unknown model.
   */
  commitCheckpoint(modelId: string): Promise<TwinCheckpoint> {
    return this.store.transaction(async (tx) => {
      const state = this.runtime.getState(modelId);
      if (!state) throw new Error(`Unknown model "${modelId}"`);
      const checkpoint = checkpointStateOf(state);
      const committedAt = this.now();
      await tx.putCheckpoint(modelId, checkpoint, committedAt);
      return {
        modelId,
        schemaVersion: TWIN_CHECKPOINT_SCHEMA_VERSION,
        tick: checkpoint.tick,
        timeMs: checkpoint.timeMs,
        componentStates: checkpoint.componentStates,
        ...(checkpoint.lastSyncAt !== undefined ? { lastSyncAt: checkpoint.lastSyncAt } : {}),
        committedAt,
      };
    });
  }
}
