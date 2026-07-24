import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import {
  apiKeyMiddleware,
  type ApiKeyRecord,
} from "../api-gateway";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../control-plane-auth";

interface TestServer {
  server: Server;
  baseUrl: string;
}

const now = new Date();
const keys = new Map<string, ApiKeyRecord>([
  [
    "write-key",
    {
      key: "write-key",
      name: "control-writer",
      scopes: ["control.write"],
      createdAt: now,
    },
  ],
  [
    "read-key",
    {
      key: "read-key",
      name: "control-reader",
      scopes: ["control.read"],
      createdAt: now,
    },
  ],
]);

function startServer(): Promise<TestServer> {
  const app = express();
  const requireControlWrite = requireControlPlaneAccess({
    scopes: ["control.write"],
  });
  const sendPrincipal: express.RequestHandler = (req, res) => {
    res.json({ principal: controlPlanePrincipal(req).name });
  };

  app.use(apiKeyMiddleware(keys));
  app.get("/protected", requireControlWrite, sendPrincipal);
  app.get(
    "/mismatched-attached-record",
    (req, _res, next) => {
      (req as express.Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord =
        keys.get("write-key");
      next();
    },
    requireControlWrite,
    sendPrincipal,
  );
  app.get(
    "/expired-attached-record",
    (req, _res, next) => {
      (req as express.Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord = {
        ...keys.get("write-key")!,
        expiresAt: new Date(0),
      };
      next();
    },
    requireControlWrite,
    sendPrincipal,
  );

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

describe("control-plane authentication composition", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startServer();
  });

  afterAll(async () => {
    await closeServer(testServer.server);
  });

  it("rejects a query-string credential even if the global gateway attached it", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/protected?api_key=write-key`,
    );

    expect(response.status).toBe(401);
  });

  it("accepts a matching X-API-Key and exposes its server-owned principal", async () => {
    const response = await fetch(`${testServer.baseUrl}/protected`, {
      headers: { "x-api-key": "write-key" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      principal: "control-writer",
    });
  });

  it("rejects a valid but under-scoped X-API-Key", async () => {
    const response = await fetch(`${testServer.baseUrl}/protected`, {
      headers: { "x-api-key": "read-key" },
    });

    expect(response.status).toBe(403);
  });

  it("rejects an attached record that does not match the header credential", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/mismatched-attached-record`,
      { headers: { "x-api-key": "read-key" } },
    );

    expect(response.status).toBe(401);
  });

  it("rechecks expiration on a matching attached record", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/expired-attached-record`,
      { headers: { "x-api-key": "write-key" } },
    );

    expect(response.status).toBe(401);
  });
});
