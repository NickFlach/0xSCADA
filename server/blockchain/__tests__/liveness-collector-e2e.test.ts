/**
 * End-to-end proof of the acceptance criterion "UI shows hypothetical penalties
 * against the ACTUAL history" (issue #456), with nothing injected at the seams
 * the other suites stub out.
 *
 * `liveness-collector-durability.test.ts` already drives the collector against a
 * real SQLite database, but it hands it a `fetchImpl` stub, so the transport
 * path is never exercised; and `server/__tests__/nodes-attestation-history-http.test.ts`
 * already exercises the HTTP route, but registers a hand-written fake source, so
 * the real `ObservedLivenessSource` never serves a request. Nothing joined the
 * two. This does:
 *
 *   a real HTTP node on a real socket
 *     -> the production bounded transport (global fetch, no fetchImpl)
 *       -> the real collector and the real SQLite store
 *         -> a genuinely refused TCP connection for the outage rounds
 *           -> the real ObservedLivenessSource registered through the real seam
 *             -> the real Express route, over real HTTP, with an operator key
 *               -> the UNMODIFIED client simulator, over the parsed JSON body
 *
 * The misses here are not an injected `Error("ECONNREFUSED")`: the node's
 * listener is closed, so the connection is refused by the OS. What the assertion
 * at the end projects penalties from is therefore the same bytes an operator's
 * browser would receive.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as StorageModule from "../../storage";
import {
  ObservedLivenessSource,
  ValidatorLivenessCollector,
  OBSERVED_LIVENESS_SOURCE_ID,
  defaultLivenessObservationStore,
  loadLivenessCollectorConfig,
} from "../liveness-collector";
import {
  clearLiveAttestationSource,
  nodesRoutes,
  registerLiveAttestationSource,
} from "../../routes/nodes";
import { _resetControlPlaneAuthCache } from "../../middleware/control-plane-auth";
import { parseRulePhrase, simulateRule } from "../../../client/src/lib/slashing-simulator";
import type { LiveAttestationHistoryResponse } from "@shared/types/slashing";

const OPERATOR_KEY = "liveness-e2e-operator-key";

let storage: typeof StorageModule;
let databaseDirectory: string;

/** The node under observation, and the API server that reads it back. */
let nodePort = 0;
let nodeServer: Server | null = null;
let apiServer: Server;
let apiBaseUrl: string;

/** Height the fake node reports; bumped between rounds to produce a `hit`. */
let nodeHeight = 5_000;

const originalEnv = {
  forcePostgres: process.env.FORCE_POSTGRES,
  sqlitePath: process.env.SQLITE_DATABASE_PATH,
  apiKeys: process.env.API_KEYS,
  anchorNodeUrls: process.env.ANCHOR_NODE_URLS,
  collectorEnabled: process.env.VALIDATOR_LIVENESS_COLLECTOR_ENABLED,
};

/** An oxscada `/status` payload, shaped per `parseOxscadaStatus`. */
function statusPayload(): string {
  return JSON.stringify({
    node_id: "node-e2e",
    height: nodeHeight,
    role: "validator",
    order_parameter: 0.98,
    mean_phase: 1.2,
    local_phase: 1.19,
    peer_phases: [],
    peers: 3,
    mempool: 1,
    uptime_ticks: nodeHeight * 10,
  });
}

/** Bind the fake node. On the first call the OS assigns the port we then reuse. */
function openNode(): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/status") {
        const body = statusPayload();
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(nodePort, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) nodePort = address.port;
      nodeServer = server;
      resolve();
    });
  });
}

/**
 * Close the listener so the port stops accepting. Subsequent polls get a real
 * connection refusal from the OS rather than a stubbed rejection.
 */
function closeNode(): Promise<void> {
  const server = nodeServer;
  nodeServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function startApi(): Promise<void> {
  const app = express();
  app.use("/api/nodes", nodesRoutes);
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      apiServer = server;
      apiBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe("observed liveness end-to-end: real socket -> real DB -> real route -> simulator", () => {
  beforeAll(async () => {
    process.env.FORCE_POSTGRES = "false";
    databaseDirectory = mkdtempSync(join(tmpdir(), "oxscada-liveness-e2e-"));
    process.env.SQLITE_DATABASE_PATH = join(databaseDirectory, "liveness-e2e.sqlite");
    process.env.API_KEYS = `${OPERATOR_KEY}:liveness-e2e-operator:operator`;
    _resetControlPlaneAuthCache();

    storage = await import("../../storage");
    await storage.initializeDatabase();
    // Start from an empty table regardless of what else ran in this worker.
    await storage.pruneValidatorLivenessObservations(Number.MAX_SAFE_INTEGER);

    await openNode();
    await startApi();
    // Module transform + import on a cold cache can exceed the 10s hook budget.
  }, 60_000);

  afterAll(async () => {
    clearLiveAttestationSource();
    await closeNode();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await storage.closeDatabase();
    for (const [key, value] of [
      ["FORCE_POSTGRES", originalEnv.forcePostgres],
      ["SQLITE_DATABASE_PATH", originalEnv.sqlitePath],
      ["API_KEYS", originalEnv.apiKeys],
      ["ANCHOR_NODE_URLS", originalEnv.anchorNodeUrls],
      ["VALIDATOR_LIVENESS_COLLECTOR_ENABLED", originalEnv.collectorEnabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetControlPlaneAuthCache();
    rmSync(databaseDirectory, { recursive: true, force: true });
  });

  it("projects penalties from history the operator's own HTTP response carried", async () => {
    const nodeUrl = `http://127.0.0.1:${nodePort}`;
    process.env.ANCHOR_NODE_URLS = nodeUrl;
    process.env.VALIDATOR_LIVENESS_COLLECTOR_ENABLED = "true";
    // Read the config through the production loader so the opt-in gate itself is
    // exercised, not hand-built around.
    const config = loadLivenessCollectorConfig();
    expect(config.enabled).toBe(true);
    expect(config.nodeUrls).toEqual([nodeUrl]);

    // Wall clock would put every round in the same millisecond, which is fine
    // for a 1h window but leaves the timeline unreadable; step a synthetic clock
    // instead. Only the timestamps are synthetic — every status below is decided
    // by a real request to a real socket.
    let clock = Date.now() - 30 * 60_000;
    const collector = new ValidatorLivenessCollector({
      config,
      store: defaultLivenessObservationStore,
      now: () => clock,
      // NO fetchImpl: this is the production bounded transport over global fetch.
    });

    // Round 1 — node is up. First observation of a validator is a baseline.
    await collector.runRound();

    // Rounds 2..5 — take the listener away. The port is closed, so connecting is
    // refused by the OS; the collector records what it actually failed to reach.
    await closeNode();
    for (let i = 0; i < 4; i += 1) {
      clock += 60_000;
      await collector.runRound();
    }

    // Round 6 — bring the node back at a higher height: answered AND advanced.
    nodeHeight += 1;
    await openNode();
    clock += 60_000;
    await collector.runRound();
    await collector.stop();

    // The refusals were transport-level, not fabricated: the stored reason is
    // whatever the OS/undici actually reported.
    const rows = await storage.listValidatorLivenessObservations(0);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.status)).toEqual(["late", "miss", "miss", "miss", "miss", "hit"]);
    // `detail` is a nullable column; the collector always writes one, and that
    // is part of what is being asserted.
    const missDetails = rows
      .filter((r) => r.status === "miss")
      .map((r) => {
        expect(typeof r.detail).toBe("string");
        // Nothing is carried forward from the round before it.
        expect(r.observedHeight).toBeNull();
        expect(r.reportedNodeId).toBeNull();
        return r.detail ?? "";
      });
    expect(missDetails).toHaveLength(4);
    for (const detail of missDetails) {
      expect(detail.startsWith("no answer:")).toBe(true);
      // The guarantee `describeFetchFailure` actually makes: never `fetch`'s
      // bare, opaque "fetch failed", always a code an auditor can look up.
      // This is the assertion the stubbed suites cannot make — they inject the
      // very message they then assert on.
      expect(detail).toMatch(/\((E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)\)$/);
    }

    // The rounds that dialled the closed port fresh are refused by the OS, and
    // that is a real errno every time.
    const withRealErrno = missDetails.filter((d) => /\(E[A-Z0-9_]+\)$/.test(d));
    expect(withRealErrno.length).toBeGreaterThanOrEqual(3);
    expect(missDetails.some((d) => d.includes("ECONNREFUSED"))).toBe(true);

    // The FIRST miss is the exception, and deliberately not pinned to an errno.
    // It reuses the keep-alive socket opened by round 1, which `closeAllConnections()`
    // destroys locally — so on some hosts there is no OS error to report at all
    // and undici's own `UND_ERR_SOCKET` is the most specific thing that exists.
    // Demanding an errno there asserted a property of the runner, not of the
    // code, and failed CI on unrelated PRs.
    expect(rows[5].previousHeight).toBe(rows[0].observedHeight);

    // ── Serve it through the real seam and the real route, over real HTTP.
    registerLiveAttestationSource(
      new ObservedLivenessSource(defaultLivenessObservationStore, config, () => clock),
    );
    const res = await fetch(`${apiBaseUrl}/api/nodes/attestation-history?window=1h`, {
      headers: { "x-api-key": OPERATOR_KEY },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-data-provenance")).toBe("live:observed-liveness");

    const body = (await res.json()) as LiveAttestationHistoryResponse;
    expect(body.synthetic).toBe(false);
    expect(body.source).toBe(OBSERVED_LIVENESS_SOURCE_ID);
    // The descriptor the UI branches on to say "Poll rounds" instead of "Duties".
    expect(body.observation.kind).toBe("observed-liveness");
    expect(body.observation.consensusAttestation.available).toBe(false);
    expect(body.validators).toHaveLength(1);

    // ── The criterion: the UNMODIFIED simulator, over the response body.
    const history = body.validators[0];
    expect(history.records.map((r) => r.status)).toEqual([
      "late",
      "miss",
      "miss",
      "miss",
      "miss",
      "hit",
    ]);

    const rule = parseRulePhrase("slash 1% per miss after 2 in 1h");
    expect(rule).not.toBeNull();
    const result = simulateRule(history, { ...rule!, livenessRunThreshold: 3 }, "1h", clock);

    expect(result.summary.total).toBe(6);
    expect(result.summary.misses).toBe(4);
    // Four misses, the first two free: two penalised at 1% each.
    expect(result.penalties).toHaveLength(2);
    expect(result.totalPenaltyPct).toBeCloseTo(2, 10);
    // The outage is one consecutive-miss run, above the threshold of 3.
    expect(result.livenessFaults).toHaveLength(1);
    expect(result.livenessFaults[0].length).toBe(4);
    // No stake source exists in this build, so the absolute amount stays 0 and
    // the descriptor says the percentage is the only meaningful output.
    expect(body.observation.stake.available).toBe(false);
    expect(result.totalPenaltyAmount).toBe(0);
  }, 60_000);
});
