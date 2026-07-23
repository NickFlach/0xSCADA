/**
 * Rate limiter backends (issue #447)
 *
 * Two implementations of the same contract:
 *
 * - SlidingWindowRateLimiter — process-local Map. Fine for a single
 *   replica; with N replicas each pod has its own windows, so a caller can
 *   multiply the effective limit by spraying requests across pods.
 * - RedisSlidingWindowRateLimiter — true sliding window over a shared
 *   Redis sorted set, giving one consistent limit across all replicas.
 *   On Redis failure it degrades to an internal in-memory limiter
 *   (per-replica limiting beats either blocking all traffic or none).
 *
 * Select via RATE_LIMITER_BACKEND=memory|redis (default memory) or the
 * explicit factory options.
 */

import crypto from 'crypto';
import type { Request } from 'express';
import { getRedisClient } from '../services/cache/redis-client';

// --- Types ---

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyExtractor?: (req: Request) => string;
  /** Per-route overrides keyed by "METHOD /path" */
  routeOverrides?: Record<string, { windowMs?: number; maxRequests: number }>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/** Common contract; memory backend is sync, Redis backend async. */
export interface RateLimiter {
  check(key: string, overrideMax?: number): RateLimitResult | Promise<RateLimitResult>;
  peek(key: string): number | Promise<number>;
  destroy(): void;
}

export type RateLimiterBackendName = 'memory' | 'redis';

// --- In-memory backend ---

interface WindowEntry {
  count: number;
  resetAt: number;
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private config: RateLimitConfig) {
    this.cleanupTimer = setInterval(() => this.cleanup(), config.windowMs * 2);
    this.cleanupTimer.unref?.();
  }

  check(key: string, overrideMax?: number): RateLimitResult {
    const now = Date.now();
    const max = overrideMax ?? this.config.maxRequests;
    let entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.config.windowMs };
      this.windows.set(key, entry);
    }

    entry.count++;
    const remaining = Math.max(0, max - entry.count);

    return {
      allowed: entry.count <= max,
      remaining,
      resetAt: entry.resetAt,
    };
  }

  /** Get current count for a key without incrementing */
  peek(key: string): number {
    const entry = this.windows.get(key);
    if (!entry || Date.now() >= entry.resetAt) return 0;
    return entry.count;
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

// --- Redis backend ---

/**
 * Structural subset of ioredis used by the Redis backend; lets tests inject
 * a fake without a live server.
 */
export interface RedisPipelineLike {
  zremrangebyscore(key: string, min: number | string, max: number | string): this;
  zadd(key: string, score: number, member: string): this;
  zcard(key: string): this;
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): this;
  pexpire(key: string, ms: number): this;
  exec(): Promise<Array<[error: Error | null, result: unknown]> | null>;
}

export interface RedisClientLike {
  pipeline(): RedisPipelineLike;
  zcount(key: string, min: number | string, max: number | string): Promise<number>;
}

const KEY_NAMESPACE = 'ratelimit:';

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  private fallback: SlidingWindowRateLimiter;
  private fallbackWarned = false;

  constructor(
    private config: RateLimitConfig,
    private client?: RedisClientLike
  ) {
    this.fallback = new SlidingWindowRateLimiter(config);
  }

  private async getClient(): Promise<RedisClientLike> {
    if (this.client) return this.client;
    this.client = (await getRedisClient()) as unknown as RedisClientLike;
    return this.client;
  }

  async check(key: string, overrideMax?: number): Promise<RateLimitResult> {
    const max = overrideMax ?? this.config.maxRequests;
    const windowMs = this.config.windowMs;
    const now = Date.now();
    const redisKey = KEY_NAMESPACE + key;
    // Member must be unique per request so concurrent hits in the same ms
    // all count.
    const member = `${now}-${crypto.randomUUID()}`;

    try {
      const client = await this.getClient();
      const replies = await client
        .pipeline()
        .zremrangebyscore(redisKey, 0, now - windowMs)
        .zadd(redisKey, now, member)
        .zcard(redisKey)
        .zrange(redisKey, 0, 0, 'WITHSCORES')
        .pexpire(redisKey, windowMs)
        .exec();

      if (!replies) throw new Error('redis pipeline returned null');
      for (const [err] of replies) {
        if (err) throw err;
      }

      const count = Number(replies[2][1]);
      // Rejected requests stay in the set on purpose: a client hammering the
      // endpoint keeps its own window full rather than sliding it free.
      const oldest = replies[3][1] as string[] | undefined;
      const oldestScore = oldest && oldest.length >= 2 ? Number(oldest[1]) : now;
      return {
        allowed: count <= max,
        remaining: Math.max(0, max - count),
        resetAt: oldestScore + windowMs,
      };
    } catch (err) {
      if (!this.fallbackWarned) {
        this.fallbackWarned = true;
        console.warn(
          `[rate-limiter] Redis unavailable, degrading to per-replica in-memory limiting: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      return this.fallback.check(key, overrideMax);
    }
  }

  async peek(key: string): Promise<number> {
    const now = Date.now();
    try {
      const client = await this.getClient();
      return await client.zcount(KEY_NAMESPACE + key, now - this.config.windowMs, '+inf');
    } catch {
      return this.fallback.peek(key);
    }
  }

  destroy(): void {
    this.fallback.destroy();
  }
}

// --- Factory ---

export interface CreateRateLimiterOptions {
  backend?: RateLimiterBackendName;
  redisClient?: RedisClientLike;
}

export function createRateLimiter(
  config: RateLimitConfig,
  options: CreateRateLimiterOptions = {}
): RateLimiter {
  const requested =
    options.backend ?? (process.env.RATE_LIMITER_BACKEND as RateLimiterBackendName | undefined) ?? 'memory';

  switch (requested) {
    case 'redis':
      return new RedisSlidingWindowRateLimiter(config, options.redisClient);
    case 'memory':
      return new SlidingWindowRateLimiter(config);
    default:
      console.warn(
        `[rate-limiter] Unknown RATE_LIMITER_BACKEND "${requested}", using in-memory backend`
      );
      return new SlidingWindowRateLimiter(config);
  }
}
