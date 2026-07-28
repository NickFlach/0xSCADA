/**
 * Observed-liveness durability, against a REAL database (issue #456).
 *
 * No mocked store here — the whole point of the table is that a 24h/7d window
 * is meaningless if the history dies with the process. These tests run the
 * collector and its live source against a file-backed SQLite database (the
 * repository's development backend), close it, reopen it, and read the same
 * observations back.
 *
 * Covered:
 *   - observations persist and survive a simulated restart;
 *   - a restarted collector resumes the round ordinal and the height baseline;
 *   - retention prunes beyond the configured window;
 *   - 1h / 24h / 7d window filtering and per-validator filtering;
 *   - the ACCEPTANCE CRITERION: the existing, unmodified simulator
 *     (`client/src/lib/slashing-simulator.ts`) evaluates an operator-typed rule
 *     over records that came out of the store and produces penalties.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as StorageModule from "../../storage";
import type { ValidatorLivenessObservationRecord } from "../../storage";
import {
  ObservedLivenessSource,
  ValidatorLivenessCollector,
  defaultLivenessObservationStore,
  type LivenessCollectorConfig,
} from "../liveness-collector";
import { parseRulePhrase, simulateRule } from "../../../client/src/lib/slashing-simulator";
import type { ValidatorHistory } from "@shared/types/slashing";

const NODE_URL = "http://127.0.0.1:9490";
const VALIDATOR_ID = "127.0.0.1:9490";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let storage: typeof StorageModule;
let databaseDirectory: string;

const originalEnv = {
  forcePostgres: process.env.FORCE_POSTGRES,
  sqlitePath: process.env.SQLITE_DATABASE_PATH,
};

function config(overrides: Partial<LivenessCollectorConfig> = {}): LivenessCollectorConfig {
  return {
    enabled: true,
    reason: "test",
    nodeUrls: [NODE_URL],
    pollIntervalMs: MINUTE,
    retentionMs: 7 * DAY,
    timeoutMs: 1_000,
    maxConcurrency: 1,
    ...overrides,
  };
}

/** Bounded-transport-shaped response carrying an oxscada `/status` payload. */
function statusResponse(height: number): Response {
  const text = JSON.stringify({
    node_id: "node-liveness",
    height,
    role: "validator",
    order_parameter: 0.99,
    mean_phase: 1.2,
    local_phase: 1.15,
    peer_phases: [],
    peers: 4,
    mempool: 2,
    uptime_ticks: height * 10,
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(text.length) }),
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: new TextEncoder().encode(text) };
          },
          async cancel() {
            /* no-op */
          },
        };
      },
    },
  } as unknown as Response;
}

/** Close and reopen the database — the closest thing to a process restart. */
async function restartDatabase(): Promise<void> {
  await storage.closeDatabase();
  await storage.initializeDatabase();
}

async function clearObservations(): Promise<void> {
  // Retention itself is the only delete path in production; using it here keeps
  // the test from needing privileged SQL.
  await storage.pruneValidatorLivenessObservations(Number.MAX_SAFE_INTEGER);
}

describe("observed-liveness durability (real SQLite)", () => {
  beforeAll(async () => {
    process.env.FORCE_POSTGRES = "false";
    databaseDirectory = mkdtempSync(join(tmpdir(), "oxscada-liveness-"));
    // File-backed, not :memory: — a restart must find the rows still there.
    process.env.SQLITE_DATABASE_PATH = join(databaseDirectory, "liveness.sqlite");

    storage = await import("../../storage");
    await storage.initializeDatabase();
    // Transforming + importing the server modules on a cold cache can exceed
    // vitest's default 10s hook budget on Windows.
  }, 60_000);

  afterAll(async () => {
    await storage.closeDatabase();
    if (originalEnv.forcePostgres === undefined) delete process.env.FORCE_POSTGRES;
    else process.env.FORCE_POSTGRES = originalEnv.forcePostgres;
    if (originalEnv.sqlitePath === undefined) delete process.env.SQLITE_DATABASE_PATH;
    else process.env.SQLITE_DATABASE_PATH = originalEnv.sqlitePath;
    rmSync(databaseDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await clearObservations();
  });

  it("persists observations and reads them back across a restart", async () => {
    let clock = 1_800_000_000_000;
    let height = 400;
    const collector = new ValidatorLivenessCollector({
      config: config(),
      store: defaultLivenessObservationStore,
      now: () => clock,
      fetchImpl: async () => statusResponse(height),
    });

    await collector.runRound(); // baseline
    clock += MINUTE;
    height += 1;
    await collector.runRound(); // advanced
    await collector.stop();

    const before = await storage.listValidatorLivenessObservations(0);
    expect(before).toHaveLength(2);

    await restartDatabase();

    const after = await storage.listValidatorLivenessObservations(0);
    expect(after).toHaveLength(2);
    // Byte-for-byte the same observations, not a re-derivation.
    expect(after.map((row) => row.status)).toEqual(["late", "hit"]);
    expect(after.map((row) => row.roundSeq)).toEqual([1, 2]);
    expect(after.map((row) => row.observedHeight)).toEqual([400, 401]);
    expect(after.map((row) => row.observedAt.getTime())).toEqual([
      1_800_000_000_000,
      1_800_000_000_000 + MINUTE,
    ]);
    expect(after[1].previousHeight).toBe(400);
    expect(after[0].sourceNodeUrl).toBe(NODE_URL);
    expect(after[1].detail).toContain("400 -> 401");
  });

  it("resumes the round ordinal and height baseline in a fresh collector after a restart", async () => {
    let clock = 1_800_000_000_000;
    const first = new ValidatorLivenessCollector({
      config: config(),
      store: defaultLivenessObservationStore,
      now: () => clock,
      fetchImpl: async () => statusResponse(700),
    });
    await first.runRound();
    clock += MINUTE;
    await first.runRound();
    await first.stop();

    await restartDatabase();

    clock += MINUTE;
    const second = new ValidatorLivenessCollector({
      config: config(),
      store: defaultLivenessObservationStore,
      now: () => clock,
      fetchImpl: async () => statusResponse(701),
    });
    await second.runRound();
    await second.stop();

    const rows = await storage.listValidatorLivenessObservations(0);
    expect(rows.map((row) => row.roundSeq)).toEqual([1, 2, 3]);
    // The restarted collector did NOT treat the node as never-before-seen: it
    // compared against the persisted height, so real progress is a hit.
    expect(rows[2].previousHeight).toBe(700);
    expect(rows[2].status).toBe("hit");
  });

  it("prunes observations beyond the retention window", async () => {
    const now = 1_800_000_000_000;
    const stale: ValidatorLivenessObservationRecord = {
      validatorId: VALIDATOR_ID,
      observedAt: new Date(now - 3 * HOUR),
      roundSeq: 1,
      status: "miss",
      sourceNodeUrl: NODE_URL,
      observedHeight: null,
      previousHeight: null,
      observedUptimeTicks: null,
      reportedNodeId: null,
      localPhase: null,
      meanPhase: null,
      detail: "no answer: timeout",
    };
    await storage.appendValidatorLivenessObservations([stale]);
    expect(await storage.listValidatorLivenessObservations(0)).toHaveLength(1);

    const collector = new ValidatorLivenessCollector({
      // Retention of 1h; the stale row is 3h old.
      config: config({ retentionMs: HOUR }),
      store: defaultLivenessObservationStore,
      now: () => now,
      fetchImpl: async () => statusResponse(10),
    });
    await collector.runRound();
    await collector.stop();

    const rows = await storage.listValidatorLivenessObservations(0);
    // Only the round just recorded survives; the table cannot grow unbounded.
    expect(rows).toHaveLength(1);
    expect(rows[0].observedAt.getTime()).toBe(now);
    expect(collector.status().rowsPruned).toBe(1);
  });

  it("filters by window and by validator", async () => {
    const now = 1_800_000_000_000;
    const other = "10.9.9.9:9090";
    const row = (
      validatorId: string,
      sourceNodeUrl: string,
      roundSeq: number,
      agoMs: number,
    ): ValidatorLivenessObservationRecord => ({
      validatorId,
      observedAt: new Date(now - agoMs),
      roundSeq,
      status: "hit",
      sourceNodeUrl,
      observedHeight: 100 + roundSeq,
      previousHeight: 99 + roundSeq,
      observedUptimeTicks: 1_000,
      reportedNodeId: "node-x",
      localPhase: 1,
      meanPhase: 1,
      detail: "height advanced",
    });

    await storage.appendValidatorLivenessObservations([
      row(VALIDATOR_ID, NODE_URL, 1, 3 * DAY),
      row(VALIDATOR_ID, NODE_URL, 2, 2 * HOUR),
      row(VALIDATOR_ID, NODE_URL, 3, 30 * MINUTE),
      row(other, "http://10.9.9.9:9090", 4, 10 * MINUTE),
    ]);

    const source = new ObservedLivenessSource(
      defaultLivenessObservationStore,
      config(),
      () => now,
    );

    const oneHour = await source.history("1h");
    expect(oneHour.flatMap((h) => h.records)).toHaveLength(2);

    const oneDay = await source.history("24h");
    expect(oneDay.flatMap((h) => h.records)).toHaveLength(3);

    const sevenDays = await source.history("7d");
    expect(sevenDays.flatMap((h) => h.records)).toHaveLength(4);
    expect(sevenDays.map((h) => h.validatorId)).toEqual([other, VALIDATOR_ID]);

    const filtered = await source.history("7d", VALIDATOR_ID);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].validatorId).toBe(VALIDATOR_ID);
    expect(filtered[0].records.map((r) => r.slot)).toEqual([1, 2, 3]);
  });

  it("lets the EXISTING simulator project penalties from stored observations", async () => {
    // ── Record a real outage: the node answers, then stops answering for eight
    // poll rounds, then comes back. Every row below is written by the collector
    // from a poll that actually happened.
    const start = 1_800_000_000_000;
    let clock = start;
    let reachable = true;
    let height = 900;

    const collector = new ValidatorLivenessCollector({
      config: config(),
      store: defaultLivenessObservationStore,
      now: () => clock,
      fetchImpl: async () => {
        if (!reachable) throw new Error("connect ECONNREFUSED 127.0.0.1:9490");
        return statusResponse(height);
      },
    });

    await collector.runRound(); // round 1: baseline -> late
    reachable = false;
    for (let i = 0; i < 8; i += 1) {
      clock += MINUTE;
      await collector.runRound(); // rounds 2..9: no answer -> miss
    }
    reachable = true;
    clock += MINUTE;
    height += 1;
    await collector.runRound(); // round 10: answered and advanced -> hit
    await collector.stop();

    // ── Restart, then read the history back through the live source. Nothing
    // in the projection below touches the collector's memory.
    await restartDatabase();

    const source = new ObservedLivenessSource(
      defaultLivenessObservationStore,
      config(),
      () => clock,
    );
    const histories: ValidatorHistory[] = await source.history("1h");
    expect(histories).toHaveLength(1);
    const history = histories[0];
    expect(history.records.map((r) => r.status)).toEqual([
      "late",
      "miss",
      "miss",
      "miss",
      "miss",
      "miss",
      "miss",
      "miss",
      "miss",
      "hit",
    ]);

    // ── The acceptance criterion: an operator types a rule, and the UNMODIFIED
    // simulator projects hypothetical penalties against this actual history.
    const rule = parseRulePhrase("slash 1% per miss after 2 in 1h");
    expect(rule).not.toBeNull();

    const result = simulateRule(history, { ...rule!, livenessRunThreshold: 3 }, "1h", clock);

    expect(result.summary.total).toBe(10);
    expect(result.summary.misses).toBe(8);
    // Eight misses, the first two free: six penalised at 1% each.
    expect(result.penalties).toHaveLength(6);
    expect(result.totalPenaltyPct).toBeCloseTo(6, 10);
    // The eight-round outage is a single consecutive-miss run.
    expect(result.livenessFaults).toHaveLength(1);
    expect(result.livenessFaults[0].length).toBe(8);
    // Stake is NOT observed anywhere in this build, so the absolute amount is
    // zero by construction. The percentage above is the real output; the API
    // descriptor reports stake.available:false and the UI hides the amount.
    expect(history.stake).toBe(0);
    expect(result.totalPenaltyAmount).toBe(0);
  });
});
