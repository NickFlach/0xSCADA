/**
 * Tests for [12.2] API Gateway & Rate Limiting
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SlidingWindowRateLimiter,
  ApiKeyManager,
  apiKeyMiddleware,
  apiKeyAuthEnabled,
  setupApiGateway,
} from '../api-gateway';
import express from 'express';

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

  it('refuses to generate a key without an explicit scope', () => {
    expect(() => manager.generate('scope-less', [])).toThrow(
      'At least one explicit API key scope is required',
    );
  });

  it('loads a scope-less environment key without implicit privileges', () => {
    process.env.API_KEYS = 'unscoped-key:legacy-client';
    manager.loadFromEnv();
    delete process.env.API_KEYS;

    expect(manager.getKeysMap().get('unscoped-key')?.scopes).toEqual([]);
  });
});

describe('fail-closed gateway configuration', () => {
  it('enables authentication by default only in production', () => {
    expect(apiKeyAuthEnabled({ NODE_ENV: 'production' })).toBe(true);
    expect(apiKeyAuthEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(apiKeyAuthEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(() => apiKeyAuthEnabled({
      NODE_ENV: 'production',
      ENABLE_API_KEYS: 'yes',
    })).toThrow('must be either "true" or "false"');
  });

  it('refuses to start enabled authentication without a bootstrap key', () => {
    const previousKeys = process.env.API_KEYS;
    const previousFile = process.env.API_KEYS_FILE;
    delete process.env.API_KEYS;
    delete process.env.API_KEYS_FILE;
    try {
      expect(() => setupApiGateway(express(), {
        enableApiKeyAuth: true,
        apiKeys: new Map(),
      })).toThrow('no bootstrap key is configured');
    } finally {
      if (previousKeys === undefined) delete process.env.API_KEYS;
      else process.env.API_KEYS = previousKeys;
      if (previousFile === undefined) delete process.env.API_KEYS_FILE;
      else process.env.API_KEYS_FILE = previousFile;
    }
  });

  it('makes direct gateway setup fail closed by default in production', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousEnabled = process.env.ENABLE_API_KEYS;
    const previousKeys = process.env.API_KEYS;
    const previousFile = process.env.API_KEYS_FILE;
    process.env.NODE_ENV = 'production';
    delete process.env.ENABLE_API_KEYS;
    delete process.env.API_KEYS;
    delete process.env.API_KEYS_FILE;

    try {
      expect(() => setupApiGateway(express(), {
        apiKeys: new Map(),
      })).toThrow('no bootstrap key is configured');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousEnabled === undefined) delete process.env.ENABLE_API_KEYS;
      else process.env.ENABLE_API_KEYS = previousEnabled;
      if (previousKeys === undefined) delete process.env.API_KEYS;
      else process.env.API_KEYS = previousKeys;
      if (previousFile === undefined) delete process.env.API_KEYS_FILE;
      else process.env.API_KEYS_FILE = previousFile;
    }
  });

  it('loads a required bootstrap key from a mounted secret file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'oxscada-api-keys-'));
    const secretFile = join(directory, 'api-keys');
    const previousKeys = process.env.API_KEYS;
    const previousFile = process.env.API_KEYS_FILE;
    writeFileSync(secretFile, 'file-key:bootstrap:admin', { mode: 0o600 });
    delete process.env.API_KEYS;
    process.env.API_KEYS_FILE = secretFile;

    try {
      const manager = setupApiGateway(express(), {
        enableApiKeyAuth: true,
        apiKeys: new Map(),
      });
      expect(manager.getKeysMap().get('file-key')?.scopes).toEqual(['admin']);
    } finally {
      if (previousKeys === undefined) delete process.env.API_KEYS;
      else process.env.API_KEYS = previousKeys;
      if (previousFile === undefined) delete process.env.API_KEYS_FILE;
      else process.env.API_KEYS_FILE = previousFile;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('apiKeyMiddleware', () => {
  const record = {
    key: 'header-key',
    name: 'operator',
    scopes: ['operator'],
    createdAt: new Date(),
  };

  function invoke(
    originalUrl: string,
    headers: Record<string, string> = {},
    publicRoutes: string[] = [],
  ) {
    let statusCode = 200;
    let body: unknown;
    let nextCalled = false;
    const req = {
      originalUrl,
      headers,
      query: Object.fromEntries(new URL(originalUrl, 'http://local').searchParams),
    } as never;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as never;
    apiKeyMiddleware(
      new Map([[record.key, record]]),
      publicRoutes,
    )(req, res, () => {
      nextCalled = true;
    });
    return { statusCode, body, nextCalled, req };
  }

  it('matches public routes against the full original API path', () => {
    expect(invoke('/api/health', {}, ['/api/health'])).toMatchObject({
      statusCode: 200,
      nextCalled: true,
    });
  });

  it('does not treat a public-route prefix collision as public', () => {
    expect(invoke('/api/health-admin', {}, ['/api/health'])).toMatchObject({
      statusCode: 401,
      nextCalled: false,
    });
  });

  it('rejects query-string API keys', () => {
    expect(invoke('/api/private?api_key=header-key')).toMatchObject({
      statusCode: 401,
      nextCalled: false,
    });
  });

  it('accepts and attaches a valid X-API-Key header', () => {
    const result = invoke('/api/private', { 'x-api-key': 'header-key' });
    expect(result).toMatchObject({ statusCode: 200, nextCalled: true });
    expect(result.req).toMatchObject({
      apiKeyName: 'operator',
      apiKeyRecord: record,
    });
  });
});
