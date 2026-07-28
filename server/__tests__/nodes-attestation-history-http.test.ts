/**
 * HTTP contract for the attestation-history endpoints (issue #456).
 *
 * The defect this pins: the endpoint used to serve seeded-PRNG output as if it
 * were attestation history. These tests assert the two properties that fix it:
 *
 *  1. The LIVE endpoint never returns generated records. With no registered
 *     source it fails closed with 503 `attestation_source_unavailable`.
 *  2. Synthetic records are only reachable from a distinct, opt-in route, and
 *     when they are returned they are labelled synthetic in the body, in every
 *     validator object, and in the response headers.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

import {
  clearLiveAttestationSource,
  isDemoDataEnabled,
  nodesRoutes,
  registerLiveAttestationSource,
} from "../routes/nodes";
import {
  getValidatorLivenessCollectorStatus,
  loadLivenessCollectorConfig,
  startValidatorLivenessCollector,
  stopValidatorLivenessCollector,
} from "../blockchain/liveness-collector";
import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";
import type {
  AttestationSourceDescriptor,
  AttestationSourceUnavailableResponse,
  LiveAttestationHistoryResponse,
  SyntheticAttestationHistoryResponse,
  ValidatorHistory,
} from "@shared/types/slashing";

/**
 * A descriptor is MANDATORY on a live source. `hit` / `miss` / `late` mean
 * whatever the source measured, so a source that will not say what it measured
 * cannot be served — see `LiveAttestationSource` in server/routes/nodes.ts.
 */
const TEST_DESCRIPTOR: AttestationSourceDescriptor = {
  kind: "observed-liveness",
  sourceId: "test-feed",
  summary: "Test feed: whether the node answered each poll round.",
  method: {
    transport: "http-get",
    endpoint: "/status",
    fields: ["height"],
    pollIntervalMs: 60_000,
    retentionMs: 604_800_000,
    maxRecordsPerQuery: 100_000,
  },
  statusSemantics: {
    hit: "answered and height advanced",
    miss: "did not answer this poll round",
    late: "answered but height did not advance",
  },
  roundIdentifier: { field: "slot", meaning: "poll-round ordinal" },
  stake: { available: false, note: "no stake source in this build" },
  consensusAttestation: {
    available: false,
    note: "no per-slot duty outcome is observable in this build",
  },
};

interface TestServer {
  server: Server;
  baseUrl: string;
}

function startServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use("/api/nodes", nodesRoutes);
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

const OPERATOR_KEY = "nodes-operator-key";

describe("attestation history HTTP surface", () => {
  const originalApiKeys = process.env.API_KEYS;
  const originalDemoFlag = process.env.SLASHING_DEMO_DATA;
  let testServer: TestServer;

  beforeAll(async () => {
    process.env.API_KEYS = `${OPERATOR_KEY}:nodes-operator:operator`;
    _resetControlPlaneAuthCache();
    testServer = await startServer();
  });

  afterEach(() => {
    clearLiveAttestationSource();
    delete process.env.SLASHING_DEMO_DATA;
  });

  afterAll(async () => {
    await closeServer(testServer.server);
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    if (originalDemoFlag === undefined) delete process.env.SLASHING_DEMO_DATA;
    else process.env.SLASHING_DEMO_DATA = originalDemoFlag;
    _resetControlPlaneAuthCache();
    clearLiveAttestationSource();
  });

  function get(path: string, key: string | null = OPERATOR_KEY): Promise<Response> {
    return fetch(`${testServer.baseUrl}${path}`, {
      headers: key ? { "x-api-key": key } : {},
    });
  }

  describe("demo data is off by default", () => {
    it("reports the demo endpoint disabled when the flag is unset", () => {
      expect(isDemoDataEnabled()).toBe(false);
    });

    it("404s the demo route rather than fabricating history", async () => {
      const res = await get("/api/nodes/attestation-history/demo?window=24h");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; enabledBy: string };
      expect(body.error).toBe("demo_data_disabled");
      expect(body.enabledBy).toBe("SLASHING_DEMO_DATA=true");
    });

    it("still 404s the demo route when the flag is not exactly 'true'", async () => {
      process.env.SLASHING_DEMO_DATA = "1";
      const res = await get("/api/nodes/attestation-history/demo?window=24h");
      expect(res.status).toBe(404);
    });
  });

  describe("live endpoint", () => {
    it("requires an operator credential", async () => {
      const res = await get("/api/nodes/attestation-history?window=24h", null);
      expect(res.status).toBe(401);
    });

    it("fails closed with 503 when no attestation source is registered", async () => {
      const res = await get("/api/nodes/attestation-history?window=24h");
      expect(res.status).toBe(503);
      const body = (await res.json()) as AttestationSourceUnavailableResponse;
      expect(body.error).toBe("attestation_source_unavailable");
      expect(body.synthetic).toBe(false);
      expect(body.demo.path).toBe("/api/nodes/attestation-history/demo");
      expect(body.demo.available).toBe(false);
      // It must NOT carry records of any kind.
      expect(body).not.toHaveProperty("validators");
    });

    it("does not fall back to synthetic data even when the demo flag is on", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const res = await get("/api/nodes/attestation-history?window=24h");
      expect(res.status).toBe(503);
      const body = (await res.json()) as AttestationSourceUnavailableResponse;
      expect(body.error).toBe("attestation_source_unavailable");
      expect(body).not.toHaveProperty("validators");
      // ...but it does tell the operator the demo route is reachable.
      expect(body.demo.available).toBe(true);
    });

    it("keeps failing closed when the observed-liveness collector is off", async () => {
      // The collector is the only thing in the tree that registers a live
      // source. With the default environment it must register NOTHING, so the
      // route's fail-closed behaviour is byte-for-byte what it was before.
      const config = loadLivenessCollectorConfig({});
      expect(config.enabled).toBe(false);

      const status = await startValidatorLivenessCollector({ config });
      expect(status.enabled).toBe(false);
      expect(status.running).toBe(false);
      // Nothing was started, so there is no collector to report on.
      expect(getValidatorLivenessCollectorStatus()).toBeNull();

      const res = await get("/api/nodes/attestation-history?window=24h");
      expect(res.status).toBe(503);
      const body = (await res.json()) as AttestationSourceUnavailableResponse;
      expect(body.error).toBe("attestation_source_unavailable");
      expect(body).not.toHaveProperty("validators");
      // The reason names the opt-in, so the operator can act on it.
      expect(body.reason).toContain("VALIDATOR_LIVENESS_COLLECTOR_ENABLED=true");
      expect(body.reason).toContain("Consensus attestation duty history is unavailable");

      await stopValidatorLivenessCollector();
    });

    it("rejects an invalid window before consulting any source", async () => {
      const res = await get("/api/nodes/attestation-history?window=3y");
      expect(res.status).toBe(400);
    });

    it("serves a registered source with synthetic:false", async () => {
      const observed: ValidatorHistory[] = [
        {
          validatorId: "node-a",
          label: "Node A",
          stake: 1000,
          records: [{ slot: 0, timestamp: 1_700_000_000_000, status: "hit" }],
        },
      ];
      registerLiveAttestationSource({
        id: "test-feed",
        descriptor: TEST_DESCRIPTOR,
        history: async () => observed,
      });

      const res = await get("/api/nodes/attestation-history?window=24h");
      expect(res.status).toBe(200);
      const body = (await res.json()) as LiveAttestationHistoryResponse;
      expect(body.synthetic).toBe(false);
      expect(body.provenance).toBe("live");
      expect(body.source).toBe("test-feed");
      expect(body.validators).toEqual(observed);
    });

    it("serves the source's semantics descriptor so a miss cannot be misread", async () => {
      registerLiveAttestationSource({
        id: "test-feed",
        descriptor: TEST_DESCRIPTOR,
        history: async () => [],
      });

      const res = await get("/api/nodes/attestation-history?window=1h");
      expect(res.status).toBe(200);
      // The provenance header names the KIND, not just "live": an
      // observed-liveness feed is live data but is not consensus attestation.
      expect(res.headers.get("x-data-provenance")).toBe("live:observed-liveness");

      const body = (await res.json()) as LiveAttestationHistoryResponse;
      expect(body.observation).toEqual(TEST_DESCRIPTOR);
      expect(body.observation.kind).toBe("observed-liveness");
      expect(body.observation.consensusAttestation.available).toBe(false);
      expect(body.observation.statusSemantics.miss).toContain("did not answer");
      expect(body.observation.method.pollIntervalMs).toBe(60_000);
    });

    it("surfaces a failing source as an error rather than substituting data", async () => {
      registerLiveAttestationSource({
        id: "broken-feed",
        descriptor: { ...TEST_DESCRIPTOR, sourceId: "broken-feed" },
        history: async () => {
          throw new Error("rpc timeout");
        },
      });

      const res = await get("/api/nodes/attestation-history?window=24h");
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("attestation_source_error");
      expect(body.message).toContain("rpc timeout");
      expect(body).not.toHaveProperty("validators");
    });
  });

  describe("demo endpoint when explicitly enabled", () => {
    it("requires an operator credential", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const res = await get("/api/nodes/attestation-history/demo?window=24h", null);
      expect(res.status).toBe(401);
    });

    it("labels the payload synthetic in the envelope, per validator, and in headers", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const res = await get("/api/nodes/attestation-history/demo?window=24h&seed=42");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-data-provenance")).toBe("synthetic");
      expect(res.headers.get("warning")).toContain("SYNTHETIC DEMO DATA");

      const body = (await res.json()) as SyntheticAttestationHistoryResponse;
      expect(body.synthetic).toBe(true);
      expect(body.demo).toBe(true);
      expect(body.provenance).toBe("synthetic");
      expect(body.generator).toBe("mulberry32");
      expect(body.seed).toBe(42);
      expect(body.notice).toContain("pseudo-random");
      expect(body.validators.length).toBeGreaterThan(0);
      for (const v of body.validators) {
        expect(v.synthetic).toBe(true);
        expect(v.generator).toBe("mulberry32");
        expect(v.validatorId.startsWith("demo-")).toBe(true);
      }
    });

    it("is reproducible for a pinned seed", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const [a, b] = await Promise.all([
        get("/api/nodes/attestation-history/demo?window=1h&seed=7").then((r) => r.json()),
        get("/api/nodes/attestation-history/demo?window=1h&seed=7").then((r) => r.json()),
      ]);
      const statuses = (payload: unknown): string =>
        (payload as SyntheticAttestationHistoryResponse).validators
          .map((v) => v.records.map((r) => r.status).join(""))
          .join("|");
      expect(statuses(a)).toBe(statuses(b));
    });

    it("404s an unknown demo validator instead of inventing one", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const res = await get(
        "/api/nodes/attestation-history/demo?window=1h&validatorId=val-not-here",
      );
      expect(res.status).toBe(404);
    });

    it("rejects an invalid window", async () => {
      process.env.SLASHING_DEMO_DATA = "true";
      const res = await get("/api/nodes/attestation-history/demo?window=90d");
      expect(res.status).toBe(400);
    });
  });
});
