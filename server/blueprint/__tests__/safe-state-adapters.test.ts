import { beforeEach, describe, expect, it, vi } from "vitest";

import * as logger from "../../logger";
import {
  DrizzleSafeStateAuditSink,
} from "../safe-state-adapters";
import type { SafeStateAuditEntry } from "../safe-state";

const ENTRY: SafeStateAuditEntry = {
  blueprintId: "bp-a",
  siteId: "site-a",
  transition: "ENTERED",
  safeState: "force-zero",
  tickBudgetMs: 10,
  consecutiveMisses: 3,
  reason: "deadline misses",
  anchorHash: "abc123",
  timestamp: "2026-07-23T12:00:00.000Z",
};

describe("DrizzleSafeStateAuditSink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(logger, "log").mockImplementation(() => {});
  });

  it("persists idempotently through PostgreSQL", async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const getDatabase = vi.fn(() => ({ insert }));
    const sink = new DrizzleSafeStateAuditSink({
      getDatabase: getDatabase as never,
      getDatabaseType: (() => "postgres") as never,
    });

    await expect(sink.record(ENTRY)).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        blueprintId: "bp-a",
        transition: "ENTERED",
        safeState: "force-zero",
        createdAt: new Date(ENTRY.timestamp),
      }),
    );
    expect(onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.anything() }),
    );
    expect(getDatabase).toHaveBeenCalledOnce();
  });

  it("rejects the SQLite no-op adapter instead of silently discarding the audit", async () => {
    vi.spyOn(logger, "logError").mockImplementation(() => {});
    const getDatabase = vi.fn();
    const sink = new DrizzleSafeStateAuditSink({
      getDatabase: getDatabase as never,
      getDatabaseType: (() => "sqlite") as never,
    });

    await expect(sink.record(ENTRY)).rejects.toThrow(
      /SQLite fallback has no durable audit-table adapter/,
    );
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("propagates a PostgreSQL write failure after logging it", async () => {
    const errorSpy = vi.spyOn(logger, "logError").mockImplementation(() => {});
    const onConflictDoNothing = vi.fn().mockRejectedValue(new Error("relation missing"));
    const sink = new DrizzleSafeStateAuditSink({
      getDatabase: (() => ({
        insert: () => ({
          values: () => ({ onConflictDoNothing }),
        }),
      })) as never,
      getDatabaseType: (() => "postgres") as never,
    });

    await expect(sink.record(ENTRY)).rejects.toThrow(/relation missing/);
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
