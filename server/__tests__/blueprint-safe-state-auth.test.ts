import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  blueprintSafeStateRoutes,
  safeStateRegistry,
} from "../routes/blueprint-safe-state";
import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";

describe("blueprint safe-state control-plane authorization", () => {
  const originalApiKeys = process.env.API_KEYS;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.API_KEYS = [
      "read-key:reader:operator",
      "safety-key:safety-op:operator+safety.resume",
      "scope-less:legacy",
    ].join(",");
    _resetControlPlaneAuthCache();

    const app = express();
    app.use(express.json());
    app.use("/api/blueprint-safe-state", blueprintSafeStateRoutes);
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    _resetControlPlaneAuthCache();
  });

  it("rejects anonymous reads", async () => {
    const response = await fetch(`${baseUrl}/api/blueprint-safe-state`);

    expect(response.status).toBe(401);
  });

  it("allows an authenticated operator to read status", async () => {
    const response = await fetch(`${baseUrl}/api/blueprint-safe-state`, {
      headers: { "x-api-key": "read-key" },
    });

    expect(response.status).toBe(200);
  });

  it("attributes an empty status list to no blueprint being loaded", async () => {
    const response = await fetch(`${baseUrl}/api/blueprint-safe-state`, {
      headers: { "x-api-key": "read-key" },
    });
    const body = await response.json() as {
      statuses: unknown[];
      host: { state: string; reason: string; registeredBlueprintIds: string[] };
    };

    // With no bindings configured the list is empty *because nothing is
    // loaded* — the response says so, rather than presenting an empty registry
    // as evidence that safe-state handling is active.
    expect(body.statuses).toEqual([]);
    expect(body.host.state).toBe("DISABLED");
    expect(body.host.reason).toMatch(/no blueprint is loaded/);
    expect(body.host.registeredBlueprintIds).toEqual([]);
  });

  it("requires authentication for the host-binding view", async () => {
    expect((await fetch(`${baseUrl}/api/blueprint-safe-state/host`)).status).toBe(401);

    const response = await fetch(`${baseUrl}/api/blueprint-safe-state/host`, {
      headers: { "x-api-key": "read-key" },
    });
    const body = await response.json() as {
      safety: { state: string; capabilities: { fieldOutputSinkBound: boolean } };
    };

    expect(response.status).toBe(200);
    expect(body.safety.state).toBe("DISABLED");
    expect(body.safety.capabilities.fieldOutputSinkBound).toBe(false);
  });

  it("reports an unregistered blueprint as 404 with the host reason attached", async () => {
    const response = await fetch(`${baseUrl}/api/blueprint-safe-state/bp-missing`, {
      headers: { "x-api-key": "read-key" },
    });
    const body = await response.json() as { error: string; host: { state: string } };

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/not registered/);
    expect(body.host.state).toBe("DISABLED");
  });

  it("requires the safety.resume scope and never grants missing scopes implicitly", async () => {
    for (const key of ["read-key", "scope-less"]) {
      const response = await fetch(
        `${baseUrl}/api/blueprint-safe-state/bp-a/resume`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
          },
          body: JSON.stringify({ reason: "condition cleared" }),
        },
      );

      expect(response.status).toBe(403);
    }
  });

  it("audits the server-owned API-key identity instead of a caller body field", async () => {
    const resume = vi.fn().mockResolvedValue({ runState: "RUNNING" });
    vi.spyOn(safeStateRegistry, "get").mockReturnValue({ resume } as never);

    const response = await fetch(
      `${baseUrl}/api/blueprint-safe-state/bp-a/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "safety-key",
        },
        body: JSON.stringify({
          operator: "spoofed-client-identity",
          reason: "condition cleared",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(resume).toHaveBeenCalledWith("safety-op", "condition cleared");
  });
});
