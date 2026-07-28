/**
 * Alarm-correlation coordination over HTTP
 * ADR-0026 / ADR-0013 [13.2] — Issue #573
 *
 * Exercises the REST surface against a real Express server, real control-plane
 * auth, and a real durable coordinator over a real SQLite file. The claims
 * under test are the ones an operator's safety depends on:
 *
 *   - production suppression cannot be enabled without healthy durable
 *     coordination, and can be once it is healthy;
 *   - a mutation performed on one replica is visible through this replica's
 *     REST surface;
 *   - a configuration retry carrying the same Idempotency-Key is applied once;
 *   - coordination health is observable rather than inferred.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";
import { alarmCorrelationRoutes } from "../routes/alarm-correlation";
import {
  AlarmCorrelationCoordinator,
  DrizzleCorrelationStore,
  alarmCorrelationService,
} from "../services/alarm-correlation";

// Real HTTP against a real Express server, with a real database file behind it
// at synchronous=FULL. Disk-bound by design; the default 5s budget is not
// enough when this runs in parallel with the rest of the repo.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const READ_KEY = "coord-read-key";
const INGEST_KEY = "coord-ingest-key";
const ACK_KEY = "coord-ack-key";
const CLEAR_KEY = "coord-clear-key";
const CONFIGURE_KEY = "coord-configure-key";

let baseUrl = "";
let server: Server;
const cleanups: Array<() => Promise<void>> = [];

function api(
  route: string,
  apiKey: string,
  init: RequestInit & { body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    ...(init.headers as Record<string, string> | undefined),
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return fetch(`${baseUrl}/api/alarm-correlation${route}`, {
    ...init,
    headers,
    body,
  });
}

async function sharedDbFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alarm-http-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "correlation.sqlite");
}

/**
 * Attach a durable coordinator to the module singleton the router reads, then
 * make sure it is detached again — the singleton outlives any one test.
 */
async function attachCoordinator(file: string, instanceId: string) {
  const store = new DrizzleCorrelationStore({ sqlitePath: file });
  const coordinator = new AlarmCorrelationCoordinator({
    store,
    instanceId,
    pollIntervalMs: 60_000,
    pruneIntervalMs: 60 * 60_000,
  });
  await coordinator.start();
  alarmCorrelationService.attachCoordinator(coordinator);
  cleanups.push(() => alarmCorrelationService.shutdown());
  return coordinator;
}

/** A second replica, not attached to the singleton, sharing the same journal. */
async function peerReplica(file: string, instanceId: string) {
  const store = new DrizzleCorrelationStore({ sqlitePath: file });
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

const originalApiKeys = process.env.API_KEYS;
const originalEphemeral = process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION;

beforeAll(async () => {
  process.env.API_KEYS = [
    `${READ_KEY}:coord-reader:alarms.read`,
    `${INGEST_KEY}:coord-ingester:alarms.ingest`,
    `${ACK_KEY}:coord-acknowledger:alarms.acknowledge`,
    `${CLEAR_KEY}:coord-clearer:alarms.clear`,
    `${CONFIGURE_KEY}:coord-configurer:alarms.configure`,
  ].join(",");
  delete process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION;
  _resetControlPlaneAuthCache();

  const app = express();
  app.use(express.json());
  app.use("/api/alarm-correlation", alarmCorrelationRoutes);
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
  delete process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  if (originalEphemeral === undefined) {
    delete process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION;
  } else {
    process.env.ALARM_CORRELATION_ALLOW_EPHEMERAL_SUPPRESSION = originalEphemeral;
  }
  _resetControlPlaneAuthCache();
});

describe("suppression gating", () => {
  it("refuses to enable suppression without durable coordination", async () => {
    const response = await api("/suppression-policy", CONFIGURE_KEY, {
      method: "PUT",
      body: { enabled: true },
    });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.coordinationMode).toBe("process-local");
    expect(String(payload.error)).toContain("durable");

    // And suppression really is still off — the refusal is not cosmetic.
    const policy = await (await api("/suppression-policy", READ_KEY)).json();
    expect(policy.enabled).toBe(false);
  });

  it("reports process-local coordination as unhealthy and explains why", async () => {
    const payload = await (await api("/coordination", READ_KEY)).json();
    expect(payload).toMatchObject({
      healthy: false,
      mode: "process-local",
      backend: "none",
    });
    expect(String(payload.detail)).toContain("process-local");
  });

  it("allows suppression once durable coordination reports healthy", async () => {
    await attachCoordinator(await sharedDbFile(), "replica-http");

    const health = await (await api("/coordination", READ_KEY)).json();
    expect(health).toMatchObject({ healthy: true, mode: "durable", backend: "sqlite" });

    const response = await api("/suppression-policy", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "policy-enable-1" },
      body: { enabled: true, neverSuppressAtOrAbove: "critical" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      neverSuppressAtOrAbove: "critical",
      unsuppressOnRootClear: true,
    });

    const readBack = await (await api("/suppression-policy", READ_KEY)).json();
    expect(readBack.enabled).toBe(true);
  });

  it("rejects a malformed Idempotency-Key instead of ignoring it", async () => {
    await attachCoordinator(await sharedDbFile(), "replica-http");
    const response = await api("/suppression-policy", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "not a valid key!" },
      body: { enabled: true },
    });
    expect(response.status).toBe(400);
    expect(String((await response.json()).error)).toContain("Idempotency-Key");
  });
});

describe("coordinated mutations over REST", () => {
  it("applies a repeated configuration request with the same key exactly once", async () => {
    const coordinator = await attachCoordinator(await sharedDbFile(), "replica-http");
    const rule = {
      name: "Custom causal",
      type: "causal",
      enabled: true,
      priority: 7,
      config: { windowMs: 45_000, maxHops: 2 },
    };

    const first = await api("/rules/custom-causal", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "rule-put-1" },
      body: rule,
    });
    expect(first.status).toBe(200);
    const seqAfterFirst = coordinator.health().appliedSeq;

    const retry = await api("/rules/custom-causal", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "rule-put-1" },
      body: rule,
    });
    expect(retry.status).toBe(200);
    // The retry collapsed onto the entry already in the journal: no second
    // operation, so nothing was applied twice.
    expect(coordinator.health().appliedSeq).toBe(seqAfterFirst);

    const rules = await (await api("/rules", READ_KEY)).json();
    expect(
      rules.rules.filter((entry: { id: string }) => entry.id === "custom-causal"),
    ).toHaveLength(1);
    // A genuine retry reports that it changed nothing, rather than implying it
    // applied the request a second time.
    expect(await retry.json()).toMatchObject({ applied: false });
  });

  it("refuses a reused Idempotency-Key that asks for something different", async () => {
    await attachCoordinator(await sharedDbFile(), "replica-http");
    const base = {
      name: "Reuse probe",
      type: "temporal",
      enabled: true,
      priority: 11,
      config: { windowMs: 5_000, scope: "same-tag" },
    };

    const first = await api("/rules/reuse-probe", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "reused-key" },
      body: base,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ applied: true });

    // Same key, different content. The journal already holds an entry for this
    // key, so nothing new is applied — and saying 200 would be a false claim
    // that the operator's edit took effect.
    const conflicting = await api("/rules/reuse-probe", CONFIGURE_KEY, {
      method: "PUT",
      headers: { "idempotency-key": "reused-key" },
      body: { ...base, priority: 99 },
    });
    expect(conflicting.status).toBe(409);
    expect(String((await conflicting.json()).error)).toContain("Idempotency-Key");

    const rules = await (await api("/rules", READ_KEY)).json();
    const stored = rules.rules.find((entry: { id: string }) => entry.id === "reuse-probe");
    expect(stored.priority).toBe(11);
  });

  it("shows an acknowledge performed on another replica through REST", async () => {
    const file = await sharedDbFile();
    const local = await attachCoordinator(file, "replica-http");
    const peer = await peerReplica(file, "replica-peer");

    const ingest = await api("/alarms", INGEST_KEY, {
      method: "POST",
      body: {
        alarms: [
          {
            id: "cross-replica-alarm",
            tagId: "PUMP-3.TRIP",
            severity: "high",
            timestamp: 1_000,
          },
        ],
      },
    });
    expect(ingest.status).toBe(200);
    expect((await ingest.json()).coordinationMode).toBe("durable");

    // The other replica sees it, and acknowledges it there.
    await peer.pump();
    const acknowledged = await peer.submitAcknowledge(
      "cross-replica-alarm",
      "operator-on-peer",
    );
    expect(acknowledged.outcome).toBe(true);

    // This replica has not consumed that entry yet...
    expect(local.engine.getAlarm("cross-replica-alarm")?.state).toBe("active");
    await local.pump();

    // ...and once it has, REST here reports the peer's decision and its author.
    const snapshot = await (await api("/snapshot", READ_KEY)).json();
    const alarm = snapshot.alarms.find(
      (entry: { id: string }) => entry.id === "cross-replica-alarm",
    );
    expect(alarm).toMatchObject({
      state: "acknowledged",
      acknowledgedBy: "operator-on-peer",
    });
    expect(alarm.correlation.coordinationMode).toBe("durable");
    expect(typeof alarm.correlation.seq).toBe("number");
  });

  it("serves one snapshot entry per active alarm and omits cleared ones", async () => {
    await attachCoordinator(await sharedDbFile(), "replica-http");
    await api("/alarms", INGEST_KEY, {
      method: "POST",
      body: {
        alarms: [
          { id: "keep-1", tagId: "PUMP-4.TRIP", severity: "high", timestamp: 1_000 },
          { id: "keep-2", tagId: "PUMP-4.TRIP", severity: "low", timestamp: 1_100 },
          { id: "gone", tagId: "TANK-9.LEVEL", severity: "medium", timestamp: 5_000 },
        ],
      },
    });
    const before = await (await api("/snapshot", READ_KEY)).json();
    expect(before.alarms.map((entry: { id: string }) => entry.id))
      .toEqual(expect.arrayContaining(["keep-1", "keep-2", "gone"]));

    const cleared = await api("/alarms/gone/clear", CLEAR_KEY, { method: "POST" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      cleared: true,
      clearedBy: "coord-clearer",
    });

    const snapshot = await (await api("/snapshot", READ_KEY)).json();
    const ids = snapshot.alarms.map((entry: { id: string }) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["keep-1", "keep-2"]));
    // A cleared alarm is not something a reconnecting operator still has to
    // act on, so it is not replayed to them.
    expect(ids).not.toContain("gone");
  });
});
