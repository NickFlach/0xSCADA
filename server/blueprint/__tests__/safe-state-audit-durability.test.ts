/**
 * The safe-state audit trail must genuinely land (#459).
 *
 * The previous implementation refused the SQLite path outright and depended on
 * a Postgres table that no migration created, so every audit write was either
 * rejected or swallowed. This suite opens a real SQLite database, writes
 * transitions through the production sink, and reads them back out.
 *
 * The Postgres half of the same table is created by
 * migrations/0009_blueprint_safe_state_log.sql; the schema-parity assertions
 * live in ./production-safety.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StorageSafeStateAuditSink } from "../safe-state-adapters";
import type { SafeStateAuditEntry } from "../safe-state";

type StorageModule = typeof import("../../storage");

let storage: StorageModule;
let directory: string;

const previousEnv = {
  sqlitePath: process.env.SQLITE_DATABASE_PATH,
  databaseUrl: process.env.DATABASE_URL,
};

/** Read the physical column list straight from the SQLite file under test. */
async function readTableInfo(): Promise<Array<Record<string, unknown>>> {
  const { Database } = await import("sqlite3");
  const file = process.env.SQLITE_DATABASE_PATH!;
  const client = await new Promise<InstanceType<typeof Database>>((resolve, reject) => {
    const opened = new Database(file, (error) => (error ? reject(error) : resolve(opened)));
  });
  try {
    return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      client.all("PRAGMA table_info(blueprint_safe_state_log)", [], (error, rows) =>
        error ? reject(error) : resolve(rows as Array<Record<string, unknown>>),
      );
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      client.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function entry(overrides: Partial<SafeStateAuditEntry> = {}): SafeStateAuditEntry {
  return {
    blueprintId: "bp-durable",
    siteId: "site-durable",
    transition: "ENTERED",
    safeState: "hold-last",
    tickBudgetMs: 25,
    consecutiveMisses: 4,
    reason: "4 consecutive ticks exceeded budget",
    anchorHash: "hash-entered",
    anchorTxHash: "0xabc",
    timestamp: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("blueprint_safe_state_log durability (SQLite)", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "safe-state-audit-"));
    process.env.SQLITE_DATABASE_PATH = join(directory, "audit.sqlite");
    // Force the SQLite development path: `usePostgres` is evaluated when the
    // storage module is first imported, so the env must be set before it.
    delete process.env.DATABASE_URL;
    storage = await import("../../storage");
    await storage.initializeDatabase();
    expect(storage.getDatabaseType()).toBe("sqlite");
  });

  afterAll(async () => {
    await storage.closeDatabase();
    rmSync(directory, { recursive: true, force: true });
    if (previousEnv.sqlitePath === undefined) delete process.env.SQLITE_DATABASE_PATH;
    else process.env.SQLITE_DATABASE_PATH = previousEnv.sqlitePath;
    if (previousEnv.databaseUrl !== undefined) {
      process.env.DATABASE_URL = previousEnv.databaseUrl;
    }
  });

  it("creates the physical table with every declared column", async () => {
    // The SQLite DDL lives as raw SQL in server/storage.ts while the typed
    // declaration lives in shared/schema-sqlite.ts. Compare the real table to
    // the declaration so the two cannot drift into a silently dropped column.
    const { getTableColumns } = await import("drizzle-orm");
    const { blueprintSafeStateLog } = await import("@shared/schema-sqlite");
    const declared = Object.values(getTableColumns(blueprintSafeStateLog))
      .map((column) => column.name)
      .sort();

    const actual = (await readTableInfo()).map((row) => String(row.name)).sort();

    expect(actual).toEqual(declared);
  });

  it("writes a transition through the production sink and reads it back", async () => {
    const sink = new StorageSafeStateAuditSink(storage.insertBlueprintSafeStateLog);

    await sink.record(entry());

    const rows = await storage.listBlueprintSafeStateLog("bp-durable");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      blueprintId: "bp-durable",
      siteId: "site-durable",
      transition: "ENTERED",
      tickBudgetMs: 25,
      consecutiveMisses: 4,
      reason: "4 consecutive ticks exceeded budget",
      anchorHash: "hash-entered",
      anchorTxHash: "0xabc",
    });
    // A bare-string safe state must survive the round trip un-double-encoded.
    expect(rows[0].safeState).toBe("hold-last");
    expect(rows[0].createdAt.toISOString()).toBe("2026-07-23T12:00:00.000Z");
    expect(rows[0].id).toBeTruthy();
  });

  it("round-trips a structured safe recipe without mangling it", async () => {
    const sink = new StorageSafeStateAuditSink(storage.insertBlueprintSafeStateLog);

    await sink.record(
      entry({
        blueprintId: "bp-recipe",
        safeState: { recipe: "purge-and-vent" },
        anchorHash: "hash-recipe",
      }),
    );

    const [row] = await storage.listBlueprintSafeStateLog("bp-recipe");
    expect(row.safeState).toEqual({ recipe: "purge-and-vent" });
  });

  it("is idempotent on anchor hash so a retried write cannot duplicate a row", async () => {
    const sink = new StorageSafeStateAuditSink(storage.insertBlueprintSafeStateLog);
    const retried = entry({ blueprintId: "bp-retry", anchorHash: "hash-retry" });

    await sink.record(retried);
    await sink.record(retried);

    expect(await storage.listBlueprintSafeStateLog("bp-retry")).toHaveLength(1);
  });

  it("records every transition kind the controller can emit", async () => {
    const sink = new StorageSafeStateAuditSink(storage.insertBlueprintSafeStateLog);
    const transitions: SafeStateAuditEntry["transition"][] = [
      "ENTERED",
      "EXIT_REQUESTED",
      "EXITED",
      "RESUME_FAILED",
      "EXIT_ABORTED",
      "RECOVERY_FAILED",
    ];

    for (const transition of transitions) {
      await sink.record(
        entry({
          blueprintId: "bp-transitions",
          transition,
          operator: "safety-op",
          anchorHash: `hash-${transition}`,
        }),
      );
    }

    const rows = await storage.listBlueprintSafeStateLog("bp-transitions");
    expect(rows.map((row) => row.transition).sort()).toEqual([...transitions].sort());
    expect(rows.every((row) => row.operator === "safety-op")).toBe(true);
  });
});
