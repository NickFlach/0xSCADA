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
import { rateLimitMiddleware } from "../middleware/api-gateway";
import {
  NodeRpcClient,
  NodeUnreachableError,
  NodeTimeoutError,
  StateKeyNotFoundError,
  NodeRpcError,
  UnknownValidatorError,
} from "../blockchain/node-client";
import { verifySignedStateResponse, type SignedStateResponse } from "../blockchain/state-signature";
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
  getActivePubkey(nodeId: string): Promise<ValidatorPubkeyRecord | null>;
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
 * Extract the rate-limit bucket. Prefer an explicit operator identity (API key
 * record / header) and fall back to the request IP. This is the seam that a
 * Redis-backed limiter (#447) will reuse verbatim.
 */
export function operatorKeyExtractor(req: Request): string {
  const apiKeyName = (req as { apiKeyName?: string }).apiKeyName;
  if (apiKeyName) return `operator:${apiKeyName}`;
  const headerOperator = req.header("x-operator-id");
  if (headerOperator) return `operator:${headerOperator}`;
  return `ip:${req.ip || "unknown"}`;
}

const stateQueryRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  maxRequests: 60,
  keyExtractor: operatorKeyExtractor,
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

  router.use(stateQueryRateLimit);

  /**
   * GET /:id/state/:key
   * Proxy a state query to validator `:id` and return its signed response after
   * verifying the signature.
   */
  router.get("/:id/state/:key", async (req: Request, res: Response) => {
    const parsed = ParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid request parameters",
        code: "invalid-params",
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const { id, key } = parsed.data;

    // 1. Resolve validator + its registered verification key.
    let node: ValidatorNodeRecord | null;
    let pubkey: ValidatorPubkeyRecord | null;
    try {
      node = await registry.getNode(id);
      pubkey = node ? await registry.getActivePubkey(id) : null;
    } catch (err) {
      logger.error({ err: (err as Error).message, nodeId: id }, "validator registry lookup failed");
      return res.status(500).json({ error: "Failed to resolve validator", code: "registry-error" });
    }

    if (!node || node.enabled === false) {
      const unknown = new UnknownValidatorError(id);
      return res.status(404).json({ error: unknown.message, code: unknown.code, nodeId: id });
    }

    if (!pubkey) {
      // We refuse to proxy a response we cannot verify.
      return res.status(409).json({
        error: `No active public key registered for validator ${id}`,
        code: "no-registered-pubkey",
        nodeId: id,
      });
    }

    // 2. Proxy the state query to the validator's RPC.
    let signed: SignedStateResponse;
    try {
      signed = await client.getState(id, node.rpcUrl, key);
    } catch (err) {
      return handleClientError(err, res, id, key);
    }

    // 3. VERIFY the signature BEFORE returning to the client.
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

    // 4. Return the verified value + signature.
    return res.status(200).json({
      nodeId: id,
      key: signed.key,
      value: signed.value,
      blockHeight: signed.blockHeight,
      signature: signed.signature,
      keyId: signed.keyId ?? pubkey.keyId ?? null,
      verified: true,
    });
  });

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
  if (err instanceof NodeRpcError) {
    return res.status(502).json({ error: err.message, code: "validator-rpc-error", nodeId, httpStatus: err.httpStatus });
  }
  logger.error({ err: (err as Error).message, nodeId, key }, "unexpected error proxying state query");
  return res.status(502).json({ error: "Failed to query validator state", code: "validator-error", nodeId });
}

/** Default router instance for mounting in `server/routes.ts`. */
export const nodeRoutes = createNodeRoutes();

export default nodeRoutes;
