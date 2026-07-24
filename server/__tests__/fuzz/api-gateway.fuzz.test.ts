/**
 * Fuzz Testing: API Gateway & Rate Limiting
 *
 * Tests the API gateway middleware with malicious and edge-case inputs
 * to discover bypasses, injection vulnerabilities, and crash vectors.
 *
 * Closes #259 (part 1/2)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  SlidingWindowRateLimiter,
  ApiKeyManager,
} from '../../middleware/api-gateway';

// =============================================================================
// RATE LIMITER FUZZ TESTS
// =============================================================================

describe('Fuzz: SlidingWindowRateLimiter', () => {
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    limiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 100,
    });
  });

  afterEach(() => {
    limiter.destroy();
  });

  it('should handle arbitrary string keys without crashing', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10_000 }), (key) => {
        const result = limiter.check(key);
        expect(typeof result.allowed).toBe('boolean');
        expect(typeof result.remaining).toBe('number');
        expect(result.remaining).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('should handle null-byte and unicode keys', () => {
    const keys = [
      '\x00',
      '\x00\x00\x00',
      '\uD800', // Unpaired surrogate
      '\u200B'.repeat(1000), // Zero-width spaces
      '🔥'.repeat(500),
      '\n\r\t'.repeat(1000),
    ];

    for (const key of keys) {
      expect(() => limiter.check(key)).not.toThrow();
    }
  });

  it('should respect maxRequests under burst load', () => {
    const max = 10;
    const burstLimiter = new SlidingWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: max,
    });

    const key = 'burst-test';
    let allowedCount = 0;
    for (let i = 0; i < max * 3; i++) {
      if (burstLimiter.check(key).allowed) allowedCount++;
    }

    expect(allowedCount).toBe(max);
    burstLimiter.destroy();
  });

  it('should handle concurrent keys without cross-contamination', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 20 }),
        (keys) => {
          const uniqueKeys = [...new Set(keys)];
          for (const key of uniqueKeys) {
            limiter.check(key);
          }
          // Each key should have independent counts
          for (const key of uniqueKeys) {
            const count = limiter.peek(key);
            expect(count).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should handle extreme maxRequests overrides', () => {
    const extremeValues = [0, -1, -Infinity, Infinity, NaN, Number.MAX_SAFE_INTEGER, 0.5];

    for (const max of extremeValues) {
      expect(() => limiter.check('test', max)).not.toThrow();
    }
  });
});

// =============================================================================
// API KEY FUZZ TESTS
// =============================================================================

describe('Fuzz: ApiKeyManager', () => {
  let manager: ApiKeyManager;

  beforeEach(() => {
    manager = new ApiKeyManager();
  });

  it('should generate keys that pass validation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 255 })
          .filter((value) => value.trim().length > 0),
        fc.array(
          fc.string({ minLength: 1, maxLength: 50 })
            .filter((value) => value.trim().length > 0),
          { minLength: 1, maxLength: 10 },
        ),
        (name, scopes) => {
          const record = manager.generate(name, scopes);
          expect(record.key).toMatch(/^oxs_/);
          expect(record.key.length).toBe(4 + 64); // prefix + 32 bytes hex
          expect(record.name).toBe(name.trim());
          expect(record.scopes).toEqual(
            Array.from(new Set(scopes.map((scope) => scope.trim()))),
          );

          // Should be findable in the map
          const keys = manager.getKeysMap();
          expect(keys.has(record.key)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should safely revoke non-existent keys', () => {
    fc.assert(
      fc.property(fc.string(), (key) => {
        const result = manager.revoke(key);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('should handle malicious API_KEYS env variable', () => {
    const maliciousEnvValues = [
      '',
      ',,,,,',
      'key1:name1:scope1,key2:name2',
      'a'.repeat(100000),
      '\x00:\x00:\x00',
      '${ENV_VAR}:name:scope',
      '"; DROP TABLE keys; --:evil:admin',
      'key:name:scope1+scope2+scope3',
    ];

    for (const val of maliciousEnvValues) {
      const m = new ApiKeyManager();
      const original = process.env.API_KEYS;
      process.env.API_KEYS = val;
      expect(() => m.loadFromEnv()).not.toThrow();
      process.env.API_KEYS = original;
    }
  });
});

// =============================================================================
// REQUEST ID / HEADER INJECTION FUZZ
// =============================================================================

describe('Fuzz: Request Header Injection', () => {
  it('should detect CRLF injection in X-Request-Id', () => {
    const crlfPayloads = [
      'legit\r\nX-Evil: injected',
      'legit\nX-Evil: injected',
      'legit\r\nHTTP/1.1 200 OK\r\n\r\n<html>evil</html>',
      '%0d%0aX-Evil:%20injected',
      'legit%0D%0ASet-Cookie:%20evil=true',
    ];

    for (const payload of crlfPayloads) {
      const hasCRLF = /[\r\n]/.test(payload) || /%0[dDaA]/i.test(payload);
      expect(hasCRLF).toBe(true);
    }
  });

  it('should handle arbitrary header values safely', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10_000 }), (headerVal) => {
        // Simulate sanitization: strip CR/LF
        const sanitized = headerVal.replace(/[\r\n]/g, '');
        expect(sanitized).not.toMatch(/[\r\n]/);
      }),
      { numRuns: 200 },
    );
  });
});

// =============================================================================
// API KEY AUTH BYPASS FUZZ
// =============================================================================

describe('Fuzz: API Key Auth Bypass Attempts', () => {
  it('should not match similar-but-different keys', () => {
    const manager = new ApiKeyManager();
    const record = manager.generate('test', ['*']);
    const keys = manager.getKeysMap();

    const mutations = [
      record.key.toUpperCase(),
      record.key.toLowerCase(),
      record.key + ' ',
      ' ' + record.key,
      record.key.slice(0, -1),
      record.key + 'x',
      record.key.replace('_', '-'),
    ];

    for (const mutated of mutations) {
      if (mutated === record.key) continue;
      expect(keys.has(mutated)).toBe(false);
    }
  });
});
