import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  sha256,
  hashObject,
  hashObjectHex,
  computeEventHash,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  generateRandomKey,
  generateDeterministicKey,
  signWithHmac,
  verifyHmacSignature,
  signEvent,
  verifyEventSignature,
  toBytes32,
  isValidEthereumAddress,
  type EventHashInput,
} from '../crypto/index';

// ============================================================================
// UNIT TESTS: Canonical JSON Serialization
// ============================================================================

describe('Canonical JSON Serialization', () => {
  describe('canonicalize', () => {
    it('should sort object keys alphabetically', () => {
      const obj = { z: 1, a: 2, m: 3 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    it('should handle nested objects with sorted keys', () => {
      const obj = { outer: { z: 1, a: 2 }, inner: 3 };
      const result = canonicalize(obj);
      expect(result).toBe('{"inner":3,"outer":{"a":2,"z":1}}');
    });

    it('should preserve array order', () => {
      const obj = { arr: [3, 1, 2] };
      const result = canonicalize(obj);
      expect(result).toBe('{"arr":[3,1,2]}');
    });

    it('should omit undefined values', () => {
      const obj = { a: 1, b: undefined, c: 3 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":1,"c":3}');
    });

    it('should handle null values', () => {
      const obj = { a: null, b: 1 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":null,"b":1}');
    });

    it('should handle empty objects', () => {
      expect(canonicalize({})).toBe('{}');
    });

    it('should handle primitives', () => {
      expect(canonicalize('string')).toBe('"string"');
      expect(canonicalize(42)).toBe('42');
      expect(canonicalize(true)).toBe('true');
      expect(canonicalize(null)).toBe('null');
    });
  });
});

// ============================================================================
// UNIT TESTS: Hashing Functions
// ============================================================================

describe('Hashing Functions', () => {
  describe('sha256', () => {
    it('should compute consistent hash for same input', () => {
      const hash1 = sha256('test data');
      const hash2 = sha256('test data');
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different input', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should return 64 character hex string', () => {
      const hash = sha256('test');
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });

    it('should handle empty string', () => {
      const hash = sha256('');
      expect(hash).toHaveLength(64);
    });

    it('should handle Buffer input', () => {
      const buffer = Buffer.from('test data');
      const hash = sha256(buffer);
      expect(hash).toHaveLength(64);
    });
  });

  describe('hashObject', () => {
    it('should produce consistent hash for same object', () => {
      const obj = { a: 1, b: 2 };
      const hash1 = hashObject(obj);
      const hash2 = hashObject(obj);
      expect(hash1).toBe(hash2);
    });

    it('should produce same hash regardless of key order', () => {
      const obj1 = { a: 1, b: 2 };
      const obj2 = { b: 2, a: 1 };
      expect(hashObject(obj1)).toBe(hashObject(obj2));
    });

    it('should produce different hash for different objects', () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 2 };
      expect(hashObject(obj1)).not.toBe(hashObject(obj2));
    });
  });

  describe('hashObjectHex', () => {
    it('should return hash with 0x prefix', () => {
      const hash = hashObjectHex({ test: 'data' });
      expect(hash.startsWith('0x')).toBe(true);
      expect(hash).toHaveLength(66); // 0x + 64 hex chars
    });
  });
});

// ============================================================================
// UNIT TESTS: Event Hashing
// ============================================================================

describe('Event Hashing', () => {
  describe('computeEventHash', () => {
    const baseEvent: EventHashInput = {
      eventType: 'TELEMETRY',
      siteId: 'site-001',
      assetId: 'asset-001',
      sourceTimestamp: '2026-01-11T12:00:00Z',
      originType: 'GATEWAY',
      originId: 'gw-001',
      payload: { temperature: 25.5 },
    };

    it('should compute consistent hash for same event', () => {
      const hash1 = computeEventHash(baseEvent);
      const hash2 = computeEventHash(baseEvent);
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different events', () => {
      const event2 = { ...baseEvent, eventType: 'ALARM' };
      expect(computeEventHash(baseEvent)).not.toBe(computeEventHash(event2));
    });

    it('should handle events without assetId', () => {
      const eventNoAsset: EventHashInput = {
        ...baseEvent,
        assetId: undefined,
      };
      const hash = computeEventHash(eventNoAsset);
      expect(hash).toHaveLength(64);
    });

    it('should return 64 character hex hash', () => {
      const hash = computeEventHash(baseEvent);
      expect(hash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    });
  });
});

// ============================================================================
// UNIT TESTS: Merkle Tree
// ============================================================================

describe('Merkle Tree', () => {
  describe('buildMerkleTree', () => {
    it('should handle empty input', () => {
      const tree = buildMerkleTree([]);
      expect(tree.root).toBeDefined();
      expect(tree.leaves).toHaveLength(0);
    });

    it('should handle single hash', () => {
      const hash = sha256('test');
      const tree = buildMerkleTree([hash]);
      expect(tree.root).toBe(hash);
      expect(tree.leaves).toHaveLength(1);
    });

    it('should build tree from two hashes', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);

      expect(tree.root).toBeDefined();
      expect(tree.leaves).toHaveLength(2);
      expect(tree.layers).toHaveLength(2);
      expect(tree.root).toBe(sha256(hash1 + hash2));
    });

    it('should build tree from multiple hashes', () => {
      const hashes = [
        sha256('event1'),
        sha256('event2'),
        sha256('event3'),
        sha256('event4'),
      ];
      const tree = buildMerkleTree(hashes);

      expect(tree.root).toBeDefined();
      expect(tree.leaves).toHaveLength(4);
      expect(tree.layers.length).toBeGreaterThan(1);
    });

    it('should pad to power of 2', () => {
      const hashes = [sha256('1'), sha256('2'), sha256('3')];
      const tree = buildMerkleTree(hashes);

      // Original leaves should remain unchanged
      expect(tree.leaves).toHaveLength(3);
      // But internal layer should be padded
      expect(tree.layers[0].length).toBe(4);
    });

    it('should produce deterministic root', () => {
      const hashes = [sha256('a'), sha256('b'), sha256('c')];
      const tree1 = buildMerkleTree(hashes);
      const tree2 = buildMerkleTree(hashes);
      expect(tree1.root).toBe(tree2.root);
    });
  });

  describe('getMerkleProof', () => {
    it('should return empty proof for single leaf tree', () => {
      const tree = buildMerkleTree([sha256('only')]);
      const proof = getMerkleProof(tree, 0);
      expect(proof).toHaveLength(0);
    });

    it('should return valid proof for two leaf tree', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);

      const proof0 = getMerkleProof(tree, 0);
      expect(proof0).toHaveLength(1);
      expect(proof0[0]).toBe(hash2);

      const proof1 = getMerkleProof(tree, 1);
      expect(proof1).toHaveLength(1);
      expect(proof1[0]).toBe(hash1);
    });

    it('should return proof with correct length', () => {
      const hashes = [
        sha256('1'),
        sha256('2'),
        sha256('3'),
        sha256('4'),
      ];
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      // For 4 leaves, proof should have 2 elements (log2(4))
      expect(proof).toHaveLength(2);
    });
  });

  describe('verifyMerkleProof', () => {
    it('should verify valid proof for first leaf', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);
      const proof = getMerkleProof(tree, 0);

      const isValid = verifyMerkleProof(hash1, proof, tree.root, 0);
      expect(isValid).toBe(true);
    });

    it('should verify valid proof for second leaf', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);
      const proof = getMerkleProof(tree, 1);

      const isValid = verifyMerkleProof(hash2, proof, tree.root, 1);
      expect(isValid).toBe(true);
    });

    it('should verify proofs for larger tree', () => {
      const hashes = [
        sha256('event1'),
        sha256('event2'),
        sha256('event3'),
        sha256('event4'),
      ];
      const tree = buildMerkleTree(hashes);

      for (let i = 0; i < hashes.length; i++) {
        const proof = getMerkleProof(tree, i);
        const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
        expect(isValid).toBe(true);
      }
    });

    it('should reject invalid proof', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);
      const proof = getMerkleProof(tree, 0);

      // Try to verify wrong leaf with correct proof
      const isValid = verifyMerkleProof(hash2, proof, tree.root, 0);
      expect(isValid).toBe(false);
    });

    it('should reject tampered proof', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);
      const proof = getMerkleProof(tree, 0);

      // Tamper with proof
      const tamperedProof = [sha256('tampered')];
      const isValid = verifyMerkleProof(hash1, tamperedProof, tree.root, 0);
      expect(isValid).toBe(false);
    });

    it('should reject wrong root', () => {
      const hash1 = sha256('test1');
      const hash2 = sha256('test2');
      const tree = buildMerkleTree([hash1, hash2]);
      const proof = getMerkleProof(tree, 0);

      const isValid = verifyMerkleProof(hash1, proof, sha256('wrong'), 0);
      expect(isValid).toBe(false);
    });
  });
});

// ============================================================================
// UNIT TESTS: Key Generation
// ============================================================================

describe('Key Generation', () => {
  describe('generateRandomKey', () => {
    it('should generate 64 character hex key', () => {
      const key = generateRandomKey();
      expect(key).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(key)).toBe(true);
    });

    it('should generate unique keys', () => {
      const key1 = generateRandomKey();
      const key2 = generateRandomKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe('generateDeterministicKey', () => {
    it('should generate consistent key from same seed', () => {
      const key1 = generateDeterministicKey('seed123');
      const key2 = generateDeterministicKey('seed123');
      expect(key1).toBe(key2);
    });

    it('should generate different keys from different seeds', () => {
      const key1 = generateDeterministicKey('seed1');
      const key2 = generateDeterministicKey('seed2');
      expect(key1).not.toBe(key2);
    });

    it('should return 64 character hex key', () => {
      const key = generateDeterministicKey('test');
      expect(key).toHaveLength(64);
    });
  });
});

// ============================================================================
// UNIT TESTS: HMAC Signing
// ============================================================================

describe('HMAC Signing', () => {
  const testKey = generateDeterministicKey('test-key');

  describe('signWithHmac', () => {
    it('should produce consistent signature', () => {
      const sig1 = signWithHmac('data', testKey);
      const sig2 = signWithHmac('data', testKey);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signature for different data', () => {
      const sig1 = signWithHmac('data1', testKey);
      const sig2 = signWithHmac('data2', testKey);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signature for different keys', () => {
      const key2 = generateDeterministicKey('other-key');
      const sig1 = signWithHmac('data', testKey);
      const sig2 = signWithHmac('data', key2);
      expect(sig1).not.toBe(sig2);
    });

    it('should return 64 character hex signature', () => {
      const sig = signWithHmac('data', testKey);
      expect(sig).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(sig)).toBe(true);
    });
  });

  describe('verifyHmacSignature', () => {
    it('should verify valid signature', () => {
      const sig = signWithHmac('data', testKey);
      const isValid = verifyHmacSignature('data', sig, testKey);
      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', () => {
      const isValid = verifyHmacSignature('data', 'invalid', testKey);
      expect(isValid).toBe(false);
    });

    it('should reject wrong data', () => {
      const sig = signWithHmac('data', testKey);
      const isValid = verifyHmacSignature('wrong', sig, testKey);
      expect(isValid).toBe(false);
    });

    it('should reject wrong key', () => {
      const key2 = generateDeterministicKey('other-key');
      const sig = signWithHmac('data', testKey);
      const isValid = verifyHmacSignature('data', sig, key2);
      expect(isValid).toBe(false);
    });
  });

  describe('signEvent and verifyEventSignature', () => {
    const testEvent: EventHashInput = {
      eventType: 'ALARM',
      siteId: 'site-001',
      sourceTimestamp: '2026-01-11T12:00:00Z',
      originType: 'GATEWAY',
      originId: 'gw-001',
      payload: { alarmCode: 'HIGH_TEMP' },
    };

    it('should sign and verify event', () => {
      const signature = signEvent(testEvent, testKey);
      const isValid = verifyEventSignature(testEvent, signature, testKey);
      expect(isValid).toBe(true);
    });

    it('should reject modified event', () => {
      const signature = signEvent(testEvent, testKey);
      const modifiedEvent = { ...testEvent, eventType: 'TELEMETRY' };
      const isValid = verifyEventSignature(modifiedEvent, signature, testKey);
      expect(isValid).toBe(false);
    });

    it('should reject wrong key', () => {
      const key2 = generateDeterministicKey('other-key');
      const signature = signEvent(testEvent, testKey);
      const isValid = verifyEventSignature(testEvent, signature, key2);
      expect(isValid).toBe(false);
    });
  });
});

// ============================================================================
// UNIT TESTS: Ethereum Utilities
// ============================================================================

describe('Ethereum Utilities', () => {
  describe('toBytes32', () => {
    it('should pad short hash to 64 characters', () => {
      const result = toBytes32('abc');
      expect(result.startsWith('0x')).toBe(true);
      expect(result).toHaveLength(66);
    });

    it('should handle hash with 0x prefix', () => {
      const hash = '0x' + 'a'.repeat(64);
      const result = toBytes32(hash);
      expect(result).toBe(hash);
    });

    it('should handle hash without 0x prefix', () => {
      const hash = 'a'.repeat(64);
      const result = toBytes32(hash);
      expect(result).toBe('0x' + hash);
    });

    it('should left-pad shorter hashes with zeros', () => {
      const result = toBytes32('abc');
      expect(result).toBe('0x' + '0'.repeat(61) + 'abc');
    });
  });

  describe('isValidEthereumAddress', () => {
    it('should validate correct Ethereum address', () => {
      const validAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f5A8F2';
      expect(isValidEthereumAddress(validAddress)).toBe(true);
    });

    it('should validate lowercase address', () => {
      const address = '0x' + 'a'.repeat(40);
      expect(isValidEthereumAddress(address)).toBe(true);
    });

    it('should validate uppercase address', () => {
      const address = '0x' + 'A'.repeat(40);
      expect(isValidEthereumAddress(address)).toBe(true);
    });

    it('should reject address without 0x prefix', () => {
      const address = 'a'.repeat(40);
      expect(isValidEthereumAddress(address)).toBe(false);
    });

    it('should reject short address', () => {
      const address = '0x' + 'a'.repeat(39);
      expect(isValidEthereumAddress(address)).toBe(false);
    });

    it('should reject long address', () => {
      const address = '0x' + 'a'.repeat(41);
      expect(isValidEthereumAddress(address)).toBe(false);
    });

    it('should reject address with invalid characters', () => {
      const address = '0x' + 'g'.repeat(40);
      expect(isValidEthereumAddress(address)).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidEthereumAddress('')).toBe(false);
    });
  });
});
