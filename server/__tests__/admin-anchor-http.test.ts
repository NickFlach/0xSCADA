import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import {
  adminAnchorRoutes,
  getSwitchHistory,
} from "../routes/admin-anchor";
import {
  _resetAnchorBackendState,
  getAnchorBackend,
  getAnchorBackendSnapshot,
  setAnchorBackend,
} from "../bridge/anchor-backend";
import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";
import { natsPublisher } from "../services/nats";

interface TestServer {
  server: Server;
  baseUrl: string;
}

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/anchor-backend", adminAnchorRoutes);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("admin anchor HTTP control plane", () => {
  const originalApiKeys = process.env.API_KEYS;
  const originalBackend = process.env.ANCHOR_BACKEND;
  const originalReplicaCount = process.env.OXSCADA_REPLICA_COUNT;
  let testServer: TestServer;

  beforeAll(async () => {
    process.env.API_KEYS = [
      "read-key:viewer:operator",
      "anchor-key:anchor-alice:operator+anchor.admin",
    ].join(",");
    process.env.ANCHOR_BACKEND = "node";
    process.env.OXSCADA_REPLICA_COUNT = "1";
    _resetControlPlaneAuthCache();
    vi.spyOn(natsPublisher, "isConnected").mockReturnValue(true);
    vi.spyOn(natsPublisher, "publish").mockReturnValue(true);
    testServer = await startServer();
  });

  beforeEach(() => {
    _resetAnchorBackendState();
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    if (originalBackend === undefined) delete process.env.ANCHOR_BACKEND;
    else process.env.ANCHOR_BACKEND = originalBackend;
    if (originalReplicaCount === undefined) {
      delete process.env.OXSCADA_REPLICA_COUNT;
    } else {
      process.env.OXSCADA_REPLICA_COUNT = originalReplicaCount;
    }
    _resetControlPlaneAuthCache();
    _resetAnchorBackendState();
    vi.restoreAllMocks();
  });

  it("requires a local operator credential for status", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/api/admin/anchor-backend`,
    );
    expect(response.status).toBe(401);
  });

  it("returns a revision-bound dry-run without a public confirm token", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/api/admin/anchor-backend`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "anchor-key",
        },
        body: JSON.stringify({
          backend: "node",
          dryRun: true,
          eventsPerMinute: 42,
        }),
      },
    );
    expect(response.status).toBe(200);
    const preview = (await response.json()) as Record<string, unknown>;
    expect(preview).toMatchObject({
      currentBackend: "node",
      backendRevision: 0,
      proposedBackend: "node",
      runtimeReady: true,
    });
    expect(preview).not.toHaveProperty("confirmToken");
  });

  it("requires anchor.admin for a commit", async () => {
    const snapshot = getAnchorBackendSnapshot();
    const response = await fetch(
      `${testServer.baseUrl}/api/admin/anchor-backend`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "read-key",
        },
        body: JSON.stringify({
          backend: "node",
          dryRun: false,
          confirm: true,
          expectedCurrentBackend: snapshot.backend,
          expectedBackendRevision: snapshot.revision,
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("rejects a stale dry-run revision without queueing", async () => {
    const preview = getAnchorBackendSnapshot();
    const publishCalls = vi.mocked(natsPublisher.publish).mock.calls.length;
    setAnchorBackend("both");

    const response = await fetch(
      `${testServer.baseUrl}/api/admin/anchor-backend`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "anchor-key",
        },
        body: JSON.stringify({
          backend: "node",
          dryRun: false,
          confirm: true,
          expectedCurrentBackend: preview.backend,
          expectedBackendRevision: preview.revision,
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "anchor-backend-preview-stale",
      committed: false,
      currentBackend: "both",
      currentBackendRevision: 1,
    });
    expect(vi.mocked(natsPublisher.publish)).toHaveBeenCalledTimes(
      publishCalls,
    );
  });

  it("queues an honest intent then commits with the API-key identity", async () => {
    setAnchorBackend("both");
    const preview = getAnchorBackendSnapshot();
    const historyLength = getSwitchHistory().length;

    const response = await fetch(
      `${testServer.baseUrl}/api/admin/anchor-backend`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "anchor-key",
          "x-operator-id": "spoofed",
        },
        body: JSON.stringify({
          backend: "node",
          dryRun: false,
          confirm: true,
          expectedCurrentBackend: preview.backend,
          expectedBackendRevision: preview.revision,
          operator: "spoofed",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      committed: true,
      currentBackend: "node",
      backendRevision: preview.revision + 1,
      auditStatus: "queued",
      auditQueueId: expect.stringMatching(/^anchor-switch-/),
    });
    expect(getAnchorBackend()).toBe("node");
    expect(getSwitchHistory()).toHaveLength(historyLength + 1);
    expect(getSwitchHistory()[0]).toMatchObject({
      previous: "both",
      current: "node",
      operator: "anchor-alice",
      auditStatus: "queued",
    });
  });
});
