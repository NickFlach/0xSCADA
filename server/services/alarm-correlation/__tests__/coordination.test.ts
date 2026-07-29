/**
 * Durable, replica-coordinated alarm correlation
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * Every test here drives the real `DrizzleCorrelationStore` against a real
 * SQLite file — the same code path production takes against Postgres, minus
 * the dialect. Nothing is mocked out except where a test deliberately breaks
 * the store to prove the fail-safe path, and in that case it is the real store
 * object whose file has been made unusable.
 *
 * "Two replicas" means two independent coordinators, each with its own engine
 * and its own store connection, pointed at one shared database file — which is
 * exactly the production topology with the database standing in for Postgres.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "sqlite3";
import type {
  AlarmGroup,
  CorrelatedAlarm,
  CorrelationRule,
  EquipmentNode,
} from "@shared/types/alarm-correlation";
import { AlarmCorrelationCoordinator } from "../coordinator";
import { DrizzleCorrelationStore, type CorrelationStore } from "../store";
import { AlarmCorrelationService } from "../index";

// Every test here commits real transactions to a real database file, with
// synchronous=FULL. That is deliberate — the point is that state survives — but
// it makes these tests disk-bound, and the default 5s budget is not enough when
// the suite runs in parallel with the rest of the repo.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

async function tempDbFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alarm-corr-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "correlation.sqlite");
}

async function openStore(file: string): Promise<DrizzleCorrelationStore> {
  const store = new DrizzleCorrelationStore({ sqlitePath: file });
  await store.ready();
  cleanups.push(() => store.close());
  return store;
}

/**
 * A coordinator whose poll timer is effectively off, so every test drives
 * journal consumption explicitly with `pump()` and no assertion depends on a
 * background interval having fired.
 */
async function startReplica(
  file: string,
  instanceId: string,
): Promise<AlarmCorrelationCoordinator> {
  const store = await openStore(file);
  const coordinator = new AlarmCorrelationCoordinator({
    store,
    instanceId,
    pollIntervalMs: 60_000,
    pruneIntervalMs: 60 * 60_000,
  });
  await coordinator.start();
  cleanups.push(() => coordinator.stop());
  return coordinator;
}

function alarm(overrides: Partial<CorrelatedAlarm> & { id: string }): CorrelatedAlarm {
  return {
    name: overrides.id,
    tagId: `${overrides.equipmentId ?? "PUMP-1"}.TRIP`,
    equipmentId: overrides.equipmentId ?? "PUMP-1",
    severity: "medium",
    state: "active",
    message: overrides.id,
    timestamp: 1_000,
    ...overrides,
  };
}

/** Comparable shape of one group, for cross-replica equality assertions. */
function groupShape(group: AlarmGroup) {
  return {
    id: group.id,
    state: group.state,
    alarmIds: [...group.alarmIds].sort(),
    rootCauseAlarmId: group.rootCauseAlarmId,
    suppressedAlarmIds: [...group.suppressedAlarmIds].sort(),
    maxSeverity: group.maxSeverity,
  };
}

function groupShapes(coordinator: AlarmCorrelationCoordinator) {
  return coordinator.engine
    .getGroups()
    .map(groupShape)
    .sort((a, b) => a.id.localeCompare(b.id));
}

const TOPOLOGY: EquipmentNode[] = [
  { equipmentId: "AREA-1", causalDownstream: [], siteId: "SITE-A" },
  {
    equipmentId: "PUMP-1",
    parentId: "AREA-1",
    causalDownstream: ["VALVE-1"],
    siteId: "SITE-A",
  },
  { equipmentId: "VALVE-1", parentId: "AREA-1", causalDownstream: [], siteId: "SITE-A" },
];

describe("durable correlation store", () => {
  it("assigns a monotonic sequence and collapses duplicate deliveries", async () => {
    const store = await openStore(await tempDbFile());

    const first = await store.append({
      idempotencyKey: "ingest:A",
      op: "ingest",
      payload: { id: "A" },
      principal: "operator-a",
      originInstance: "replica-1",
    });
    const second = await store.append({
      idempotencyKey: "ingest:B",
      op: "ingest",
      payload: { id: "B" },
      principal: "operator-a",
      originInstance: "replica-2",
    });
    // Same logical operation, submitted again — possibly by another replica.
    const replay = await store.append({
      idempotencyKey: "ingest:A",
      op: "ingest",
      payload: { id: "A" },
      principal: "operator-b",
      originInstance: "replica-2",
    });

    expect(first.created).toBe(true);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(replay).toEqual({ seq: first.seq, created: false });

    const entries = await store.read(0);
    expect(entries.map((entry) => entry.idempotencyKey)).toEqual([
      "ingest:A",
      "ingest:B",
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([first.seq, second.seq]);
    // Attribution is the submitting principal of the entry that was recorded,
    // not of the replay that lost.
    expect(entries[0].principal).toBe("operator-a");
  });

  it("refuses to rewrite a recorded operation's attribution", async () => {
    const file = await tempDbFile();
    const store = await openStore(file);
    await store.append({
      idempotencyKey: "acknowledge:A",
      op: "acknowledge",
      payload: { alarmId: "A" },
      principal: "operator-jane",
      originInstance: "replica-1",
    });

    // The journal is append-only in the DATABASE, not merely by convention in
    // application code: attribution that any UPDATE could rewrite would not be
    // an audit record. Migration 0015 installs the Postgres trigger; this
    // exercises the SQLite one the dev/test backend gets.
    const raw = new Database(file);
    cleanups.push(() => new Promise<void>((resolve) => raw.close(() => resolve())));
    await expect(new Promise<void>((resolve, reject) => {
      raw.run(
        "UPDATE alarm_correlation_journal SET principal = 'attacker' WHERE seq = 1",
        (error) => (error ? reject(error) : resolve()),
      );
    })).rejects.toThrow(/append-only/);

    const entries = await store.read(0);
    expect(entries[0].principal).toBe("operator-jane");
  });

  it("refuses to project an entry another replica already projected", async () => {
    const file = await tempDbFile();
    const a = await openStore(file);
    const b = await openStore(file);

    const changes = {
      groups: [],
      alarms: [],
      deletedGroupIds: [],
      deletedAlarmIds: [],
      upsertRules: [] as CorrelationRule[],
      removedRuleIds: [],
      upsertEquipment: [] as EquipmentNode[],
      removedEquipmentIds: [],
      policy: null,
      metrics: {
        alarmsIngested: 0,
        groupsCreated: 0,
        groupsClosed: 0,
        alarmsSuppressed: 0,
        alarmsUnsuppressed: 0,
      },
      principal: "system",
    };

    expect(await a.project(5, changes)).toBe(true);
    // Behind: writes nothing rather than overwriting seq 5's effects with the
    // state as of seq 4.
    expect(await b.project(4, changes)).toBe(false);
    expect(await b.project(6, changes)).toBe(true);
    expect((await a.load()).appliedSeq).toBe(6);
  });
});

describe("restart recovery", () => {
  it("restores rules, topology, policy, open groups, root cause, lifecycle and attribution", async () => {
    const file = await tempDbFile();
    const before = await startReplica(file, "replica-1");

    await before.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    const customRule: CorrelationRule = {
      id: "custom-causal",
      name: "Custom causal window",
      type: "causal",
      enabled: true,
      priority: 5,
      config: { windowMs: 60_000, maxHops: 3 },
    };
    await before.submitConfig("rule-upsert", { rule: customRule }, "engineer", "r1");
    await before.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );

    await before.submitIngest(
      alarm({ id: "pump-trip", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "sensor-gw",
    );
    await before.submitIngest(
      alarm({
        id: "valve-fault",
        equipmentId: "VALVE-1",
        severity: "low",
        timestamp: 1_500,
        // number | string on the wire: both forms have to come back as the
        // type they went in as, or a numeric limit turns into a string.
        value: 42.5,
        limit: "HIGH-HIGH",
      }),
      "sensor-gw",
    );
    await before.submitAcknowledge("valve-fault", "operator-jane");

    const groupsBefore = groupShapes(before);
    expect(groupsBefore).toHaveLength(1);
    expect(groupsBefore[0].rootCauseAlarmId).toBe("pump-trip");
    await before.stop();

    // Fresh process: new store connection, new engine, nothing carried over in
    // memory. Everything below has to come off disk.
    const after = await startReplica(file, "replica-1-restarted");

    expect(after.engine.rules.get("custom-causal")).toMatchObject({
      name: "Custom causal window",
      config: { windowMs: 60_000, maxHops: 3 },
    });
    expect(after.engine.topology.get("PUMP-1")).toMatchObject({
      parentId: "AREA-1",
      causalDownstream: ["VALVE-1"],
      siteId: "SITE-A",
    });
    expect(after.health().policyEnabledIntent).toBe(true);
    expect(after.engine.getSuppressionPolicy().enabled).toBe(true);

    expect(groupShapes(after)).toEqual(groupsBefore);
    const recovered = after.engine.getGroups({ state: "open" })[0];
    expect(recovered.rootCauseAlarmId).toBe("pump-trip");
    expect(after.engine.getRootCause(recovered.id)?.alarm.id).toBe("pump-trip");

    // Lifecycle state and the principal that produced it both survived.
    const acknowledged = after.engine.getAlarm("valve-fault");
    expect(acknowledged?.state).toBe("acknowledged");
    expect(acknowledged?.acknowledgedBy).toBe("operator-jane");
    expect(acknowledged?.value).toBe(42.5);
    expect(acknowledged?.limit).toBe("HIGH-HIGH");
    expect(acknowledged?.message).toBe("valve-fault");
    expect(acknowledged?.tagId).toBe("VALVE-1.TRIP");
    // Cumulative counters are recovered rather than silently reset to zero.
    expect(after.engine.getMetrics().alarmsIngested).toBe(2);
  });

  it("recovers a suppressed alarm as suppressed, and can still restore it", async () => {
    const file = await tempDbFile();
    const before = await startReplica(file, "replica-1");
    await before.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await before.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );

    await before.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "gw",
    );
    await before.submitIngest(
      alarm({ id: "consequence", equipmentId: "VALVE-1", severity: "low", timestamp: 1_200 }),
      "gw",
    );
    const groupId = before.engine.getGroups({ state: "open" })[0].id;
    expect(before.engine.getGroup(groupId)?.suppressedAlarmIds).toEqual(["consequence"]);
    await before.stop();

    const after = await startReplica(file, "replica-1-restarted");
    // The whole point of persisting suppression: the alarm the operator cannot
    // see is still known to be hidden, and still attached to its group.
    expect(after.engine.getGroup(groupId)?.suppressedAlarmIds).toEqual(["consequence"]);
    expect(after.engine.getAlarm("consequence")?.state).toBe("suppressed");

    // ...and clearing the root still restores it, which is the reason the
    // membership had to survive at all.
    const cleared = await after.submitClear("root", "operator-jane");
    expect(cleared.outcome?.unsuppressed).toEqual(["consequence"]);
    expect(after.engine.getAlarm("consequence")?.state).toBe("active");
  });
});

describe("two-replica coordination", () => {
  it("produces identical membership, root cause, suppression and group ids", async () => {
    const file = await tempDbFile();
    const a = await startReplica(file, "replica-a");
    const b = await startReplica(file, "replica-b");

    await a.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await a.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );

    // The stream is split across replicas: whichever instance a request lands
    // on must not change the outcome.
    await a.submitIngest(
      alarm({ id: "pump-trip", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "gw",
    );
    await b.submitIngest(
      alarm({ id: "valve-fault", equipmentId: "VALVE-1", severity: "low", timestamp: 1_200 }),
      "gw",
    );
    await a.submitIngest(
      alarm({ id: "valve-chatter", equipmentId: "VALVE-1", severity: "low", timestamp: 1_400 }),
      "gw",
    );

    await a.pump();
    await b.pump();

    expect(groupShapes(a)).toEqual(groupShapes(b));
    expect(a.engine.getGroups()).toHaveLength(1);
    // Group ids come from the shared journal position, so both replicas named
    // it the same thing — not merely "a group each".
    expect(groupShapes(a)[0].id).toMatch(/^ACG-\d+$/);
    expect(groupShapes(a)[0].rootCauseAlarmId).toBe("pump-trip");
    expect(groupShapes(a)[0].suppressedAlarmIds).toEqual(["valve-chatter", "valve-fault"]);
  });

  it("converges when event time and journal order disagree", async () => {
    const file = await tempDbFile();
    const a = await startReplica(file, "replica-a");
    const b = await startReplica(file, "replica-b");
    await a.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");

    // Late-arriving earlier alarm: journal order is 5000, 5200, 4800 while
    // event time is 4800, 5000, 5200.
    await a.submitIngest(alarm({ id: "late", equipmentId: "PUMP-1", timestamp: 5_000 }), "gw");
    await b.submitIngest(alarm({ id: "later", equipmentId: "PUMP-1", timestamp: 5_200 }), "gw");
    await a.submitIngest(
      alarm({ id: "earliest", equipmentId: "PUMP-1", timestamp: 4_800 }),
      "gw",
    );
    await a.pump();
    await b.pump();

    expect(groupShapes(a)).toEqual(groupShapes(b));
    // Root election is event-time driven, so the late-delivered earliest alarm
    // wins on both replicas.
    expect(groupShapes(a)[0].rootCauseAlarmId).toBe("earliest");
  });

  it("makes duplicate ingest idempotent across replicas without a second group", async () => {
    const file = await tempDbFile();
    const a = await startReplica(file, "replica-a");
    const b = await startReplica(file, "replica-b");
    await a.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");

    const duplicated = alarm({ id: "dup", equipmentId: "PUMP-1", timestamp: 2_000 });
    const first = await a.submitIngest(duplicated, "gw");
    const second = await b.submitIngest(duplicated, "gw");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.seq).toBe(first.seq);
    await a.pump();
    await b.pump();
    expect(a.engine.getMetrics().alarmsIngested).toBe(1);
    expect(b.engine.getMetrics().alarmsIngested).toBe(1);

    // Now form a group on each side and prove the ids cannot collide.
    await a.submitIngest(alarm({ id: "peer", equipmentId: "PUMP-1", timestamp: 2_100 }), "gw");
    await b.submitIngest(
      alarm({ id: "other-root", equipmentId: "VALVE-1", timestamp: 9_000, siteId: "SITE-A" }),
      "gw",
    );
    await b.submitIngest(
      alarm({ id: "other-peer", equipmentId: "VALVE-1", timestamp: 9_100, siteId: "SITE-A" }),
      "gw",
    );
    await a.pump();
    await b.pump();

    const ids = a.engine.getGroups().map((group) => group.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(groupShapes(a)).toEqual(groupShapes(b));
  });

  it("journals idle-group sweeps so both replicas close and restore identically", async () => {
    const file = await tempDbFile();
    const a = await startReplica(file, "replica-a");
    const b = await startReplica(file, "replica-b");
    await a.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await a.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );
    await a.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "gw",
    );
    await a.submitIngest(
      alarm({ id: "hidden", equipmentId: "VALVE-1", severity: "low", timestamp: 1_100 }),
      "gw",
    );
    await b.pump();
    expect(b.engine.getAlarm("hidden")?.state).toBe("suppressed");

    // Only replica A's sweep timer fires. If sweeping were process-local, A
    // would close the group and reveal the suppressed alarm while B kept
    // hiding it — the two replicas would disagree about what an operator sees.
    const sweepClock = Date.now() + 20 * 60 * 1000;
    await a.submitSweep(sweepClock, 30_000);
    await b.pump();

    expect(groupShapes(a)).toEqual(groupShapes(b));
    for (const replica of [a, b]) {
      expect(replica.engine.getGroups()[0].state).toBe("closed");
      expect(replica.engine.getAlarm("hidden")?.state).toBe("active");
    }

    // A second replica sweeping in the same interval collapses onto the entry
    // already recorded rather than producing a second sweep.
    const duplicate = await b.submitSweep(sweepClock, 30_000);
    expect(duplicate.created).toBe(false);
  });

  it("makes acknowledge, clear and configuration visible on the other replica", async () => {
    const file = await tempDbFile();
    const a = await startReplica(file, "replica-a");
    const b = await startReplica(file, "replica-b");
    await a.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await a.submitIngest(alarm({ id: "one", equipmentId: "PUMP-1", timestamp: 1_000 }), "gw");
    await a.submitIngest(alarm({ id: "two", equipmentId: "PUMP-1", timestamp: 1_100 }), "gw");
    await b.pump();

    // Acknowledge on B, observe on A.
    await b.submitAcknowledge("two", "operator-b");
    await a.pump();
    expect(a.engine.getAlarm("two")).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "operator-b",
    });

    // Configuration change on B, observe on A.
    await b.submitConfig(
      "rule-enabled",
      { ruleId: "default-tag-chatter", enabled: false },
      "engineer-b",
      "cfg-1",
    );
    await a.pump();
    expect(a.engine.rules.get("default-tag-chatter")?.enabled).toBe(false);

    // Clear on A, observe on B.
    await a.submitClear("one", "operator-a");
    await b.pump();
    expect(b.engine.getAlarm("one")).toMatchObject({
      state: "cleared",
      clearedBy: "operator-a",
    });
    expect(groupShapes(a)).toEqual(groupShapes(b));
  });
});

describe("fail-safe on coordination loss", () => {
  /**
   * A store that works until `fail` is set, then rejects everything.
   *
   * `failProject` breaks only the projection, which is the one way an entry can
   * be applied to the engine while the coordinator stays degraded — reads
   * succeed, so `drain()` reaches `applyEntry()`, but it throws before
   * `markHealthy()`.
   */
  function breakableStore(
    inner: CorrelationStore,
  ): CorrelationStore & { fail: boolean; failProject: boolean } {
    const wrapper = {
      fail: false,
      failProject: false,
      ready: () => inner.ready(),
      backend: () => inner.backend(),
      append: (entry: Parameters<CorrelationStore["append"]>[0]) =>
        (wrapper.fail
          ? Promise.reject(new Error("journal unreachable"))
          : inner.append(entry)),
      read: (afterSeq: number, limit?: number) =>
        (wrapper.fail
          ? Promise.reject(new Error("journal unreachable"))
          : inner.read(afterSeq, limit)),
      load: () => inner.load(),
      project: (seq: number, changes: Parameters<CorrelationStore["project"]>[1]) =>
        (wrapper.fail || wrapper.failProject
          ? Promise.reject(new Error("journal unreachable"))
          : inner.project(seq, changes)),
      prune: (options: Parameters<CorrelationStore["prune"]>[0]) => inner.prune(options),
      close: () => inner.close(),
    };
    return wrapper;
  }

  it("disables suppression and restores every suppressed alarm when the store fails", async () => {
    const inner = await openStore(await tempDbFile());
    const store = breakableStore(inner);
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());

    await coordinator.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await coordinator.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );
    await coordinator.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "gw",
    );
    await coordinator.submitIngest(
      alarm({ id: "hidden", equipmentId: "VALVE-1", severity: "low", timestamp: 1_100 }),
      "gw",
    );
    expect(coordinator.engine.getAlarm("hidden")?.state).toBe("suppressed");

    const restored: string[] = [];
    coordinator.engine.on("alarms-unsuppressed", (payload: { alarmIds: string[] }) => {
      restored.push(...payload.alarmIds);
    });

    store.fail = true;
    await expect(
      coordinator.submitIngest(alarm({ id: "next", timestamp: 1_200 }), "gw"),
    ).rejects.toThrow(/journal unreachable/);

    // The alarm the operator could not see is visible again, and was re-emitted
    // so a consumer that had hidden it is told to show it.
    expect(restored).toContain("hidden");
    expect(coordinator.engine.getAlarm("hidden")?.state).toBe("active");
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(false);

    const health = coordinator.health();
    expect(health.healthy).toBe(false);
    expect(health.mode).toBe("process-local");
    expect(health.suppressionDisabledByHealth).toBe(true);
    // The operator's intent is remembered — it was coordination that failed,
    // not the operator that changed their mind.
    expect(health.policyEnabledIntent).toBe(true);
    expect(health.suppressionActive).toBe(false);
  });

  it("re-enables suppression only once coordination is healthy again", async () => {
    const inner = await openStore(await tempDbFile());
    const store = breakableStore(inner);
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());
    await coordinator.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await coordinator.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );

    store.fail = true;
    await expect(coordinator.pump()).rejects.toThrow();
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(false);

    store.fail = false;
    await coordinator.pump();
    expect(coordinator.health().healthy).toBe(true);
    expect(coordinator.health().suppressionDisabledByHealth).toBe(false);
    // Restored to the operator's persisted intent, not to some default.
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(true);
  });

  it("does not let a policy write re-enable suppression while still degraded", async () => {
    const inner = await openStore(await tempDbFile());
    const store = breakableStore(inner);
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());

    await coordinator.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await coordinator.submitConfig(
      "policy-set",
      { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
      "engineer",
      "p1",
    );
    await coordinator.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", severity: "high", timestamp: 1_000 }),
      "gw",
    );
    await coordinator.submitIngest(
      alarm({ id: "hidden", equipmentId: "VALVE-1", severity: "low", timestamp: 1_100 }),
      "gw",
    );
    expect(coordinator.engine.getAlarm("hidden")?.state).toBe("suppressed");

    store.fail = true;
    await expect(coordinator.pump()).rejects.toThrow();
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(false);
    expect(coordinator.engine.getAlarm("hidden")?.state).toBe("active");

    // Reads work again, so the entry IS applied and `syncEnginePolicy()` runs —
    // but the projection still fails, so the coordinator never becomes healthy.
    // `degrade()` is idempotent and will not force suppression off a second
    // time, so the health gate inside `syncEnginePolicy()` is the only thing
    // standing between a degraded replica and silently hiding alarms again.
    store.fail = false;
    store.failProject = true;
    await expect(
      coordinator.submitConfig(
        "policy-set",
        { policy: { enabled: true, neverSuppressAtOrAbove: "critical" } },
        "engineer",
        "p2",
      ),
    ).rejects.toThrow(/journal unreachable/);

    expect(coordinator.health().healthy).toBe(false);
    expect(coordinator.health().suppressionDisabledByHealth).toBe(true);
    expect(coordinator.health().policyEnabledIntent).toBe(true);
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(false);
    expect(coordinator.health().suppressionActive).toBe(false);
    expect(coordinator.engine.getAlarm("hidden")?.state).toBe("active");

    // And once projection recovers, the operator's intent is honoured again.
    store.failProject = false;
    await coordinator.pump();
    expect(coordinator.health().healthy).toBe(true);
    expect(coordinator.engine.getSuppressionPolicy().enabled).toBe(true);
  });

  it("still delivers the alarm when the journal cannot be written", async () => {
    const inner = await openStore(await tempDbFile());
    const store = breakableStore(inner);
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());

    const service = new AlarmCorrelationService();
    service.attachCoordinator(coordinator);
    const delivered: string[] = [];
    service.on("alarm-snapshot", (snapshot: { id: string }) => delivered.push(snapshot.id));

    store.fail = true;
    const outcome = await service.submit({
      id: "storm-alarm",
      tagId: "PUMP-9.TRIP",
      severity: "high",
      state: "active",
      timestamp: 4_000,
    });

    // Storage loss must never hide an alarm: it is correlated locally, returned
    // to the caller, and broadcast.
    expect(outcome?.alarm.id).toBe("storm-alarm");
    expect(delivered).toContain("storm-alarm");
    expect(service.coordinationMode()).toBe("process-local");
    const health = await service.healthCheck();
    expect(health.durableSuppressionAvailable).toBe(false);
  });

  it("re-projects an entry whose projection failed instead of skipping its rows", async () => {
    const file = await tempDbFile();
    const inner = await openStore(file);
    let failProject = false;
    const store: CorrelationStore = {
      ready: () => inner.ready(),
      backend: () => inner.backend(),
      append: (entry) => inner.append(entry),
      read: (afterSeq, limit) => inner.read(afterSeq, limit),
      load: () => inner.load(),
      project: (seq, changes) =>
        (failProject
          ? Promise.reject(new Error("projection write failed"))
          : inner.project(seq, changes)),
      prune: (options) => inner.prune(options),
      close: () => Promise.resolve(),
    };
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());

    // The entry applies to the engine, then its projection write fails.
    failProject = true;
    await expect(
      coordinator.submitIngest(
        alarm({ id: "survivor", equipmentId: "PUMP-1", severity: "critical" }),
        "gw",
      ),
    ).rejects.toThrow(/projection write failed/);

    // Storage recovers and the entry is retried. Re-applying it is a no-op at
    // the engine, so nothing is re-emitted — the retry has to project the rows
    // the first attempt collected, or the watermark advances past an entry
    // whose alarm was never written and no replica can ever recover it.
    failProject = false;
    await coordinator.pump();
    expect(coordinator.health().healthy).toBe(true);

    const snapshot = await inner.load();
    expect(snapshot.pending.map((entry) => entry.id)).toContain("survivor");

    // A replica that starts from the projection alone still sees the alarm.
    const restarted = await startReplica(file, "replica-b");
    expect(restarted.engine.getAlarm("survivor")).toBeTruthy();
  });
});

describe("service integration", () => {
  it("reports durable mode and a shared seq on snapshots", async () => {
    const file = await tempDbFile();
    const coordinator = await startReplica(file, "replica-a");
    const service = new AlarmCorrelationService();
    service.attachCoordinator(coordinator);

    const snapshots: Array<{ id: string; correlation: { seq: number | null; coordinationMode: string } }> = [];
    service.on("alarm-snapshot", (snapshot: never) => snapshots.push(snapshot));

    await service.submit(
      { id: "a1", tagId: "PUMP-1.TRIP", severity: "high", state: "active", timestamp: 1_000 },
      "gw",
    );
    await service.submit(
      { id: "a2", tagId: "PUMP-1.TRIP", severity: "low", state: "active", timestamp: 1_100 },
      "gw",
    );

    expect(service.coordinationMode()).toBe("durable");
    const last = snapshots.at(-1);
    expect(last?.correlation.coordinationMode).toBe("durable");
    expect(typeof last?.correlation.seq).toBe("number");
    expect(coordinator.alarmSeq("a2")).toBeGreaterThan(0);
  });

  it("returns one canonical reconnect snapshot per active alarm", async () => {
    const file = await tempDbFile();
    const coordinator = await startReplica(file, "replica-a");
    const service = new AlarmCorrelationService();
    service.attachCoordinator(coordinator);

    await service.submit(
      { id: "open-1", tagId: "PUMP-1.TRIP", severity: "high", state: "active", timestamp: 1_000 },
      "gw",
    );
    await service.submit(
      { id: "open-2", tagId: "PUMP-1.TRIP", severity: "low", state: "active", timestamp: 1_100 },
      "gw",
    );
    await service.submit(
      { id: "standalone", tagId: "TANK-7.LEVEL", severity: "medium", state: "active", timestamp: 2_000 },
      "gw",
    );
    await service.clear("open-1", "operator-a");

    const snapshot = service.getReconnectSnapshot();
    const ids = snapshot.map((entry) => entry.id);
    // Exactly once each, cleared alarms omitted, and every entry carries the
    // canonical correlation state rather than whatever was last broadcast.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("open-1");
    expect(ids).toEqual(expect.arrayContaining(["open-2", "standalone"]));
    for (const entry of snapshot) {
      expect(entry.correlation.coordinationMode).toBe("durable");
      expect(entry.state).not.toBe("cleared");
    }
  });

  it("keeps REST and WebSocket surfaces on the same engine after attaching", async () => {
    const file = await tempDbFile();
    const coordinator = await startReplica(file, "replica-a");
    const service = new AlarmCorrelationService();
    service.attachCoordinator(coordinator);
    // The read surface used by routes and the surface used by fanout must be
    // the same object, or the two could report different suppression.
    expect(service.engine).toBe(coordinator.engine);
  });
});

describe("retention", () => {
  it("prunes projected journal entries and aged closed groups, keeping live state", async () => {
    const file = await tempDbFile();
    const store = await openStore(file);
    const coordinator = new AlarmCorrelationCoordinator({
      store,
      instanceId: "replica-a",
      pollIntervalMs: 60_000,
      pruneIntervalMs: 60 * 60_000,
      journalRetentionMs: 0,
      stateRetentionMs: 0,
    });
    await coordinator.start();
    cleanups.push(() => coordinator.stop());

    await coordinator.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await coordinator.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", timestamp: 1_000 }),
      "gw",
    );
    await coordinator.submitIngest(
      alarm({ id: "peer", equipmentId: "PUMP-1", timestamp: 1_100 }),
      "gw",
    );
    const closedGroupId = coordinator.engine.getGroups()[0].id;
    await coordinator.submitClear("root", "operator-a");
    expect(coordinator.engine.getGroup(closedGroupId)?.state).toBe("closed");

    // An open group with a live alarm, which retention must not touch.
    await coordinator.submitIngest(
      alarm({ id: "live-1", equipmentId: "VALVE-1", timestamp: 8_000 }),
      "gw",
    );
    await coordinator.submitIngest(
      alarm({ id: "live-2", equipmentId: "VALVE-1", timestamp: 8_100 }),
      "gw",
    );

    const pruned = await coordinator.prune();
    expect(pruned.groups).toBe(1);
    expect(pruned.alarms).toBe(2);
    expect(pruned.journalEntries).toBeGreaterThan(0);

    const snapshot = await store.load();
    // The closed group is gone; the open one and its members are intact.
    expect(snapshot.groups.map((group) => group.id)).not.toContain(closedGroupId);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].alarmIds.sort()).toEqual(["live-1", "live-2"]);

    // The watermark entry itself is never pruned, so a restarting replica can
    // still tell how far the projection got.
    const remaining = await store.read(0);
    expect(remaining.every((entry) => entry.seq >= snapshot.appliedSeq)).toBe(true);
    expect(snapshot.appliedSeq).toBeGreaterThan(0);
  });

  it("honours the documented retention environment variables", async () => {
    // Migration 0015 and .env.example tell an operator these two variables
    // control retention of durable alarm state. A documented knob that nothing
    // reads is worse than no knob: the operator believes state is being aged
    // out (or kept) on a schedule that is not the one in force.
    const file = await tempDbFile();
    const previous = {
      journal: process.env.ALARM_CORRELATION_JOURNAL_RETENTION_MS,
      state: process.env.ALARM_CORRELATION_STATE_RETENTION_MS,
    };
    process.env.ALARM_CORRELATION_JOURNAL_RETENTION_MS = "1";
    process.env.ALARM_CORRELATION_STATE_RETENTION_MS = "1";
    cleanups.push(async () => {
      if (previous.journal === undefined) {
        delete process.env.ALARM_CORRELATION_JOURNAL_RETENTION_MS;
      } else {
        process.env.ALARM_CORRELATION_JOURNAL_RETENTION_MS = previous.journal;
      }
      if (previous.state === undefined) {
        delete process.env.ALARM_CORRELATION_STATE_RETENTION_MS;
      } else {
        process.env.ALARM_CORRELATION_STATE_RETENTION_MS = previous.state;
      }
    });

    const service = new AlarmCorrelationService();
    const coordinator = await service.enableDurableCoordination({
      sqlitePath: file,
      pollIntervalMs: 60_000,
      instanceId: "replica-env",
    });
    cleanups.push(() => service.shutdown());

    // Wall-clock event times, so the built-in 30-day default would keep this
    // group and only the 1 ms value from the environment can age it out.
    const nowMs = Date.now();
    await coordinator.submitConfig("topology-upsert", { nodes: TOPOLOGY }, "engineer", "t1");
    await coordinator.submitIngest(
      alarm({ id: "root", equipmentId: "PUMP-1", timestamp: nowMs }),
      "gw",
    );
    await coordinator.submitIngest(
      alarm({ id: "peer", equipmentId: "PUMP-1", timestamp: nowMs + 100 }),
      "gw",
    );
    await coordinator.submitClear("root", "operator-a");
    expect(coordinator.engine.getGroups()[0].state).toBe("closed");

    // Both cutoffs are `now - retention`, and Windows' Date.now() granularity
    // is coarse enough that rows written in the same tick as the prune are not
    // strictly older than it. Wait past one tick so the assertions are about
    // retention, not clock resolution.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // With the built-in 7-day / 30-day defaults nothing here is old enough to
    // age out, so a non-zero result is only possible if both environment
    // values were actually read.
    const pruned = await coordinator.prune();
    expect(pruned.groups).toBe(1);
    expect(pruned.journalEntries).toBeGreaterThan(0);
  });
});
