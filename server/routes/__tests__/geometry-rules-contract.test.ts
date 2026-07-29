/**
 * Contract tests for the custom geometry classification-rule surface (#641).
 *
 * The classifier has no custom-rule input. The route must therefore refuse a
 * write instead of storing and echoing a rule that classification never reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { geometryRoutes } from "../geometry";

const WRITE_KEY = "geometry-rules-contract-write";
const READ_ONLY_KEY = "geometry-rules-contract-read";

let server: Server;
let base: string;
let originalApiKeys: string | undefined;
let originalApiKeysFile: string | undefined;

interface ApiResponse {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function api(
  method: "GET" | "POST",
  path: string,
  key?: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (key) headers["x-api-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    text,
  };
}

beforeAll(async () => {
  originalApiKeys = process.env.API_KEYS;
  originalApiKeysFile = process.env.API_KEYS_FILE;
  process.env.API_KEYS =
    `${WRITE_KEY}:geometry-rule-writer:geometry.write,` +
    `${READ_ONLY_KEY}:geometry-rule-reader:geometry.read`;
  delete process.env.API_KEYS_FILE;
  _resetControlPlaneAuthCache();

  const app = express();
  app.use(express.json());
  app.use("/api/geometry", geometryRoutes(null));

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  if (originalApiKeysFile === undefined) delete process.env.API_KEYS_FILE;
  else process.env.API_KEYS_FILE = originalApiKeysFile;
  _resetControlPlaneAuthCache();
});

describe("custom geometry classification rules", () => {
  it("keeps the unavailable mutation behind geometry.write", async () => {
    const unauthenticated = await api("POST", "/api/geometry/rules", undefined, {});
    expect(unauthenticated.status).toBe(401);

    const readOnly = await api("POST", "/api/geometry/rules", READ_ONLY_KEY, {});
    expect(readOnly.status).toBe(403);
    expect(readOnly.json.requiredScopes).toEqual(["geometry.write"]);
  });

  it("returns an honest 501 and never stores or echoes the requested override", async () => {
    const before = await api("GET", "/api/geometry/rules");
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({
      configured: false,
      rules: [],
    });
    expect(before.json.detail).toMatch(/not implemented/i);
    expect(before.json.reference).toContain("641");

    const requestedRule = {
      pattern: "^PUMP-OVERRIDE-PROBE$",
      quadrant: 3,
      triality: 2,
      slot: 7,
    };
    const refused = await api("POST", "/api/geometry/rules", WRITE_KEY, requestedRule);

    expect(refused.status).toBe(501);
    expect(refused.json).toMatchObject({
      error: "not_implemented",
      detail: before.json.detail,
      reference: before.json.reference,
    });
    expect(refused.json).not.toHaveProperty("message");
    expect(refused.json).not.toHaveProperty("totalRules");
    expect(refused.json).not.toHaveProperty("rule");

    const after = await api("GET", "/api/geometry/rules");
    expect(after.text).toBe(before.text);
    expect(after.text).not.toContain(requestedRule.pattern);
  });
});
