import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
  createRateLimiter,
  type RedisClientLike,
  type RedisPipelineLike,
} from '../rate-limiter';
import { rateLimitMiddleware } from '../api-gateway';

/**
 * In-process fake of the ioredis subset the Redis backend uses. One store
 * can back several client instances — the multi-replica scenario.
 */
class FakeRedisStore {
  sets = new Map<string, Map<string, number>>();

  client(): RedisClientLike {
    const store = this;
    return {
      pipeline(): RedisPipelineLike {
        const ops: Array<() => unknown> = [];
        const pipe = {
          zremrangebyscore(key: string, min: number | string, max: number | string) {
            ops.push(() => {
              const set = store.sets.get(key);
              if (!set) return 0;
              let removed = 0;
              for (const [member, score] of set) {
                if (score >= Number(min) && score <= Number(max)) {
                  set.delete(member);
                  removed++;
                }
              }
              return removed;
            });
            return pipe;
          },
          zadd(key: string, score: number, member: string) {
            ops.push(() => {
              let set = store.sets.get(key);
              if (!set) {
                set = new Map();
                store.sets.set(key, set);
              }
              set.set(member, score);
              return 1;
            });
            return pipe;
          },
          zcard(key: string) {
            ops.push(() => store.sets.get(key)?.size ?? 0);
            return pipe;
          },
          zrange(key: string, start: number, stop: number, _ws: 'WITHSCORES') {
            ops.push(() => {
              const set = store.sets.get(key);
              if (!set) return [];
              const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
              const slice = sorted.slice(start, stop === -1 ? undefined : stop + 1);
              return slice.flatMap(([member, score]) => [member, String(score)]);
            });
            return pipe;
          },
          pexpire(_key: string, _ms: number) {
            ops.push(() => 1);
            return pipe;
          },
          async exec() {
            return ops.map(op => [null, op()] as [Error | null, unknown]);
          },
        };
        return pipe as RedisPipelineLike;
      },
      async zcount(key: string, min: number | string, _max: number | string) {
        const set = store.sets.get(key);
        if (!set) return 0;
        let n = 0;
        for (const score of set.values()) {
          if (score >= Number(min)) n++;
        }
        return n;
      },
    };
  }
}

function failingRedis(): RedisClientLike {
  return {
    pipeline(): RedisPipelineLike {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        zrange: () => pipe,
        pexpire: () => pipe,
        exec: async () => {
          throw new Error('ECONNREFUSED');
        },
      };
      return pipe as unknown as RedisPipelineLike;
    },
    zcount: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
}

// --- Backend contract (both implementations) ---

describe.each([
  ['memory', () => new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 })],
  [
    'redis',
    () => new RedisSlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 }, new FakeRedisStore().client()),
  ],
] as const)('rate limiter contract (%s backend)', (_name, makeLimiter) => {
  it('allows requests up to the limit and blocks beyond it', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) {
      const r = await limiter.check('k');
      expect(r.allowed).toBe(true);
    }
    const blocked = await limiter.check('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    limiter.destroy();
  });

  it('tracks keys independently', async () => {
    const limiter = makeLimiter();
    for (let i = 0; i < 5; i++) await limiter.check('a');
    expect((await limiter.check('a')).allowed).toBe(false);
    expect((await limiter.check('b')).allowed).toBe(true);
    limiter.destroy();
  });

  it('honors per-call override limits', async () => {
    const limiter = makeLimiter();
    expect((await limiter.check('k', 1)).allowed).toBe(true);
    expect((await limiter.check('k', 1)).allowed).toBe(false);
    limiter.destroy();
  });

  it('frees the window after windowMs', async () => {
    vi.useFakeTimers();
    try {
      const limiter = makeLimiter();
      for (let i = 0; i < 6; i++) await limiter.check('k');
      expect((await limiter.check('k')).allowed).toBe(false);
      vi.advanceTimersByTime(1500);
      expect((await limiter.check('k')).allowed).toBe(true);
      limiter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- Multi-replica behavior (the actual #447 bug) ---

describe('multi-replica limiting', () => {
  it('memory backend leaks limit across replicas (documents the bug)', async () => {
    const podA = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 10 });
    const podB = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 10 });
    for (let i = 0; i < 10; i++) expect(podA.check('client').allowed).toBe(true);
    expect(podA.check('client').allowed).toBe(false);
    // Same caller, different pod: fresh window. This is the failure mode.
    expect(podB.check('client').allowed).toBe(true);
    podA.destroy();
    podB.destroy();
  });

  it('redis backend enforces one shared limit: 11th call over a 10-limit window 429s on instance B', async () => {
    const shared = new FakeRedisStore();
    const podA = new RedisSlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 10 }, shared.client());
    const podB = new RedisSlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 10 }, shared.client());

    for (let i = 0; i < 10; i++) {
      expect((await podA.check('client')).allowed).toBe(true);
    }
    const eleventh = await podB.check('client');
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.remaining).toBe(0);
    podA.destroy();
    podB.destroy();
  });
});

// --- Degradation ---

describe('redis failure degradation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('falls back to in-memory limiting and warns once', async () => {
    const limiter = new RedisSlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 2 }, failingRedis());

    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    // Still limited — by the fallback — rather than failing open entirely
    expect((await limiter.check('k')).allowed).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    limiter.destroy();
  });
});

// --- Factory ---

describe('createRateLimiter', () => {
  const originalEnv = process.env.RATE_LIMITER_BACKEND;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RATE_LIMITER_BACKEND;
    else process.env.RATE_LIMITER_BACKEND = originalEnv;
  });

  it('defaults to memory', () => {
    delete process.env.RATE_LIMITER_BACKEND;
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 5 });
    expect(limiter).toBeInstanceOf(SlidingWindowRateLimiter);
    limiter.destroy();
  });

  it('selects redis via env', () => {
    process.env.RATE_LIMITER_BACKEND = 'redis';
    const limiter = createRateLimiter(
      { windowMs: 1000, maxRequests: 5 },
      { redisClient: new FakeRedisStore().client() }
    );
    expect(limiter).toBeInstanceOf(RedisSlidingWindowRateLimiter);
    limiter.destroy();
  });

  it('explicit option beats env', () => {
    process.env.RATE_LIMITER_BACKEND = 'redis';
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 5 }, { backend: 'memory' });
    expect(limiter).toBeInstanceOf(SlidingWindowRateLimiter);
    limiter.destroy();
  });
});

// --- Middleware over the Redis backend ---

describe('rateLimitMiddleware with redis backend', () => {
  function mockRes() {
    const res: any = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: undefined as unknown,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
      },
    };
    return res;
  }

  it('returns 429 with rate-limit headers once the shared window is exhausted', async () => {
    const shared = new FakeRedisStore();
    const mw = rateLimitMiddleware(
      { windowMs: 10_000, maxRequests: 3 },
      { backend: 'redis', redisClient: shared.client() }
    );
    const req = { ip: '10.0.0.1', method: 'GET', path: '/api/tags', headers: {} } as any;

    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      const next = vi.fn();
      await mw(req, res, next);
      expect(next).toHaveBeenCalled();
    }

    const res = mockRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['X-RateLimit-Remaining']).toBe('0');
    expect((res.body as any).retryAfter).toBeGreaterThan(0);
  });
});
