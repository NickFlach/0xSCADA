import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";
import {
  setupApiGateway,
  type ApiKeyRecord,
} from "../middleware/api-gateway";
import { predictiveRoutes } from "../routes/predictive";
import { predictiveStore } from "../services/predictive/store";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface RouteCase {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: Record<string, unknown>;
  authorizedStatus: number;
  authorizedKey?: string;
  underScopedKey?: string;
}

const readRoutes: RouteCase[] = [
  { method: "GET", path: "/tags", authorizedStatus: 200 },
  { method: "GET", path: "/configured-tags", authorizedStatus: 200 },
  { method: "GET", path: "/thresholds/unknown-tag", authorizedStatus: 200 },
  { method: "GET", path: "/alerts", authorizedStatus: 200 },
  { method: "GET", path: "/status", authorizedStatus: 200 },
];

const recommendationRoutes: RouteCase[] = [
  {
    method: "GET",
    path: "/analyze/unknown-tag",
    authorizedStatus: 404,
    authorizedKey: "recommend-key",
    underScopedKey: "read-key",
  },
  {
    method: "GET",
    path: "/prediction/unknown-tag",
    authorizedStatus: 404,
    authorizedKey: "recommend-key",
    underScopedKey: "read-key",
  },
];

const mutationRoutes: RouteCase[] = [
  {
    method: "POST",
    path: "/ingest",
    body: {},
    authorizedStatus: 400,
    authorizedKey: "ingest-key",
    underScopedKey: "configure-key",
  },
  {
    method: "PUT",
    path: "/thresholds/unknown-tag",
    body: { minSamples: 2 },
    authorizedStatus: 400,
    authorizedKey: "configure-key",
    underScopedKey: "acknowledge-key",
  },
  {
    method: "POST",
    path: "/alerts/unknown-alert/acknowledge",
    body: {},
    authorizedStatus: 404,
    authorizedKey: "acknowledge-key",
    underScopedKey: "ingest-key",
  },
];

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const records: ApiKeyRecord[] = [
    {
      key: "read-key",
      name: "predictive-reader",
      scopes: ["predictive.read"],
      createdAt: new Date(),
    },
    {
      key: "recommend-key",
      name: "predictive-recommender",
      scopes: ["predictive.recommend"],
      createdAt: new Date(),
    },
    {
      key: "ingest-key",
      name: "predictive-ingester",
      scopes: ["predictive.ingest"],
      createdAt: new Date(),
    },
    {
      key: "configure-key",
      name: "predictive-configurer",
      scopes: ["predictive.configure"],
      createdAt: new Date(),
    },
    {
      key: "acknowledge-key",
      name: "predictive-operator",
      scopes: ["predictive.acknowledge"],
      createdAt: new Date(),
    },
    {
      key: "other-key",
      name: "under-scoped-client",
      scopes: ["other.read"],
      createdAt: new Date(),
    },
  ];
  setupApiGateway(app, {
    enableApiKeyAuth: true,
    apiKeys: new Map(records.map((record) => [record.key, record])),
    publicRoutes: [],
    rateLimit: { windowMs: 60_000, maxRequests: 1_000 },
    corsOrigins: [],
  });
  app.use("/api/predictive", predictiveRoutes);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(
  testServer: TestServer,
  route: RouteCase,
  apiKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (route.body) headers["content-type"] = "application/json";

  return fetch(`${testServer.baseUrl}/api/predictive${route.path}`, {
    method: route.method,
    headers,
    body: route.body ? JSON.stringify(route.body) : undefined,
  });
}

describe("predictive HTTP authorization", () => {
  const originalApiKeys = process.env.API_KEYS;
  let testServer: TestServer;
  let temporaryDirectory: string;

  beforeAll(async () => {
    // #546: the routes now read and write a real durable store. Point it at a
    // throwaway file so authorization tests cannot touch a developer database.
    temporaryDirectory = mkdtempSync(join(tmpdir(), "predictive-auth-"));
    process.env.PREDICTIVE_SQLITE_PATH = join(temporaryDirectory, "predictive.sqlite");
    process.env.API_KEYS = [
      "read-key:predictive-reader:predictive.read",
      "recommend-key:predictive-recommender:predictive.recommend",
      "ingest-key:predictive-ingester:predictive.ingest",
      "configure-key:predictive-configurer:predictive.configure",
      "acknowledge-key:predictive-operator:predictive.acknowledge",
      "other-key:under-scoped-client:other.read",
    ].join(",");
    _resetControlPlaneAuthCache();
    testServer = await startServer();
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    delete process.env.PREDICTIVE_SQLITE_PATH;
    _resetControlPlaneAuthCache();
    // Release the durable-store handle before removing the file it holds open.
    await predictiveStore.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it.each([...readRoutes, ...recommendationRoutes, ...mutationRoutes])(
    "returns 401 for anonymous $method $path",
    async (route) => {
      const response = await request(testServer, route);
      expect(response.status).toBe(401);
    },
  );

  it("rejects invalid and query-string credentials", async () => {
    const invalid = await request(testServer, readRoutes[0], "not-a-key");
    expect(invalid.status).toBe(401);

    const queryCredential = await fetch(
      `${testServer.baseUrl}/api/predictive/status?api_key=read-key`,
    );
    expect(queryCredential.status).toBe(401);
  });

  it.each(readRoutes)(
    "requires predictive.read for $method $path",
    async (route) => {
      const response = await request(testServer, route, "other-key");
      expect(response.status).toBe(403);
    },
  );

  it.each(recommendationRoutes)(
    "requires predictive.recommend for $method $path",
    async (route) => {
      const response = await request(
        testServer,
        route,
        route.underScopedKey,
      );
      expect(response.status).toBe(403);
    },
  );

  it.each(recommendationRoutes)(
    "allows predictive.recommend to reach $method $path",
    async (route) => {
      const response = await request(
        testServer,
        route,
        route.authorizedKey,
      );
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it.each(readRoutes)(
    "allows predictive.read to reach $method $path",
    async (route) => {
      const response = await request(testServer, route, "read-key");
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it.each(mutationRoutes)(
    "rejects a different predictive mutation scope for $method $path",
    async (route) => {
      const response = await request(
        testServer,
        route,
        route.underScopedKey,
      );
      expect(response.status).toBe(403);
    },
  );

  it.each(mutationRoutes)(
    "allows the exact mutation scope to reach handler validation for $method $path",
    async (route) => {
      const response = await request(
        testServer,
        route,
        route.authorizedKey,
      );
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it("allows predictive.read to reach read-handler validation", async () => {
    const response = await request(
      testServer,
      {
        method: "GET",
        path: "/alerts?acknowledged=invalid",
        authorizedStatus: 400,
      },
      "read-key",
    );
    expect(response.status).toBe(400);
  });
});
