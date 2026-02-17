/**
 * Tests for [12.2] API Gateway & Rate Limiting
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SlidingWindowRateLimiter,
  ApiKeyManager,
} from '../api-gateway';

describe('SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxRequests: 5 });
  });

  it('allows requests within limit', () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('user1');
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks requests over limit', () => {
    for (let i = 0; i < 5; i++) limiter.check('user1');
    const result = limiter.check('user1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('tracks separate keys independently', () => {
    for (let i = 0; i < 5; i++) limiter.check('user1');
    const result = limiter.check('user2');
    expect(result.allowed).toBe(true);
  });

  it('supports override max', () => {
    for (let i = 0; i < 3; i++) limiter.check('user1', 3);
    const result = limiter.check('user1', 3);
    expect(result.allowed).toBe(false);
  });

  it('peek returns count without incrementing', () => {
    limiter.check('user1');
    limiter.check('user1');
    expect(limiter.peek('user1')).toBe(2);
    expect(limiter.peek('user1')).toBe(2); // no increment
  });

  afterEach(() => {
    limiter.destroy();
  });
});

describe('ApiKeyManager', () => {
  let manager: ApiKeyManager;

  beforeEach(() => {
    manager = new ApiKeyManager();
  });

  it('generates keys with oxs_ prefix', () => {
    const record = manager.generate('test-key', ['read']);
    expect(record.key).toMatch(/^oxs_/);
    expect(record.name).toBe('test-key');
    expect(record.scopes).toEqual(['read']);
  });

  it('generates keys with expiration', () => {
    const record = manager.generate('expiring', ['*'], 30);
    expect(record.expiresAt).toBeDefined();
    expect(record.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('revokes keys', () => {
    const record = manager.generate('to-revoke', ['*']);
    expect(manager.revoke(record.key)).toBe(true);
    expect(manager.revoke(record.key)).toBe(false);
  });

  it('lists keys with redacted prefixes', () => {
    manager.generate('key1', ['read']);
    manager.generate('key2', ['write']);
    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list[0].keyPrefix).toContain('...');
    expect(list[0]).not.toHaveProperty('key');
  });

  it('loads keys from env', () => {
    process.env.API_KEYS = 'testkey123:myapp:read+write,anotherkey:admin:*';
    manager.loadFromEnv();
    delete process.env.API_KEYS;

    const keys = manager.getKeysMap();
    expect(keys.has('testkey123')).toBe(true);
    expect(keys.get('testkey123')?.scopes).toEqual(['read', 'write']);
    expect(keys.get('anotherkey')?.scopes).toEqual(['*']);
  });
});
