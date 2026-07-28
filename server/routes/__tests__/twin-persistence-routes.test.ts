/**
 * Digital-twin API ↔ durable storage
 * ADR-0013 [13.3] — Issue #550
 *
 * The unit suite in server/services/twin/__tests__ proves the store and the
 * transactional registry behave. This suite proves the HTTP surface is
 * actually wired to them: a model registered through POST /api/twin/models is
 * in the database, a checkpoint committed through the API is what a restart
 * restores, that restart comes back idle, and DELETE removes both rows.
 *
 * It drives the real router against a real SQLite file — no mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import {
  DigitalTwinService,
  DrizzleTwinStore,
  digitalTwinService,
} from "../../services/twin";
import type { ProcessModel } from "@shared/types/digital-twin";
import { twinRoutes } from "../twin";

const MODEL: ProcessModel = {
  id: "route-tank",
  name: "Route tank",
  components: [
    {
      id: "valve-1",
      type: "valve",
      name: "Feed valve",
      config: { maxFlow: 10 },
      initialState: { position: 50 },
      connections: ["tank-1"],
    },
    {
      id: "tank-1",
      type: "tank",
      name: "Buffer tank",
      config: { capacity: 100, outflow: 2 },
      initialState: { level: 20 },
      connections: [],
    },
  ],
  tagBindings: [{ tagId: "TK-1.LEVEL", componentId: "tank-1", parameter: "level" }],
  stepFunction: "basic-flow",
  timeStepMs: 1000,
};

interface EnvBackup {
  apiKeys: string | undefined;
  sqlitePath: string | undefined;
  forcePostgres: string | undefined;
}

describe("digital-twin API persistence", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let file: string;
  let env: EnvBackup;

  function api(
    method: "GET" | "POST" | "DELETE",
    routePath: string,
    apiKey: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { "x-api-key": apiKey };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${baseUrl}/api/twin${routePath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** A fresh process reading the same database file. */
  async function restartAndRestore(): Promise<DigitalTwinService> {
    const service = new DigitalTwinService(
      3_600_000,
      new DrizzleTwinStore({ sqlitePath: file }),
    );
    await service.initialize();
    return service;
  }

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "twin-routes-"));
    file = path.join(directory, "twin.sqlite");
    env = {
      apiKeys: process.env.API_KEYS,
      sqlitePath: process.env.TWIN_STATE_SQLITE_PATH,
      forcePostgres: process.env.FORCE_POSTGRES,
    };
    process.env.API_KEYS = [
      "read-key:twin-reader:twin.read",
      "configure-key:twin-configurer:twin.configure",
      "operate-key:twin-operator:twin.operate",
    ].join(",");
    // The singleton store resolves its path lazily, on first use.
    process.env.TWIN_STATE_SQLITE_PATH = file;
    process.env.FORCE_POSTGRES = "false";
    _resetControlPlaneAuthCache();

    const app = express();
    app.use(express.json());
    app.use("/api/twin", twinRoutes);
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await digitalTwinService.shutdown();
    await rm(directory, { recursive: true, force: true });
    if (env.apiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = env.apiKeys;
    if (env.sqlitePath === undefined) delete process.env.TWIN_STATE_SQLITE_PATH;
    else process.env.TWIN_STATE_SQLITE_PATH = env.sqlitePath;
    if (env.forcePostgres === undefined) delete process.env.FORCE_POSTGRES;
    else process.env.FORCE_POSTGRES = env.forcePostgres;
    _resetControlPlaneAuthCache();
  });

  it("registers, checkpoints, restores idle, and deletes through the API", async () => {
    const created = await api("POST", "/models", "configure-key", MODEL);
    expect(created.status).toBe(201);

    // A model is durable from the moment it is registered, before any
    // checkpoint is explicitly committed.
    const beforeAnyStep = await restartAndRestore();
    try {
      expect(beforeAnyStep.persistenceStatus().lastRestore?.restored).toEqual(["route-tank"]);
      expect(beforeAnyStep.runtime.getState("route-tank")!.tick).toBe(0);
    } finally {
      await beforeAnyStep.shutdown();
    }

    const stepped = await api("POST", "/models/route-tank/step", "operate-key", { ticks: 3 });
    expect(stepped.status).toBe(200);
    expect(((await stepped.json()) as { tick: number }).tick).toBe(3);

    const started = await api("POST", "/models/route-tank/start", "operate-key");
    expect(started.status).toBe(200);

    const checkpoint = await api("POST", "/models/route-tank/checkpoint", "operate-key");
    expect(checkpoint.status).toBe(200);
    const committed = (await checkpoint.json()) as {
      checkpoint: { tick: number; schemaVersion: number; committedAt: number };
    };
    expect(committed.checkpoint.tick).toBe(3);
    expect(committed.checkpoint.schemaVersion).toBe(1);
    expect(committed.checkpoint.committedAt).toBeGreaterThan(0);

    const status = await api("GET", "/status", "read-key");
    expect(status.status).toBe(200);
    const reported = (await status.json()) as {
      persistence: { configured: boolean; backend: string };
    };
    expect(reported.persistence.configured).toBe(true);
    expect(reported.persistence.backend).toBe("sqlite");

    // Restart: the checkpoint comes back, and the simulation that was running
    // when it was committed comes back STOPPED.
    const restarted = await restartAndRestore();
    try {
      const restored = restarted.runtime.getState("route-tank")!;
      expect(restored.tick).toBe(3);
      expect(restored.status).toBe("idle");
      expect(restarted.runtime.getStatus().running).toBe(0);
      restarted.runtime.stepRunning(Date.now() + 3_600_000);
      expect(restarted.runtime.getState("route-tank")!.tick).toBe(3);
    } finally {
      await restarted.shutdown();
    }

    const removed = await api("DELETE", "/models/route-tank", "configure-key");
    expect(removed.status).toBe(200);

    const afterDelete = await restartAndRestore();
    try {
      expect(afterDelete.persistenceStatus().lastRestore).toEqual({
        scanned: 0,
        restored: [],
        failed: [],
      });
      expect(afterDelete.runtime.getModel("route-tank")).toBeUndefined();
    } finally {
      await afterDelete.shutdown();
    }
  });
});
