/**
 * HTTP authorization matrix for /api/tuning
 * ADR-0013 [13.4] — Issue #215
 *
 * Every route is checked four ways, following the #576 control-plane pattern:
 *   anonymous              -> 401
 *   unknown credential     -> 401
 *   valid key, wrong scope -> 403
 *   correct scope          -> the route's own status
 *
 * The suite then drives the full gated flow over HTTP to prove the properties
 * the previous attempt at this feature failed on: the approver identity comes
 * from the API key rather than the request body, a caller-supplied `approver`
 * field is rejected outright, four-eyes holds, and a live gain only moves
 * after a recorded approval that is readable from the durable audit trail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { tuningRoutes } from "../tuning";
import { tuningService } from "../../services/tuning";
import type { TuningAuditRecord, TuningProposal } from "@shared/types/tuning";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface RouteCase {
  method: "GET" | "POST" | "PUT";
  path: string;
  authorizedStatus: number;
  authorizedKey: string;
  underScopedKey: string;
}

const READ_KEY = "read-key";
const WRITE_KEY = "write-key";
const APPROVE_KEY = "approve-key";
/** Same principal NAME as WRITE_KEY, so it can be used to test four-eyes. */
const ENGINEER_APPROVE_KEY = "engineer-approve-key";
const UNRELATED_KEY = "other-key";

const PROPOSER_NAME = "tuning-engineer";
const APPROVER_NAME = "control-room-lead";

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/tuning", tuningRoutes);

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
  routes: ReadonlyArray<readonly [RouteCase["method"], string, number]>,
): RouteCase[] {
  return routes.map(([method, routePath, authorizedStatus]) => ({
    method,
    path: routePath,
    authorizedStatus,
    authorizedKey,
    underScopedKey,
  }));
}

const readRoutes = routeCases(READ_KEY, WRITE_KEY, [
  ["GET", "/loops/missing", 404],
  ["GET", "/proposals", 200],
  ["GET", "/proposals/missing", 404],
  ["GET", "/audit", 200],
  ["GET", "/status", 200],
]);

const writeRoutes = routeCases(WRITE_KEY, READ_KEY, [
  ["POST", "/loops", 400],
  ["PUT", "/loops/missing/envelope", 400],
  ["POST", "/loops/missing/tune/relay", 400],
  ["POST", "/loops/missing/tune/cohen-coon", 400],
  ["POST", "/loops/missing/tune/rl", 400],
]);

const approveRoutes = routeCases(APPROVE_KEY, WRITE_KEY, [
  ["POST", "/proposals/missing/approve", 404],
  ["POST", "/proposals/missing/reject", 404],
]);

const allRoutes = [...readRoutes, ...writeRoutes, ...approveRoutes];

function request(
  testServer: TestServer,
  route: Pick<RouteCase, "method" | "path">,
  apiKey?: string,
  body: unknown = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (route.method !== "GET") headers["content-type"] = "application/json";

  return fetch(`${testServer.baseUrl}/api/tuning${route.path}`, {
    method: route.method,
    headers,
    body: route.method === "GET" ? undefined : JSON.stringify(body),
  });
}

describe("PID tuning route authorization", () => {
  const originalEnv = { ...process.env };
  let testServer: TestServer;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tuning-http-"));
    process.env.TUNING_AUDIT_SQLITE_PATH = path.join(directory, "audit.sqlite");
    process.env.FORCE_POSTGRES = "false";
    process.env.API_KEYS = [
      `${READ_KEY}:tuning-reader:tuning.read`,
      `${WRITE_KEY}:${PROPOSER_NAME}:tuning.write`,
      `${ENGINEER_APPROVE_KEY}:${PROPOSER_NAME}:tuning.write+tuning.approve`,
      `${APPROVE_KEY}:${APPROVER_NAME}:tuning.approve`,
      `${UNRELATED_KEY}:other-service:predictive.read`,
    ].join(",");
    process.env.PID_TUNING_APPROVERS = `${APPROVER_NAME},${PROPOSER_NAME}`;
    process.env.PID_TUNING_APPLY_ENABLED = "true";
    _resetControlPlaneAuthCache();
    testServer = await startServer();
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    await tuningService.shutdown();
    for (const name of [
      "TUNING_AUDIT_SQLITE_PATH",
      "FORCE_POSTGRES",
      "API_KEYS",
      "PID_TUNING_APPROVERS",
      "PID_TUNING_APPLY_ENABLED",
    ]) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    _resetControlPlaneAuthCache();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(allRoutes)("fails closed for anonymous $method $path", async (route) => {
    const response = await request(testServer, route);
    expect(response.status).toBe(401);
  });

  it.each(allRoutes)("rejects an unknown credential on $method $path", async (route) => {
    const response = await request(testServer, route, "not-a-key");
    expect(response.status).toBe(401);
  });

  it.each(allRoutes)(
    "rejects a valid credential with the wrong scope on $method $path",
    async (route) => {
      const response = await request(testServer, route, route.underScopedKey);
      expect(response.status).toBe(403);
    },
  );

  it.each(allRoutes)(
    "rejects a credential from an unrelated service on $method $path",
    async (route) => {
      const response = await request(testServer, route, UNRELATED_KEY);
      expect(response.status).toBe(403);
    },
  );

  it.each(allRoutes)(
    "allows the exact scope to reach $method $path",
    async (route) => {
      const response = await request(testServer, route, route.authorizedKey);
      expect(response.status).toBe(route.authorizedStatus);
    },
  );

  it("never accepts a credential from the query string", async () => {
    const response = await fetch(
      `${testServer.baseUrl}/api/tuning/status?api_key=${READ_KEY}`,
    );
    expect(response.status).toBe(401);
  });
});

describe("PID tuning gated flow over HTTP", () => {
  const originalEnv = { ...process.env };
  let testServer: TestServer;
  let directory: string;
  const loopId = "http-flow-loop";

  const loopBody = {
    id: loopId,
    name: "Flow FIC-101",
    gains: { kp: 0.7, ki: 0.3, kd: 0.025 },
    setpoint: 50,
    outputMin: 0,
    outputMax: 100,
  };
  const model = { gain: 2, timeConstantS: 10, deadTimeS: 1 };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tuning-flow-"));
    process.env.TUNING_AUDIT_SQLITE_PATH = path.join(directory, "audit.sqlite");
    process.env.FORCE_POSTGRES = "false";
    process.env.API_KEYS = [
      `${READ_KEY}:tuning-reader:tuning.read`,
      `${WRITE_KEY}:${PROPOSER_NAME}:tuning.write`,
      `${ENGINEER_APPROVE_KEY}:${PROPOSER_NAME}:tuning.write+tuning.approve`,
      `${APPROVE_KEY}:${APPROVER_NAME}:tuning.approve`,
    ].join(",");
    process.env.PID_TUNING_APPROVERS = `${APPROVER_NAME},${PROPOSER_NAME}`;
    process.env.PID_TUNING_APPLY_ENABLED = "true";
    _resetControlPlaneAuthCache();
    testServer = await startServer();

    const created = await request(testServer, { method: "POST", path: "/loops" },
      WRITE_KEY, loopBody);
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    await tuningService.shutdown();
    for (const name of [
      "TUNING_AUDIT_SQLITE_PATH",
      "FORCE_POSTGRES",
      "API_KEYS",
      "PID_TUNING_APPROVERS",
      "PID_TUNING_APPLY_ENABLED",
    ]) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    _resetControlPlaneAuthCache();
    await rm(directory, { recursive: true, force: true });
  });

  async function proposeTuning(): Promise<TuningProposal> {
    const response = await request(
      testServer,
      { method: "POST", path: `/loops/${loopId}/tune/cohen-coon` },
      WRITE_KEY,
      { model },
    );
    expect(response.status).toBe(201);
    return await response.json() as TuningProposal;
  }

  async function currentGains(): Promise<TuningProposal["currentGains"]> {
    const response = await request(testServer,
      { method: "GET", path: `/loops/${loopId}` }, READ_KEY);
    expect(response.status).toBe(200);
    const body = await response.json() as { gains: TuningProposal["currentGains"] };
    return body.gains;
  }

  it("attributes the proposal to the authenticated principal", async () => {
    const proposal = await proposeTuning();
    expect(proposal.status).toBe("pending");
    expect(proposal.proposedBy).toBe(PROPOSER_NAME);
  });

  it("rejects a caller-supplied approver field outright", async () => {
    const proposal = await proposeTuning();
    const response = await request(
      testServer,
      { method: "POST", path: `/proposals/${proposal.id}/approve` },
      APPROVE_KEY,
      { approver: "somebody-else", comment: "ok" },
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toMatch(/approver/i);
    // The proposal is untouched and still awaiting a real decision.
    const still = await request(testServer,
      { method: "GET", path: `/proposals/${proposal.id}` }, READ_KEY);
    expect(((await still.json()) as TuningProposal).status).toBe("pending");
  });

  it("enforces four-eyes: the proposing principal cannot approve", async () => {
    const proposal = await proposeTuning();
    const before = await currentGains();

    const response = await request(
      testServer,
      { method: "POST", path: `/proposals/${proposal.id}/approve` },
      // Same principal name as the proposer, and it does hold tuning.approve.
      ENGINEER_APPROVE_KEY,
    );
    expect(response.status).toBe(403);
    const body = await response.json() as { reason: string };
    expect(body.reason).toBe("separation-of-duties");
    expect(await currentGains()).toEqual(before);
  });

  it("applies gains only after a second principal approves, and records it", async () => {
    const proposal = await proposeTuning();
    const before = await currentGains();

    const response = await request(
      testServer,
      { method: "POST", path: `/proposals/${proposal.id}/approve` },
      APPROVE_KEY,
      { comment: "reviewed against the trend" },
    );
    expect(response.status).toBe(200);
    const decided = await response.json() as TuningProposal;
    expect(decided.status).toBe("applied");
    expect(decided.decidedBy).toBe(APPROVER_NAME);
    expect(decided.fullyApplied).toBe(true);

    const after = await currentGains();
    expect(after).not.toEqual(before);
    expect(after).toEqual(decided.appliedGains);

    const auditResponse = await request(
      testServer,
      { method: "GET", path: `/audit?proposalId=${proposal.id}` },
      READ_KEY,
    );
    expect(auditResponse.status).toBe(200);
    const { records } = await auditResponse.json() as { records: TuningAuditRecord[] };
    const approved = records.find((record) => record.decision === "approved")!;
    expect(approved.proposedBy).toBe(PROPOSER_NAME);
    expect(approved.decidedBy).toBe(APPROVER_NAME);
    expect(approved.currentGains).toEqual(before);
    expect(approved.appliedGains).toEqual(after);
    expect(approved.envelopeDecision).toBe("within-envelope");
  });

  it("refuses a recommendation outside the safety envelope at proposal time", async () => {
    const tightened = await request(
      testServer,
      { method: "PUT", path: `/loops/${loopId}/envelope` },
      WRITE_KEY,
      {
        kpRange: { min: 0, max: 0.2 },
        kiRange: { min: 0, max: 0.4 },
        kdRange: { min: 0, max: 0.4 },
      },
    );
    expect(tightened.status).toBe(200);

    const response = await request(
      testServer,
      { method: "POST", path: `/loops/${loopId}/tune/cohen-coon` },
      WRITE_KEY,
      { model },
    );
    expect(response.status).toBe(422);
    const body = await response.json() as { reason: string; error: string };
    expect(body.reason).toBe("envelope-violation");
    expect(body.error).toMatch(/kp=/);
  });

  it("refuses every decision once the approver allowlist is emptied", async () => {
    // Restore a workable envelope and raise one more proposal first.
    const restored = await request(
      testServer,
      { method: "PUT", path: `/loops/${loopId}/envelope` },
      WRITE_KEY,
      {
        kpRange: { min: 0, max: 100 },
        kiRange: { min: 0, max: 50 },
        kdRange: { min: 0, max: 50 },
      },
    );
    expect(restored.status).toBe(200);
    const proposal = await proposeTuning();
    const before = await currentGains();

    process.env.PID_TUNING_APPROVERS = "";
    try {
      const response = await request(
        testServer,
        { method: "POST", path: `/proposals/${proposal.id}/approve` },
        APPROVE_KEY,
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { reason: string }).reason)
        .toBe("approver-allowlist-empty");
      expect(await currentGains()).toEqual(before);

      // A new proposal cannot even be raised against an ungated deployment.
      const proposing = await request(
        testServer,
        { method: "POST", path: `/loops/${loopId}/tune/cohen-coon` },
        WRITE_KEY,
        { model },
      );
      expect(proposing.status).toBe(503);
      expect(((await proposing.json()) as { reason: string }).reason)
        .toBe("approval-gate-unconfigured");
    } finally {
      process.env.PID_TUNING_APPROVERS = `${APPROVER_NAME},${PROPOSER_NAME}`;
    }
  });

  it("cannot overwrite a live loop by re-registering its id", async () => {
    // Regression: POST /loops keyed the controller registry by id, so a
    // tuning.write holder could re-POST an existing id and replace the live
    // controller outright — new gains, attacker-chosen envelope, no proposal,
    // no approver, no rate limit and no audit row. tuning.write must not be a
    // gain write; only an approved decision may move gains.
    const before = await currentGains();

    const response = await request(
      testServer,
      { method: "POST", path: "/loops" },
      WRITE_KEY,
      {
        ...loopBody,
        gains: { kp: 500, ki: 400, kd: 300 },
        envelope: {
          kpRange: { min: 0, max: 100000 },
          kiRange: { min: 0, max: 100000 },
          kdRange: { min: 0, max: 100000 },
        },
      },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { reason: string }).reason)
      .toBe("loop-already-registered");
    expect(await currentGains()).toEqual(before);
  });

  it("refuses to apply gains when the opt-in is off", async () => {
    const proposal = await proposeTuning();
    const before = await currentGains();

    process.env.PID_TUNING_APPLY_ENABLED = "false";
    try {
      const response = await request(
        testServer,
        { method: "POST", path: `/proposals/${proposal.id}/approve` },
        APPROVE_KEY,
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { reason: string }).reason)
        .toBe("gain-apply-disabled");
      expect(await currentGains()).toEqual(before);
    } finally {
      process.env.PID_TUNING_APPLY_ENABLED = "true";
    }
  });
});
