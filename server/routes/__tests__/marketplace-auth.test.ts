/**
 * Agent Marketplace HTTP authorization matrix.
 *
 * Feature [13.6] of ADR-0013 — Issue #217, following the #576
 * `requireControlPlaneAccess` pattern.
 *
 * For every route: anonymous -> 401, unknown credential -> 401, a valid
 * credential holding a DIFFERENT marketplace scope -> 403, and the exact
 * scope -> its expected status. The manifest-hijack attempt the review
 * flagged is exercised explicitly, over HTTP, and asserted to be refused.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { marketplaceRoutes } from "../marketplace";
import { marketplaceService } from "../../services/marketplace";
import { TAG_THRESHOLD_MONITOR_ID } from "../../services/marketplace/builtin";
import { tagStreamServer } from "../../websocket/tag-stream";

interface TestServer {
  server: Server;
  baseUrl: string;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface RouteCase {
  method: Method;
  path: string;
  authorizedStatus: number;
  authorizedKey: string;
  underScopedKey: string;
  body?: string;
}

const MISSING = "no-such-plugin";

let testServer: TestServer;

function routeCases(
  authorizedKey: string,
  underScopedKey: string,
  routes: ReadonlyArray<readonly [Method, string, number]>,
): RouteCase[] {
  return routes.map(([method, path, authorizedStatus]) => ({
    method,
    path,
    authorizedStatus,
    authorizedKey,
    underScopedKey,
  }));
}

const readRoutes = routeCases("read-key", "install-key", [
  ["GET", "/plugins", 200],
  ["GET", `/plugins/${MISSING}`, 404],
  ["GET", "/installed", 200],
  ["GET", `/plugins/${MISSING}/health`, 404],
  ["GET", "/health", 200],
  ["GET", "/status", 200],
]);

// A body-less publish fails validation with 400 — the point is that the
// request reached the handler, so the scope was accepted.
const publishRoutes = routeCases("publish-key", "install-key", [
  ["POST", "/plugins", 400],
]);

const installRoutes = routeCases("install-key", "invoke-key", [
  ["POST", `/plugins/${MISSING}/install`, 404],
  ["POST", `/plugins/${MISSING}/update`, 404],
  ["PUT", `/plugins/${MISSING}/config`, 400],
  ["POST", `/plugins/${MISSING}/start`, 404],
  ["POST", `/plugins/${MISSING}/stop`, 404],
  ["POST", `/plugins/${MISSING}/enable`, 404],
  ["POST", `/plugins/${MISSING}/disable`, 404],
]);

// A plugin-level failure is a 200 carrying success:false plus a machine code;
// only transport and authorization failures use non-2xx statuses.
const invokeRoutes = routeCases("invoke-key", "install-key", [
  ["POST", `/plugins/${MISSING}/invoke`, 200],
]);

const uninstallRoutes = routeCases("uninstall-key", "install-key", [
  ["DELETE", `/plugins/${MISSING}`, 404],
]);

const allRoutes = [
  ...readRoutes,
  ...publishRoutes,
  ...installRoutes,
  ...invokeRoutes,
  ...uninstallRoutes,
];

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/marketplace", marketplaceRoutes);

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

function call(
  method: Method,
  path: string,
  options: { apiKey?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers["x-api-key"] = options.apiKey;
  if (method !== "GET") headers["content-type"] = "application/json";
  return fetch(`${testServer.baseUrl}/api/marketplace${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
}

function request(route: RouteCase, apiKey?: string): Promise<Response> {
  return call(route.method, route.path, { apiKey });
}

function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "alpha-plugin",
    name: "Alpha Plugin",
    version: "1.0.0",
    description: "auth matrix fixture",
    author: "tests",
    category: "custom",
    requiredCapabilities: ["log"],
    configSchema: {},
    dependencies: {},
    tags: ["alpha"],
    ...overrides,
  };
}

const originalApiKeys = process.env.API_KEYS;

// File-scoped: every describe below shares one server and one marketplace
// singleton, and the ownership assertions depend on that shared state.
beforeAll(async () => {
  process.env.API_KEYS = [
    "read-key:marketplace-reader:marketplace.read",
    "publish-key:publisher-one:marketplace.publish",
    "publish-key-2:publisher-two:marketplace.publish",
    "install-key:marketplace-installer:marketplace.install",
    "invoke-key:marketplace-invoker:marketplace.invoke",
    "uninstall-key:marketplace-remover:marketplace.uninstall",
    "unrelated-key:other-service:predictive.read",
  ].join(",");
  _resetControlPlaneAuthCache();
  await marketplaceService.initialize();
  testServer = await startServer();
});

afterAll(async () => {
  await closeServer(testServer.server);
  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  _resetControlPlaneAuthCache();
});

describe("agent marketplace route authorization", () => {
  it.each(allRoutes)("fails closed for anonymous $method $path", async (route) => {
    const response = await request(route);
    expect(response.status).toBe(401);
  });

  it.each(allRoutes)(
    "rejects an unknown credential on $method $path",
    async (route) => {
      const response = await request(route, "not-a-real-key");
      expect(response.status).toBe(401);
    },
  );

  it.each(allRoutes)(
    "rejects a credential from an unrelated service on $method $path",
    async (route) => {
      const response = await request(route, "unrelated-key");
      expect(response.status).toBe(403);
    },
  );

  it.each(allRoutes)(
    "rejects a different marketplace scope on $method $path",
    async (route) => {
      const response = await request(route, route.underScopedKey);
      expect(response.status).toBe(403);
    },
  );

  it.each(allRoutes)(
    "allows the exact scope to reach $method $path",
    async (route) => {
      const response = await request(route, route.authorizedKey);
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it("never accepts a credential from the query string", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/api/marketplace/status?api_key=read-key`,
    );
    expect(response.status).toBe(401);
  });
});

describe("manifest ownership over HTTP", () => {
  it("binds the publisher to the authenticated principal, not the request body", async () => {
    const created = await call("POST", "/plugins", {
      apiKey: "publish-key",
      body: manifestBody(),
    });
    expect(created.status).toBe(201);
    const entry = await created.json() as { publisher: string };
    expect(entry.publisher).toBe("publisher-one");
  });

  it("rejects a body that tries to supply its own publisher", async () => {
    const spoofed = await call("POST", "/plugins", {
      apiKey: "publish-key-2",
      body: manifestBody({ id: "spoof-plugin", publisher: "publisher-one" }),
    });
    expect(spoofed.status).toBe(400);
    // The id must not have been created under the spoofed owner.
    const lookup = await call("GET", "/plugins/spoof-plugin", { apiKey: "read-key" });
    expect(lookup.status).toBe(404);
  });

  it("refuses a different publisher republishing the id with a bumped version", async () => {
    const hijack = await call("POST", "/plugins", {
      apiKey: "publish-key-2",
      body: manifestBody({ version: "2.0.0" }),
    });
    expect(hijack.status).toBe(403);
    expect(await hijack.json()).toMatchObject({ code: "ownership-conflict" });

    const current = await call("GET", "/plugins/alpha-plugin", { apiKey: "read-key" });
    expect(await current.json()).toMatchObject({
      publisher: "publisher-one",
      manifest: { version: "1.0.0" },
    });
  });

  it("refuses re-publishing an existing version and requires forward motion", async () => {
    const same = await call("POST", "/plugins", {
      apiKey: "publish-key",
      body: manifestBody({ version: "1.0.0" }),
    });
    expect(same.status).toBe(409);
    expect(await same.json()).toMatchObject({ code: "version-conflict" });

    const older = await call("POST", "/plugins", {
      apiKey: "publish-key",
      body: manifestBody({ version: "0.9.0" }),
    });
    expect(older.status).toBe(409);

    const newer = await call("POST", "/plugins", {
      apiKey: "publish-key",
      body: manifestBody({ version: "1.1.0" }),
    });
    expect(newer.status).toBe(201);
    expect(await newer.json()).toMatchObject({ manifest: { version: "1.1.0" } });
  });

  it("refuses to republish a built-in plugin id", async () => {
    const hijack = await call("POST", "/plugins", {
      apiKey: "publish-key",
      body: manifestBody({ id: TAG_THRESHOLD_MONITOR_ID, version: "99.0.0" }),
    });
    expect(hijack.status).toBe(403);
    expect(await hijack.json()).toMatchObject({ code: "ownership-conflict" });
  });
});

describe("installed-but-not-implemented is reported, not faked", () => {
  it("installs a manifest with no implementation and says so", async () => {
    const installed = await call("POST", "/plugins/alpha-plugin/install", {
      apiKey: "install-key",
      body: { config: {}, grants: ["log"] },
    });
    expect(installed.status).toBe(201);
    expect(await installed.json()).toMatchObject({
      implementationState: "unavailable",
      installedBy: "marketplace-installer",
      grantedCapabilities: ["log"],
    });

    const started = await call("POST", "/plugins/alpha-plugin/start", {
      apiKey: "install-key",
    });
    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({ code: "not-implemented" });

    const invoked = await call("POST", "/plugins/alpha-plugin/invoke", {
      apiKey: "invoke-key",
      body: {},
    });
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toMatchObject({
      success: false,
      code: "not-implemented",
    });
  });
});

describe("a real built-in plugin runs end to end over HTTP", () => {
  it("installs, starts, and invokes the tag threshold monitor against a live tag", async () => {
    tagStreamServer.broadcastTagUpdate({
      tagName: "PT-101",
      value: 97,
      quality: "good",
      timestamp: new Date().toISOString(),
    });

    const installed = await call(`POST`, `/plugins/${TAG_THRESHOLD_MONITOR_ID}/install`, {
      apiKey: "install-key",
      body: {
        config: { tagId: "PT-101", highLimit: 90, lowLimit: 10 },
        grants: ["tags:read", "events:emit", "log"],
      },
    });
    expect(installed.status).toBe(201);
    expect(await installed.json()).toMatchObject({ implementationState: "available" });

    const started = await call("POST", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/start`, {
      apiKey: "install-key",
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ status: "running" });

    const invoked = await call("POST", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/invoke`, {
      apiKey: "invoke-key",
      body: {},
    });
    expect(invoked.status).toBe(200);
    const result = await invoked.json() as {
      success: boolean;
      code: string;
      output: { tagId: string; state: string; value: number };
    };
    expect(result.success).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.output).toMatchObject({ tagId: "PT-101", state: "high", value: 97 });
  });

  it("denies an ungranted capability at the host boundary", async () => {
    // Reinstall with tags:read withheld — the handler reaches for it anyway,
    // so the invocation must fail with capability-denied instead of quietly
    // skipping the read.
    const uninstalled = await call("DELETE", `/plugins/${TAG_THRESHOLD_MONITOR_ID}`, {
      apiKey: "uninstall-key",
    });
    expect(uninstalled.status).toBe(200);

    const installed = await call("POST", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/install`, {
      apiKey: "install-key",
      body: {
        config: { tagId: "PT-101", highLimit: 90, lowLimit: 10 },
        grants: ["log"],
      },
    });
    expect(installed.status).toBe(201);
    await call("POST", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/start`, {
      apiKey: "install-key",
    });

    const invoked = await call("POST", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/invoke`, {
      apiKey: "invoke-key",
      body: {},
    });
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toMatchObject({
      success: false,
      code: "capability-denied",
    });

    const health = await call("GET", `/plugins/${TAG_THRESHOLD_MONITOR_ID}/health`, {
      apiKey: "read-key",
    });
    expect(await health.json()).toMatchObject({ capabilityDenials: 1 });
  });

  it("requires the uninstall scope to remove a plugin", async () => {
    const forbidden = await call("DELETE", "/plugins/alpha-plugin", {
      apiKey: "install-key",
    });
    expect(forbidden.status).toBe(403);

    const removed = await call("DELETE", "/plugins/alpha-plugin", {
      apiKey: "uninstall-key",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ uninstalled: true });
  });
});
