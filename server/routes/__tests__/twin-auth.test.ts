import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { twinRoutes } from "../twin";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface RouteCase {
  method: "GET" | "POST" | "DELETE";
  path: string;
  authorizedStatus: number;
  authorizedKey: string;
  underScopedKey: string;
}

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/twin", twinRoutes);

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

function routeCases(
  authorizedKey: string,
  underScopedKey: string,
  routes: ReadonlyArray<
    readonly [RouteCase["method"], string, number]
  >,
): RouteCase[] {
  return routes.map(([method, path, authorizedStatus]) => ({
    method,
    path,
    authorizedStatus,
    authorizedKey,
    underScopedKey,
  }));
}

const readRoutes = routeCases("read-key", "simulate-key", [
  ["GET", "/models", 200],
  ["GET", "/models/missing", 404],
  ["GET", "/models/missing/state", 404],
  ["GET", "/models/missing/compare", 400],
  ["GET", "/step-functions", 200],
  ["GET", "/status", 200],
]);

const configureRoutes = routeCases("configure-key", "operate-key", [
  ["POST", "/models", 400],
  ["DELETE", "/models/missing", 404],
]);

const operateRoutes = routeCases("operate-key", "configure-key", [
  ["POST", "/models/missing/start", 400],
  ["POST", "/models/missing/stop", 400],
  ["POST", "/models/missing/reset", 400],
  ["POST", "/models/missing/step", 400],
  ["POST", "/models/missing/sync", 400],
  // #550: committing a durable checkpoint is an operate-scope action.
  ["POST", "/models/missing/checkpoint", 400],
]);

const simulationRoutes = routeCases("simulate-key", "operate-key", [
  ["POST", "/scenarios", 400],
  ["POST", "/models/missing/rollback-simulation", 400],
]);

const authenticatedRoutes = [
  ...readRoutes,
  ...configureRoutes,
  ...operateRoutes,
  ...simulationRoutes,
];

function request(
  testServer: TestServer,
  route: RouteCase,
  apiKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (route.method !== "GET") headers["content-type"] = "application/json";

  return fetch(`${testServer.baseUrl}/api/twin${route.path}`, {
    method: route.method,
    headers,
    body: route.method === "GET" ? undefined : "{}",
  });
}

describe("digital-twin route authorization", () => {
  const originalApiKeys = process.env.API_KEYS;
  let testServer: TestServer;

  beforeAll(async () => {
    process.env.API_KEYS = [
      "read-key:twin-reader:twin.read",
      "configure-key:twin-configurer:twin.configure",
      "operate-key:twin-operator:twin.operate",
      "simulate-key:twin-simulator:twin.simulate",
      "other-key:other-service:predictive.read",
    ].join(",");
    _resetControlPlaneAuthCache();
    testServer = await startServer();
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    _resetControlPlaneAuthCache();
  });

  it.each(authenticatedRoutes)(
    "fails closed for anonymous $method $path",
    async (route) => {
      const response = await request(testServer, route);
      expect(response.status).toBe(401);
    }
  );

  it("rejects a credential from an unrelated service", async () => {
    const unrelated = await fetch(`${testServer.baseUrl}/api/twin/status`, {
      headers: { "x-api-key": "other-key" },
    });
    expect(unrelated.status).toBe(403);
  });

  it("rejects invalid and query-string credentials", async () => {
    const invalid = await fetch(`${testServer.baseUrl}/api/twin/status`, {
      headers: { "x-api-key": "not-a-key" },
    });
    expect(invalid.status).toBe(401);

    const queryCredential = await fetch(
      `${testServer.baseUrl}/api/twin/status?api_key=read-key`,
    );
    expect(queryCredential.status).toBe(401);
  });

  it.each(authenticatedRoutes)(
    "rejects a different twin scope for $method $path",
    async (route) => {
      const response = await request(testServer, route, route.underScopedKey);
      expect(response.status).toBe(403);
    }
  );

  it.each(authenticatedRoutes)(
    "allows the exact twin scope to reach $method $path",
    async (route) => {
      const response = await request(testServer, route, route.authorizedKey);
      expect(response.status).toBe(route.authorizedStatus);
    }
  );
});
