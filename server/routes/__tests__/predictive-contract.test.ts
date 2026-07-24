/**
 * Contract tests for the predictive-maintenance HTTP surface
 * (server/routes/predictive.ts). Issue #11.
 *
 * The engine is deterministic and in-memory, so each endpoint is exercised
 * against a port-0 express server with no DB and no network. Assertions pin
 * status codes and response SHAPES (field names and types), plus the two
 * behavioural contracts that matter: GET /analyze is read-only (never creates
 * alerts) and future-dated ingest points are rejected. Unique tag ids per
 * test keep the shared engine singleton from leaking state between cases.
 *
 * Harness pattern copied from twin-auth.test.ts (port-0 express, API_KEYS env,
 * x-api-key header). No new dependencies, no production code changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { predictiveRoutes } from "../predictive";

const KEY = "contract-key";
let server: Server;
let base: string;
let tagSeq = 0;
const nextTag = () => `contract-tag-${tagSeq++}`;

function startServer(): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use("/api/predictive", predictiveRoutes);
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
  const res = await fetch(`${base}/api/predictive${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  // A single privileged key (scope "*") satisfies every guard on the router;
  // scope enforcement itself is covered elsewhere. Contract tests focus on the
  // request/response contract, not authorization.
  process.env.API_KEYS = `${KEY}:contract-tester:*`;
  _resetControlPlaneAuthCache();
  ({ server, base } = await startServer());
});

afterAll(async () => {
  delete process.env.API_KEYS;
  _resetControlPlaneAuthCache();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function series(count: number, at = Date.now()): Array<{ timestamp: number; value: number }> {
  return Array.from({ length: count }, (_, i) => ({ timestamp: at - (count - i) * 1000, value: 10 + Math.sin(i) }));
}

// A near-flat baseline followed by a large terminal spike. The spike sits many
// standard deviations off the baseline, so the ensemble (z-score/EWMA/IQR)
// scores it anomalous and the engine generates at least one alert on ingest —
// which is what lets the read-only test below actually exercise non-mutation
// over a NON-EMPTY alert set (see issue #22).
function spikeSeries(baselineCount = 20, at = Date.now()): Array<{ timestamp: number; value: number }> {
  const total = baselineCount + 1;
  const baseline = Array.from({ length: baselineCount }, (_, i) => ({
    timestamp: at - (total - i) * 1000,
    value: 10 + 0.05 * Math.sin(i),
  }));
  return [...baseline, { timestamp: at, value: 1000 }];
}

describe("POST /api/predictive/ingest", () => {
  it("ingests a series and returns the assessment envelope", async () => {
    const { status, json } = await api("POST", "/ingest", { tagId: nextTag(), points: series(5) });
    expect(status).toBe(200);
    expect(typeof json.ingested).toBe("number");
    expect(typeof json.rejectedFuturePoints).toBe("number");
    expect(json).toHaveProperty("assessment"); // object or null, but present
  });

  it("rejects a malformed body with 400 + error message", async () => {
    const { status, json } = await api("POST", "/ingest", { tagId: "", points: [] });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("rejects future-dated points (rejectedFuturePoints > 0)", async () => {
    const future = Date.now() + 2 * 60 * 60 * 1000; // 2h ahead, beyond the 1h skew
    const { status, json } = await api("POST", "/ingest", {
      tagId: nextTag(),
      points: [{ timestamp: future, value: 1 }, { timestamp: Date.now(), value: 2 }],
    });
    expect(status).toBe(200);
    expect(json.rejectedFuturePoints).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/predictive/analyze/:tagId", () => {
  it("returns 404 with required/available for an unknown tag", async () => {
    const { status, json } = await api("GET", `/analyze/${nextTag()}`);
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
    expect(typeof json.required).toBe("number");
    expect(typeof json.available).toBe("number");
  });

  it("is read-only: analyze never changes a non-empty alert set", async () => {
    const tag = nextTag();
    // Ingest a spike so the engine actually generates an alert. Without this,
    // a smooth series yields zero alerts and the assertion below (before ==
    // after == 0) passes even if analyze mutated state — the vacuous case in
    // issue #22.
    await api("POST", "/ingest", { tagId: tag, points: spikeSeries() });
    const before = (await api("GET", "/alerts")).json.alerts.length;
    // Guard: the fixture must have produced at least one alert, otherwise this
    // test would be vacuous again.
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await api("GET", `/analyze/${tag}`);
    const after = (await api("GET", "/alerts")).json.alerts.length;
    // Non-mutation is now exercised over a real, non-empty alert set: three
    // read-only GETs must leave the count unchanged (and still non-zero).
    expect(after).toBe(before);
  });
});

describe("GET /api/predictive/prediction/:tagId", () => {
  it("returns 404 for a tag with insufficient data", async () => {
    const { status, json } = await api("GET", `/prediction/${nextTag()}`);
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });
});

describe("GET /api/predictive/tags", () => {
  it("returns the tracked-tags array", async () => {
    const { status, json } = await api("GET", "/tags");
    expect(status).toBe(200);
    expect(Array.isArray(json.tags)).toBe(true);
  });
});

describe("GET/PUT /api/predictive/thresholds/:tagId", () => {
  it("GET returns a thresholds object with minSamples", async () => {
    const { status, json } = await api("GET", `/thresholds/${nextTag()}`);
    expect(status).toBe(200);
    expect(typeof json.minSamples).toBe("number");
  });

  it("PUT rejects an out-of-range field with 400", async () => {
    const { status, json } = await api("PUT", `/thresholds/${nextTag()}`, { minSamples: 1 });
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("PUT rejects an inconsistent severity ordering with 400", async () => {
    const { status, json } = await api("PUT", `/thresholds/${nextTag()}`, {
      severityThresholds: { warning: 0.9, critical: 0.5, emergency: 0.1 },
    });
    expect(status).toBe(400);
    expect(json.error).toContain("warning <= critical <= emergency");
  });

  it("PUT accepts a valid partial override and returns the merged config", async () => {
    const { status, json } = await api("PUT", `/thresholds/${nextTag()}`, { zScoreThreshold: 4 });
    expect(status).toBe(200);
    expect(typeof json.minSamples).toBe("number");
  });
});

describe("GET /api/predictive/alerts", () => {
  it("returns the alerts array", async () => {
    const { status, json } = await api("GET", "/alerts");
    expect(status).toBe(200);
    expect(Array.isArray(json.alerts)).toBe(true);
  });

  it("rejects an invalid severity filter with 400", async () => {
    const { status, json } = await api("GET", "/alerts?severity=bogus");
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });
});

describe("POST /api/predictive/alerts/:alertId/acknowledge", () => {
  it("returns 404 for an unknown alert id", async () => {
    const { status, json } = await api("POST", "/alerts/missing-alert/acknowledge");
    expect(status).toBe(404);
    expect(typeof json.error).toBe("string");
  });
});

describe("GET /api/predictive/status", () => {
  it("returns the engine status envelope", async () => {
    const { status, json } = await api("GET", "/status");
    expect(status).toBe(200);
    expect(typeof json.trackedTags).toBe("number");
    expect(typeof json.totalAlerts).toBe("number");
    expect(Array.isArray(json.detectors)).toBe(true);
  });
});
