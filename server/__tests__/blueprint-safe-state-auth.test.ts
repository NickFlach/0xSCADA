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
