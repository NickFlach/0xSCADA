import { beforeEach, describe, expect, it, vi } from "vitest";

import * as logger from "../../logger";
import { StorageSafeStateAuditSink } from "../safe-state-adapters";
import type { SafeStateAuditEntry } from "../safe-state";
import type { SafeStateLogInsert } from "../../storage";

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

describe("StorageSafeStateAuditSink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(logger, "log").mockImplementation(() => {});
  });

  it("hands the transition to the durable writer with a real timestamp", async () => {
    const written: SafeStateLogInsert[] = [];
    const sink = new StorageSafeStateAuditSink(async (entry) => {
      written.push(entry);
    });

    await expect(sink.record(ENTRY)).resolves.toBeUndefined();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      blueprintId: "bp-a",
      siteId: "site-a",
      transition: "ENTERED",
      safeState: "force-zero",
      tickBudgetMs: 10,
      consecutiveMisses: 3,
      anchorHash: "abc123",
    });
    expect(written[0].createdAt).toEqual(new Date(ENTRY.timestamp));
  });

  it("propagates a persistence failure after logging it, never swallowing it", async () => {
    const errorSpy = vi.spyOn(logger, "logError").mockImplementation(() => {});
    const sink = new StorageSafeStateAuditSink(async () => {
      throw new Error("relation missing");
    });

    await expect(sink.record(ENTRY)).rejects.toThrow(/relation missing/);
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
