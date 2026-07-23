/**
 * Fail-closed authentication and authorization for control-plane routes.
 *
 * This reuses the repository's API key records and `API_KEYS` configuration
 * (`key:name:scope+scope`) while keeping the guard local to each sensitive
 * router. The global API gateway is optional, so a live-state read must not
 * depend on it having been mounted by the composition root.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyManager, type ApiKeyRecord } from "./api-gateway";

export interface ControlPlanePrincipal {
  name: string;
  roles: readonly string[];
  scopes: readonly string[];
}

declare global {
  namespace Express {
    interface Request {
      controlPlanePrincipal?: ControlPlanePrincipal;
    }
  }
}

export interface ControlPlaneAccess {
  roles?: readonly string[];
  scopes?: readonly string[];
}

let cachedApiKeysRaw: string | undefined;
let cachedApiKeys = new Map<string, ApiKeyRecord>();

function configuredApiKeys(): Map<string, ApiKeyRecord> {
  const raw = process.env.API_KEYS;
  if (raw === cachedApiKeysRaw) return cachedApiKeys;

  const manager = new ApiKeyManager();
  manager.loadFromEnv();
  cachedApiKeysRaw = raw;
  cachedApiKeys = manager.getKeysMap();
  return cachedApiKeys;
}

function rolesFor(record: ApiKeyRecord): string[] {
  const roles = new Set<string>();
  for (const grant of record.scopes) {
    if (grant === "admin" || grant === "*") {
      roles.add("admin");
      roles.add("operator");
    } else if (grant === "operator") {
      roles.add("operator");
    } else if (grant.startsWith("role.")) {
      roles.add(grant.slice("role.".length));
    }
  }
  return [...roles];
}

function authenticate(req: Request): ApiKeyRecord | undefined {
  const attached = (req as Request & { apiKeyRecord?: ApiKeyRecord })
    .apiKeyRecord;
  if (attached) return attached;

  // Query-string credentials leak into logs and browser history.
  const key = req.header("x-api-key");
  if (!key) return undefined;

  const record = configuredApiKeys().get(key);
  if (!record) return undefined;
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now())
    return undefined;

  (req as Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord = record;
  (req as Request & { apiKeyName?: string }).apiKeyName = record.name;
  return record;
}

function hasAny(
  granted: readonly string[],
  required: readonly string[],
): boolean {
  return (
    required.length === 0 || required.some((value) => granted.includes(value))
  );
}

export function requireControlPlaneAccess(
  access: ControlPlaneAccess = {},
): RequestHandler {
  const requiredRoles = [...(access.roles ?? [])];
  const requiredScopes = [...(access.scopes ?? [])];

  return (req: Request, res: Response, next: NextFunction): void => {
    const record = authenticate(req);
    if (!record) {
      res.status(401).json({
        error: "Authentication required",
        message: "Provide a valid API key via the X-API-Key header.",
      });
      return;
    }

    const roles = rolesFor(record);
    const privileged =
      record.scopes.includes("*") || record.scopes.includes("admin");
    const roleAllowed = privileged || hasAny(roles, requiredRoles);
    const scopeAllowed = privileged || hasAny(record.scopes, requiredScopes);

    if (!roleAllowed || !scopeAllowed) {
      res.status(403).json({
        error: "Insufficient privileges",
        requiredRoles,
        requiredScopes,
      });
      return;
    }

    req.controlPlanePrincipal = Object.freeze({
      name: record.name,
      roles: Object.freeze([...roles]),
      scopes: Object.freeze([...record.scopes]),
    });
    next();
  };
}

/** Test hook for environment-isolated authentication tests. */
export function _resetControlPlaneAuthCache(): void {
  cachedApiKeysRaw = undefined;
  cachedApiKeys = new Map();
}
