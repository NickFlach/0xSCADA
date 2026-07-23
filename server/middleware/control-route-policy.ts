/**
 * Central authorization inventory for mutating HTTP routes.
 *
 * Every mutating /api request receives at least the default `write` policy.
 * Safety-sensitive prefixes are listed explicitly with narrower scopes. Route
 * modules may add a stricter guard; this inventory is the gateway-level floor.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ApiKeyRecord } from "./api-gateway";

export const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ControlRoutePolicy {
  id: string;
  pathPrefix: string;
  scopes: readonly string[];
  description: string;
}
/**
 * Ordered most-specific first. Prefixes match only complete path segments.
 *
 * Future focused feature branches already use the tuning and safe-state
 * prefixes below, so merging them cannot silently fall back to broad `write`.
 */
export const CONTROL_ROUTE_POLICIES: readonly ControlRoutePolicy[] = Object.freeze([
  {
    id: "gateway-key-administration",
    pathPrefix: "/api/v1/gateway/keys",
    scopes: Object.freeze(["admin"]),
    description: "Create and revoke API credentials.",
  },
  {
    id: "anchor-backend-control",
    pathPrefix: "/api/admin/anchor-backend",
    scopes: Object.freeze(["anchor.admin"]),
    description: "Change the live event anchoring backend.",
  },
  {
    id: "safe-state-resume",
    pathPrefix: "/api/blueprint-safe-state",
    scopes: Object.freeze(["safety.resume"]),
    description: "Resume a blueprint from a fail-closed safe state.",
  },
  {
    id: "tuning-proposal-decision",
    pathPrefix: "/api/tuning/proposals",
    scopes: Object.freeze(["tuning.approve"]),
    description: "Approve or reject a pending tuning proposal.",
  },
  {
    id: "tuning-control",
    pathPrefix: "/api/tuning",
    scopes: Object.freeze(["tuning.write"]),
    description: "Change tuning envelopes or create tuning proposals.",
  },
  {
    id: "alarm-control",
    pathPrefix: "/api/alarms",
    scopes: Object.freeze(["alarms.write"]),
    description: "Inject, evaluate, acknowledge, or suppress alarms.",
  },
  {
    id: "geometry-control",
    pathPrefix: "/api/geometry",
    scopes: Object.freeze(["geometry.write"]),
    description: "Change classification rules or trigger recalibration.",
  },
  {
    id: "digital-twin-control",
    pathPrefix: "/api/intelligence/digitaltwin/operate",
    scopes: Object.freeze(["control.write"]),
    description: "Operate a digital twin against control inputs.",
  },
  {
    id: "hsm-control",
    pathPrefix: "/api/security/hsm/operation",
    scopes: Object.freeze(["security.admin"]),
    description: "Execute an HSM-backed security operation.",
  },
  {
    id: "websocket-administration",
    pathPrefix: "/api/ws/clients",
    scopes: Object.freeze(["websocket.admin"]),
    description: "Disconnect or otherwise administer streaming clients.",
  },
]);

export const DEFAULT_MUTATION_POLICY: ControlRoutePolicy = Object.freeze({
  id: "default-api-mutation",
  pathPrefix: "/api",
  scopes: Object.freeze(["write"]),
  description: "Create, update, or delete an API resource.",
});

function requestPath(req: Request): string {
  // Use Express's parsed mount path rather than raw `originalUrl`. HTTP
  // proxies may send an absolute-form request target; matching the raw value
  // would let that valid request bypass a `/api` prefix policy.
  return `${req.baseUrl}${req.path}` || "/";
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  // Express routing is case-insensitive unless explicitly configured
  // otherwise, so authorization matching must be equally case-insensitive.
  const normalizedPath = path.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  return normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function mutationPolicyFor(
  method: string,
  path: string,
): ControlRoutePolicy | undefined {
  if (!MUTATING_HTTP_METHODS.has(method.toUpperCase())) return undefined;
  if (!pathMatchesPrefix(path, "/api")) return undefined;

  return CONTROL_ROUTE_POLICIES.find((policy) =>
    pathMatchesPrefix(path, policy.pathPrefix)
  ) ?? DEFAULT_MUTATION_POLICY;
}

function isPrivileged(record: ApiKeyRecord): boolean {
  return record.scopes.includes("*") || record.scopes.includes("admin");
}

function permits(record: ApiKeyRecord, policy: ControlRoutePolicy): boolean {
  return isPrivileged(record) ||
    policy.scopes.some((scope) => record.scopes.includes(scope));
}

/**
 * Enforce the central mutation policy after API-key authentication.
 */
export function mutationAuthorizationMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const policy = mutationPolicyFor(req.method, requestPath(req));
    if (!policy) {
      next();
      return;
    }

    const record = (req as Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord;
    if (!record) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    if (!permits(record, policy)) {
      res.status(403).json({
        error: "Insufficient scope",
        policy: policy.id,
        required: policy.scopes,
      });
      return;
    }

    next();
  };
}
