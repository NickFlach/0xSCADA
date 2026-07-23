/**
 * Cross-Node State Query Routes (#454)
 *
 * Operator endpoint to inspect a *specific* validator's view of a state key —
 * useful for divergence investigations ("what does validator 2 think about
 * event X?").
 *
 *   GET /api/nodes/:id/state/:key
 *
 * Flow:
 *   1. Resolve the validator (id) and its registered Ed25519 public key.
 *   2. Proxy a `state_get` to that validator's oxscada RPC endpoint.
 *   3. VERIFY the validator's signature against the registered pubkey BEFORE
 *      returning anything to the operator.
 *   4. Return the value + signature, or a distinct error shape per failure.
 *
 * Distinct error status codes (acceptance criteria):
 *   - validator-unreachable → 502  (cannot reach the node)
 *   - validator-timeout     → 504  (node too slow)
 *   - signature-invalid     → 502  (proxied OK but signature failed — distinct
 *                                   `code` so clients can tell it apart)
 *   - key-not-found         → 404
 *   - unknown-validator     → 404  (id not in registry / disabled)
 *
 * Rate-limited per-operator using the existing sliding-window limiter
 * (`server/middleware/api-gateway.ts`). The bucket key is the operator id.
 * INTEGRATION (#447): once Redis-backed limiting lands, swap the in-memory
 * `rateLimitMiddleware` for the Redis limiter keyed the same way — the
 * `keyExtractor` below is the seam and stays unchanged.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import pino from "pino";
import { randomBytes } from "node:crypto";
import { rateLimitMiddleware } from "../middleware/api-gateway";
import { requireControlPlaneAccess } from "../middleware/control-plane-auth";
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
  verifySignedStateResponse,
  verifyStateResponseFreshness,
  type SignedStateResponse,
} from "../blockchain/state-signature";
import {
  getValidatorNode,
  getActiveValidatorPubkey,
  type ValidatorNodeRecord,
  type ValidatorPubkeyRecord,
} from "../storage";

const logger = pino({ name: "node-state-routes" });

// ─── Registry abstraction (injectable for tests) ───────────────────────────────

/**
 * Resolves validator metadata + the public key the server uses to verify a
 * validator's signed responses. Backed by the DB via `server/storage.ts` in
 * production; an in-memory implementation is injected in tests.
 */
export interface ValidatorRegistry {
  getNode(id: string): Promise<ValidatorNodeRecord | null>;
  getActivePubkey(
    nodeId: string,
    keyId: string,
  ): Promise<ValidatorPubkeyRecord | null>;
}

const defaultRegistry: ValidatorRegistry = {
  getNode: getValidatorNode,
  getActivePubkey: getActiveValidatorPubkey,
};

// ─── Validation ────────────────────────────────────────────────────────────────

// Validator ids and keys are URL path params. Keep them conservative: the id
// matches the registry id format; the key is any non-empty, reasonably-sized
// string (the value namespace of the validator is opaque to us).
const ParamsSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "invalid validator id"),
  key: z.string().min(1).max(512),
});

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

// ─── Router factory ──────────────────────────────────────────────────────────

export interface NodeRoutesDeps {
  registry?: ValidatorRegistry;
  client?: NodeRpcClient;
}

/**
 * Build the cross-node state router. Dependencies are injectable so the route
 * can be integration-tested against a local fake node + in-memory registry.
 */
export function createNodeRoutes(deps: NodeRoutesDeps = {}): Router {
  const router = Router();
  const registry = deps.registry ?? defaultRegistry;
  const client = deps.client ?? new NodeRpcClient();

  /**
   * GET /:id/state/:key
   * Proxy a state query to validator `:id` and return its signed response after
   * verifying the signature.
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

    // 2. Proxy the state query to the validator's RPC.
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

    // 4. Verify integrity and request freshness before returning any value.
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

    const freshness = verifyStateResponseFreshness(signed, { key, nonce });
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

    // 5. Return the verified value + signature.
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

/** Default router instance for mounting in `server/routes.ts`. */
export const nodeRoutes = createNodeRoutes();

export default nodeRoutes;
