/**
 * Node / validator routes.
 *
 * Two independent operator surfaces share the `/api/nodes` prefix and are
 * exported as two routers (both mounted in `server/routes.ts`):
 *
 *   - `nodeRoutes`  — cross-node signed state queries + the validator registry
 *                     that backs them (#454). Documented immediately below.
 *   - `nodesRoutes` — read-only validator attestation history for the Slashing
 *                     & Liveness Visualizer (#456). Documented at the bottom of
 *                     this file, next to its implementation.
 *
 * ── Cross-Node State Query Routes (#454) ────────────────────────────────────
 *
 * Operator endpoint to inspect a *specific* validator's view of a state key —
 * useful for divergence investigations ("what does validator 2 think about
 * event X?"), plus the admin surface that seeds the validator registry the
 * query depends on.
 *
 *   GET    /api/nodes                        (operator) list registered validators
 *   POST   /api/nodes                        (admin)    register / update a validator
 *   POST   /api/nodes/:id/pubkeys            (admin)    register / rotate a verification key
 *   DELETE /api/nodes/:id/pubkeys/:keyId     (admin)    retire a verification key
 *   GET    /api/nodes/:id/state/:key         (operator) signed cross-node state read
 *
 * Read flow:
 *   1. Resolve the validator (id) from the registry.
 *   2. Mint a fresh random nonce and proxy `state_get` to the validator's RPC.
 *   3. Resolve the exact Ed25519 public key the response names, from the DB
 *      registry — never from the payload.
 *   4. VERIFY the signature against that key BEFORE returning anything.
 *   5. Check freshness: the signed nonce must equal the one we just minted and
 *      the signed observation time must fall inside a bounded skew window.
 *   6. Check anti-rollback: the reported blockHeight must not be below the
 *      highest height already accepted for this (validator, key) pair, and the
 *      new high-water mark must be persisted before we answer.
 *   7. Only then return the value + signature.
 *
 * ## What is enforced where (and what needs a node-side change)
 *
 * Steps 3, 4, 6 are fully enforced by this server against its own database and
 * hold no matter what the validator does.
 *
 * Step 5's nonce binding requires the validator to speak `oxscada-state-v2`:
 * it must read the `?nonce=` query parameter, include it and its own
 * `observedAt` timestamp in the canonical signed message, and echo both in the
 * response body. That producer lives in the oxscada node (geth fork), NOT in
 * this repository, so it cannot be implemented here. Until a node ships v2 the
 * proxy does not silently downgrade: `NodeRpcClient` rejects a v1-shaped
 * response with `state-protocol-incompatible` (502) and no value reaches the
 * operator. The freshness contract is specified in
 * `server/blockchain/state-signature.ts` and documented in
 * `docs/blockchain/cross-node-state-queries.md`.
 *
 * Distinct error status codes (acceptance criteria):
 *   - validator-unreachable         → 502  (cannot reach the node)
 *   - validator-timeout             → 504  (node too slow)
 *   - signature-invalid             → 502  (proxied OK but signature failed)
 *   - response-not-fresh            → 502  (replayed nonce / timestamp outside window)
 *   - state-rollback                → 502  (blockHeight below the accepted high-water mark)
 *   - rollback-check-unavailable    → 503  (cannot read/persist the high-water mark)
 *   - state-protocol-incompatible   → 502  (node still speaks v1, no freshness proof)
 *   - key-not-found                 → 404
 *   - unknown-validator             → 404  (id not in registry / disabled)
 *   - no-matching-pubkey            → 409  (no active Ed25519 key for the named keyId)
 *
 * Rate-limited per-operator using the existing sliding-window limiter
 * (`server/middleware/api-gateway.ts`). The bucket key is the operator id.
 * INTEGRATION (#447): once Redis-backed limiting lands, swap the in-memory
 * `rateLimitMiddleware` for the Redis limiter keyed the same way — the
 * `keyExtractor` below is the seam and stays unchanged.
 */

import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import pino from "pino";
import { randomBytes } from "node:crypto";
import { rateLimitMiddleware } from "../middleware/api-gateway";
import {
  controlPlanePrincipal,
  requireControlPlaneAccess,
} from "../middleware/control-plane-auth";
import {
  NodeRpcClient,
  NodeUnreachableError,
  NodeTimeoutError,
  StateKeyNotFoundError,
  StateProtocolVersionError,
  NodeRpcError,
  UnknownValidatorError,
} from "../blockchain/node-client";
import {
  parsePublicKeyPem,
  verifySignedStateResponse,
  verifyStateResponseFreshness,
  type SignedStateResponse,
} from "../blockchain/state-signature";
import {
  getValidatorNode,
  listValidatorNodes,
  upsertValidatorNode,
  getActiveValidatorPubkey,
  upsertValidatorPubkey,
  retireValidatorPubkey,
  getValidatorStateWatermark,
  recordValidatorStateWatermark,
  type ValidatorNodeRecord,
  type ValidatorPubkeyRecord,
  type ValidatorStateWatermarkRecord,
} from "../storage";
import type {
  AttestationSourceUnavailableResponse,
  SyntheticAttestationHistoryResponse,
  TimelineWindow,
  ValidatorHistory,
} from "@shared/types/slashing";
import {
  SYNTHETIC_ATTESTATION_NOTICE,
  SYNTHETIC_ATTESTATION_NOTICE_ASCII,
  SYNTHETIC_GENERATOR_ID,
} from "@shared/types/slashing";
import {
  DEFAULT_SYNTHETIC_SEED,
  generateFleetHistory,
} from "../demo/synthetic-attestations";

const logger = pino({ name: "node-state-routes" });

// ─── Registry abstraction (injectable for tests) ───────────────────────────────

/**
 * Resolves validator metadata + the public key the server uses to verify a
 * validator's signed responses, and owns the registration (seeding) writes.
 * Backed by the DB via `server/storage.ts` in production; an in-memory
 * implementation is injected in tests.
 */
export interface ValidatorRegistry {
  getNode(id: string): Promise<ValidatorNodeRecord | null>;
  getActivePubkey(
    nodeId: string,
    keyId: string,
  ): Promise<ValidatorPubkeyRecord | null>;
  listNodes(): Promise<ValidatorNodeRecord[]>;
  upsertNode(input: {
    id: string;
    name: string;
    rpcUrl: string;
    operatorId?: string | null;
    region?: string | null;
    enabled?: boolean;
  }): Promise<ValidatorNodeRecord>;
  upsertPubkey(input: {
    nodeId: string;
    keyId: string;
    publicKeyPem: string;
    algorithm?: string;
    active?: boolean;
  }): Promise<ValidatorPubkeyRecord>;
  retirePubkey(nodeId: string, keyId: string): Promise<boolean>;
}

/**
 * Persisted per-(validator, key) high-water mark of the highest block height
 * whose signed answer has already been served. This is what makes the
 * anti-rollback check survive a restart and hold across replicas.
 */
export interface StateWatermarkStore {
  get(
    nodeId: string,
    stateKey: string,
  ): Promise<ValidatorStateWatermarkRecord | null>;
  record(
    nodeId: string,
    stateKey: string,
    blockHeight: number,
    observedAt: Date,
  ): Promise<ValidatorStateWatermarkRecord>;
}

const defaultRegistry: ValidatorRegistry = {
  getNode: getValidatorNode,
  getActivePubkey: getActiveValidatorPubkey,
  listNodes: listValidatorNodes,
  upsertNode: upsertValidatorNode,
  upsertPubkey: upsertValidatorPubkey,
  retirePubkey: retireValidatorPubkey,
};

const defaultWatermarks: StateWatermarkStore = {
  get: getValidatorStateWatermark,
  record: recordValidatorStateWatermark,
};

// ─── Validation ────────────────────────────────────────────────────────────────

// Validator ids and keys are URL path params. Keep them conservative: the id
// matches the registry id format; the key is any non-empty, reasonably-sized
// string (the value namespace of the validator is opaque to us).
const ValidatorIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "invalid validator id");
const KeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid key id");

const ParamsSchema = z.object({
  id: ValidatorIdSchema,
  key: z.string().min(1).max(512),
});

/**
 * A validator RPC endpoint the proxy will make outbound requests to. Restricted
 * to http/https so an admin typo cannot turn the proxy into a file:// or
 * gopher:// fetcher.
 */
const RpcUrlSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "rpcUrl must be an absolute http(s) URL");

const RegisterNodeSchema = z
  .object({
    id: ValidatorIdSchema,
    name: z.string().trim().min(1).max(255),
    rpcUrl: RpcUrlSchema,
    operatorId: z.string().trim().min(1).max(255).nullable().optional(),
    region: z.string().trim().min(1).max(64).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const RegisterPubkeySchema = z
  .object({
    keyId: KeyIdSchema,
    publicKeyPem: z.string().min(1).max(8192),
    // Only Ed25519 is verifiable by `verifySignedStateResponse`; accepting any
    // other algorithm here would register a key that can never validate.
    algorithm: z.literal("ed25519").optional(),
  })
  .strict();

// ─── Freshness / anti-rollback policy ─────────────────────────────────────────

/**
 * How far in the past a validator's `observedAt` may be, and how far a clock may
 * legitimately run ahead of ours. Deliberately tight: this endpoint reports what
 * a node believes *right now*, so a minute-old answer is not useful and an
 * unbounded window would make a captured response replayable forever if a nonce
 * ever collided.
 */
const MAX_OBSERVATION_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;

// ─── Per-operator rate limiting ─────────────────────────────────────────────────

/**
 * Extract the rate-limit bucket from a server-authenticated API-key identity.
 * An arbitrary operator header must not let an unauthenticated caller rotate
 * rate-limit buckets.
 */
export function operatorKeyExtractor(req: Request): string {
  const apiKeyName = (req as { apiKeyName?: string }).apiKeyName;
  if (apiKeyName) return `operator:${apiKeyName}`;
  return `ip:${req.ip || "unknown"}`;
}

const stateQueryRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 60,
  keyExtractor: operatorKeyExtractor,
});
const requireNodeStateRead = requireControlPlaneAccess({
  roles: ["operator"],
});
/**
 * Registry writes decide which remote endpoints and which public keys this
 * server will trust, so they are gated behind an explicit admin scope rather
 * than plain operator access. `admin` / `*` keys satisfy this by construction.
 */
const requireValidatorAdmin = requireControlPlaneAccess({
  roles: ["operator"],
  scopes: ["validator.admin"],
});

// ─── Router factory ──────────────────────────────────────────────────────────

export interface NodeRoutesDeps {
  registry?: ValidatorRegistry;
  client?: NodeRpcClient;
  watermarks?: StateWatermarkStore;
  /** Injectable clock so freshness bounds are testable without sleeping. */
  now?: () => number;
}

/**
 * Build the cross-node state router. Dependencies are injectable so the route
 * can be integration-tested against a local fake node + in-memory registry.
 */
export function createNodeRoutes(deps: NodeRoutesDeps = {}): Router {
  const router = Router();
  const registry = deps.registry ?? defaultRegistry;
  const client = deps.client ?? new NodeRpcClient();
  const watermarks = deps.watermarks ?? defaultWatermarks;
  const now = deps.now ?? (() => Date.now());

  // Parse JSON bodies locally: this router must not depend on a body parser
  // having been installed by whatever composition root mounts it.
  router.use(express.json({ limit: "64kb" }));

  // ── Registry (seeding) surface ─────────────────────────────────────────────

  /** GET / — list registered validators. No key material is returned. */
  router.get("/", requireNodeStateRead, async (_req: Request, res: Response) => {
    try {
      const nodes = await registry.listNodes();
      return res.status(200).json({ nodes });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "validator registry list failed");
      return res.status(500).json({
        error: "Failed to list validators",
        code: "registry-error",
      });
    }
  });

  /**
   * POST / — register or update a validator node.
   *
   * This is the supported seeding path: the registry ships empty on purpose (a
   * migration cannot know your validator set), and an empty registry fails
   * closed because every /state/:key read 404s with `unknown-validator`.
   */
  router.post("/", requireValidatorAdmin, async (req: Request, res: Response) => {
    const parsed = RegisterNodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid validator registration",
        code: "invalid-body",
        details: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    try {
      const node = await registry.upsertNode(parsed.data);
      logger.info(
        { nodeId: node.id, by: controlPlanePrincipal(req).name },
        "validator node registered",
      );
      return res.status(200).json({ node });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, nodeId: parsed.data.id },
        "validator node registration failed",
      );
      return res.status(500).json({
        error: "Failed to register validator",
        code: "registry-error",
      });
    }
  });

  /**
   * POST /:id/pubkeys — register (or rotate) the Ed25519 key whose signatures
   * this server will accept from that validator.
   */
  router.post(
    "/:id/pubkeys",
    requireValidatorAdmin,
    async (req: Request, res: Response) => {
      const id = ValidatorIdSchema.safeParse(req.params.id);
      if (!id.success) {
        return res.status(400).json({
          error: "Invalid validator id",
          code: "invalid-params",
        });
      }

      const parsed = RegisterPubkeySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid public key registration",
          code: "invalid-body",
          details: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }

      // Reject unusable key material at registration time rather than letting
      // every later query fail with an opaque `malformed-pubkey`.
      if (!parsePublicKeyPem(parsed.data.publicKeyPem)) {
        return res.status(400).json({
          error: "publicKeyPem is not a PEM-encoded Ed25519 SPKI public key",
          code: "invalid-public-key",
        });
      }

      try {
        const node = await registry.getNode(id.data);
        if (!node) {
          const unknown = new UnknownValidatorError(id.data);
          return res.status(404).json({
            error: unknown.message,
            code: unknown.code,
            nodeId: id.data,
          });
        }

        const pubkey = await registry.upsertPubkey({
          nodeId: id.data,
          keyId: parsed.data.keyId,
          publicKeyPem: parsed.data.publicKeyPem,
          algorithm: parsed.data.algorithm ?? "ed25519",
          active: true,
        });
        logger.info(
          {
            nodeId: id.data,
            keyId: pubkey.keyId,
            by: controlPlanePrincipal(req).name,
          },
          "validator verification key registered",
        );
        return res.status(200).json({
          nodeId: pubkey.nodeId,
          keyId: pubkey.keyId,
          algorithm: pubkey.algorithm,
          active: pubkey.active,
        });
      } catch (err) {
        logger.error(
          { err: (err as Error).message, nodeId: id.data },
          "validator key registration failed",
        );
        return res.status(500).json({
          error: "Failed to register validator key",
          code: "registry-error",
        });
      }
    },
  );

  /** DELETE /:id/pubkeys/:keyId — retire a key so its signatures stop verifying. */
  router.delete(
    "/:id/pubkeys/:keyId",
    requireValidatorAdmin,
    async (req: Request, res: Response) => {
      const params = z
        .object({ id: ValidatorIdSchema, keyId: KeyIdSchema })
        .safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({
          error: "Invalid request parameters",
          code: "invalid-params",
        });
      }

      try {
        const retired = await registry.retirePubkey(
          params.data.id,
          params.data.keyId,
        );
        if (!retired) {
          return res.status(404).json({
            error: `No active key ${params.data.keyId} registered for validator ${params.data.id}`,
            code: "no-matching-pubkey",
            nodeId: params.data.id,
            keyId: params.data.keyId,
          });
        }
        logger.info(
          {
            nodeId: params.data.id,
            keyId: params.data.keyId,
            by: controlPlanePrincipal(req).name,
          },
          "validator verification key retired",
        );
        return res.status(200).json({
          nodeId: params.data.id,
          keyId: params.data.keyId,
          active: false,
        });
      } catch (err) {
        logger.error(
          { err: (err as Error).message, nodeId: params.data.id },
          "validator key retirement failed",
        );
        return res.status(500).json({
          error: "Failed to retire validator key",
          code: "registry-error",
        });
      }
    },
  );

  // ── Signed cross-node read ─────────────────────────────────────────────────

  /**
   * GET /:id/state/:key
   * Proxy a state query to validator `:id` and return its signed response after
   * verifying the signature, the request freshness and the block-height
   * high-water mark.
   */
  router.get(
    "/:id/state/:key",
    requireNodeStateRead,
    stateQueryRateLimit,
    async (req: Request, res: Response) => {
    const parsed = ParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request parameters",
        code: "invalid-params",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const { id, key } = parsed.data;

    // 1. Resolve the validator before making any outbound request.
    let node: ValidatorNodeRecord | null;
    try {
      node = await registry.getNode(id);
    } catch (err) {
      logger.error({ err: (err as Error).message, nodeId: id }, "validator registry lookup failed");
      return res.status(500).json({ error: "Failed to resolve validator", code: "registry-error" });
    }

    if (!node || node.enabled === false) {
      const unknown = new UnknownValidatorError(id);
      return res.status(404).json({ error: unknown.message, code: unknown.code, nodeId: id });
    }

    // 2. Proxy the state query to the validator's RPC under a fresh challenge.
    const nonce = randomBytes(16).toString("hex");
    let signed: SignedStateResponse;
    try {
      signed = await client.getState(id, node.rpcUrl, key, nonce);
    } catch (err) {
      return handleClientError(err, res, id, key);
    }

    // 3. Resolve the exact active Ed25519 key named by the response. Selecting
    // an arbitrary active key is unsafe during key rotation.
    if (!signed.keyId || signed.keyId.length > 128) {
      return res.status(502).json({
        error: "Validator response did not identify a usable signing key",
        code: "validator-key-id-missing",
        nodeId: id,
        key,
      });
    }

    let pubkey: ValidatorPubkeyRecord | null;
    try {
      pubkey = await registry.getActivePubkey(id, signed.keyId);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, nodeId: id, keyId: signed.keyId },
        "validator public-key lookup failed",
      );
      return res.status(500).json({
        error: "Failed to resolve validator signing key",
        code: "registry-error",
      });
    }

    if (
      !pubkey ||
      pubkey.nodeId !== id ||
      pubkey.keyId !== signed.keyId ||
      pubkey.active !== true ||
      pubkey.algorithm.toLowerCase() !== "ed25519"
    ) {
      return res.status(409).json({
        error: `No matching active Ed25519 public key registered for validator ${id}`,
        code: "no-matching-pubkey",
        nodeId: id,
        keyId: signed.keyId,
      });
    }

    // 4. Verify integrity before returning any value.
    const verdict = verifySignedStateResponse(signed, pubkey.publicKeyPem);
    if (!verdict.valid) {
      logger.warn(
        { nodeId: id, key, reason: verdict.reason },
        "validator state response failed signature verification",
      );
      // Proxied successfully but the payload is not trustworthy. 502 Bad Gateway
      // with a distinct code so clients can distinguish from a transport error.
      return res.status(502).json({
        error: "Validator response failed signature verification",
        code: "signature-invalid",
        reason: verdict.reason,
        nodeId: id,
        key,
      });
    }

    // 5. Verify request freshness: the signature must cover the challenge we
    // just minted, and the observation must fall inside the skew window. A
    // captured-and-replayed response fails the nonce check here.
    const freshness = verifyStateResponseFreshness(signed, {
      key,
      nonce,
      nowMs: now(),
      maxAgeMs: MAX_OBSERVATION_AGE_MS,
      maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
    });
    if (!freshness.valid) {
      logger.warn(
        { nodeId: id, key, reason: freshness.reason },
        "validator state response failed freshness verification",
      );
      return res.status(502).json({
        error: "Validator response failed freshness verification",
        code: "response-not-fresh",
        reason: freshness.reason,
        nodeId: id,
        key,
      });
    }

    // 6. Anti-rollback: never serve a height below one already accepted for
    // this (validator, key). Equal heights are legitimate (the same block read
    // twice); only a regression is refused.
    let watermark: ValidatorStateWatermarkRecord | null;
    try {
      watermark = await watermarks.get(id, key);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, nodeId: id, key },
        "state watermark lookup failed",
      );
      return res.status(503).json({
        error: "Cannot verify state freshness: high-water mark unavailable",
        code: "rollback-check-unavailable",
        nodeId: id,
        key,
      });
    }

    if (watermark && signed.blockHeight < watermark.blockHeight) {
      logger.warn(
        {
          nodeId: id,
          key,
          blockHeight: signed.blockHeight,
          highestAcceptedBlockHeight: watermark.blockHeight,
        },
        "validator state response regressed below the accepted block height",
      );
      return res.status(502).json({
        error: "Validator reported a block height below the highest already accepted",
        code: "state-rollback",
        reason: "block-height-regression",
        nodeId: id,
        key,
        blockHeight: signed.blockHeight,
        highestAcceptedBlockHeight: watermark.blockHeight,
      });
    }

    // Persist the advanced mark BEFORE answering. If we cannot, a later
    // rollback would go undetected, so fail closed rather than serve blind.
    try {
      await watermarks.record(
        id,
        key,
        signed.blockHeight,
        new Date(signed.observedAt),
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, nodeId: id, key },
        "state watermark persist failed",
      );
      return res.status(503).json({
        error: "Cannot record state freshness: high-water mark not persisted",
        code: "rollback-check-unavailable",
        nodeId: id,
        key,
      });
    }

    // 7. Return the verified value + signature.
    return res.status(200).json({
      nodeId: id,
      key: signed.key,
      value: signed.value,
      blockHeight: signed.blockHeight,
      observedAt: signed.observedAt,
      signature: signed.signature,
      keyId: signed.keyId,
      verified: true,
    });
    },
  );

  return router;
}

/** Map node-client errors onto distinct HTTP status codes + stable `code`s. */
function handleClientError(err: unknown, res: Response, nodeId: string, key: string): Response {
  if (err instanceof StateKeyNotFoundError) {
    return res.status(404).json({ error: err.message, code: "key-not-found", nodeId, key });
  }
  if (err instanceof NodeTimeoutError) {
    return res.status(504).json({ error: err.message, code: "validator-timeout", nodeId });
  }
  if (err instanceof NodeUnreachableError) {
    return res.status(502).json({ error: err.message, code: "validator-unreachable", nodeId });
  }
  if (err instanceof StateProtocolVersionError) {
    return res.status(502).json({
      error: err.message,
      code: err.code,
      nodeId,
      expectedProtocol: err.expectedProtocol,
      incompatibleFields: err.incompatibleFields,
    });
  }
  if (err instanceof NodeRpcError) {
    return res.status(502).json({ error: err.message, code: "validator-rpc-error", nodeId, httpStatus: err.httpStatus });
  }
  logger.error({ err: (err as Error).message, nodeId, key }, "unexpected error proxying state query");
  return res.status(502).json({ error: "Failed to query validator state", code: "validator-error", nodeId });
}

// =============================================================================
// Validator attestation history (issue #456)
// =============================================================================

/**
 * Backs the Slashing & Liveness Visualizer. Read-only: this router never writes
 * and never slashes anything.
 *
 * ── WHY THERE IS NO LIVE ATTESTATION FEED HERE ──────────────────────────────
 *
 * PR #514 originally served a seeded PRNG from `GET /api/nodes/history` as
 * though it were attestation history. That was rejected, correctly: it violates
 * the repository Integrity Rule ("NO fabricated data"). Before rewriting it the
 * tree was searched for a real source, and there is none:
 *
 *   - `server/blockchain/validator-health.ts` is a real, tested monitor, but it
 *     polls the oxscada node `GET /status` surface, whose schema
 *     (height / peers / mempool / Kuramoto phase / uptime_ticks) carries no
 *     per-slot attestation duty outcome at all. It also keeps only the latest
 *     sample — there is no history — and it is not constructed anywhere in
 *     production code, only in its own test.
 *   - `server/blockchain.ts` is a declared stub: `isConnected()` returns false
 *     and `getBlockchainHealth()` reports "Not implemented". Chain integration
 *     is opt-in via ENABLE_BLOCKCHAIN and there is no attestation RPC behind it.
 *   - The cross-node state surface above proxies a validator's view of a state
 *     key. It is a point-in-time signed read, not a per-slot duty log, so it
 *     cannot answer "did validator N attest in slot S?" either.
 *   - Neither `shared/schema.ts` nor any migration has an attestations table,
 *     and the batch-anchoring pipeline anchors Merkle roots of industrial
 *     events — not validator duties.
 *
 * So this build genuinely cannot report attestation history. Rather than fake
 * it, the endpoints are split by provenance:
 *
 *   GET /api/nodes/attestation-history
 *       The live endpoint. Fails closed with HTTP 503 and a machine-readable
 *       `attestation_source_unavailable` body while no feed exists. It never
 *       falls back to synthetic records.
 *
 *   GET /api/nodes/attestation-history/demo
 *       Explicitly-synthetic demo data for exercising the (real, unit-tested)
 *       what-if simulator. OFF BY DEFAULT — 404 unless
 *       SLASHING_DEMO_DATA=true. Every response is labelled `synthetic: true`,
 *       carries the canonical notice string, and sets `X-Data-Provenance:
 *       synthetic` plus an RFC 9111 `Warning: 199` header.
 *
 * When a real feed lands, register it with `registerLiveAttestationSource()`
 * below and the live route serves it with `synthetic: false`. Do not point the
 * live route at `server/demo/`.
 */
const attestationRouter = Router();

/** Path of the synthetic demo endpoint, as advertised to clients. */
export const DEMO_HISTORY_PATH = "/api/nodes/attestation-history/demo";
/** Environment assignment that enables the synthetic demo endpoint. */
export const DEMO_ENV_FLAG = "SLASHING_DEMO_DATA=true";

// ---------------------------------------------------------------------------
// Live attestation sources
// ---------------------------------------------------------------------------

/**
 * A live per-validator attestation feed.
 *
 * `history` must return records that were OBSERVED. An implementation that
 * computes, estimates, interpolates or randomises duty outcomes is not a live
 * source and must not be registered here.
 */
export interface LiveAttestationSource {
  /** Stable identifier reported to operators, e.g. "oxscada-rpc". */
  readonly id: string;
  history(
    window: TimelineWindow,
    validatorId?: string,
  ): Promise<ValidatorHistory[]>;
}

/**
 * The registered live source, if any.
 *
 * Nothing in this repository registers one today — see the section header — so
 * the live route reports "unavailable". This is an empty registry, not a stub
 * implementation: the moment a real feed calls
 * `registerLiveAttestationSource()` at startup, the live route serves it.
 */
let liveAttestationSource: LiveAttestationSource | undefined;

/**
 * Wire a real observed-attestation feed into the live route. Intended to be
 * called once during server startup by whatever module owns the feed.
 */
export function registerLiveAttestationSource(
  source: LiveAttestationSource,
): void {
  liveAttestationSource = source;
}

/** Drop the registered live source (used by tests and by shutdown paths). */
export function clearLiveAttestationSource(): void {
  liveAttestationSource = undefined;
}

function resolveLiveAttestationSource(): LiveAttestationSource | undefined {
  return liveAttestationSource;
}

/** Whether the synthetic demo endpoint is enabled. Off unless opted in. */
export function isDemoDataEnabled(): boolean {
  return process.env.SLASHING_DEMO_DATA === "true";
}

const NO_LIVE_SOURCE_REASON =
  "No live attestation feed is compiled into this build. The oxscada node " +
  "/status surface reports height, peers, mempool and Kuramoto phase but no " +
  "per-slot attestation duty outcome, and nothing in this repository persists " +
  "per-validator duty history.";

function unavailableBody(): AttestationSourceUnavailableResponse {
  return {
    error: "attestation_source_unavailable",
    synthetic: false,
    provenance: "live",
    message:
      "No live attestation history is available. This endpoint fails closed " +
      "rather than returning generated data.",
    reason: NO_LIVE_SOURCE_REASON,
    demo: {
      available: isDemoDataEnabled(),
      path: DEMO_HISTORY_PATH,
      enabledBy: DEMO_ENV_FLAG,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HistoryQuerySchema = z.object({
  /** Timeline window to return. */
  window: z.enum(["1h", "24h", "7d"]).default("24h"),
  /** Optional validator filter; when omitted, all known validators returned. */
  validatorId: z.string().min(1).optional(),
});

const DemoHistoryQuerySchema = HistoryQuerySchema.extend({
  /** Optional PRNG seed override, for reproducible demonstrations. */
  seed: z.coerce.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/nodes/attestation-history?window=24h[&validatorId=...]
 *
 * Live per-validator attestation history. Read-only. Returns 503 while no live
 * source is wired — never synthetic records.
 */
attestationRouter.get(
  "/attestation-history",
  requireControlPlaneAccess({ roles: ["operator"] }),
  async (req, res) => {
    const parsed = HistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid history query",
        details: parsed.error.flatten(),
      });
    }

    const source = resolveLiveAttestationSource();
    if (!source) {
      return res.status(503).json(unavailableBody());
    }

    const { window, validatorId } = parsed.data;
    try {
      const validators = await source.history(window, validatorId);
      return res.json({
        synthetic: false,
        demo: false,
        provenance: "live",
        source: source.id,
        window,
        validators,
      });
    } catch (err) {
      // A failing feed must surface as a failure, never as substituted data.
      return res.status(502).json({
        error: "attestation_source_error",
        synthetic: false,
        provenance: "live",
        source: source.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/**
 * GET /api/nodes/attestation-history/demo?window=24h[&validatorId=...][&seed=...]
 *
 * SYNTHETIC demo data. Disabled unless SLASHING_DEMO_DATA=true, in which case
 * every response is labelled synthetic in the body and in response headers.
 */
attestationRouter.get(
  "/attestation-history/demo",
  requireControlPlaneAccess({ roles: ["operator"] }),
  (req, res) => {
    if (!isDemoDataEnabled()) {
      return res.status(404).json({
        error: "demo_data_disabled",
        message:
          "Synthetic slashing demo data is disabled. It is opt-in because it " +
          "is fabricated, not measured.",
        enabledBy: DEMO_ENV_FLAG,
      });
    }

    const parsed = DemoHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid demo history query",
        details: parsed.error.flatten(),
      });
    }
    const { window, validatorId, seed } = parsed.data;
    const effectiveSeed = seed ?? DEFAULT_SYNTHETIC_SEED;
    const anchorMs = Date.now();
    const validators = generateFleetHistory(
      window,
      anchorMs,
      effectiveSeed,
      validatorId,
    );

    if (validatorId && validators.length === 0) {
      return res.status(404).json({
        error: `Unknown demo validator: ${validatorId}`,
        synthetic: true,
      });
    }

    // Provenance survives even if the body is truncated, proxied or logged.
    // Header values must be ASCII, hence the plain restatement of the notice.
    res.setHeader("X-Data-Provenance", "synthetic");
    res.setHeader("Warning", `199 - "${SYNTHETIC_ATTESTATION_NOTICE_ASCII}"`);

    const body: SyntheticAttestationHistoryResponse = {
      synthetic: true,
      demo: true,
      provenance: "synthetic",
      generator: SYNTHETIC_GENERATOR_ID,
      notice: SYNTHETIC_ATTESTATION_NOTICE,
      seed: effectiveSeed,
      window,
      anchorMs,
      validators,
    };
    return res.json(body);
  },
);

/** Attestation-history router (#456), mounted alongside `nodeRoutes`. */
export { attestationRouter as nodesRoutes };

/** Default router instance for mounting in `server/routes.ts`. */
export const nodeRoutes = createNodeRoutes();

export default nodeRoutes;
