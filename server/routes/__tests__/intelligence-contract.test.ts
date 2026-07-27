/**
 * Contract tests for the legacy /api/intelligence surface (issue #216).
 *
 * Every handler on this router used to fabricate its payload: PRNG-generated
 * risk and health scores, hardcoded recommendations, invented timestamps. These
 * tests pin the replacement contract — an explicit, machine-readable refusal —
 * and, just as importantly, assert the *absence* of fabricated measurements:
 * no score fields, and byte-identical bodies across repeated calls, which a
 * pseudo-random payload cannot satisfy.
 *
 * The real routers (/api/predictive #212, /api/twin #214) are mounted on the
 * same test server so the "the working APIs still work" half of the contract is
 * exercised rather than assumed.
 *
 * Harness pattern follows predictive-contract.test.ts: port-0 express server,
 * API_KEYS env, x-api-key header. No DB, no network, no new dependencies.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { intelligenceRoutes } from "../intelligence";
import { predictiveRoutes } from "../predictive";
import { twinRoutes } from "../twin";

const KEY = "intelligence-contract-key";
let server: Server;
let base: string;

interface ApiResponse {
  status: number;
  json: Record<string, unknown>;
  /** Raw body text, so byte-level equality can be compared across calls. */
  text: string;
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const headers: Record<string, string> = { "x-api-key": KEY };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    text,
  };
}

beforeAll(async () => {
  // A single privileged key satisfies the guards on the real routers. The
  // intelligence router carries no per-route control-plane guard of its own,
  // which is precisely why its handlers must not serve engine data (see the
  // module comment there).
  process.env.API_KEYS = `${KEY}:intelligence-contract-tester:*`;
  _resetControlPlaneAuthCache();

  const app = express();
  app.use(express.json());
  // Mirror the mounts in server/routes.ts registerRoutes.
  app.use("/api/intelligence", intelligenceRoutes);
  app.use("/api/predictive", predictiveRoutes);
  app.use("/api/twin", twinRoutes);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.API_KEYS;
  _resetControlPlaneAuthCache();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Field names the removed handlers used to fabricate. */
const FABRICATED_FIELDS = [
  "riskScore",
  "healthScore",
  "predictions",
  "accuracy",
  "confidence",
  "recommendations",
  "trends",
  "alerts",
  "insights",
  "models",
  "history",
  "results",
] as const;

function expectNoFabricatedMeasurements(body: Record<string, unknown>): void {
  for (const field of FABRICATED_FIELDS) {
    expect(body).not.toHaveProperty(field);
  }
  // Belt and braces: a refusal body carries strings only. Any bare number in
  // the payload would be a measurement-shaped value that a caller could plot.
  for (const value of Object.values(body)) {
    expect(typeof value).not.toBe("number");
  }
}

// ── Endpoints with no implementation anywhere on main → 501 ────────────────

const NOT_IMPLEMENTED: ReadonlyArray<readonly [string, string, unknown]> = [
  ["POST", "/api/intelligence/nlquery", { query: "Show me pump efficiency trends" }],
  ["GET", "/api/intelligence/nlquery/history", undefined],
  [
    "POST",
    "/api/intelligence/ml/pipeline",
    { modelId: "pump-efficiency-v1", operation: "predict", data: [{ vibration: 1 }] },
  ],
  ["GET", "/api/intelligence/ml/models", undefined],
  ["GET", "/api/intelligence/ml/pipeline/status/job-1", undefined],
];

describe("unimplemented intelligence endpoints return 501, never fabricated data", () => {
  it.each(NOT_IMPLEMENTED)("%s %s", async (method, path, body) => {
    const res = await api(method, path, body);

    expect(res.status).toBe(501);
    expect(res.json.error).toBe("not_implemented");
    expect(typeof res.json.detail).toBe("string");
    expect((res.json.detail as string).length).toBeGreaterThan(0);
    expect(res.json.reference).toContain("216");
    // 501 means "nothing implements this" — there is no endpoint to point at.
    expect(res.json).not.toHaveProperty("replacement");
    expectNoFabricatedMeasurements(res.json);
  });

  it("refuses a request that the removed Zod schema would have accepted", async () => {
    // The old handler validated this exact body and answered 200 with
    // pseudo-random predictions. A well-formed request must still be refused.
    const res = await api("POST", "/api/intelligence/ml/pipeline", {
      modelId: "pump-efficiency-v1",
      operation: "predict",
      data: [{ vibration: 0.4 }, { vibration: 0.6 }],
    });
    expect(res.status).toBe(501);
    expect(res.json).not.toHaveProperty("results");
  });
});

// ── Endpoints superseded by a real, guarded router → 410 + pointer ─────────

const RETIRED: ReadonlyArray<readonly [string, string, unknown, string]> = [
  [
    "POST",
    "/api/intelligence/maintenance/analyze",
    {
      assetId: "PUMP-101",
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" },
      analysisType: "predictive",
    },
    "/api/predictive",
  ],
  ["GET", "/api/intelligence/maintenance/insights/PUMP-101", undefined, "/api/predictive"],
  [
    "POST",
    "/api/intelligence/digitaltwin/operate",
    { assetId: "PUMP-101", operation: "simulate", parameters: {} },
    "/api/twin",
  ],
  ["GET", "/api/intelligence/digitaltwin/status/PUMP-101", undefined, "/api/twin"],
];

describe("superseded intelligence endpoints return 410 with a migration pointer", () => {
  it.each(RETIRED)("%s %s", async (method, path, body, expectedApi) => {
    const res = await api(method, path, body);

    expect(res.status).toBe(410);
    expect(res.json.error).toBe("endpoint_retired");
    expect(typeof res.json.detail).toBe("string");
    expect(res.json.reference).toContain("216");
    expectNoFabricatedMeasurements(res.json);

    const replacement = res.json.replacement as {
      endpoints: string[];
      scopes: string[];
    };
    expect(Array.isArray(replacement.endpoints)).toBe(true);
    expect(replacement.endpoints.length).toBeGreaterThan(0);
    // Every pointer names the real router, so a caller can act on the 410.
    for (const endpoint of replacement.endpoints) {
      expect(endpoint).toContain(expectedApi);
    }
    expect(replacement.scopes.length).toBeGreaterThan(0);
  });
});

// ── The anti-fabrication assertion ─────────────────────────────────────────

describe("no intelligence endpoint returns a value that varies between calls", () => {
  const ALL_PATHS: ReadonlyArray<readonly [string, string, unknown]> = [
    ...NOT_IMPLEMENTED,
    ...RETIRED.map(([method, path, body]) => [method, path, body] as const),
  ];

  it.each(ALL_PATHS)("%s %s is byte-identical across repeated calls", async (method, path, body) => {
    const [first, second, third] = await Promise.all([
      api(method, path, body),
      api(method, path, body),
      api(method, path, body),
    ]);
    // Pseudo-random payloads cannot pass this; fixed refusal bodies always do.
    expect(second.text).toBe(first.text);
    expect(third.text).toBe(first.text);
  });

  it("gives every asset id the same answer (the mocks varied per call, not per asset)", async () => {
    const a = await api("GET", "/api/intelligence/maintenance/insights/PUMP-101");
    const b = await api("GET", "/api/intelligence/maintenance/insights/TANK-203");
    expect(b.text).toBe(a.text);
    expect(a.status).toBe(410);
  });
});

// ── The real routers are untouched ─────────────────────────────────────────

describe("the implemented APIs still serve real data", () => {
  it("GET /api/predictive/tags returns the engine's tracked tags", async () => {
    const res = await api("GET", "/api/predictive/tags");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.tags)).toBe(true);
  });

  it("POST /api/predictive/ingest then GET /analyze/:tagId returns a real assessment", async () => {
    const tagId = "intelligence-contract-tag";
    const now = Date.now();
    // A flat baseline with a terminal spike: enough samples for the engine's
    // default minSamples, and a value the ensemble can actually score.
    const points = Array.from({ length: 40 }, (_, i) => ({
      timestamp: now - (40 - i) * 1000,
      value: i === 39 ? 500 : 10,
    }));

    const ingest = await api("POST", "/api/predictive/ingest", { tagId, points });
    expect(ingest.status).toBe(200);
    expect(ingest.json.ingested).toBe(points.length);

    const analyze = await api("GET", `/api/predictive/analyze/${tagId}`);
    expect(analyze.status).toBe(200);
    // The assessment is computed from the ingested series, so it is tied to the
    // data — unlike the removed mock, which ignored its input entirely.
    expect(analyze.json.tagId).toBe(tagId);
    expect(typeof analyze.json.ensembleScore).toBe("number");
    expect(Array.isArray(analyze.json.detectorResults)).toBe(true);
    // The spike is the last ingested point, so the assessment must reflect it.
    expect(analyze.json.value).toBe(500);
  });

  it("GET /api/twin/models and /api/twin/step-functions respond from the runtime", async () => {
    const models = await api("GET", "/api/twin/models");
    expect(models.status).toBe(200);
    expect(Array.isArray(models.json.models)).toBe(true);

    const stepFunctions = await api("GET", "/api/twin/step-functions");
    expect(stepFunctions.status).toBe(200);
    expect(Array.isArray(stepFunctions.json.stepFunctions)).toBe(true);
  });

  it("the real routers still enforce their control-plane scopes", async () => {
    // Proves the 410 pointer sends callers somewhere that is actually guarded,
    // which is why /api/intelligence must not proxy to these engines.
    const res = await fetch(`${base}/api/predictive/tags`);
    expect(res.status).toBe(401);
  });
});

// ── Source-level regression guard ──────────────────────────────────────────

describe("server/routes contains no fabricated-measurement source", () => {
  it("no route module calls Math.random()", () => {
    const routesDir = dirname(dirname(fileURLToPath(import.meta.url)));
    // Top-level route modules only; __tests__ is excluded because test
    // fixtures may legitimately generate values.
    const modules = readdirSync(routesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);

    expect(modules.length).toBeGreaterThan(0);
    const offenders = modules.filter((name) =>
      /Math\s*\.\s*random\s*\(/.test(readFileSync(join(routesDir, name), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
