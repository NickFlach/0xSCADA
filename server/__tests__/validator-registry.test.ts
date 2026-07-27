/**
 * Validator Registry Seeding + Anti-Rollback Persistence (#454)
 *
 * The first attempt at the cross-node state proxy was rejected for two reasons:
 * it had no replay/freshness protection, and it was "non-functional outside a
 * seeded Postgres — the validator_nodes/validator_pubkeys tables have DDL but
 * no seed".
 *
 * This suite closes both against a REAL database. Nothing here is stubbed: the
 * router is built with its production dependencies (`createNodeRoutes()` with no
 * injected registry, watermark store or RPC client), talking to the real
 * `server/storage.ts` on an in-memory SQLite database and to a real local
 * validator over HTTP. It proves, in order, that:
 *
 *   1. An empty registry FAILS CLOSED — an unregistered validator is never
 *      trusted, it is rejected with 404 unknown-validator.
 *   2. The registry is seeded through an admin-authenticated route, not by hand
 *      editing SQL, and an operator-only key cannot seed it.
 *   3. Once seeded, the signed read works end to end with no manual DB setup.
 *   4. The block-height high-water mark is actually persisted, and a later
 *      answer that regresses below it is refused.
 *   5. Retiring the registered key makes reads fail closed again.
 *
 * Runs sequentially: the cases build on each other's persisted state on purpose,
 * because "the state survived the previous request" is part of what is asserted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import { buildStateSigningMessage } from "../blockchain/state-signature";

const ADMIN_KEY = "validator-registry-admin-key";
const OPERATOR_KEY = "validator-registry-operator-key";
const NODE_ID = "validator-1";
const STATE_KEY = "event-X";
const KEY_ID = "node-key-1";

interface NodeControls {
  blockHeight: number;
  knownKeys: Set<string>;
}

describe.sequential("validator registry seeding + persistence (#454)", () => {
  let database: typeof import("../storage");
  let createNodeRoutes: typeof import("../routes/nodes").createNodeRoutes;

  let publicKeyPem: string;
  let privateKey: KeyObject;
  let fakeNode: Server;
  let fakeNodeUrl: string;
  let proxy: Server;
  let baseUrl: string;

  const controls: NodeControls = {
    blockHeight: 4200,
    knownKeys: new Set([STATE_KEY]),
  };

  const originalEnv = {
    apiKeys: process.env.API_KEYS,
    forcePostgres: process.env.FORCE_POSTGRES,
    sqlitePath: process.env.SQLITE_DATABASE_PATH,
  };

  function request(url: string, apiKey: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", apiKey);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(url, { ...init, headers });
  }

  beforeAll(async () => {
    // Force the development SQLite path so the whole feature is exercised
    // without a Postgres instance — the point of the seeding fix.
    process.env.FORCE_POSTGRES = "false";
    process.env.SQLITE_DATABASE_PATH = ":memory:";
    process.env.API_KEYS =
      `${ADMIN_KEY}:validator-admin:admin,${OPERATOR_KEY}:validator-operator:operator`;

    database = await import("../storage");
    await database.initializeDatabase();
    ({ createNodeRoutes } = await import("../routes/nodes"));
    const auth = await import("../middleware/control-plane-auth");
    auth._resetControlPlaneAuthCache();

    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

    // A real validator: signs the server-supplied nonce and its own timestamp.
    const nodeApp = express();
    nodeApp.get("/state/:key", (req, res) => {
      const key = decodeURIComponent(req.params.key);
      if (!controls.knownKeys.has(key)) {
        res.status(404).json({ error: "key not found", key });
        return;
      }
      const nonce = typeof req.query.nonce === "string" ? req.query.nonce : "";
      const observedAt = new Date().toISOString();
      const value = { reading: 42, key };
      const signature = cryptoSign(
        null,
        Buffer.from(
          buildStateSigningMessage({
            key,
            value,
            blockHeight: controls.blockHeight,
            nonce,
            observedAt,
          }),
          "utf8",
        ),
        privateKey,
      ).toString("hex");
      res.status(200).json({
        key,
        value,
        blockHeight: controls.blockHeight,
        nonce,
        observedAt,
        keyId: KEY_ID,
        signature,
      });
    });

    fakeNode = createServer(nodeApp);
    await new Promise<void>((resolve) => fakeNode.listen(0, () => resolve()));
    const nodeAddr = fakeNode.address();
    fakeNodeUrl = `http://127.0.0.1:${typeof nodeAddr === "object" && nodeAddr ? nodeAddr.port : 0}`;

    // NOTE: no injected deps — this is the production wiring.
    const proxyApp = express();
    proxyApp.use("/api/nodes", createNodeRoutes());
    proxy = createServer(proxyApp);
    await new Promise<void>((resolve) => proxy.listen(0, () => resolve()));
    const proxyAddr = proxy.address();
    baseUrl = `http://127.0.0.1:${typeof proxyAddr === "object" && proxyAddr ? proxyAddr.port : 0}`;
    // Transforming + importing the server modules on a cold cache can exceed
    // vitest's default 10s hook budget on Windows.
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => fakeNode.close(() => resolve()));
    await database.closeDatabase();

    if (originalEnv.apiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalEnv.apiKeys;
    if (originalEnv.forcePostgres === undefined) delete process.env.FORCE_POSTGRES;
    else process.env.FORCE_POSTGRES = originalEnv.forcePostgres;
    if (originalEnv.sqlitePath === undefined) delete process.env.SQLITE_DATABASE_PATH;
    else process.env.SQLITE_DATABASE_PATH = originalEnv.sqlitePath;

    const auth = await import("../middleware/control-plane-auth");
    auth._resetControlPlaneAuthCache();
  });

  it("fails closed on an empty registry: an unregistered validator is rejected", async () => {
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unknown-validator" });
    expect(await database.getValidatorNode(NODE_ID)).toBeNull();
  });

  it("refuses registry writes from an operator key without validator.admin", async () => {
    const res = await request(`${baseUrl}/api/nodes`, OPERATOR_KEY, {
      method: "POST",
      body: JSON.stringify({ id: NODE_ID, name: "Validator 1", rpcUrl: fakeNodeUrl }),
    });
    expect(res.status).toBe(403);
    expect(await database.getValidatorNode(NODE_ID)).toBeNull();
  });

  it("refuses registry writes with no credentials at all", async () => {
    const res = await fetch(`${baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: NODE_ID, name: "Validator 1", rpcUrl: fakeNodeUrl }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-http(s) RPC endpoint", async () => {
    const res = await request(`${baseUrl}/api/nodes`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({
        id: NODE_ID,
        name: "Validator 1",
        rpcUrl: "file:///etc/passwd",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-body" });
  });

  it("registers a validator through the admin route and persists it", async () => {
    const res = await request(`${baseUrl}/api/nodes`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({
        id: NODE_ID,
        name: "Validator 1",
        rpcUrl: fakeNodeUrl,
        region: "east",
      }),
    });
    expect(res.status).toBe(200);

    // Read straight from storage: the row is really in the database.
    expect(await database.getValidatorNode(NODE_ID)).toMatchObject({
      id: NODE_ID,
      name: "Validator 1",
      rpcUrl: fakeNodeUrl,
      region: "east",
      enabled: true,
    });
  });

  it("still fails closed with a node but no registered verification key", async () => {
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no-matching-pubkey" });
  });

  it("rejects key material that is not an Ed25519 SPKI PEM", async () => {
    const res = await request(`${baseUrl}/api/nodes/${NODE_ID}/pubkeys`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ keyId: KEY_ID, publicKeyPem: "-----BEGIN PUBLIC KEY-----junk" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-public-key" });
    expect(await database.getActiveValidatorPubkey(NODE_ID, KEY_ID)).toBeNull();
  });

  it("rejects an RSA key, which this scheme could never verify", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const res = await request(`${baseUrl}/api/nodes/${NODE_ID}/pubkeys`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({
        keyId: KEY_ID,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-public-key" });
  });

  it("rejects key registration for an unregistered validator", async () => {
    const res = await request(`${baseUrl}/api/nodes/validator-99/pubkeys`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ keyId: KEY_ID, publicKeyPem }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unknown-validator" });
  });

  it("registers the Ed25519 verification key and persists it", async () => {
    const res = await request(`${baseUrl}/api/nodes/${NODE_ID}/pubkeys`, ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ keyId: KEY_ID, publicKeyPem }),
    });
    expect(res.status).toBe(200);
    expect(await database.getActiveValidatorPubkey(NODE_ID, KEY_ID)).toMatchObject({
      nodeId: NODE_ID,
      keyId: KEY_ID,
      algorithm: "ed25519",
      active: true,
      publicKeyPem,
    });
  });

  it("serves a verified cross-node read with no hand-seeded database", async () => {
    controls.blockHeight = 4200;
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nodeId: NODE_ID,
      key: STATE_KEY,
      value: { reading: 42, key: STATE_KEY },
      blockHeight: 4200,
      keyId: KEY_ID,
      verified: true,
    });
  });

  it("persisted the block-height high-water mark", async () => {
    const mark = await database.getValidatorStateWatermark(NODE_ID, STATE_KEY);
    expect(mark).toMatchObject({
      nodeId: NODE_ID,
      stateKey: STATE_KEY,
      blockHeight: 4200,
    });
  });

  it("advances the persisted mark on a higher block height", async () => {
    controls.blockHeight = 4300;
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(200);
    expect(
      (await database.getValidatorStateWatermark(NODE_ID, STATE_KEY))?.blockHeight,
    ).toBe(4300);
  });

  it("rejects a correctly signed, fresh answer that regresses below the mark", async () => {
    controls.blockHeight = 4299;
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "state-rollback",
      reason: "block-height-regression",
      blockHeight: 4299,
      highestAcceptedBlockHeight: 4300,
    });
    // The refused answer must not have lowered the persisted mark.
    expect(
      (await database.getValidatorStateWatermark(NODE_ID, STATE_KEY))?.blockHeight,
    ).toBe(4300);
  });

  it("never lowers the persisted mark, even called directly with a lower height", async () => {
    // The route refuses a regression before it would ever write, so exercise the
    // storage compare-and-set on its own: this is the guard that stops two
    // replicas racing the mark backwards.
    const lowered = await database.recordValidatorStateWatermark(
      NODE_ID,
      STATE_KEY,
      1,
      new Date(),
    );
    expect(lowered.blockHeight).toBe(4300);

    const raised = await database.recordValidatorStateWatermark(
      NODE_ID,
      STATE_KEY,
      4301,
      new Date(),
    );
    expect(raised.blockHeight).toBe(4301);

    // Put the mark back where the route left it for the remaining cases.
    expect(
      (await database.getValidatorStateWatermark(NODE_ID, STATE_KEY))?.blockHeight,
    ).toBe(4301);
  });

  it("lists registered validators for an operator without exposing key material", async () => {
    const res = await request(`${baseUrl}/api/nodes`, OPERATOR_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Record<string, unknown>[] };
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({ id: NODE_ID, rpcUrl: fakeNodeUrl });
    expect(JSON.stringify(body)).not.toContain("BEGIN PUBLIC KEY");
  });

  it("fails closed again once the verification key is retired", async () => {
    const retire = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/pubkeys/${KEY_ID}`,
      ADMIN_KEY,
      { method: "DELETE" },
    );
    expect(retire.status).toBe(200);
    expect(await database.getActiveValidatorPubkey(NODE_ID, KEY_ID)).toBeNull();

    controls.blockHeight = 4400;
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/state/${STATE_KEY}`,
      OPERATOR_KEY,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no-matching-pubkey" });
  });

  it("reports 404 when retiring a key that is not registered", async () => {
    const res = await request(
      `${baseUrl}/api/nodes/${NODE_ID}/pubkeys/never-registered`,
      ADMIN_KEY,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no-matching-pubkey" });
  });
});
