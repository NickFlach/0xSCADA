/**
 * [12.2] API Gateway & Rate Limiting
 * 
 * Express middleware stack: sliding-window rate limiter, API key validation,
 * request ID injection, Zod request validation, versioned route mounting,
 * CORS configuration.
 * 
 * Closes #204
 */

import { Request, Response, NextFunction, Router, Express } from 'express';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { z, ZodSchema } from 'zod';
import { rateLimit as expressRateLimit } from 'express-rate-limit';
import {
  createRateLimiter,
  type CreateRateLimiterOptions,
  type RateLimitConfig,
} from './rate-limiter';
import { mutationAuthorizationMiddleware } from './control-route-policy';

// Limiter implementations live in ./rate-limiter (issue #447); re-exported
// here so existing imports keep working.
export {
  SlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
  createRateLimiter,
  type RateLimitConfig,
  type RateLimitResult,
  type RateLimiter,
  type RateLimiterBackendName,
} from './rate-limiter';

// --- Types ---

export interface ApiKeyRecord {
  key: string;
  name: string;
  scopes: string[];
  rateLimit?: number; // per-key rate limit override
  createdAt: Date;
  expiresAt?: Date;
}

export interface ApiGatewayConfig {
  rateLimit: RateLimitConfig;
  apiKeys: Map<string, ApiKeyRecord>;
  corsOrigins: string[];
  enableApiKeyAuth: boolean;
  trustedProxies: string[];
  /** Routes that bypass API key auth (e.g. health checks) */
  publicRoutes: string[];
}

const DEFAULT_CONFIG: ApiGatewayConfig = {
  rateLimit: { windowMs: 60_000, maxRequests: 100 },
  apiKeys: new Map(),
  corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
  enableApiKeyAuth: false,
  trustedProxies: [],
  publicRoutes: ['/api/health', '/api/healthz', '/api/readyz'],
};

/**
 * Production is fail-closed when ENABLE_API_KEYS is omitted. Development and
 * tests remain explicitly opt-in; malformed values abort startup.
 */
export function apiKeyAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.ENABLE_API_KEYS?.trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  if (configured) {
    throw new Error('ENABLE_API_KEYS must be either "true" or "false"');
  }
  return env.NODE_ENV === 'production';
}

// --- Middleware Functions ---

/** Inject a unique request ID */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    (req as any).requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

/** Rate limiting middleware with per-route overrides */
export function rateLimitMiddleware(config: RateLimitConfig, limiterOptions?: CreateRateLimiterOptions) {
  const limiter = createRateLimiter(config, limiterOptions);
  const keyFn = config.keyExtractor || ((req: Request) => req.ip || 'unknown');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = keyFn(req);
    const routeKey = `${req.method} ${req.path}`;

    // Check for route-specific overrides
    let maxRequests = config.maxRequests;
    if (config.routeOverrides) {
      for (const [pattern, override] of Object.entries(config.routeOverrides)) {
        if (routeKey.startsWith(pattern) || req.path.startsWith(pattern.split(' ')[1] || pattern)) {
          maxRequests = override.maxRequests;
          break;
        }
      }
    }

    // Use per-key limit from API key if present
    const apiKeyRecord = (req as any).apiKeyRecord as ApiKeyRecord | undefined;
    if (apiKeyRecord?.rateLimit) {
      maxRequests = apiKeyRecord.rateLimit;
    }

    let result;
    try {
      result = await limiter.check(key, maxRequests);
    } catch (err) {
      // Backends degrade internally; anything reaching here is unexpected —
      // fail open rather than take down the API path.
      console.error('[rate-limiter] check failed unexpectedly, allowing request:', err);
      next();
      return;
    }

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000).toString());

    if (!result.allowed) {
      res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
      return;
    }
    next();
  };
}

/** API key authentication middleware with scopes */
export function apiKeyMiddleware(keys: Map<string, ApiKeyRecord>, publicRoutes: string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip auth for public routes
    const requestPath = req.originalUrl.split('?', 1)[0];
    if (publicRoutes.some(route =>
      requestPath === route || requestPath.startsWith(`${route}/`)
    )) {
      return next();
    }

    // Query-string credentials leak through browser history, proxies, and
    // access logs. Accept API keys only through the standard request header.
    const key = req.headers['x-api-key'] as string | undefined;
    if (!key) {
      res.status(401).json({ error: 'Missing API key. Provide via X-API-Key header.' });
      return;
    }

    const record = keys.get(key);
    if (!record) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Check expiration
    if (record.expiresAt && new Date() > record.expiresAt) {
      res.status(401).json({ error: 'API key expired' });
      return;
    }

    // Attach key record to request for downstream use
    (req as any).apiKeyRecord = record;
    (req as any).apiKeyName = record.name;
    next();
  };
}

/** Scope-checking middleware (use after apiKeyMiddleware) */
export function requireScope(...scopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const record = (req as any).apiKeyRecord as ApiKeyRecord | undefined;
    if (!record) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const hasScope =
      record.scopes.includes('*') ||
      record.scopes.includes('admin') ||
      scopes.some(s => record.scopes.includes(s));
    if (!hasScope) {
      res.status(403).json({ error: 'Insufficient scope', required: scopes, granted: record.scopes });
      return;
    }
    next();
  };
}

/** CORS middleware */
export function corsMiddleware(origins: string[]) {
  const originSet = new Set(origins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && (originSet.has('*') || originSet.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Request validation middleware using Zod schemas */
export function validateRequest(schema: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ location: string; issues: z.ZodIssue[] }> = [];

    if (schema.body) {
      const result = schema.body.safeParse(req.body);
      if (!result.success) {
        errors.push({ location: 'body', issues: result.error.issues });
      } else {
        req.body = result.data;
      }
    }

    if (schema.query) {
      const result = schema.query.safeParse(req.query);
      if (!result.success) {
        errors.push({ location: 'query', issues: result.error.issues });
      } else {
        (req as any).validatedQuery = result.data;
      }
    }

    if (schema.params) {
      const result = schema.params.safeParse(req.params);
      if (!result.success) {
        errors.push({ location: 'params', issues: result.error.issues });
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: 'Validation failed',
        details: errors.map(e => ({
          location: e.location,
          errors: e.issues.map(i => ({
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        })),
      });
      return;
    }

    next();
  };
}

/** Payload size guard */
export function requestValidation(maxPayloadBytes = 10_000_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.body && JSON.stringify(req.body).length > maxPayloadBytes) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    next();
  };
}

// --- Versioned Route Mounting ---

export interface VersionedRouteConfig {
  v1: Router;
  v2?: Router;
  /** If true, unversioned /api/* falls through to v1 */
  defaultVersion?: 'v1' | 'v2';
}

export function mountVersionedRoutes(app: Express, config: VersionedRouteConfig): void {
  app.use('/api/v1', config.v1);
  if (config.v2) {
    app.use('/api/v2', config.v2);
  }

  // Default /api routes to specified version (default: v1)
  const defaultRouter = config.defaultVersion === 'v2' && config.v2 ? config.v2 : config.v1;
  app.use('/api', defaultRouter);
}

// --- API Key Management ---

export class ApiKeyManager {
  private keys = new Map<string, ApiKeyRecord>();

  /** Generate a new API key */
  generate(name: string, scopes: string[], expiresInDays?: number): ApiKeyRecord {
    const normalizedName = name.trim();
    const normalizedScopes = Array.from(new Set(
      scopes.map((scope) => scope.trim()).filter(Boolean),
    ));
    if (!normalizedName) {
      throw new Error('API key name must be non-empty');
    }
    if (normalizedScopes.length === 0) {
      throw new Error('At least one explicit API key scope is required');
    }
    if (
      expiresInDays !== undefined &&
      (!Number.isInteger(expiresInDays) || expiresInDays <= 0)
    ) {
      throw new Error('expiresInDays must be a positive integer');
    }

    const key = `oxs_${crypto.randomBytes(32).toString('hex')}`;
    const record: ApiKeyRecord = {
      key,
      name: normalizedName,
      scopes: normalizedScopes,
      createdAt: new Date(),
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 86_400_000)
        : undefined,
    };
    this.keys.set(key, record);
    return record;
  }

  /** Revoke an API key */
  revoke(key: string): boolean {
    return this.keys.delete(key);
  }

  /** List all keys (redacted) */
  list(): Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string }> {
    return Array.from(this.keys.values()).map(r => ({
      keyPrefix: r.key.slice(0, 12) + '...',
      name: r.name,
      scopes: r.scopes,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Load keys from environment variable (comma-separated key:name:scopes) */
  loadFromEnv(envVar = 'API_KEYS'): void {
    const inline = process.env[envVar]?.trim();
    const secretFile = envVar === 'API_KEYS'
      ? process.env.API_KEYS_FILE?.trim()
      : undefined;
    let raw = inline;

    if (!raw && secretFile) {
      try {
        raw = readFileSync(secretFile, 'utf8').trim();
      } catch (error) {
        throw new Error(
          `Unable to read API key secret file "${secretFile}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!raw) return;

    for (const entry of raw.split(',')) {
      const [key, name, scopeStr] = entry.trim().split(':');
      if (key && name) {
        // Missing scopes must never silently create an all-powerful key.
        // Operators can grant `*` explicitly when that is truly intended.
        const scopes = scopeStr ? scopeStr.split('+').filter(Boolean) : [];
        this.keys.set(key, {
          key,
          name,
          scopes,
          createdAt: new Date(),
        });
      }
    }
  }

  getKeysMap(): Map<string, ApiKeyRecord> {
    return this.keys;
  }
}

// --- Full Gateway Setup ---

export function setupApiGateway(app: Express, config: Partial<ApiGatewayConfig> = {}): ApiKeyManager {
  const cfg: ApiGatewayConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    apiKeys: config.apiKeys ?? DEFAULT_CONFIG.apiKeys,
    enableApiKeyAuth: config.enableApiKeyAuth ?? apiKeyAuthEnabled(),
  };

  const keyManager = new ApiKeyManager();
  keyManager.loadFromEnv();

  // Merge env-loaded keys with provided keys
  for (const [k, v] of cfg.apiKeys) {
    keyManager.getKeysMap().set(k, v);
  }

  if (cfg.enableApiKeyAuth && keyManager.getKeysMap().size === 0) {
    throw new Error(
      'API key authentication is enabled but no bootstrap key is configured. ' +
      'Set API_KEYS or API_KEYS_FILE before starting the server.',
    );
  }

  // Order matters
  app.use(requestIdMiddleware());
  app.use(corsMiddleware(cfg.corsOrigins));
  // Two limiters, deliberately, at the same bound.
  //
  // `rateLimitMiddleware` is the real one: it can be backed by Redis
  // (RATE_LIMITER_BACKEND=redis), so under multiple replicas it enforces the
  // limit fleet-wide rather than per process. It is hand-rolled, which means
  // static analysis cannot recognise it as a rate limiter — every `/api` route
  // handler is reported as `js/missing-rate-limiting` even though all of them
  // sit behind this line.
  //
  // `express-rate-limit` is modelled by CodeQL. Layering it here at the same
  // window and limit makes the protection visible to the scanner once, for the
  // whole surface, instead of requiring a second limiter on every new route
  // (the per-route approach taken in #631). It is per-process, so it never
  // loosens the shared bound — it is a local backstop for when Redis is
  // unavailable, which is exactly when a process-local limit matters most.
  app.use('/api/', rateLimitMiddleware(cfg.rateLimit));
  app.use(
    '/api/',
    expressRateLimit({
      windowMs: cfg.rateLimit.windowMs,
      limit: cfg.rateLimit.maxRequests,
      standardHeaders: false,
      // `rateLimitMiddleware` above already owns the response headers and the
      // 429 body; this layer must not overwrite them when it is not the one
      // rejecting.
      legacyHeaders: false,
    }),
  );
  if (cfg.enableApiKeyAuth) {
    app.use('/api/', apiKeyMiddleware(keyManager.getKeysMap(), cfg.publicRoutes));
    app.use('/api/', mutationAuthorizationMiddleware());
  }
  app.use(requestValidation());

  // API key management endpoints (admin only)
  app.get('/api/v1/gateway/keys', requireScope('admin'), (_req, res) => {
    res.json(keyManager.list());
  });

  app.post('/api/v1/gateway/keys', requireScope('admin'), (req, res) => {
    const parsed = z.object({
      name: z.string().trim().min(1).max(100),
      scopes: z.array(z.string().trim().min(1).max(100)).min(1),
      expiresInDays: z.number().int().positive().max(3650).optional(),
    }).strict().safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: 'name and at least one explicit scope are required',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const { name, scopes, expiresInDays } = parsed.data;
    const record = keyManager.generate(name, scopes, expiresInDays);
    // The plaintext credential is returned once to the caller but must never
    // be serialized by the response logger.
    res.locals.sensitiveResponse = true;
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ key: record.key, name: record.name, scopes: record.scopes, expiresAt: record.expiresAt });
  });

  app.delete('/api/v1/gateway/keys/:key', requireScope('admin'), (req, res) => {
    const revoked = keyManager.revoke(req.params.key);
    res.json({ revoked });
  });

  return keyManager;
}

export default setupApiGateway;
