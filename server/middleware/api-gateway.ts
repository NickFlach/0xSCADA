/**
 * [12.2] API Gateway & Rate Limiting
 * 
 * Express middleware stack: rate limiter (sliding window), API key validation,
 * request ID injection, versioned route mounting, CORS configuration.
 */

import { Request, Response, NextFunction, Router, Express } from 'express';
import crypto from 'crypto';

// --- Types ---

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyExtractor?: (req: Request) => string;
}

export interface ApiGatewayConfig {
  rateLimit: RateLimitConfig;
  apiKeys: Set<string>;
  corsOrigins: string[];
  enableApiKeyAuth: boolean;
  trustedProxies: string[];
}

const DEFAULT_CONFIG: ApiGatewayConfig = {
  rateLimit: { windowMs: 60_000, maxRequests: 100 },
  apiKeys: new Set(),
  corsOrigins: ['http://localhost:3000', 'http://localhost:5173'],
  enableApiKeyAuth: false,
  trustedProxies: [],
};

// --- Sliding Window Rate Limiter ---

interface WindowEntry {
  count: number;
  resetAt: number;
}

export class SlidingWindowRateLimiter {
  private windows = new Map<string, WindowEntry>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private config: RateLimitConfig) {
    this.cleanupTimer = setInterval(() => this.cleanup(), config.windowMs * 2);
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.config.windowMs };
      this.windows.set(key, entry);
    }

    entry.count++;
    const remaining = Math.max(0, this.config.maxRequests - entry.count);

    return {
      allowed: entry.count <= this.config.maxRequests,
      remaining,
      resetAt: entry.resetAt,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key);
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.windows.clear();
  }
}

// --- Middleware Functions ---

/** Inject a unique request ID */
export function requestIdMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    (req as any).requestId = id;
    _res.setHeader('X-Request-Id', id);
    next();
  };
}

/** Rate limiting middleware */
export function rateLimitMiddleware(config: RateLimitConfig) {
  const limiter = new SlidingWindowRateLimiter(config);
  const keyFn = config.keyExtractor || ((req: Request) => req.ip || 'unknown');

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const result = limiter.check(key);

    res.setHeader('X-RateLimit-Limit', config.maxRequests.toString());
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

/** API key authentication middleware */
export function apiKeyMiddleware(validKeys: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers['x-api-key'] as string;
    if (!key || !validKeys.has(key)) {
      res.status(401).json({ error: 'Invalid or missing API key' });
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

/** Request validation middleware */
export function requestValidation() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Reject oversized payloads already parsed
    if (req.body && JSON.stringify(req.body).length > 10_000_000) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    next();
  };
}

// --- Versioned Route Mounting ---

export function mountVersionedRoutes(app: Express, v1Router: Router, v2Router?: Router): void {
  app.use('/api/v1', v1Router);
  if (v2Router) {
    app.use('/api/v2', v2Router);
  }
  // Default /api routes to latest stable version
  app.use('/api', v1Router);
}

// --- Full Gateway Setup ---

export function setupApiGateway(app: Express, config: Partial<ApiGatewayConfig> = {}): void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Order matters
  app.use(requestIdMiddleware());
  app.use(corsMiddleware(cfg.corsOrigins));
  app.use(rateLimitMiddleware(cfg.rateLimit));
  if (cfg.enableApiKeyAuth && cfg.apiKeys.size > 0) {
    app.use(apiKeyMiddleware(cfg.apiKeys));
  }
  app.use(requestValidation());
}

export default setupApiGateway;
