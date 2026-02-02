/**
 * Fuzz Testing: Cryptographic Functions
 * 
 * Tests cryptographic primitives with random and edge-case inputs
 * to ensure correct behavior and resistance to attacks.
 * 
 * Issue: #55 - Security Fuzz Testing for Protocol Handlers
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  sha256,
  canonicalize,
  hashObject,
  hashObjectHex,
  computeEventHash,
  signWithHmac,
  verifyHmacSignature,
  signEvent,
  verifyEventSignature,
  generateRandomKey,
  generateDeterministicKey,
  toBytes32,
  isValidEthereumAddress,
  type EventHashInput,
} from '../../crypto/index';

// =============================================================================
// SHA-256 HASH FUNCTION TESTS
// =============================================================================

describe('Fuzz: SHA-256 Properties', () => {
  // Property: Output is always 64 hex characters
  it('should always produce 64-character hex output', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 10000 }),
        (input) => {
          const hash = sha256(input);
          expect(hash).toMatch(/^[a-f0-9]{64}$/);
        }
      ),
      { numRuns: 1000 }
    );
  });

  // Property: Same input always produces same output (deterministic)
  it('should be deterministic', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 5000 }),
        (input) => {
          const hash1 = sha256(input);
          const hash2 = sha256(input);
          expect(hash1).toBe(hash2);
        }
      ),
      { numRuns: 500 }
    );
  });

  // Property: Different inputs should (almost always) produce different outputs
  it('should produce different outputs for different inputs (collision resistance)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.string({ minLength: 1, maxLength: 1000 }),
        (input1, input2) => {
          if (input1 === input2) return; // Skip identical inputs
          
          const hash1 = sha256(input1);
          const hash2 = sha256(input2);
          
          // This should virtually always be true for SHA-256
          expect(hash1).not.toBe(hash2);
        }
      ),
      { numRuns: 500 }
    );
  });

  // Property: Avalanche effect - small changes should dramatically change output
  it('should exhibit avalanche effect', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10, maxLength: 1000 }),
        fc.integer({ min: 0, max: 999 }),
        (input, position) => {
          const pos = position % input.length;
          
          // Flip one bit in one character
          const modified = input.slice(0, pos) + 
            String.fromCharCode(input.charCodeAt(pos) ^ 1) + 
            input.slice(pos + 1);
          
          if (input === modified) return;
          
          const hash1 = sha256(input);
          const hash2 = sha256(modified);
          
          // Count differing bits (approximate via different hex chars)
          let differences = 0;
          for (let i = 0; i < 64; i++) {
            if (hash1[i] !== hash2[i]) differences++;
          }
          
          // Should have significant differences (avalanche effect)
          // Statistically, about 50% of bits should differ
          expect(differences).toBeGreaterThan(10);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Test: Binary data handling
  it('should handle binary data (Buffer)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 1000 }),
        (bytes) => {
          const buffer = Buffer.from(bytes);
          const hash = sha256(buffer);
          expect(hash).toMatch(/^[a-f0-9]{64}$/);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// CANONICALIZATION TESTS
// =============================================================================

describe('Fuzz: JSON Canonicalization', () => {
  // Property: Output is valid JSON
  it('should produce valid JSON output', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => {
          const canonical = canonicalize(value);
          expect(() => JSON.parse(canonical)).not.toThrow();
        }
      ),
      { numRuns: 500 }
    );
  });

  // Property: Canonicalization is idempotent
  it('should be idempotent', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => {
          const once = canonicalize(value);
          const twice = canonicalize(JSON.parse(once));
          expect(twice).toBe(once);
        }
      ),
      { numRuns: 500 }
    );
  });

  // Property: Object keys are sorted
  it('should sort object keys alphabetically', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue(), { minKeys: 1, maxKeys: 20 }),
        (obj) => {
          const canonical = canonicalize(obj);
          const parsed = JSON.parse(canonical);
          const keys = Object.keys(parsed);
          
          const sortedKeys = [...keys].sort();
          expect(keys).toEqual(sortedKeys);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Nested object keys are sorted
  it('should sort nested object keys', () => {
    fc.assert(
      fc.property(
        fc.record({
          z: fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer()),
          a: fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.integer()),
          m: fc.constant({ c: 1, b: 2, a: 3 }),
        }),
        (obj) => {
          const canonical = canonicalize(obj);
          const parsed = JSON.parse(canonical);
          
          // Top level keys should be sorted
          expect(Object.keys(parsed)).toEqual(['a', 'm', 'z']);
          
          // Nested keys should be sorted
          expect(Object.keys(parsed.m)).toEqual(['a', 'b', 'c']);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Test: Undefined values are omitted
  it('should omit undefined values', () => {
    const objWithUndefined = {
      a: 1,
      b: undefined,
      c: 3,
    };
    
    const canonical = canonicalize(objWithUndefined);
    const parsed = JSON.parse(canonical);
    
    expect(parsed).toEqual({ a: 1, c: 3 });
    expect('b' in parsed).toBe(false);
  });
});

// =============================================================================
// HMAC SIGNING TESTS
// =============================================================================

describe('Fuzz: HMAC Signing', () => {
  // Property: Same key and data produces same signature
  it('should be deterministic', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, key) => {
          const sig1 = signWithHmac(data, key);
          const sig2 = signWithHmac(data, key);
          expect(sig1).toBe(sig2);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Verification works for valid signatures
  it('should verify valid signatures', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, key) => {
          const signature = signWithHmac(data, key);
          expect(verifyHmacSignature(data, signature, key)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Different keys produce different signatures
  it('should produce different signatures with different keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, key1, key2) => {
          if (key1 === key2) return;
          
          const sig1 = signWithHmac(data, key1);
          const sig2 = signWithHmac(data, key2);
          
          expect(sig1).not.toBe(sig2);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Wrong key should not verify
  it('should fail verification with wrong key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, correctKey, wrongKey) => {
          if (correctKey === wrongKey) return;
          
          const signature = signWithHmac(data, correctKey);
          expect(verifyHmacSignature(data, signature, wrongKey)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Modified data should not verify
  it('should fail verification with modified data', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, key) => {
          const signature = signWithHmac(data, key);
          const modifiedData = data + 'x';
          
          expect(verifyHmacSignature(modifiedData, signature, key)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Modified signature should not verify
  it('should fail verification with modified signature', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (data, key) => {
          const signature = signWithHmac(data, key);
          
          // Modify one character of the signature
          const modifiedSig = signature.slice(0, -1) + 
            (signature[signature.length - 1] === '0' ? '1' : '0');
          
          if (modifiedSig === signature) return;
          
          expect(verifyHmacSignature(data, modifiedSig, key)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// =============================================================================
// EVENT SIGNING TESTS
// =============================================================================

describe('Fuzz: Event Signing', () => {
  // Property: Event signatures are valid
  it('should create valid event signatures', () => {
    fc.assert(
      fc.property(
        fc.record({
          eventType: fc.constantFrom('SENSOR_READING', 'ALARM', 'SETPOINT_CHANGE'),
          siteId: fc.uuid(),
          assetId: fc.option(fc.uuid(), { nil: undefined }),
          sourceTimestamp: fc.date().map(d => d.toISOString()),
          originType: fc.constantFrom('GATEWAY', 'OPERATOR', 'SYSTEM'),
          originId: fc.uuid(),
          payload: fc.jsonValue(),
        }),
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (event, key) => {
          const signature = signEvent(event as EventHashInput, key);
          expect(verifyEventSignature(event as EventHashInput, signature, key)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Different events have different signatures
  it('should produce different signatures for different events', () => {
    fc.assert(
      fc.property(
        fc.record({
          eventType: fc.string(),
          siteId: fc.uuid(),
          sourceTimestamp: fc.date().map(d => d.toISOString()),
          originType: fc.string(),
          originId: fc.uuid(),
          payload: fc.jsonValue(),
        }),
        fc.record({
          eventType: fc.string(),
          siteId: fc.uuid(),
          sourceTimestamp: fc.date().map(d => d.toISOString()),
          originType: fc.string(),
          originId: fc.uuid(),
          payload: fc.jsonValue(),
        }),
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (event1, event2, key) => {
          const hash1 = computeEventHash(event1 as EventHashInput);
          const hash2 = computeEventHash(event2 as EventHashInput);
          
          if (hash1 === hash2) return; // Events are effectively identical
          
          const sig1 = signEvent(event1 as EventHashInput, key);
          const sig2 = signEvent(event2 as EventHashInput, key);
          
          expect(sig1).not.toBe(sig2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// KEY GENERATION TESTS
// =============================================================================

describe('Fuzz: Key Generation', () => {
  // Test: Random keys are unique
  it('should generate unique random keys', () => {
    const keys = new Set<string>();
    
    for (let i = 0; i < 100; i++) {
      const key = generateRandomKey();
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  // Property: Deterministic keys are consistent
  it('should generate consistent deterministic keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        (seed) => {
          const key1 = generateDeterministicKey(seed);
          const key2 = generateDeterministicKey(seed);
          expect(key1).toBe(key2);
          expect(key1).toMatch(/^[a-f0-9]{64}$/);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Different seeds produce different keys
  it('should produce different keys for different seeds', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.string({ minLength: 1, maxLength: 1000 }),
        (seed1, seed2) => {
          if (seed1 === seed2) return;
          
          const key1 = generateDeterministicKey(seed1);
          const key2 = generateDeterministicKey(seed2);
          expect(key1).not.toBe(key2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// ETHEREUM UTILITIES TESTS
// =============================================================================

describe('Fuzz: Ethereum Utilities', () => {
  // Property: toBytes32 always produces 66-character hex string
  it('should produce valid bytes32 format', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 1, maxLength: 64 }),
        (hash) => {
          const bytes32 = toBytes32(hash);
          expect(bytes32).toMatch(/^0x[0-9a-fA-F]{64}$/);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: toBytes32 handles 0x prefix correctly
  it('should handle 0x prefix correctly', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (hash) => {
          const withPrefix = '0x' + hash;
          const withoutPrefix = hash;
          
          expect(toBytes32(withPrefix)).toBe(toBytes32(withoutPrefix));
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Valid Ethereum addresses pass validation
  it('should validate valid Ethereum addresses', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 40, maxLength: 40 }),
        (hex) => {
          const address = '0x' + hex;
          expect(isValidEthereumAddress(address)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: Invalid Ethereum addresses fail validation
  it('should reject invalid Ethereum addresses', () => {
    const invalidAddresses = [
      '', // Empty
      '0x', // Too short
      '0x' + '1'.repeat(39), // 39 chars
      '0x' + '1'.repeat(41), // 41 chars
      '1'.repeat(40), // Missing prefix
      '0x' + 'g'.repeat(40), // Invalid hex
      '0x' + ' '.repeat(40), // Spaces
      'hello world', // Random string
      '0X' + '1'.repeat(40), // Wrong case prefix
    ];

    for (const addr of invalidAddresses) {
      expect(isValidEthereumAddress(addr)).toBe(false);
    }
  });
});

// =============================================================================
// HASH CONSISTENCY TESTS
// =============================================================================

describe('Fuzz: Hash Consistency', () => {
  // Property: hashObject and hashObjectHex should be consistent
  it('should maintain consistency between hashObject and hashObjectHex', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => {
          const hash = hashObject(value);
          const hashHex = hashObjectHex(value);
          expect(hashHex).toBe('0x' + hash);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Property: computeEventHash should be consistent
  it('should compute consistent event hashes', () => {
    fc.assert(
      fc.property(
        fc.record({
          eventType: fc.string(),
          siteId: fc.uuid(),
          assetId: fc.option(fc.uuid(), { nil: undefined }),
          sourceTimestamp: fc.date().map(d => d.toISOString()),
          originType: fc.string(),
          originId: fc.uuid(),
          payload: fc.jsonValue(),
        }),
        (event) => {
          const hash1 = computeEventHash(event as EventHashInput);
          const hash2 = computeEventHash(event as EventHashInput);
          expect(hash1).toBe(hash2);
        }
      ),
      { numRuns: 200 }
    );
  });
});
