/**
 * Regression coverage for the authenticated predictive-state rate limit.
 *
 * The four routes below read or mutate durable state. Their limiter must run
 * after control-plane authentication and use the trusted API-key identity, so
 * operators behind one proxy do not share a source-IP bucket and anonymous
 * traffic cannot consume an authenticated operator's allowance.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { predictiveStore } from "../../services/predictive/store";
import { predictiveRoutes } from "../predictive";

const ALPHA_KEY = "predictive-rate-alpha";
const BETA_KEY = "predictive-rate-beta";
const LIMIT = 60;

let server: Server;
let baseUrl: string;
let temporaryDirectory: string;
const originalApiKeys = process.env.API_KEYS;
const originalSqlitePath = process.env.PREDICTIVE_SQLITE_PATH;

function request(
  path: string,
  options: {
    method?: "GET" | "PUT";
    apiKey?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.apiKey !== undefined) headers["x-api-key"] = options.apiKey;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api/predictive${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

beforeAll(async () => {
  process.env.API_KEYS = [
    `${ALPHA_KEY}:predictive-alpha:*`,
    `${BETA_KEY}:predictive-beta:*`,
  ].join(",");
  temporaryDirectory = mkdtempSync(join(tmpdir(), "predictive-rate-limit-"));
  process.env.PREDICTIVE_SQLITE_PATH = join(temporaryDirectory, "predictive.sqlite");
  _resetControlPlaneAuthCache();

  const app = express();
  app.use(express.json());
  app.use("/api/predictive", predictiveRoutes);
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Predictive rate-limit test server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await predictiveStore.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });

  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  if (originalSqlitePath === undefined) delete process.env.PREDICTIVE_SQLITE_PATH;
  else process.env.PREDICTIVE_SQLITE_PATH = originalSqlitePath;
  _resetControlPlaneAuthCache();
});

describe("predictive durable-state rate limiting", () => {
  it("returns 429 on every protected route after an operator exhausts the shared budget", async () => {
    // Invalid threshold data exits before a store mutation, making this a cheap
    // way to consume the route-local budget without polluting durable fixtures.
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      const response = await request("/thresholds/rate-limit-target", {
        method: "PUT",
        apiKey: ALPHA_KEY,
        body: { minSamples: 1 },
      });
      expect(response.status).toBe(400);
    }

    const protectedRoutes = [
      request("/configured-tags", { apiKey: ALPHA_KEY }),
      request("/thresholds/rate-limit-target", { apiKey: ALPHA_KEY }),
      request("/thresholds/rate-limit-target", {
        method: "PUT",
        apiKey: ALPHA_KEY,
        body: { minSamples: 1 },
      }),
      request("/alerts", { apiKey: ALPHA_KEY }),
    ];
    const responses = await Promise.all(protectedRoutes);
    expect(responses.map((response) => response.status)).toEqual([429, 429, 429, 429]);
    for (const response of responses) {
      expect(response.headers.get("x-ratelimit-limit")).toBe(String(LIMIT));
      expect((await response.json()).error).toBe("Too Many Requests");
    }
  });

  it("isolates buckets by authenticated API-key identity, not shared source IP", async () => {
    const responses = await Promise.all([
      request("/configured-tags", { apiKey: BETA_KEY }),
      request("/thresholds/rate-limit-target", { apiKey: BETA_KEY }),
      request("/thresholds/rate-limit-target", {
        method: "PUT",
        apiKey: BETA_KEY,
        body: { minSamples: 1 },
      }),
      request("/alerts", { apiKey: BETA_KEY }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 400, 200]);
  });

  it("authenticates before consulting the limiter", async () => {
    const response = await request("/configured-tags");
    expect(response.status).toBe(401);
    expect(response.headers.has("x-ratelimit-limit")).toBe(false);
  });
});
