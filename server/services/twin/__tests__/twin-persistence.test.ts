/**
 * Durable digital-twin registry and checkpoint tests
 * ADR-0013 [13.3] — Issue #550
 *
 * These run against a real SQLite file through the real Drizzle store — no
 * in-memory stand-in — so the claims that matter are actually observed:
 * a model and its committed checkpoint survive a restart, the restored
 * simulation is idle, corrupt rows fail closed for their own model only, and
 * a failed write leaves neither storage nor the in-memory registry changed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "sqlite3";
import type { ProcessModel } from "@shared/types/digital-twin";
import { TwinRuntime } from "../engine";
import {
  DrizzleTwinStore,
  MAX_PERSISTED_PAYLOAD_BYTES,
  TwinPersistenceError,
  type TwinLoadResult,
  type TwinPersistence,
  type TwinStoreTransaction,
} from "../persistence";
import { PersistentTwinRegistry } from "../registry";

/** Valve (maxFlow 10, position 50 → flow 5) feeding a tank draining at 2 */
function valveTankModel(overrides: Partial<ProcessModel> = {}): ProcessModel {
  return {
    id: "m1",
    name: "valve-tank",
    components: [
      {
        id: "valve-1",
        type: "valve",
        name: "Feed valve",
        config: { maxFlow: 10 },
        initialState: { position: 50 },
        connections: ["tank-1"],
      },
      {
        id: "tank-1",
        type: "tank",
        name: "Buffer tank",
        config: { capacity: 100, outflow: 2 },
        initialState: { level: 20 },
        connections: [],
      },
    ],
    tagBindings: [{ tagId: "TK-1.LEVEL", componentId: "tank-1", parameter: "level" }],
    stepFunction: "basic-flow",
    timeStepMs: 1000,
    ...overrides,
  };
}

function rawSqlite(file: string): Database {
  return new Database(file);
}

function rawRun(client: Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    client.run(sql, params, (error) => (error ? reject(error) : resolve()));
  });
}

function rawAll(
  client: Database,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    client.all(sql, params, (error, rows) =>
      error ? reject(error) : resolve(rows as Record<string, unknown>[]));
  });
}

function rawClose(client: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    client.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A promise together with its resolver, for driving an exact interleaving. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Wait for `settling`, giving up after `ms`.
 *
 * Used to give a concurrent registration its chance to commit. The bound only
 * decides whether an *unsynchronised* store is caught in the act; a store that
 * serialises the restore against mutations cannot commit that registration
 * early however long the wait, so the assertions that follow never depend on
 * which way this went.
 */
async function settleWithin(settling: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    settling.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * The real store with the window between "the stored rows have been read" and
 * "the read resolves to its caller" held open on demand. Everything else — the
 * read itself, the transactions, the lock — is the production implementation.
 */
class GatedLoadStore extends DrizzleTwinStore {
  private readonly read = deferred();
  private readonly gate = deferred();
  /** Resolves once a `load()` has read the database and is holding its result. */
  readonly loadHasRead = this.read.promise;

  override async load(): Promise<TwinLoadResult> {
    const loaded = await super.load();
    this.read.resolve();
    await this.gate.promise;
    return loaded;
  }

  /** Let the in-flight read — and every later one — resolve. */
  releaseLoad(): void {
    this.gate.resolve();
  }
}

describe("durable twin registry (SQLite backend)", () => {
  let directory: string;
  let file: string;
  let store: DrizzleTwinStore;
  let runtime: TwinRuntime;
  let registry: PersistentTwinRegistry;
  const openStores: DrizzleTwinStore[] = [];
  let databaseCounter = 0;

  /** A fresh process: new store handle, new runtime, nothing in memory. */
  function restart(): { runtime: TwinRuntime; registry: PersistentTwinRegistry } {
    const reopened = new DrizzleTwinStore({ sqlitePath: file });
    openStores.push(reopened);
    const freshRuntime = new TwinRuntime();
    return {
      runtime: freshRuntime,
      registry: new PersistentTwinRegistry(freshRuntime, reopened),
    };
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "twin-persistence-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A database file per test, in one shared temp directory: each test still
    // starts from an empty store, without paying for a directory create and
    // recursive delete per case.
    file = path.join(directory, `twin-${databaseCounter++}.sqlite`);
    store = new DrizzleTwinStore({ sqlitePath: file });
    openStores.length = 0;
    openStores.push(store);
    runtime = new TwinRuntime();
    registry = new PersistentTwinRegistry(runtime, store);
  });

  afterEach(async () => {
    for (const open of openStores) await open.close();
  });

  // ── Restart recovery ─────────────────────────────────────────────────────

  it("restores a registered model and its last committed checkpoint", async () => {
    await registry.registerModel(valveTankModel({ description: "feed loop" }));
    runtime.step("m1", 4);
    const committed = await registry.commitCheckpoint("m1");
    expect(committed.tick).toBe(4);
    expect(committed.componentStates["tank-1"].level).toBe(32);
    await store.close();

    const after = restart();
    const report = await after.registry.restore();

    expect(report.scanned).toBe(1);
    expect(report.restored).toEqual(["m1"]);
    expect(report.failed).toEqual([]);
    expect(after.runtime.getModel("m1")).toEqual(valveTankModel({ description: "feed loop" }));
    const state = after.runtime.getState("m1")!;
    expect(state.tick).toBe(4);
    expect(state.timeMs).toBe(4000);
    // Including the solver's derived state, so the restored simulation
    // continues from exactly where it stopped rather than re-deriving it.
    expect(state.componentStates).toEqual({
      "valve-1": { position: 50, currentFlow: 5 },
      "tank-1": { level: 32, inflow: 5, fillPercent: 32 },
    });
  });

  it("restores ticks the caller committed, not ticks run after the commit", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 2);
    await registry.commitCheckpoint("m1");
    runtime.step("m1", 5);
    expect(runtime.getState("m1")!.tick).toBe(7);
    await store.close();

    const after = restart();
    await after.registry.restore();
    expect(after.runtime.getState("m1")!.tick).toBe(2);
  });

  it("carries the last live-sync timestamp into the restored checkpoint", async () => {
    await registry.registerModel(valveTankModel());
    runtime.ingestActual("TK-1.LEVEL", 61.5, 1_000);
    runtime.syncFromLive("m1", 9_000);
    await registry.commitCheckpoint("m1");
    await store.close();

    const after = restart();
    await after.registry.restore();
    const state = after.runtime.getState("m1")!;
    expect(state.lastSyncAt).toBe(9_000);
    expect(state.componentStates["tank-1"].level).toBe(61.5);
  });

  // ── Safety: a restart never resumes anything ─────────────────────────────

  it("restores a running simulation in a stopped state and does not resume it", async () => {
    await registry.registerModel(valveTankModel());
    runtime.setRunning("m1", true, 0);
    runtime.stepRunning(3_000);
    expect(runtime.getState("m1")!.status).toBe("running");
    expect(runtime.getState("m1")!.tick).toBe(3);
    await registry.commitCheckpoint("m1");
    await store.close();

    const after = restart();
    await after.registry.restore();

    const restored = after.runtime.getState("m1")!;
    expect(restored.status).toBe("idle");
    expect(restored.tick).toBe(3);

    // The service's step driver must find nothing to do, however much
    // wall-clock time has passed since the checkpoint.
    after.runtime.syncRunningFromLive(1_000_000);
    after.runtime.stepRunning(1_000_000);
    expect(after.runtime.getState("m1")!.tick).toBe(3);
    expect(after.runtime.getStatus().running).toBe(0);

    // ...until an authorized caller explicitly steps it.
    expect(after.runtime.step("m1", 1).tick).toBe(4);
  });

  it("restores a simulation that failed with a solver error as idle, not error", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 1);
    await registry.commitCheckpoint("m1");
    // Force the runtime into the error state after the commit.
    const errored = runtime.exportEntry("m1")!;
    errored.state.status = "error";
    errored.state.error = "solver blew up";
    runtime.restoreEntry("m1", errored);
    expect(runtime.getState("m1")!.status).toBe("error");
    await store.close();

    const after = restart();
    await after.registry.restore();
    const restored = after.runtime.getState("m1")!;
    expect(restored.status).toBe("idle");
    expect(restored.error).toBeUndefined();
  });

  // ── Corruption and partial writes fail closed, per model ─────────────────

  it("refuses a model whose stored definition is not valid JSON and loads the rest", async () => {
    await registry.registerModel(valveTankModel({ id: "broken" }));
    await registry.registerModel(valveTankModel({ id: "healthy" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_models SET definition = ? WHERE id = ?", [
      "{not json at all",
      "broken",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();

    expect(report.restored).toEqual(["healthy"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].modelId).toBe("broken");
    expect(report.failed[0].stage).toBe("model");
    expect(after.runtime.getModel("broken")).toBeUndefined();
    expect(after.runtime.getModel("healthy")).toBeDefined();
  });

  it("refuses a model row written under an unknown schema version", async () => {
    await registry.registerModel(valveTankModel({ id: "future" }));
    await registry.registerModel(valveTankModel({ id: "healthy" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_models SET schema_version = 99 WHERE id = ?", ["future"]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();

    expect(report.restored).toEqual(["healthy"]);
    expect(report.failed).toEqual([
      {
        modelId: "future",
        stage: "model",
        reason: expect.stringContaining("unsupported model schema version 99"),
      },
    ]);
  });

  it("refuses a checkpoint written under an unknown schema version", async () => {
    await registry.registerModel(valveTankModel({ id: "future-cp" }));
    await registry.registerModel(valveTankModel({ id: "healthy" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_checkpoints SET schema_version = 7 WHERE model_id = ?", [
      "future-cp",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();

    expect(report.restored).toEqual(["healthy"]);
    expect(report.failed[0].stage).toBe("checkpoint");
    expect(report.failed[0].reason).toContain("unsupported checkpoint schema version 7");
    expect(after.runtime.getModel("future-cp")).toBeUndefined();
  });

  it("refuses a checkpoint whose component states do not match the model", async () => {
    await registry.registerModel(valveTankModel({ id: "mismatched" }));
    await registry.registerModel(valveTankModel({ id: "healthy" }));
    await store.close();

    const raw = rawSqlite(file);
    // A state record for a component the model does not contain: the stored
    // pair disagrees, so neither half can be trusted.
    await rawRun(raw, "UPDATE twin_checkpoints SET component_states = ? WHERE model_id = ?", [
      JSON.stringify({ "valve-1": { position: 50 }, "ghost-tank": { level: 1 } }),
      "mismatched",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();

    expect(report.restored).toEqual(["healthy"]);
    expect(report.failed[0]).toMatchObject({ modelId: "mismatched", stage: "checkpoint" });
    expect(after.runtime.getModel("mismatched")).toBeUndefined();
  });

  it("refuses a checkpoint carrying a non-finite value rather than admitting it", async () => {
    await registry.registerModel(valveTankModel({ id: "nan-state" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_checkpoints SET component_states = ? WHERE model_id = ?", [
      '{"valve-1":{"position":50},"tank-1":{"level":null}}',
      "nan-state",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();
    expect(report.restored).toEqual([]);
    expect(report.failed[0].stage).toBe("checkpoint");
  });

  it("treats a model row with no checkpoint row as a torn write", async () => {
    await registry.registerModel(valveTankModel({ id: "torn" }));
    await registry.registerModel(valveTankModel({ id: "healthy" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "DELETE FROM twin_checkpoints WHERE model_id = ?", ["torn"]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();

    expect(report.scanned).toBe(2);
    expect(report.restored).toEqual(["healthy"]);
    expect(report.failed).toEqual([
      { modelId: "torn", stage: "checkpoint", reason: expect.stringContaining("torn write") },
    ]);
    // The unreadable row is reported, not repaired: it is still in storage.
    const check = rawSqlite(file);
    const rows = await rawAll(check, "SELECT id FROM twin_models WHERE id = ?", ["torn"]);
    await rawClose(check);
    expect(rows).toHaveLength(1);
  });

  it("refuses a definition whose id does not match the row it was stored under", async () => {
    await registry.registerModel(valveTankModel({ id: "renamed" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_models SET definition = ? WHERE id = ?", [
      JSON.stringify(valveTankModel({ id: "somethingelse" })),
      "renamed",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();
    expect(report.restored).toEqual([]);
    expect(report.failed[0]).toMatchObject({ modelId: "renamed", stage: "model" });
  });

  it("refuses a model whose step function this build does not know", async () => {
    await registry.registerModel(valveTankModel({ id: "exotic" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_models SET definition = ? WHERE id = ?", [
      JSON.stringify(valveTankModel({ id: "exotic", stepFunction: "quantum-flow" })),
      "exotic",
    ]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();
    expect(report.failed[0]).toMatchObject({ modelId: "exotic", stage: "model" });
    expect(report.failed[0].reason).toContain("quantum-flow");
  });

  // ── Transactional storage ────────────────────────────────────────────────

  it("rolls the stored model and checkpoint back together when the transaction throws", async () => {
    const model = valveTankModel({ id: "half-written" });
    await expect(
      store.transaction(async (tx: TwinStoreTransaction) => {
        await tx.putModel(model, { tick: 0, timeMs: 0, componentStates: { "valve-1": {} } }, 1);
        throw new Error("interrupted before commit");
      }),
    ).rejects.toThrow("interrupted before commit");

    const loaded: TwinLoadResult = await store.load();
    expect(loaded.scanned).toBe(0);
    expect(loaded.records).toEqual([]);
    expect(loaded.failures).toEqual([]);
  });

  it("deletes a model and its checkpoint together", async () => {
    await registry.registerModel(valveTankModel({ id: "doomed" }));
    await registry.registerModel(valveTankModel({ id: "kept" }));

    expect(await registry.removeModel("doomed")).toBe(true);
    expect(runtime.getModel("doomed")).toBeUndefined();

    const loaded = await store.load();
    expect(loaded.records.map((record) => record.model.id)).toEqual(["kept"]);

    const raw = rawSqlite(file);
    const orphans = await rawAll(raw, "SELECT model_id FROM twin_checkpoints WHERE model_id = ?", [
      "doomed",
    ]);
    await rawClose(raw);
    expect(orphans).toEqual([]);
  });

  it("reports an unknown model as not removed without touching storage", async () => {
    await registry.registerModel(valveTankModel({ id: "kept" }));
    expect(await registry.removeModel("never-existed")).toBe(false);
    expect((await store.load()).records).toHaveLength(1);
  });

  it("re-registering replaces the stored definition and its checkpoint", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 3);
    await registry.commitCheckpoint("m1");

    const revised = valveTankModel({ name: "valve-tank rev B" });
    revised.components[1].config.outflow = 4;
    await registry.registerModel(revised);
    await store.close();

    const after = restart();
    await after.registry.restore();
    expect(after.runtime.getModel("m1")!.name).toBe("valve-tank rev B");
    // Re-registration reseeds the simulation, and the checkpoint written in
    // the same transaction says so.
    expect(after.runtime.getState("m1")!.tick).toBe(0);
    expect(after.runtime.getState("m1")!.componentStates["tank-1"].level).toBe(20);
  });

  it("lets an operator clear a stored model this build refused to load", async () => {
    await registry.registerModel(valveTankModel({ id: "unloadable" }));
    await store.close();

    const raw = rawSqlite(file);
    await rawRun(raw, "UPDATE twin_models SET schema_version = 42 WHERE id = ?", ["unloadable"]);
    await rawClose(raw);

    const after = restart();
    const report = await after.registry.restore();
    expect(report.failed).toHaveLength(1);

    expect(await after.registry.removeModel("unloadable")).toBe(true);
    expect((await after.registry.restore()).scanned).toBe(0);
  });

  it("refuses a checkpoint payload over the persistence cap instead of truncating it", async () => {
    await registry.registerModel(valveTankModel({ id: "huge" }));
    runtime.step("huge", 2);
    await registry.commitCheckpoint("huge");

    const parameter = "p".repeat(60);
    const oversized: Record<string, number> = {};
    for (let i = 0; oversized[`${parameter}${i}`] === undefined; i++) {
      oversized[`${parameter}${i}`] = 1.2345678901234;
      if (i * 82 > MAX_PERSISTED_PAYLOAD_BYTES) break;
    }
    await expect(
      store.transaction((tx) => tx.putCheckpoint(
        "huge",
        { tick: 9, timeMs: 9000, componentStates: { "tank-1": oversized } },
        Date.now(),
      )),
    ).rejects.toThrow(/persistence limit/);

    // The previously committed checkpoint is untouched.
    const loaded = await store.load();
    expect(loaded.records[0].checkpoint.tick).toBe(2);
  });

  it("serialises concurrent transactions on its single connection", async () => {
    await Promise.all([
      registry.registerModel(valveTankModel({ id: "a" })),
      registry.registerModel(valveTankModel({ id: "b" })),
      registry.registerModel(valveTankModel({ id: "c" })),
    ]);
    const loaded = await store.load();
    expect(loaded.records.map((record) => record.model.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not apply a restore over a registration that committed during it", async () => {
    await registry.registerModel(valveTankModel({ description: "v1" }));
    runtime.step("m1", 5);
    await registry.commitCheckpoint("m1");
    await store.close();

    const gated = new GatedLoadStore({ sqlitePath: file });
    openStores.push(gated);
    const freshRuntime = new TwinRuntime();
    const freshRegistry = new PersistentTwinRegistry(freshRuntime, gated);

    // The restore has read "v1" at tick 5 out of storage but has not applied
    // it to the runtime yet.
    const restoring = freshRegistry.restore();
    await gated.loadHasRead;

    // A registration arriving in exactly that window replaces the stored model
    // with "v2" at tick 0. It must not be able to commit while the restore is
    // still deciding what the runtime should contain.
    const registering = freshRegistry.registerModel(valveTankModel({ description: "v2" }));
    await settleWithin(registering, 250);
    gated.releaseLoad();
    await restoring;
    await registering;

    const stored = (await gated.load()).records;
    expect(stored).toHaveLength(1);
    // Whichever of the two ran last, storage and the runtime must describe the
    // same model: the restore's rows are stale the moment a mutation commits.
    expect(freshRuntime.getModel("m1")!.description).toBe(stored[0].model.description);
    expect(freshRuntime.getState("m1")!.tick).toBe(stored[0].checkpoint.tick);
  });

  it("reports a checkpoint for a concurrently deleted model as unknown, not as an outage", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 2);

    // The delete is requested first, so it takes the store first; the
    // checkpoint runs against a model that is gone by the time it does.
    const removing = registry.removeModel("m1");
    const committing = registry.commitCheckpoint("m1");

    expect(await removing).toBe(true);
    // Reading the state before the transaction let this reach the database and
    // fail on the checkpoint's foreign key — a storage error for a request
    // that is simply naming a model that no longer exists.
    await expect(committing).rejects.toThrow('Unknown model "m1"');
    await expect(committing).rejects.not.toBeInstanceOf(TwinPersistenceError);
    expect((await store.load()).records).toEqual([]);
  });

  it("closes the connection an open still in flight is about to produce", async () => {
    const raced = new DrizzleTwinStore({ sqlitePath: path.join(directory, "raced.sqlite") });
    const opening = raced.ready();
    // close() races the very first connect(): the handle the open resolves is
    // the store's to release, so it must not be left owned by nobody.
    await raced.close();
    await opening;
    expect(raced.backend()).toBe("unopened");
  });

  it("reports a store that cannot be opened as a persistence failure", async () => {
    const unopenable = new DrizzleTwinStore({
      sqlitePath: path.join(directory, "no-such-directory", "twin.sqlite"),
    });
    await expect(unopenable.ready()).rejects.toBeInstanceOf(TwinPersistenceError);
  });
});

// ── CRUD atomicity against a store that fails on demand ────────────────────

type StoreFailure = "putModel" | "putCheckpoint" | "deleteModel" | "commit";

/**
 * A `TwinPersistence` with real transactional semantics — staged writes are
 * applied only on commit — that can be told to fail at a chosen point. Used to
 * observe what the in-memory registry looks like after a durable write fails;
 * the SQLite suite above covers the storage half.
 */
class FailingStore implements TwinPersistence {
  readonly models = new Map<string, ProcessModel>();
  readonly checkpoints = new Map<string, { tick: number }>();
  failAt: StoreFailure | null = null;
  /** Fail the Nth `putModel` of this store's lifetime (1-based). */
  failPutModelOnCall: number | null = null;
  private putModelCalls = 0;
  private tail: Promise<unknown> = Promise.resolve();

  async ready(): Promise<void> {}

  async load(): Promise<TwinLoadResult> {
    return { scanned: this.models.size, records: [], failures: [] };
  }

  transaction<T>(work: (tx: TwinStoreTransaction) => Promise<T>): Promise<T> {
    // Serialised like the real store, so concurrent callers see one another's
    // committed writes instead of interleaving on a stale staging snapshot.
    return this.serialise(() => this.runTransaction(work));
  }

  /** The same queue, held without opening a transaction — as the real store. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialise(operation);
  }

  private serialise<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(operation);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runTransaction<T>(work: (tx: TwinStoreTransaction) => Promise<T>): Promise<T> {
    const stagedModels = new Map(this.models);
    const stagedCheckpoints = new Map(this.checkpoints);
    const tx: TwinStoreTransaction = {
      putModel: async (model, checkpoint) => {
        this.putModelCalls += 1;
        if (this.failAt === "putModel" || this.putModelCalls === this.failPutModelOnCall) {
          throw new TwinPersistenceError("disk on fire");
        }
        stagedModels.set(model.id, model);
        stagedCheckpoints.set(model.id, { tick: checkpoint.tick });
      },
      putCheckpoint: async (modelId, checkpoint) => {
        if (this.failAt === "putCheckpoint") throw new TwinPersistenceError("disk on fire");
        stagedCheckpoints.set(modelId, { tick: checkpoint.tick });
      },
      deleteModel: async (modelId) => {
        if (this.failAt === "deleteModel") throw new TwinPersistenceError("disk on fire");
        const existed = stagedModels.delete(modelId);
        stagedCheckpoints.delete(modelId);
        return existed;
      },
    };
    const result = await work(tx);
    if (this.failAt === "commit") throw new TwinPersistenceError("commit rejected");
    this.models.clear();
    for (const [id, model] of stagedModels) this.models.set(id, model);
    this.checkpoints.clear();
    for (const [id, checkpoint] of stagedCheckpoints) this.checkpoints.set(id, checkpoint);
    return result;
  }

  backend(): "postgres" | "sqlite" | "unopened" {
    return "unopened";
  }

  async close(): Promise<void> {}
}

describe("twin registry CRUD atomicity", () => {
  let store: FailingStore;
  let runtime: TwinRuntime;
  let registry: PersistentTwinRegistry;

  beforeEach(() => {
    store = new FailingStore();
    runtime = new TwinRuntime();
    registry = new PersistentTwinRegistry(runtime, store);
  });

  it("does not register a model whose durable write fails", async () => {
    store.failAt = "putModel";
    await expect(registry.registerModel(valveTankModel())).rejects.toThrow("disk on fire");
    expect(runtime.getModel("m1")).toBeUndefined();
    expect(runtime.getStatus().models).toBe(0);
    expect(store.models.size).toBe(0);
  });

  it("does not register a model whose commit fails", async () => {
    store.failAt = "commit";
    await expect(registry.registerModel(valveTankModel())).rejects.toThrow("commit rejected");
    expect(runtime.getModel("m1")).toBeUndefined();
    expect(store.models.size).toBe(0);
  });

  it("keeps the previous model, state and live actuals when a replacement fails", async () => {
    await registry.registerModel(valveTankModel({ description: "rev A" }));
    runtime.step("m1", 3);
    runtime.ingestActual("TK-1.LEVEL", 47, 5_000);
    runtime.setRunning("m1", true, 1_000);

    store.failAt = "putModel";
    const replacement = valveTankModel({ description: "rev B" });
    await expect(registry.registerModel(replacement)).rejects.toThrow("disk on fire");

    expect(runtime.getModel("m1")!.description).toBe("rev A");
    const state = runtime.getState("m1")!;
    expect(state.tick).toBe(3);
    expect(state.status).toBe("running");
    expect(runtime.compare("m1")[0].actual).toBe(47);
    expect(store.models.get("m1")!.description).toBe("rev A");
  });

  it("keeps the model registered when its delete fails", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 2);

    store.failAt = "deleteModel";
    await expect(registry.removeModel("m1")).rejects.toThrow("disk on fire");

    expect(runtime.getModel("m1")).toBeDefined();
    expect(runtime.getState("m1")!.tick).toBe(2);
    expect(store.models.has("m1")).toBe(true);
  });

  it("keeps the model registered when the delete commit fails", async () => {
    await registry.registerModel(valveTankModel());
    store.failAt = "commit";
    await expect(registry.removeModel("m1")).rejects.toThrow("commit rejected");
    expect(runtime.getModel("m1")).toBeDefined();
    expect(store.models.has("m1")).toBe(true);
  });

  it("leaves the runtime untouched when a checkpoint commit fails", async () => {
    await registry.registerModel(valveTankModel());
    runtime.step("m1", 4);

    store.failAt = "putCheckpoint";
    await expect(registry.commitCheckpoint("m1")).rejects.toThrow("disk on fire");

    expect(runtime.getState("m1")!.tick).toBe(4);
    expect(store.checkpoints.get("m1")!.tick).toBe(0);
  });

  it("writes nothing when the runtime rejects the model", async () => {
    const invalid = valveTankModel();
    invalid.components[1].config.capacity = -5;
    await expect(registry.registerModel(invalid)).rejects.toThrow(/capacity must be positive/);
    expect(store.models.size).toBe(0);
    expect(runtime.getStatus().models).toBe(0);
  });

  it("does not roll a concurrently committed registration out of the registry", async () => {
    // Both requests arrive before either transaction runs; the second one's
    // durable write fails. Its rollback must not undo the first one's commit,
    // or storage would hold a model the runtime has forgotten.
    store.failPutModelOnCall = 2;
    const first = registry.registerModel(valveTankModel({ description: "rev A" }));
    const second = registry.registerModel(valveTankModel({ description: "rev B" }));

    await expect(first).resolves.toBeTruthy();
    await expect(second).rejects.toThrow("disk on fire");

    expect(store.models.get("m1")!.description).toBe("rev A");
    expect(runtime.getModel("m1")?.description).toBe("rev A");
  });

  it("refuses to checkpoint a model that is not registered", async () => {
    await expect(registry.commitCheckpoint("ghost")).rejects.toThrow('Unknown model "ghost"');
    expect(store.checkpoints.size).toBe(0);
  });
});
