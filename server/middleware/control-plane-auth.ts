/**
 * Fail-closed authentication and authorization for control-plane routes.
 *
 * This reuses the repository's API key records and `API_KEYS` configuration
 * (`key:name:scope+scope`) while making the guard local to each sensitive
 * router. The global API gateway is optional, so a control mutation must not
 * depend on it having been mounted in `server/index.ts`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyManager, type ApiKeyRecord } from "./api-gateway";

export interface ControlPlanePrincipal {
  /** Trusted audit identity from the server-owned API key record. */
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
  /** Every listed role is accepted; `admin` and `*` always bypass this check. */
  roles?: readonly string[];
  /** Every listed scope is accepted; `admin` and `*` always bypass this check. */
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
  // Credentials in a query string leak into access logs and browser history.
  // Sensitive routes intentionally accept only the standard header form.
  const key = req.header("x-api-key");
  if (!key) return undefined;

  const attached = (req as Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord;
  if (attached) {
    // A preceding gateway may attach a record from a credential source with a
    // different trust policy. Re-bind that record to the exact header value
    // before accepting it at the control-plane boundary.
    if (attached.key !== key) return undefined;
    if (attached.expiresAt && attached.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    return attached;
  }

  const record = configuredApiKeys().get(key);
  if (!record) return undefined;
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return undefined;

  // Preserve the repository-native gateway projections for rate-limit and
  // downstream middleware compatibility.
  (req as Request & { apiKeyRecord?: ApiKeyRecord }).apiKeyRecord = record;
  (req as Request & { apiKeyName?: string }).apiKeyName = record.name;
  return record;
}

function hasAny(granted: readonly string[], required: readonly string[]): boolean {
  return required.length === 0 || required.some((value) => granted.includes(value));
}

/**
 * Authenticate an API key, bind its server-owned identity to the request, and
 * enforce the requested role/scope grants.
 */
export function requireControlPlaneAccess(access: ControlPlaneAccess = {}): RequestHandler {
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
    const privileged = record.scopes.includes("*") || record.scopes.includes("admin");
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

/** Read the trusted identity after a control-plane guard has run. */
export function controlPlanePrincipal(req: Request): ControlPlanePrincipal {
  if (!req.controlPlanePrincipal) {
    throw new Error("Control-plane principal unavailable: authentication guard was not run");
  }
  return req.controlPlanePrincipal;
}

/** Test hook for environment-isolated authentication tests. */
export function _resetControlPlaneAuthCache(): void {
  cachedApiKeysRaw = undefined;
  cachedApiKeys = new Map();
}
