import express from "express";
import { createServer, request as httpRequest, type Server } from "http";
import { afterEach, describe, expect, it } from "vitest";
import {
  setupApiGateway,
  type ApiKeyRecord,
} from "../api-gateway";
import {
  CONTROL_ROUTE_POLICIES,
  mutationPolicyFor,
} from "../control-route-policy";
import {
  SENSITIVE_PATH_SEGMENT_MARKER,
  SENSITIVE_RESPONSE_LOG_MARKER,
  requestLoggingMiddleware,
} from "../request-logging";

const records: ApiKeyRecord[] = [
  { key: "read-key", name: "reader", scopes: ["read"], createdAt: new Date() },
  { key: "write-key", name: "writer", scopes: ["write"], createdAt: new Date() },
  {
    key: "alarm-key",
    name: "alarm-operator",
    scopes: ["read", "alarms.write"],
    createdAt: new Date(),
  },
  {
    key: "alarm-ingest-key",
    name: "alarm-ingester",
    scopes: ["alarms.ingest"],
    createdAt: new Date(),
  },
  {
    key: "predictive-ingest-key",
    name: "predictive-ingester",
    scopes: ["predictive.ingest"],
    createdAt: new Date(),
  },
  {
    key: "marketplace-publish-key",
    name: "plugin-publisher",
    scopes: ["marketplace.publish"],
    createdAt: new Date(),
  },
  {
    key: "predictive-configure-key",
    name: "predictive-configurer",
    scopes: ["predictive.configure"],
    createdAt: new Date(),
  },
  {
    key: "predictive-ack-key",
    name: "predictive-operator",
    scopes: ["predictive.acknowledge"],
    createdAt: new Date(),
  },
  {
    key: "tuning-write-key",
    name: "tuning-writer",
    scopes: ["tuning.write"],
    createdAt: new Date(),
  },
  {
    key: "tuning-approve-key",
    name: "tuning-approver",
    scopes: ["tuning.approve"],
    createdAt: new Date(),
  },
  { key: "admin-key", name: "admin", scopes: ["admin"], createdAt: new Date() },
];

const openServers: Server[] = [];

async function startApp(logs: string[] = []): Promise<string> {
  const app = express();
  app.use(express.json());
  // Capture the structured payload as well as the message. The CodeQL
  // log-injection autofix in #658 moved the request details out of the
  // formatted message and into pino's structured field — which is the right
  // place for untrusted values, since pino encodes them — but this sink only
  // recorded the first argument, so the redaction assertions below were
  // silently checking a string that no longer contains the response at all.
  app.use(
    requestLoggingMiddleware((message, ...args) =>
      logs.push(args.length > 0 ? `${message} ${JSON.stringify(args)}` : message),
    ),
  );
  setupApiGateway(app, {
    enableApiKeyAuth: true,
    apiKeys: new Map(records.map((record) => [record.key, record])),
    publicRoutes: ["/api/healthz"],
    rateLimit: { windowMs: 60_000, maxRequests: 1000 },
    corsOrigins: [],
  });
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/sites", (_req, res) => res.json({ ok: true }));
  app.post("/api/sites", (_req, res) => res.status(201).json({ created: true }));
  app.post("/api/alarms/phi/check", (_req, res) =>
    res.status(201).json({ checked: true })
  );
  app.post("/api/alarm-correlation/alarms", (_req, res) =>
    res.status(201).json({ ingested: true })
  );
  app.post("/api/predictive/ingest", (_req, res) =>
    res.status(201).json({ ingested: true })
  );
  app.put("/api/predictive/thresholds/tag-1", (_req, res) =>
    res.status(200).json({ configured: true })
  );
  app.post("/api/predictive/alerts/alert-1/acknowledge", (_req, res) =>
    res.status(200).json({ acknowledged: true })
  );
  app.post("/api/tuning/loops/loop-1/tune/relay", (_req, res) =>
    res.status(201).json({ proposed: true })
  );
  app.post("/api/tuning/proposals/proposal-1/approve", (_req, res) =>
    res.status(200).json({ approved: true })
  );
  app.post("/api/marketplace/plugins", (_req, res) =>
    res.status(201).json({ published: true })
  );

  const server = createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function absoluteFormMutation(
  baseUrl: string,
  path: string,
  apiKey: string,
): Promise<number> {
  const target = new URL(baseUrl);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: `${baseUrl}${path}`,
      headers: { "X-API-Key": apiKey },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

describe("control route policy inventory", () => {
  it("keeps safety-sensitive route families explicit", () => {
    expect(CONTROL_ROUTE_POLICIES.map((policy) => policy.id)).toEqual(
      expect.arrayContaining([
        "anchor-backend-control",
        "safe-state-resume",
        "sre-remediation-control",
        "tuning-proposal-decision",
        "tuning-control",
        "alarm-control",
        "alarm-correlation-control",
        "predictive-alert-acknowledgement",
        "predictive-threshold-control",
        "predictive-ingestion",
        "geometry-control",
        "marketplace-control",
      ]),
    );
  });

  it("requires the dedicated SRE remediation scope", () => {
    expect(mutationPolicyFor(
      "POST",
      "/api/governance/sre/remediations/execute",
    )?.scopes).toEqual(["sre.remediate"]);
  });

  it("keeps agent-marketplace mutations off the generic write scope", () => {
    for (const path of [
      "/api/marketplace/plugins",
      "/api/marketplace/plugins/demo/install",
      "/api/marketplace/plugins/demo/invoke",
      "/api/marketplace/plugins/demo",
    ]) {
      expect(mutationPolicyFor("POST", path)?.scopes).toEqual([
        "marketplace.publish",
        "marketplace.install",
        "marketplace.invoke",
        "marketplace.uninstall",
      ]);
    }
  });

  it("assigns write to unlisted mutations and nothing to reads", () => {
    expect(mutationPolicyFor("POST", "/api/sites")?.scopes).toEqual(["write"]);
    expect(mutationPolicyFor("POST", "/API/SITES")?.scopes).toEqual(["write"]);
    expect(mutationPolicyFor("GET", "/api/sites")).toBeUndefined();
  });

  it("maps alarm-correlation mutations to its exact action-scope floor", () => {
    expect(
      mutationPolicyFor("POST", "/api/alarm-correlation/alarms")?.scopes,
    ).toEqual([
      "alarms.ingest",
      "alarms.acknowledge",
      "alarms.clear",
      "alarms.configure",
    ]);
  });

  it("maps predictive mutations to their exact action scopes", () => {
    expect(mutationPolicyFor("POST", "/api/predictive/ingest")?.scopes)
      .toEqual(["predictive.ingest"]);
    expect(
      mutationPolicyFor("PUT", "/api/predictive/thresholds/tag-1")?.scopes,
    ).toEqual(["predictive.configure"]);
    expect(
      mutationPolicyFor(
        "POST",
        "/api/predictive/alerts/alert-1/acknowledge",
      )?.scopes,
    ).toEqual(["predictive.acknowledge"]);
  });
});

describe("mutating REST authorization", () => {
  it("keeps health probes public when authentication is enabled", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/api/healthz`)).status).toBe(200);
  });

  it("allows reads but denies ordinary mutations to a read-only key", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/api/sites`, {
      headers: { "X-API-Key": "read-key" },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/sites`, {
      method: "POST",
      headers: { "X-API-Key": "read-key" },
    })).status).toBe(403);
  });

  it("cannot bypass mutation policy with an absolute-form request target", async () => {
    const baseUrl = await startApp();
    expect(await absoluteFormMutation(baseUrl, "/api/sites", "read-key"))
      .toBe(403);
  });

  it("cannot bypass mutation policy with case-variant routing", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/API/SITES`, {
      method: "POST",
      headers: { "X-API-Key": "read-key" },
    })).status).toBe(403);
  });

  it("allows a write key on ordinary mutations but not alarm control", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/api/sites`, {
      method: "POST",
      headers: { "X-API-Key": "write-key" },
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}/api/alarms/phi/check`, {
      method: "POST",
      headers: { "X-API-Key": "write-key" },
    })).status).toBe(403);
  });

  it("allows the narrow alarm scope only on alarm control", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/api/alarms/phi/check`, {
      method: "POST",
      headers: { "X-API-Key": "alarm-key" },
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}/api/sites`, {
      method: "POST",
      headers: { "X-API-Key": "alarm-key" },
    })).status).toBe(403);
  });

  it("accepts an exact alarm-correlation action scope but rejects generic write", async () => {
    const baseUrl = await startApp();
    const path = "/api/alarm-correlation/alarms";
    expect((await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "X-API-Key": "alarm-ingest-key" },
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "X-API-Key": "write-key" },
    })).status).toBe(403);
  });

  it("enforces exact predictive action scopes at the central gateway floor", async () => {
    const baseUrl = await startApp();
    const cases = [
      {
        method: "POST",
        path: "/api/predictive/ingest",
        key: "predictive-ingest-key",
      },
      {
        method: "PUT",
        path: "/api/predictive/thresholds/tag-1",
        key: "predictive-configure-key",
      },
      {
        method: "POST",
        path: "/api/predictive/alerts/alert-1/acknowledge",
        key: "predictive-ack-key",
      },
    ];

    for (const testCase of cases) {
      expect((await fetch(`${baseUrl}${testCase.path}`, {
        method: testCase.method,
        headers: { "X-API-Key": testCase.key },
      })).status).toBeLessThan(300);
      expect((await fetch(`${baseUrl}${testCase.path}`, {
        method: testCase.method,
        headers: { "X-API-Key": "write-key" },
      })).status).toBe(403);
    }

    expect((await fetch(`${baseUrl}/api/predictive/thresholds/tag-1`, {
      method: "PUT",
      headers: { "X-API-Key": "predictive-ingest-key" },
    })).status).toBe(403);
  });

  it("blocks a generic write key from the agent-marketplace surface", async () => {
    const baseUrl = await startApp();
    expect((await fetch(`${baseUrl}/api/marketplace/plugins`, {
      method: "POST",
      headers: { "X-API-Key": "write-key" },
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/marketplace/plugins`, {
      method: "POST",
      headers: { "X-API-Key": "marketplace-publish-key" },
    })).status).toBe(201);
  });

  it("separates tuning proposal creation from human approval authority", async () => {
    const baseUrl = await startApp();
    const proposePath = "/api/tuning/loops/loop-1/tune/relay";
    const approvePath = "/api/tuning/proposals/proposal-1/approve";

    expect((await fetch(`${baseUrl}${proposePath}`, {
      method: "POST",
      headers: { "X-API-Key": "tuning-write-key" },
    })).status).toBe(201);
    expect((await fetch(`${baseUrl}${approvePath}`, {
      method: "POST",
      headers: { "X-API-Key": "tuning-write-key" },
    })).status).toBe(403);

    expect((await fetch(`${baseUrl}${approvePath}`, {
      method: "POST",
      headers: { "X-API-Key": "tuning-approve-key" },
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}${proposePath}`, {
      method: "POST",
      headers: { "X-API-Key": "tuning-approve-key" },
    })).status).toBe(403);
  });

  it("requires explicit nonempty scopes and redacts a returned key from logs", async () => {
    const logs: string[] = [];
    const baseUrl = await startApp(logs);

    const invalid = await fetch(`${baseUrl}/api/v1/gateway/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "admin-key",
      },
      body: JSON.stringify({ name: "scope-less" }),
    });
    expect(invalid.status).toBe(400);

    const created = await fetch(`${baseUrl}/api/v1/gateway/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "admin-key",
      },
      body: JSON.stringify({ name: "dashboard", scopes: ["read", "stream.read"] }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await created.json() as { key: string };
    expect(body.key).toMatch(/^oxs_/);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logs.join("\n")).toContain(SENSITIVE_RESPONSE_LOG_MARKER);
    expect(logs.join("\n")).not.toContain(body.key);

    const revoked = await fetch(
      `${baseUrl}/API/V1/GATEWAY/KEYS/${encodeURIComponent(body.key)}`,
      {
        method: "DELETE",
        headers: { "X-API-Key": "admin-key" },
      },
    );
    expect(revoked.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logs.join("\n")).toContain(
      `/API/V1/GATEWAY/KEYS/${SENSITIVE_PATH_SEGMENT_MARKER}`,
    );
    expect(logs.join("\n")).not.toContain(body.key);
  });
});
