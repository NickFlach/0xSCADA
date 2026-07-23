/**
 * Cross-Node State Query Test Suite (#454)
 *
 * Covers the per-validator `/state/:key` proxy end to end:
 *   - Unit: canonical signing message + Ed25519 signature verification, incl.
 *     the security-critical tamper case.
 *   - Integration: a REAL local fake validator node (http.Server on port 0)
 *     returns a signed payload; the route proxies, verifies and returns it.
 *     We then have the fake node tamper its response *after signing* and assert
 *     the route returns the distinct `signature-invalid` (502) shape. We also
 *     exercise validator-unreachable (502), validator-timeout (504),
 *     key-not-found (404) and unknown-validator (404).
 *
 * No supertest dependency (not in package.json): we mount the router on a real
 * Express app + http.Server and drive it with the global `fetch` (Node 18+),
 * matching the http.createServer + listen(0) convention in websocket.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

import {
  buildStateSigningMessage,
  canonicalJsonStringify,
  verifySignedStateResponse,
  verifyStateResponseFreshness,
  type SignedStateResponse,
} from "../blockchain/state-signature";
import { NodeRpcClient } from "../blockchain/node-client";
import {
  createNodeRoutes,
  operatorKeyExtractor,
  type ValidatorRegistry,
} from "../routes/nodes";
import type { ValidatorNodeRecord, ValidatorPubkeyRecord } from "../storage";
import { _resetControlPlaneAuthCache } from "../middleware/control-plane-auth";

// ─── Test signing helpers (simulate what a validator does) ─────────────────────

function makeKeyPair(): { publicKeyPem: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { publicKeyPem, privateKey };
}

function signState(
  privateKey: KeyObject,
  params: {
    key: string;
    value: unknown;
    blockHeight: number;
    keyId?: string;
    nonce?: string;
    observedAt?: string;
  },
): SignedStateResponse {
  const signedFields = {
    ...params,
    nonce: params.nonce ?? "test-nonce",
    observedAt: params.observedAt ?? new Date().toISOString(),
  };
  const message = Buffer.from(buildStateSigningMessage(signedFields), "utf8");
  const signature = cryptoSign(null, message, privateKey).toString("hex");
  return {
    key: signedFields.key,
    value: signedFields.value,
    blockHeight: signedFields.blockHeight,
    nonce: signedFields.nonce,
    observedAt: signedFields.observedAt,
    keyId: params.keyId,
    signature,
  };
}

// =============================================================================
// UNIT: canonical message + signature verification
// =============================================================================

describe("canonicalJsonStringify", () => {
  it("sorts object keys deterministically and recursively", () => {
    const a = canonicalJsonStringify({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJsonStringify({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles null and primitives", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(42)).toBe("42");
    expect(canonicalJsonStringify("x")).toBe('"x"');
  });

  it("preserves the special __proto__ JSON key", () => {
    const withProtoKey = JSON.parse(
      '{"__proto__":{"admin":true},"x":1}',
    ) as Record<string, unknown>;
    expect(canonicalJsonStringify(withProtoKey)).toBe(
      '{"__proto__":{"admin":true},"x":1}',
    );
  });
});

describe("buildStateSigningMessage", () => {
  it("is domain-separated and field-ordered", () => {
    const msg = buildStateSigningMessage({
      key: "k",
      value: { x: 1 },
      blockHeight: 7,
      nonce: "challenge-1",
      observedAt: "2026-07-23T00:00:00.000Z",
    });
    expect(msg).toBe(
      'oxscada-state-v2\nk\n7\nchallenge-1\n2026-07-23T00:00:00.000Z\n{"x":1}',
    );
  });

  it("is stable regardless of value object key order", () => {
    const common = {
      key: "k",
      blockHeight: 1,
      nonce: "challenge-1",
      observedAt: "2026-07-23T00:00:00.000Z",
    };
    const m1 = buildStateSigningMessage({ ...common, value: { a: 1, b: 2 } });
    const m2 = buildStateSigningMessage({ ...common, value: { b: 2, a: 1 } });
    expect(m1).toBe(m2);
  });
});

describe("verifySignedStateResponse", () => {
  const { publicKeyPem, privateKey } = makeKeyPair();

  it("accepts a correctly signed response", () => {
    const signed = signState(privateKey, { key: "temp", value: { c: 21 }, blockHeight: 100 });
    expect(verifySignedStateResponse(signed, publicKeyPem)).toEqual({ valid: true });
  });

  it("rejects a tampered VALUE (security-critical)", () => {
    const signed = signState(privateKey, { key: "temp", value: { c: 21 }, blockHeight: 100 });
    const tampered = { ...signed, value: { c: 999 } };
    const result = verifySignedStateResponse(tampered, publicKeyPem);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature-mismatch");
  });

  it("rejects a tampered KEY", () => {
    const signed = signState(privateKey, { key: "temp", value: 1, blockHeight: 1 });
    const result = verifySignedStateResponse({ ...signed, key: "pressure" }, publicKeyPem);
    expect(result.valid).toBe(false);
  });

  it("rejects a tampered blockHeight", () => {
    const signed = signState(privateKey, { key: "temp", value: 1, blockHeight: 1 });
    const result = verifySignedStateResponse({ ...signed, blockHeight: 2 }, publicKeyPem);
    expect(result.valid).toBe(false);
  });

  it("rejects a signature from a DIFFERENT key", () => {
    const other = makeKeyPair();
    const signed = signState(other.privateKey, { key: "temp", value: 1, blockHeight: 1 });
    const result = verifySignedStateResponse(signed, publicKeyPem);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature-mismatch");
  });

  it("reports missing-signature", () => {
    const r = verifySignedStateResponse(
      {
        key: "k",
        value: 1,
        blockHeight: 1,
        nonce: "n",
        observedAt: new Date().toISOString(),
        signature: "",
      },
      publicKeyPem,
    );
    expect(r).toEqual({ valid: false, reason: "missing-signature" });
  });

  it("reports malformed-signature for non-hex / odd length", () => {
    const r = verifySignedStateResponse(
      {
        key: "k",
        value: 1,
        blockHeight: 1,
        nonce: "n",
        observedAt: new Date().toISOString(),
        signature: "zz",
      },
      publicKeyPem,
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("malformed-signature");
  });

  it("reports malformed-pubkey for garbage PEM", () => {
    const signed = signState(privateKey, { key: "k", value: 1, blockHeight: 1 });
    const r = verifySignedStateResponse(signed, "not a pem");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("malformed-pubkey");
  });

  it("rejects a well-formed non-Ed25519 public key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const signed = signState(privateKey, { key: "k", value: 1, blockHeight: 1 });
    expect(verifySignedStateResponse(signed, rsaPublicKeyPem)).toEqual({
      valid: false,
      reason: "malformed-pubkey",
    });
  });
});

describe("verifyStateResponseFreshness", () => {
  const response = signState(makeKeyPair().privateKey, {
    key: "temp",
    value: 21,
    blockHeight: 10,
    nonce: "current-challenge",
    observedAt: "2026-07-23T00:00:20.000Z",
  });

  it("rejects a captured response replayed for a new challenge", () => {
    expect(
      verifyStateResponseFreshness(response, {
        key: "temp",
        nonce: "different-challenge",
        nowMs: Date.parse("2026-07-23T00:00:30.000Z"),
      }),
    ).toEqual({ valid: false, reason: "nonce-mismatch" });
  });
});

// =============================================================================
// INTEGRATION: route + real fake validator node
// =============================================================================

interface FakeNodeControls {
  /** When set, the node tampers its signed value after signing. */
  tamper: boolean;
  /** Keys the node "knows"; querying an unknown key yields 404. */
  knownKeys: Set<string>;
  nonceOverride?: string;
  observedAtOffsetMs?: number;
  keyIdOverride?: string | null;
  legacyV1?: boolean;
}

/** Stand up a real local fake validator node returning signed state responses. */
function startFakeNode(privateKey: KeyObject, controls: FakeNodeControls): Promise<{ server: Server; url: string }> {
  const app = express();

  app.get("/state/:key", (req, res) => {
    const key = decodeURIComponent(req.params.key);
    if (!controls.knownKeys.has(key)) {
      res.status(404).json({ error: "key not found", key });
      return;
    }
    const value = { reading: 42, key };
    const blockHeight = 1234;
    const requestNonce =
      typeof req.query.nonce === "string" ? req.query.nonce : "";
    const signed = signState(privateKey, {
      key,
      value,
      blockHeight,
      keyId:
        controls.keyIdOverride === null
          ? undefined
          : (controls.keyIdOverride ?? "node-key-1"),
      nonce: controls.nonceOverride ?? requestNonce,
      observedAt: new Date(
        Date.now() + (controls.observedAtOffsetMs ?? 0),
      ).toISOString(),
    });

    if (controls.tamper) {
      // Mutate the value AFTER signing — exactly the in-flight tamper the issue
      // requires the server to detect.
      signed.value = { reading: 9999, key };
    }
    if (controls.legacyV1) {
      res.status(200).json({
        key: signed.key,
        value: signed.value,
        blockHeight: signed.blockHeight,
        keyId: signed.keyId,
        signature: signed.signature,
      });
      return;
    }
    res.status(200).json(signed);
  });

  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Mount the cross-node route on a real Express server for end-to-end testing. */
function startProxyServer(registry: ValidatorRegistry, client: NodeRpcClient): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use("/api/nodes", createNodeRoutes({ registry, client }));
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("GET /api/nodes/:id/state/:key (integration)", () => {
  const apiKey = "node-state-read-key";
  const originalApiKeys = process.env.API_KEYS;
  const { publicKeyPem, privateKey } = makeKeyPair();
  const controls: FakeNodeControls = { tamper: false, knownKeys: new Set(["event-X"]) };

  let fakeNode: { server: Server; url: string };
  let proxy: { server: Server; baseUrl: string };

  function fetchAsOperator(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", apiKey);
    return fetch(url, { ...init, headers });
  }

  function buildRegistry(rpcUrl: string, withPubkey = true): ValidatorRegistry {
    const node: ValidatorNodeRecord = {
      id: "validator-2",
      name: "Validator 2",
      rpcUrl,
      operatorId: "operator-acme",
      region: "east",
      enabled: true,
    };
    const pubkey: ValidatorPubkeyRecord = {
      nodeId: "validator-2",
      algorithm: "ed25519",
      publicKeyPem,
      keyId: "node-key-1",
      active: true,
    };
    return {
      getNode: async (id) => (id === "validator-2" ? node : null),
      getActivePubkey: async (id, keyId) =>
        id === "validator-2" &&
        keyId === "node-key-1" &&
        withPubkey
          ? pubkey
          : null,
    };
  }

  beforeAll(async () => {
    process.env.API_KEYS = `${apiKey}:node-state-reader:operator`;
    _resetControlPlaneAuthCache();
    fakeNode = await startFakeNode(privateKey, controls);
  });

  beforeEach(() => {
    controls.tamper = false;
    controls.nonceOverride = undefined;
    controls.observedAtOffsetMs = undefined;
    controls.keyIdOverride = undefined;
    controls.legacyV1 = false;
  });

  afterAll(async () => {
    await closeServer(fakeNode.server);
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    _resetControlPlaneAuthCache();
  });

  afterAll(async () => {
    if (proxy) await closeServer(proxy.server);
  });

  it("proxies, verifies the signature and returns the value (happy path)", async () => {
    controls.tamper = false;
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.nodeId).toBe("validator-2");
    expect(body.key).toBe("event-X");
    expect(body.value).toEqual({ reading: 42, key: "event-X" });
    expect(typeof body.signature).toBe("string");
    await closeServer(proxy.server);
  });

  it("requires a local operator API key before proxying live state", async () => {
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetch(
      `${proxy.baseUrl}/api/nodes/validator-2/state/event-X`,
    );
    expect(res.status).toBe(401);
    await closeServer(proxy.server);
  });

  it("rejects a validly signed response replayed for another challenge", async () => {
    controls.nonceOverride = "captured-old-challenge";
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(
      `${proxy.baseUrl}/api/nodes/validator-2/state/event-X`,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "response-not-fresh",
      reason: "nonce-mismatch",
    });
    await closeServer(proxy.server);
  });

  it("reports a clear v1-to-v2 producer incompatibility", async () => {
    controls.legacyV1 = true;
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(
      `${proxy.baseUrl}/api/nodes/validator-2/state/event-X`,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: "state-protocol-incompatible",
      expectedProtocol: "oxscada-state-v2",
      incompatibleFields: ["nonce", "observedAt"],
    });
    await closeServer(proxy.server);
  });

  it("requires an exact active Ed25519 keyId match", async () => {
    controls.keyIdOverride = "rotated-unknown-key";
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(
      `${proxy.baseUrl}/api/nodes/validator-2/state/event-X`,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "no-matching-pubkey",
      keyId: "rotated-unknown-key",
    });
    await closeServer(proxy.server);
  });

  it("returns 502 signature-invalid when the node tampers the response in-flight", async () => {
    controls.tamper = true;
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("signature-invalid");
    expect(body.reason).toBe("signature-mismatch");
    controls.tamper = false;
    await closeServer(proxy.server);
  });

  it("returns 404 key-not-found for an unknown key", async () => {
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("key-not-found");
    await closeServer(proxy.server);
  });

  it("returns 404 unknown-validator for an unregistered id", async () => {
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-99/state/event-X`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("unknown-validator");
    await closeServer(proxy.server);
  });

  it("returns 502 validator-unreachable when the node is down", async () => {
    // Point the registry at a port nothing is listening on.
    const deadRegistry = buildRegistry("http://127.0.0.1:1");
    proxy = await startProxyServer(deadRegistry, new NodeRpcClient({ timeoutMs: 1000 }));
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("validator-unreachable");
    await closeServer(proxy.server);
  });

  it("returns 504 validator-timeout when the node is too slow", async () => {
    // Fake slow node that never responds within the deadline.
    const slow = createServer((_req, res) => {
      // Intentionally never end the response.
      void res;
    });
    await new Promise<void>((r) => slow.listen(0, () => r()));
    const addr = slow.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const slowRegistry = buildRegistry(`http://127.0.0.1:${port}`);
    proxy = await startProxyServer(slowRegistry, new NodeRpcClient({ timeoutMs: 200 }));
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.code).toBe("validator-timeout");
    await closeServer(proxy.server);
    await closeServer(slow);
  });

  it("returns 409 when no verification pubkey is registered", async () => {
    proxy = await startProxyServer(buildRegistry(fakeNode.url, /* withPubkey */ false), new NodeRpcClient());
    const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("no-matching-pubkey");
    await closeServer(proxy.server);
  });

  it("rate-limits per-operator (returns 429 once the window is exhausted)", async () => {
    // Acceptance criterion: requests are rate-limited per operator. The in-router
    // sliding-window limit is 60 req/min keyed by operator (IP fallback here, since
    // all requests originate from 127.0.0.1 they share one bucket). The 61st request
    // in the window must be rejected with 429 — proving the limiter is actually wired,
    // not just that the key extractor exists.
    controls.tamper = false;
    proxy = await startProxyServer(buildRegistry(fakeNode.url), new NodeRpcClient());

    let sawRateLimited = false;
    let lastStatus = 0;
    // 60 are allowed; the 61st should trip the limiter. Issue sequentially so the
    // sliding-window counter is deterministic.
    for (let i = 0; i < 61; i++) {
      const res = await fetchAsOperator(`${proxy.baseUrl}/api/nodes/validator-2/state/event-X`);
      lastStatus = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
    expect(lastStatus).toBe(429);
    await closeServer(proxy.server);
  });
});

// =============================================================================
// UNIT: NodeRpcClient error taxonomy (injected fetch, no real socket)
// =============================================================================

describe("NodeRpcClient", () => {
  it("maps a 404 to StateKeyNotFoundError", async () => {
    const client = new NodeRpcClient({
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "nf" }),
    });
    await expect(client.getState("v1", "http://x", "k")).rejects.toMatchObject({ code: "key-not-found" });
  });

  it("maps an AbortError to NodeTimeoutError", async () => {
    const client = new NodeRpcClient({
      timeoutMs: 50,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    });
    await expect(client.getState("v1", "http://x", "k")).rejects.toMatchObject({ code: "validator-timeout" });
  });

  it("maps a network throw to NodeUnreachableError", async () => {
    const client = new NodeRpcClient({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.getState("v1", "http://x", "k")).rejects.toMatchObject({ code: "validator-unreachable" });
  });

  it("rejects a malformed signed-state body as NodeRpcError", async () => {
    const client = new NodeRpcClient({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }), text: async () => "" }),
    });
    await expect(client.getState("v1", "http://x", "k")).rejects.toMatchObject({ code: "validator-rpc-error" });
  });

  it("classifies a legacy response without v2 freshness fields", async () => {
    const client = new NodeRpcClient({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          key: "k",
          value: 1,
          blockHeight: 7,
          keyId: "legacy-key",
          signature: "00",
        }),
        text: async () => "",
      }),
    });

    await expect(client.getState("v1", "http://x", "k")).rejects.toMatchObject({
      code: "state-protocol-incompatible",
      expectedProtocol: "oxscada-state-v2",
      incompatibleFields: ["nonce", "observedAt"],
    });
  });
});

// =============================================================================
// UNIT: operator rate-limit key extraction
// =============================================================================

describe("operatorKeyExtractor", () => {
  it("prefers the API key name", () => {
    const req = { apiKeyName: "acme", header: () => undefined, ip: "1.2.3.4" } as never;
    expect(operatorKeyExtractor(req)).toBe("operator:acme");
  });

  it("ignores an unauthenticated x-operator-id header", () => {
    const req = { header: (h: string) => (h === "x-operator-id" ? "op-7" : undefined), ip: "1.2.3.4" } as never;
    expect(operatorKeyExtractor(req)).toBe("ip:1.2.3.4");
  });

  it("falls back to IP", () => {
    const req = { header: () => undefined, ip: "9.9.9.9" } as never;
    expect(operatorKeyExtractor(req)).toBe("ip:9.9.9.9");
  });
});
