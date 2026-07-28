/**
 * Observed-liveness collector: configuration gating, status mapping, lifecycle
 * and failure handling (issue #456).
 *
 * The durability half — that observations survive a restart, that retention
 * prunes, that window/validator filtering works, and that the existing
 * simulator produces penalties from stored records — lives in
 * ./liveness-collector-durability.test.ts against a real SQLite database.
 *
 * What is pinned here:
 *   - with default env NOTHING is armed: no timer, no poll, no write;
 *   - an unreachable node produces a `miss` OBSERVATION rather than throwing;
 *   - the three mappings (answered+advanced / no answer / answered+stalled),
 *     plus the two cases that must NOT be reported as `hit` or `miss`: a first
 *     observation, and a height regression;
 *   - `stop()` clears the timer and leaves nothing running;
 *   - a storage failure is counted and surfaced, never swallowed.
 */

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OBSERVED_LIVENESS_SOURCE_ID,
  ObservedLivenessSource,
  ValidatorLivenessCollector,
  buildObservedLivenessDescriptor,
  classifyObservation,
  loadLivenessCollectorConfig,
  observedValidatorId,
  toValidatorHistories,
  type LivenessObservationStore,
} from "../liveness-collector";
import type { ValidatorNodeView } from "@shared/types/services/validator-dashboard";
import type { ValidatorLivenessObservationRecord } from "../../storage";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * In-memory store. Used ONLY for the non-durability assertions in this file;
 * the persistence contract is proved against a real database elsewhere.
 */
class MemoryStore implements LivenessObservationStore {
  rows: ValidatorLivenessObservationRecord[] = [];
  appendCalls = 0;
  pruneCalls: number[] = [];
  failAppendWith: Error | null = null;
  failPruneWith: Error | null = null;

  async append(rows: readonly ValidatorLivenessObservationRecord[]): Promise<void> {
    this.appendCalls += 1;
    if (this.failAppendWith) throw this.failAppendWith;
    this.rows.push(...rows.map((row) => ({ ...row })));
  }

  async since(
    fromMs: number,
    validatorId?: string,
  ): Promise<ValidatorLivenessObservationRecord[]> {
    return this.rows
      .filter((row) => row.observedAt.getTime() >= fromMs)
      .filter((row) => validatorId === undefined || row.validatorId === validatorId)
      .sort((a, b) => a.roundSeq - b.roundSeq);
  }

  async prune(beforeMs: number): Promise<number> {
    this.pruneCalls.push(beforeMs);
    if (this.failPruneWith) throw this.failPruneWith;
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.observedAt.getTime() >= beforeMs);
    return before - this.rows.length;
  }

  async maxRoundSeq(): Promise<number> {
    return this.rows.reduce((max, row) => Math.max(max, row.roundSeq), 0);
  }

  async latestHeights(): Promise<Array<{ validatorId: string; observedHeight: number }>> {
    const latest = new Map<string, { roundSeq: number; observedHeight: number }>();
    for (const row of this.rows) {
      if (row.observedHeight === null) continue;
      const current = latest.get(row.validatorId);
      if (!current || row.roundSeq > current.roundSeq) {
        latest.set(row.validatorId, {
          roundSeq: row.roundSeq,
          observedHeight: row.observedHeight,
        });
      }
    }
    return [...latest.entries()].map(([validatorId, entry]) => ({
      validatorId,
      observedHeight: entry.observedHeight,
    }));
  }
}

function statusPayload(height: number, nodeId = "node-1"): unknown {
  return {
    node_id: nodeId,
    height,
    role: "validator",
    order_parameter: 0.97,
    mean_phase: 1.1,
    local_phase: 1.05,
    peer_phases: [],
    peers: 3,
    mempool: 0,
    uptime_ticks: height * 10,
  };
}

/** Minimal fetch double matching the shared bounded transport's expectations. */
function okResponse(body: unknown): Response {
  const text = JSON.stringify(body);
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

function reachableView(height: number): ValidatorNodeView {
  return {
    label: "node:9090",
    reachable: true,
    error: null,
    observedAt: 1_700_000_000_000,
    status: {
      nodeId: "node-1",
      height,
      role: "validator",
      reportedOrderParameter: 0.97,
      reportedMeanPhase: 1.1,
      localPhase: 1.05,
      peers: 3,
      mempool: 0,
      uptimeTicks: height * 10,
      peerPhases: [],
    },
  };
}

function unreachableView(error: string): ValidatorNodeView {
  return {
    label: "node:9090",
    reachable: false,
    error,
    observedAt: 1_700_000_000_000,
    status: null,
  };
}

// ─── Migration / dev-mode DDL alignment ──────────────────────────────────────

describe("observed-liveness migration alignment", () => {
  const COLUMNS = [
    "validator_id",
    "observed_at",
    "round_seq",
    "status",
    "source_node_url",
    "observed_height",
    "previous_height",
    "observed_uptime_ticks",
    "reported_node_id",
    "local_phase",
    "mean_phase",
    "detail",
    "created_at",
  ] as const;

  it("creates every durable column and index in the Postgres migration", () => {
    const sql = readFileSync(
      new URL("../../../migrations/0012_validator_liveness_observations.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS validator_liveness_observations");
    for (const column of COLUMNS) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sql).toContain("UNIQUE INDEX IF NOT EXISTS idx_validator_liveness_validator_round");
    expect(sql).toContain("idx_validator_liveness_observed_at");
    expect(sql).toContain("idx_validator_liveness_validator_observed_at");
    // The status vocabulary is constrained in the database, so a row this code
    // cannot interpret cannot be written by anything else either.
    expect(sql).toContain("CHECK (status IN ('hit', 'miss', 'late'))");
  });

  it("declares the same table for the SQLite development fallback", () => {
    const storageSource = readFileSync(new URL("../../storage.ts", import.meta.url), "utf8");

    expect(storageSource).toContain(
      "CREATE TABLE IF NOT EXISTS validator_liveness_observations",
    );
    for (const column of COLUMNS) {
      expect(storageSource).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(storageSource).toContain("UNIQUE(validator_id, round_seq)");
    expect(storageSource).toContain("CHECK (status IN ('hit', 'miss', 'late'))");
    // Applied on every open, so the dev backend is usable without hand-seeding.
    expect(storageSource).toContain("await sqliteExec(validatorLivenessSqliteSchema)");
  });
});

// ─── Configuration gating ────────────────────────────────────────────────────

describe("observed-liveness collector configuration", () => {
  it("is disabled with an empty environment: the feature costs nothing by default", () => {
    const config = loadLivenessCollectorConfig({});
    expect(config.enabled).toBe(false);
    expect(config.nodeUrls).toEqual([]);
    expect(config.reason).toContain("VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true");
  });

  it("is disabled when the flag is not exactly 'true'", () => {
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      const config = loadLivenessCollectorConfig({
        VALIDATOR_LIVENESS_COLLECTOR_ENABLED: value,
        ANCHOR_NODE_URLS: "http://127.0.0.1:9090",
      });
      expect(config.enabled).toBe(false);
    }
  });

  it("is disabled when opted in but no node is configured, and says so", () => {
    const config = loadLivenessCollectorConfig({
      VALIDATOR_LIVENESS_COLLECTOR_ENABLED: "true",
    });
    expect(config.enabled).toBe(false);
    expect(config.reason).toContain("ANCHOR_NODE_URLS");
  });

  it("enables only with the exact flag plus at least one http(s) node", () => {
    const config = loadLivenessCollectorConfig({
      VALIDATOR_LIVENESS_COLLECTOR_ENABLED: "true",
      ANCHOR_NODE_URLS: "http://127.0.0.1:9090,file:///etc/passwd",
    });
    expect(config.enabled).toBe(true);
    // The non-http entry is dropped by the shared parser, not polled.
    expect(config.nodeUrls).toEqual(["http://127.0.0.1:9090"]);
  });

  it("clamps cadence and retention rather than trusting the environment", () => {
    const tooSmall = loadLivenessCollectorConfig({
      VALIDATOR_LIVENESS_POLL_INTERVAL_MS: "1",
      VALIDATOR_LIVENESS_RETENTION_MS: "1",
    });
    expect(tooSmall.pollIntervalMs).toBe(5_000);
    expect(tooSmall.retentionMs).toBe(3_600_000);

    const tooLarge = loadLivenessCollectorConfig({
      VALIDATOR_LIVENESS_POLL_INTERVAL_MS: "999999999",
      VALIDATOR_LIVENESS_RETENTION_MS: "999999999999",
    });
    expect(tooLarge.pollIntervalMs).toBe(3_600_000);
    expect(tooLarge.retentionMs).toBe(30 * 24 * 60 * 60 * 1000);

    const defaults = loadLivenessCollectorConfig({});
    expect(defaults.pollIntervalMs).toBe(60_000);
    // Default retention is the longest window the UI offers.
    expect(defaults.retentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("derives a validator id offline, so unanswered polls are still attributable", () => {
    expect(observedValidatorId("http://10.0.0.12:9090")).toBe("10.0.0.12:9090");
    expect(observedValidatorId("https://node.example:443/a")).toBe("node.example/a");
    // Two nodes behind one host:port do not collide.
    expect(observedValidatorId("http://h:9090/a")).not.toBe(
      observedValidatorId("http://h:9090/b"),
    );
  });
});

// ─── Status mapping ──────────────────────────────────────────────────────────

describe("observed-liveness status mapping", () => {
  it("maps a node that answered and advanced to hit", () => {
    const result = classifyObservation(reachableView(101), 100);
    expect(result.status).toBe("hit");
    expect(result.detail).toContain("100 -> 101");
  });

  it("maps a node that did not answer to miss, carrying the reason", () => {
    const result = classifyObservation(unreachableView("connect ECONNREFUSED"), 100);
    expect(result.status).toBe("miss");
    expect(result.detail).toContain("no answer");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("maps a node that answered but stalled to late, not miss", () => {
    const result = classifyObservation(reachableView(100), 100);
    expect(result.status).toBe("late");
    expect(result.detail).toContain("did not advance");
  });

  it("maps a height regression to late, because the node did answer", () => {
    const result = classifyObservation(reachableView(90), 100);
    // Calling this a `miss` would assert the node was unreachable, which is
    // false. The regression stays visible in the detail and in the row.
    expect(result.status).toBe("late");
    expect(result.detail).toContain("previous 100");
    expect(result.detail).toContain("observed 90");
  });

  it("maps a first observation to late, never hit: one sample shows no progress", () => {
    const result = classifyObservation(reachableView(100), null);
    expect(result.status).toBe("late");
    expect(result.detail).toContain("baseline");
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe("observed-liveness collector lifecycle", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function collector(
    options: { nodeUrls?: string[]; enabled?: boolean; now?: () => number } = {},
  ): ValidatorLivenessCollector {
    return new ValidatorLivenessCollector({
      config: {
        enabled: options.enabled ?? true,
        reason: "test",
        nodeUrls: options.nodeUrls ?? ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 2,
      },
      store,
      now: options.now,
      fetchImpl: async () => okResponse(statusPayload(1)),
    });
  }

  it("arms no timer and writes nothing when the feature is disabled", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const inert = collector({ enabled: false });

    const status = await inert.start();

    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(store.appendCalls).toBe(0);
    expect(store.rows).toHaveLength(0);
    setIntervalSpy.mockRestore();
    await inert.stop();
  });

  it("arms exactly one timer however many times start() is called", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const active = collector();

    await active.start();
    await active.start();
    await active.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(active.status().running).toBe(true);

    await active.stop();
    expect(active.status().running).toBe(false);
    setIntervalSpy.mockRestore();
  });

  it("stop() clears the timer and leaves nothing running", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const active = collector();

    await active.start();
    await active.stop();
    await active.stop(); // idempotent

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(active.status().running).toBe(false);
    clearIntervalSpy.mockRestore();
  });

  it("stop() awaits the round that is really running, not a skipped tick", async () => {
    // A tick that lands while a slow round is still writing is SKIPPED and
    // resolves immediately. If that no-op were what `stop()` awaited, `stop()`
    // would return while an observation was still being written — and a caller
    // that closed the database next would tear it out from under the write.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writesCompleted = 0;
    const slowStore = new MemoryStore();
    const append = slowStore.append.bind(slowStore);
    slowStore.append = async (rows) => {
      await gate;
      await append(rows);
      writesCompleted += 1;
    };

    const slow = new ValidatorLivenessCollector({
      config: {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      store: slowStore,
      fetchImpl: async () => okResponse(statusPayload(7)),
    });

    const round = slow.runRound(); // blocks inside append
    await slow.runRound(); // overlapping: skipped, resolves at once
    expect(slow.status().roundsSkipped).toBe(1);

    let stopReturned = false;
    const stopped = slow.stop().then(() => {
      stopReturned = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(writesCompleted).toBe(0);
    expect(stopReturned).toBe(false);

    release();
    await stopped;
    await round;
    expect(stopReturned).toBe(true);
    expect(writesCompleted).toBe(1);
  });

  it("records a miss observation for an unreachable node rather than throwing", async () => {
    const failing = new ValidatorLivenessCollector({
      config: {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9099"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      store,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9099");
      },
    });

    // The point: this resolves. A dead fleet is data, not an exception.
    await expect(failing.runRound()).resolves.toBeUndefined();

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.status).toBe("miss");
    expect(row.validatorId).toBe("127.0.0.1:9099");
    // Nothing is invented for a node that did not answer.
    expect(row.observedHeight).toBeNull();
    expect(row.observedUptimeTicks).toBeNull();
    expect(row.reportedNodeId).toBeNull();
    expect(row.localPhase).toBeNull();
    expect(failing.status().observedMisses).toBe(1);
    await failing.stop();
  });

  it("advances the round ordinal and the height baseline across rounds", async () => {
    let height = 100;
    const advancing = new ValidatorLivenessCollector({
      config: {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      store,
      fetchImpl: async () => okResponse(statusPayload(height)),
    });

    await advancing.runRound(); // baseline -> late
    height = 101;
    await advancing.runRound(); // advanced -> hit
    await advancing.runRound(); // unchanged -> late

    expect(store.rows.map((r) => r.status)).toEqual(["late", "hit", "late"]);
    expect(store.rows.map((r) => r.roundSeq)).toEqual([1, 2, 3]);
    expect(store.rows.map((r) => r.previousHeight)).toEqual([null, 100, 101]);
    expect(store.rows.map((r) => r.observedHeight)).toEqual([100, 101, 101]);
    await advancing.stop();
  });

  it("prunes beyond the retention window on every recorded round", async () => {
    const now = 1_800_000_000_000;
    const pruning = new ValidatorLivenessCollector({
      config: {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 3_600_000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      store,
      now: () => now,
      fetchImpl: async () => okResponse(statusPayload(5)),
    });

    await pruning.runRound();

    expect(store.pruneCalls).toEqual([now - 3_600_000]);
    await pruning.stop();
  });

  it("surfaces a storage failure instead of swallowing it", async () => {
    store.failAppendWith = new Error("database is locked");
    const broken = collector();

    await broken.runRound();

    const status = broken.status();
    expect(status.storageFailures).toBe(1);
    expect(status.lastError).toContain("database is locked");
    // The round is lost, not half-applied: nothing was recorded and the
    // in-memory baseline was not advanced past a write that did not happen.
    expect(status.roundsRecorded).toBe(0);
    expect(store.rows).toHaveLength(0);
    await broken.stop();
  });

  it("surfaces a retention failure without losing the recorded round", async () => {
    store.failPruneWith = new Error("no such table");
    const broken = collector();

    await broken.runRound();

    const status = broken.status();
    expect(status.retentionFailures).toBe(1);
    expect(status.lastError).toContain("no such table");
    expect(status.roundsRecorded).toBe(1);
    expect(store.rows).toHaveLength(1);
    await broken.stop();
  });

  it("resumes the round ordinal and baseline from the store on restart", async () => {
    store.rows.push({
      validatorId: "127.0.0.1:9090",
      observedAt: new Date(1_700_000_000_000),
      roundSeq: 41,
      status: "hit",
      sourceNodeUrl: "http://127.0.0.1:9090",
      observedHeight: 500,
      previousHeight: 499,
      observedUptimeTicks: 5000,
      reportedNodeId: "node-1",
      localPhase: 1,
      meanPhase: 1,
      detail: "height advanced 499 -> 500",
    });

    const restarted = new ValidatorLivenessCollector({
      config: {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      store,
      fetchImpl: async () => okResponse(statusPayload(501)),
    });

    await restarted.runRound();

    const appended = store.rows[store.rows.length - 1];
    // Ordinal continues from the stored high-water mark...
    expect(appended.roundSeq).toBe(42);
    // ...and the node is NOT treated as a never-before-seen baseline, so real
    // progress across the restart is recorded as the hit it was.
    expect(appended.previousHeight).toBe(500);
    expect(appended.status).toBe("hit");
    await restarted.stop();
  });
});

// ─── Source shaping ──────────────────────────────────────────────────────────

describe("observed-liveness source", () => {
  it("declares its semantics, including that consensus attestation is unavailable", () => {
    const descriptor = buildObservedLivenessDescriptor({
      enabled: true,
      reason: "test",
      nodeUrls: ["http://127.0.0.1:9090"],
      pollIntervalMs: 30_000,
      retentionMs: 86_400_000,
      timeoutMs: 1_000,
      maxConcurrency: 1,
    });

    expect(descriptor.kind).toBe("observed-liveness");
    expect(descriptor.sourceId).toBe(OBSERVED_LIVENESS_SOURCE_ID);
    // The cadence and retention reported are the ones actually in force.
    expect(descriptor.method.pollIntervalMs).toBe(30_000);
    expect(descriptor.method.retentionMs).toBe(86_400_000);
    expect(descriptor.method.endpoint).toBe("/status");
    // A miss must be unmistakable.
    expect(descriptor.statusSemantics.miss).toContain("did not answer this poll round");
    expect(descriptor.statusSemantics.miss).toContain("NOT a missed consensus attestation");
    expect(descriptor.consensusAttestation.available).toBe(false);
    // Stake is not observed anywhere in this build, and the descriptor says so.
    expect(descriptor.stake.available).toBe(false);
    expect(descriptor.roundIdentifier.meaning).toContain("not a");
  });

  it("groups rows per validator, ordered by round, keeping the real height", () => {
    const rows: ValidatorLivenessObservationRecord[] = [
      {
        validatorId: "b:9090",
        observedAt: new Date(2_000),
        roundSeq: 2,
        status: "miss",
        sourceNodeUrl: "http://b:9090",
        observedHeight: null,
        previousHeight: 10,
        observedUptimeTicks: null,
        reportedNodeId: null,
        localPhase: null,
        meanPhase: null,
        detail: "no answer: timeout",
      },
      {
        validatorId: "a:9090",
        observedAt: new Date(1_000),
        roundSeq: 1,
        status: "hit",
        sourceNodeUrl: "http://a:9090",
        observedHeight: 11,
        previousHeight: 10,
        observedUptimeTicks: 110,
        reportedNodeId: "node-a",
        localPhase: 1,
        meanPhase: 1,
        detail: "height advanced 10 -> 11",
      },
    ];

    const histories = toValidatorHistories(rows);

    expect(histories.map((h) => h.validatorId)).toEqual(["a:9090", "b:9090"]);
    // The label survives a screenshot without the JSON envelope.
    expect(histories[0].label).toContain("observed liveness");
    // Stake is not observed, so it is 0 and the descriptor tells consumers to
    // ignore absolute amounts.
    expect(histories[0].stake).toBe(0);
    expect(histories[0].records[0]).toEqual({
      slot: 1,
      timestamp: 1_000,
      status: "hit",
      observedHeight: 11,
    });
    // A miss carries a null height — nothing is carried forward.
    expect(histories[1].records[0].observedHeight).toBeNull();
  });

  it("reads the requested window from the store and substitutes nothing when empty", async () => {
    const store = new MemoryStore();
    const now = 1_800_000_000_000;
    const source = new ObservedLivenessSource(
      store,
      {
        enabled: true,
        reason: "test",
        nodeUrls: ["http://127.0.0.1:9090"],
        pollIntervalMs: 60_000,
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        timeoutMs: 1_000,
        maxConcurrency: 1,
      },
      () => now,
    );

    const sinceSpy = vi.spyOn(store, "since");
    const empty = await source.history("1h");

    // An empty window is reported as an empty window.
    expect(empty).toEqual([]);
    expect(sinceSpy).toHaveBeenCalledWith(now - 3_600_000, undefined);
    expect(source.id).toBe(OBSERVED_LIVENESS_SOURCE_ID);
  });
});
