/**
 * Contract tests for the alarm-correlation HTTP surface
 * (server/routes/alarm-correlation.ts). Issue #11.
 *
 * The correlation engine is deterministic and in-memory. Every endpoint is
 * exercised against a port-0 express server (no DB, no network). Assertions
 * pin status codes and response shapes, the 404 paths for unknown
 * ids, and the behavioural contract that alarm ingest returns per-alarm
 * results including `rejected` entries (e.g. future-dated alarms). Unique
 * ids per test keep the shared engine singleton from leaking state.
 *
 * Harness pattern copied from twin-auth.test.ts. No new dependencies, no
 * production code changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { alarmCorrelationRoutes } from "../alarm-correlation";

const KEY = "contract-key";
let server: Server;
let base: string;
let seq = 0;
const uid = (p: string) => `${p}-${seq++}`;

function startServer(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use("/api/alarms", alarmCorrelationRoutes);
  return new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: s, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "x-api-key": KEY };
  if (method !== "GET") headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/alarms${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  process.env.API_KEYS = `${KEY}:contract-tester:*`;
  _resetControlPlaneAuthCache();
  ({ server, base } = await startServer());
});

afterAll(async () => {
  delete process.env.API_KEYS;
  _resetControlPlaneAuthCache();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function alarm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: uid("alarm"), tagId: uid("tag"), severity: "high", timestamp: Date.now(), ...overrides };
}

function causalRule(id: string): Record<string, unknown> {
  return { name: "contract-rule", enabled: true, priority: 1, type: "causal", config: { windowMs: 60_000, maxHops: 3 } };
}

// ── Ingestion & lifecycle ───────────────────────────────────────────────────

describe("POST /api/alarms/alarms", () => {
  it("ingests alarms and returns {ingested, results, rejected}", async () => {
    const { status, json } = await api("POST", "/alarms", { alarms: [alarm()] });
    expect(status).toBe(200);
    expect(typeof json.ingested).toBe("number");
    expect(Array.isArray(json.results)).toBe(true);
    expect(Array.isArray(json.rejected)).toBe(true);
    expect(json.results[0]).toHaveProperty("action");
  });

  it("rejects a malformed body with 400 + error message", async () => {
    const { status, json } = await api("POST", "/alarms", { alarms: [] });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("returns per-alarm rejected entries for future-dated alarms", async () => {
    const future = Date.now() + 2 * 60 * 60 * 1000;
    const { status, json } = await api("POST", "/alarms", {
      alarms: [alarm(), alarm({ timestamp: future })],
    });
    expect(status).toBe(200);
    expect(json.rejected.length).toBeGreaterThanOrEqual(1);
    expect(json.rejected[0]).toHaveProperty("reason");
  });
});

describe("alarm lifecycle 404s", () => {
  it("POST /alarms/:id/clear returns 404 for an untracked alarm", async () => {
    const { status, json } = await api("POST", "/alarms/missing/clear");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });

  it("POST /alarms/:id/acknowledge returns 404 for an untracked alarm", async () => {
    const { status, json } = await api("POST", "/alarms/missing/acknowledge");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });
});

// ── Groups & root cause ─────────────────────────────────────────────────────

describe("GET /api/alarms/groups", () => {
  it("returns the groups array", async () => {
    const { status, json } = await api("GET", "/groups");
    expect(status).toBe(200);
    expect(Array.isArray(json.groups)).toBe(true);
  });

  it("rejects an invalid state filter with 400", async () => {
    const { status, json } = await api("GET", "/groups?state=bogus");
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("GET /groups/:id returns 404 for an unknown group", async () => {
    const { status, json } = await api("GET", "/groups/missing");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });

  it("GET /groups/:id/root-cause returns 404 for an unknown group", async () => {
    const { status, json } = await api("GET", "/groups/missing/root-cause");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });
});

// ── Rules engine ────────────────────────────────────────────────────────────

describe("rules engine", () => {
  it("GET /rules returns the rules array", async () => {
    const { status, json } = await api("GET", "/rules");
    expect(status).toBe(200);
    expect(Array.isArray(json.rules)).toBe(true);
  });

  it("PUT /rules/:id upserts a valid rule", async () => {
    const id = uid("rule");
    const { status, json } = await api("PUT", `/rules/${id}`, causalRule(id));
    expect(status).toBe(200);
    expect(json.id).toBe(id);
    expect(json.type).toBe("causal");
  });

  it("PUT /rules/:id rejects a malformed rule with 400", async () => {
    const { status, json } = await api("PUT", `/rules/${uid("rule")}`, { type: "causal", config: {} });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("DELETE /rules/:id returns 404 for an unknown rule", async () => {
    const { status, json } = await api("DELETE", "/rules/missing");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });

  it("POST /rules/:id/enable and /disable return 404 for an unknown rule", async () => {
    expect((await api("POST", "/rules/missing/enable")).status).toBe(404);
    expect((await api("POST", "/rules/missing/disable")).status).toBe(404);
  });

  it("enable/disable toggle an existing rule", async () => {
    const id = uid("rule");
    await api("PUT", `/rules/${id}`, causalRule(id));
    expect((await api("POST", `/rules/${id}/disable`)).json.enabled).toBe(false);
    expect((await api("POST", `/rules/${id}/enable`)).json.enabled).toBe(true);
  });
});

// ── Topology ────────────────────────────────────────────────────────────────

describe("equipment topology", () => {
  it("GET /topology returns the nodes array", async () => {
    const { status, json } = await api("GET", "/topology");
    expect(status).toBe(200);
    expect(Array.isArray(json.nodes)).toBe(true);
  });

  it("PUT /topology upserts nodes and returns a count", async () => {
    const { status, json } = await api("PUT", "/topology", {
      nodes: [{ equipmentId: uid("eq"), causalDownstream: [] }],
    });
    expect(status).toBe(200);
    expect(typeof json.upserted).toBe("number");
    expect(Array.isArray(json.nodes)).toBe(true);
  });

  it("PUT /topology rejects a malformed body with 400", async () => {
    const { status, json } = await api("PUT", "/topology", { nodes: [] });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("DELETE /topology/:id returns 404 for unknown equipment", async () => {
    const { status, json } = await api("DELETE", "/topology/missing");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });
});

// ── Suppression policy ──────────────────────────────────────────────────────

describe("suppression policy", () => {
  it("GET /suppression-policy returns the policy object", async () => {
    const { status, json } = await api("GET", "/suppression-policy");
    expect(status).toBe(200);
    expect(json).toBeTypeOf("object");
  });

  it("PUT /suppression-policy rejects an empty body with 400", async () => {
    const { status, json } = await api("PUT", "/suppression-policy", {});
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("PUT /suppression-policy enabling without the env opt-in returns 409", async () => {
    const { status, json } = await api("PUT", "/suppression-policy", { enabled: true });
    expect(status).toBe(409);
    expect(json.coordinationMode).toBe("process-local");
  });
});

// ── Metrics & status ────────────────────────────────────────────────────────

describe("metrics & status", () => {
  it("GET /metrics returns a metrics object", async () => {
    const { status, json } = await api("GET", "/metrics");
    expect(status).toBe(200);
    expect(json).toBeTypeOf("object");
  });

  it("GET /status returns the engine status envelope", async () => {
    const { status, json } = await api("GET", "/status");
    expect(status).toBe(200);
    expect(json).toBeTypeOf("object");
  });
});
