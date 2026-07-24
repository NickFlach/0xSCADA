import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";
import { alarmCorrelationRoutes } from "../routes/alarm-correlation";

interface TestServer {
  server: Server;
  baseUrl: string;
}

type AlarmScope = "read" | "ingest" | "acknowledge" | "clear" | "configure";

interface RouteCase {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  scope: AlarmScope;
  authorizedStatus: number;
  body?: Record<string, unknown>;
}

const routeCases: RouteCase[] = [
  { method: "GET", path: "/groups", scope: "read", authorizedStatus: 200 },
  { method: "GET", path: "/groups/unknown", scope: "read", authorizedStatus: 404 },
  {
    method: "GET",
    path: "/groups/unknown/root-cause",
    scope: "read",
    authorizedStatus: 404,
  },
  { method: "GET", path: "/rules", scope: "read", authorizedStatus: 200 },
  { method: "GET", path: "/topology", scope: "read", authorizedStatus: 200 },
  {
    method: "GET",
    path: "/suppression-policy",
    scope: "read",
    authorizedStatus: 200,
  },
  { method: "GET", path: "/metrics", scope: "read", authorizedStatus: 200 },
  { method: "GET", path: "/status", scope: "read", authorizedStatus: 200 },
  {
    method: "POST",
    path: "/alarms",
    scope: "ingest",
    body: { alarms: [] },
    authorizedStatus: 400,
  },
  {
    method: "POST",
    path: "/alarms/unknown/acknowledge",
    scope: "acknowledge",
    authorizedStatus: 404,
  },
  {
    method: "POST",
    path: "/alarms/unknown/clear",
    scope: "clear",
    authorizedStatus: 404,
  },
  {
    method: "PUT",
    path: "/rules/test-rule",
    scope: "configure",
    body: {},
    authorizedStatus: 400,
  },
  {
    method: "DELETE",
    path: "/rules/unknown",
    scope: "configure",
    authorizedStatus: 404,
  },
  {
    method: "POST",
    path: "/rules/unknown/enable",
    scope: "configure",
    authorizedStatus: 404,
  },
  {
    method: "POST",
    path: "/rules/unknown/disable",
    scope: "configure",
    authorizedStatus: 404,
  },
  {
    method: "PUT",
    path: "/topology",
    scope: "configure",
    body: { nodes: [] },
    authorizedStatus: 400,
  },
  {
    method: "DELETE",
    path: "/topology/unknown",
    scope: "configure",
    authorizedStatus: 404,
  },
  {
    method: "PUT",
    path: "/suppression-policy",
    scope: "configure",
    body: {},
    authorizedStatus: 400,
  },
];

const keys: Record<AlarmScope, string> = {
  read: "read-key",
  ingest: "ingest-key",
  acknowledge: "acknowledge-key",
  clear: "clear-key",
  configure: "configure-key",
};

const crossScope: Record<AlarmScope, string> = {
  read: keys.ingest,
  ingest: keys.configure,
  acknowledge: keys.clear,
  clear: keys.acknowledge,
  configure: keys.read,
};

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/alarm-correlation", alarmCorrelationRoutes);
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
  if (route.body !== undefined) headers["content-type"] = "application/json";

  return fetch(`${testServer.baseUrl}/api/alarm-correlation${route.path}`, {
    method: route.method,
    headers,
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

describe("alarm-correlation HTTP authorization", () => {
  const originalApiKeys = process.env.API_KEYS;
  let testServer: TestServer;

  beforeAll(async () => {
    process.env.API_KEYS = [
      "read-key:alarm-reader:alarms.read",
      "ingest-key:alarm-ingester:alarms.ingest",
      "acknowledge-key:alarm-acknowledger:alarms.acknowledge",
      "clear-key:alarm-clearer:alarms.clear",
      "configure-key:alarm-configurer:alarms.configure",
      "other-key:unrelated-client:other.read",
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

  it.each(routeCases)("returns 401 for anonymous $method $path", async (route) => {
    const response = await request(testServer, route);
    expect(response.status).toBe(401);
  });

  it("rejects invalid and query-string credentials", async () => {
    const invalid = await request(testServer, routeCases[0], "invalid-key");
    expect(invalid.status).toBe(401);

    const queryOnly = await fetch(
      `${testServer.baseUrl}/api/alarm-correlation/status?api_key=${keys.read}`,
    );
    expect(queryOnly.status).toBe(401);
  });

  it.each(routeCases)(
    "rejects a cross-action scope for $method $path",
    async (route) => {
      const response = await request(testServer, route, crossScope[route.scope]);
      expect(response.status).toBe(403);
    },
  );

  it.each(routeCases)(
    "allows the exact scope to reach $method $path",
    async (route) => {
      const response = await request(testServer, route, keys[route.scope]);
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it("derives source and lifecycle attribution from server-owned principals", async () => {
    const now = Date.now();
    for (const body of [
      {
        alarms: [{
          id: "auth-root",
          tagId: "AUTH-LOOP.TRIP",
          timestamp: now,
          severity: "high",
        }],
      },
      {
        alarms: [{
          id: "auth-member",
          tagId: "AUTH-LOOP.TRIP",
          timestamp: now + 100,
          severity: "medium",
        }],
      },
    ]) {
      const response = await request(
        testServer,
        {
          method: "POST",
          path: "/alarms",
          scope: "ingest",
          authorizedStatus: 200,
          body,
        },
        keys.ingest,
      );
      expect(response.status).toBe(200);
    }

    const groupsResponse = await request(testServer, routeCases[0], keys.read);
    const groupsBody = await groupsResponse.json() as {
      groups: Array<{
        id: string;
        alarmIds: string[];
        suppressedAlarmIds: string[];
        alarms: Array<Record<string, unknown>>;
      }>;
    };
    const group = groupsBody.groups.find((candidate) =>
      candidate.alarmIds.includes("auth-root")
    );
    expect(group).toBeDefined();
    expect(group?.alarms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "auth-root",
        source: "api:alarm-ingester",
      }),
      expect.objectContaining({
        id: "auth-member",
        source: "api:alarm-ingester",
      }),
    ]));

    const acknowledge = await request(
      testServer,
      {
        method: "POST",
        path: "/alarms/auth-member/acknowledge",
        scope: "acknowledge",
        authorizedStatus: 200,
      },
      keys.acknowledge,
    );
    expect(await acknowledge.json()).toEqual({
      acknowledged: true,
      acknowledgedBy: "alarm-acknowledger",
    });

    const clear = await request(
      testServer,
      {
        method: "POST",
        path: "/alarms/auth-root/clear",
        scope: "clear",
        authorizedStatus: 200,
      },
      keys.clear,
    );
    expect(await clear.json()).toMatchObject({
      cleared: true,
      clearedBy: "alarm-clearer",
    });

    const groupResponse = await request(
      testServer,
      {
        method: "GET",
        path: `/groups/${group?.id}`,
        scope: "read",
        authorizedStatus: 200,
      },
      keys.read,
    );
    const updated = await groupResponse.json() as {
      suppressedAlarmIds: string[];
      alarms: Array<Record<string, unknown>>;
    };
    expect(updated.suppressedAlarmIds).not.toContain("auth-member");
    expect(updated.alarms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "auth-root",
        state: "cleared",
        clearedBy: "alarm-clearer",
      }),
      expect.objectContaining({
        id: "auth-member",
        state: "acknowledged",
        acknowledgedBy: "alarm-acknowledger",
      }),
    ]));
  });

  it("rejects spoofed source/lifecycle fields and future alarms before mutation", async () => {
    const spoofed = await request(
      testServer,
      {
        method: "POST",
        path: "/alarms",
        scope: "ingest",
        authorizedStatus: 400,
        body: {
          alarms: [{
            id: "spoofed",
            tagId: "SPOOFED.TRIP",
            timestamp: Date.now(),
            source: "simulator",
            state: "suppressed",
          }],
        },
      },
      keys.ingest,
    );
    expect(spoofed.status).toBe(400);

    const future = await request(
      testServer,
      {
        method: "POST",
        path: "/alarms",
        scope: "ingest",
        authorizedStatus: 200,
        body: {
          alarms: [{
            id: "future-not-mutated",
            tagId: "FUTURE.TRIP",
            timestamp: Date.now() + 2 * 60 * 60 * 1000,
          }],
        },
      },
      keys.ingest,
    );
    expect(await future.json()).toMatchObject({
      ingested: 0,
      rejected: [expect.objectContaining({
        reason: "timestamp too far in the future",
      })],
    });

    const accepted = await request(
      testServer,
      {
        method: "POST",
        path: "/alarms",
        scope: "ingest",
        authorizedStatus: 200,
        body: {
          alarms: [{
            id: "future-not-mutated",
            tagId: "FUTURE.TRIP",
            timestamp: Date.now(),
          }],
        },
      },
      keys.ingest,
    );
    const acceptedBody = await accepted.json() as {
      ingested: number;
      results: Array<{ reason: string }>;
    };
    expect(acceptedBody.ingested).toBe(1);
    expect(acceptedBody.results[0]?.reason).not.toMatch(/duplicate/);
  });

  it("returns a conflict for duplicate alarm ids", async () => {
    const body = {
      alarms: [{
        id: "duplicate-http",
        tagId: "DUPLICATE.ALARM",
        timestamp: Date.now(),
      }],
    };
    const route: RouteCase = {
      method: "POST",
      path: "/alarms",
      scope: "ingest",
      authorizedStatus: 200,
      body,
    };

    expect((await request(testServer, route, keys.ingest)).status).toBe(200);
    const duplicate = await request(testServer, route, keys.ingest);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      ingested: 0,
      rejected: [expect.objectContaining({
        reason: expect.stringMatching(/duplicate alarm id/),
      })],
    });
  });

  it("keeps suppression fail-safe without explicit ephemeral opt-in", async () => {
    const response = await request(
      testServer,
      {
        method: "PUT",
        path: "/suppression-policy",
        scope: "configure",
        authorizedStatus: 409,
        body: { enabled: true },
      },
      keys.configure,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      coordinationMode: "process-local",
    });
  });
});
