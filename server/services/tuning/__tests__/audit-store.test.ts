/**
 * Durable PID tuning audit store tests
 * ADR-0013 [13.4] — Issue #215
 *
 * These run against a real SQLite file through the real Drizzle store — no
 * in-memory stand-in — so the two claims that matter are actually observed:
 * records survive a reopen, and the table rejects UPDATE and DELETE.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "sqlite3";
import type { GainEnvelope, TuningAuditAppend } from "@shared/types/tuning";
import { DrizzleTuningAuditStore } from "../audit-store";

const ENVELOPE: GainEnvelope = {
  kpRange: { min: 0, max: 10 },
  kiRange: { min: 0, max: 5 },
  kdRange: { min: 0, max: 5 },
};

function record(overrides: Partial<TuningAuditAppend> = {}): TuningAuditAppend {
  return {
    proposalId: "TUNE-1",
    controllerId: "FIC-101",
    method: "relay-feedback",
    decision: "approved",
    proposedBy: "tuning-engineer",
    decidedBy: "control-room-lead",
    currentGains: { kp: 1, ki: 0.1, kd: 0.05 },
    proposedGains: { kp: 1.2, ki: 0.12, kd: 0.06 },
    appliedGains: { kp: 1.2, ki: 0.12, kd: 0.06 },
    envelope: ENVELOPE,
    envelopeDecision: "within-envelope",
    reasonCode: null,
    detail: null,
    ...overrides,
  };
}

function rawSqlite(file: string): Database {
  return new Database(file);
}

function rawRun(client: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.run(sql, (error) => (error ? reject(error) : resolve()));
  });
}

function rawClose(client: Database): Promise<void> {
  return new Promise((resolve, reject) => {
    client.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("DrizzleTuningAuditStore", () => {
  let directory: string;
  let file: string;
  let store: DrizzleTuningAuditStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tuning-audit-"));
    file = path.join(directory, "audit.sqlite");
    store = new DrizzleTuningAuditStore({ sqlitePath: file });
  });

  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates its schema and reports the backend in use", async () => {
    await store.ready();
    expect(store.backend()).toBe("sqlite");
  });

  it("round-trips every field, including JSON gains and the envelope", async () => {
    const appended = await store.append(record({ detail: "looks safe" }));
    expect(appended.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(appended.recordedAt).toBeInstanceOf(Date);

    const [persisted] = await store.list({ proposalId: "TUNE-1" });
    expect(persisted.id).toBe(appended.id);
    expect(persisted.controllerId).toBe("FIC-101");
    expect(persisted.decision).toBe("approved");
    expect(persisted.proposedBy).toBe("tuning-engineer");
    expect(persisted.decidedBy).toBe("control-room-lead");
    expect(persisted.currentGains).toEqual({ kp: 1, ki: 0.1, kd: 0.05 });
    expect(persisted.proposedGains).toEqual({ kp: 1.2, ki: 0.12, kd: 0.06 });
    expect(persisted.appliedGains).toEqual({ kp: 1.2, ki: 0.12, kd: 0.06 });
    expect(persisted.envelope).toEqual(ENVELOPE);
    expect(persisted.envelopeDecision).toBe("within-envelope");
    expect(persisted.detail).toBe("looks safe");
    expect(persisted.reasonCode).toBeNull();
    expect(persisted.recordedAt.getTime()).toBe(appended.recordedAt.getTime());
  });

  it("survives a full close/reopen cycle", async () => {
    await store.append(record({ proposalId: "TUNE-restart" }));
    await store.close();

    const reopened = new DrizzleTuningAuditStore({ sqlitePath: file });
    try {
      const records = await reopened.list({ proposalId: "TUNE-restart" });
      expect(records).toHaveLength(1);
      expect(records[0].proposedBy).toBe("tuning-engineer");
    } finally {
      await reopened.close();
    }
  });

  it("filters by proposal, controller and decision, newest first", async () => {
    await store.append(record({ proposalId: "TUNE-a", decision: "proposed" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.append(record({ proposalId: "TUNE-a", decision: "approved" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.append(record({ proposalId: "TUNE-b", controllerId: "TIC-9" }));

    const forProposal = await store.list({ proposalId: "TUNE-a" });
    expect(forProposal.map((entry) => entry.decision)).toEqual(["approved", "proposed"]);

    const forController = await store.list({ controllerId: "TIC-9" });
    expect(forController).toHaveLength(1);

    const approvals = await store.list({ decision: "approved" });
    expect(approvals.every((entry) => entry.decision === "approved")).toBe(true);
  });

  it("honours the list limit", async () => {
    for (let index = 0; index < 5; index++) {
      await store.append(record({ proposalId: `TUNE-${index}` }));
    }
    expect(await store.list({ limit: 2 })).toHaveLength(2);
  });

  it("is append-only: the database itself rejects UPDATE and DELETE", async () => {
    await store.append(record({ proposalId: "TUNE-immutable" }));

    // A second, independent connection — nothing in the process can rewrite
    // history, not just the store's own API surface.
    const client = rawSqlite(file);
    try {
      await expect(
        rawRun(client, "UPDATE pid_tuning_audit SET decided_by = 'someone-else'")
      ).rejects.toThrow(/append-only/);
      await expect(
        rawRun(client, "DELETE FROM pid_tuning_audit")
      ).rejects.toThrow(/append-only/);
    } finally {
      await rawClose(client);
    }

    const [survivor] = await store.list({ proposalId: "TUNE-immutable" });
    expect(survivor.decidedBy).toBe("control-room-lead");
  });
});
