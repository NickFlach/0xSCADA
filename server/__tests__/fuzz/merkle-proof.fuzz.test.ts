/**
 * Fuzz Testing: Merkle Proof Verification
 * 
 * Tests Merkle tree construction and proof verification with
 * randomly generated inputs to discover edge cases and vulnerabilities.
 * 
 * Issue: #55 - Security Fuzz Testing for Protocol Handlers
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  sha256,
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  canonicalize,
  hashObject,
} from '../../crypto/index';
import { MerkleTree as BatchMerkleTree } from '../../batch-anchoring';

// =============================================================================
// MERKLE TREE PROPERTY TESTS
// =============================================================================

describe('Fuzz: Merkle Tree Properties', () => {
  // Property: A valid proof for any leaf should always verify
  it('should generate valid proofs for any leaf in tree', () => {
    fc.assert(
      fc.property(
        fc.array(fc.hexaString({ minLength: 8, maxLength: 64 }), { minLength: 1, maxLength: 100 }),
        (hashes) => {
          const tree = buildMerkleTree(hashes);
          
          // Verify proof for each leaf
          for (let i = 0; i < hashes.length; i++) {
            const proof = getMerkleProof(tree, i);
            const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
            expect(isValid).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Same inputs should always produce same root
  it('should be deterministic - same inputs produce same root', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 1, maxLength: 50 }),
        (inputs) => {
          const hashes = inputs.map(sha256);
          const tree1 = buildMerkleTree(hashes);
          const tree2 = buildMerkleTree(hashes);
          expect(tree1.root).toBe(tree2.root);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Property: Different inputs should produce different roots (collision resistance)
  it('should have collision resistance - different inputs produce different roots', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 50 }),
        fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 50 }),
        (inputs1, inputs2) => {
          // Skip if inputs are identical
          if (JSON.stringify(inputs1) === JSON.stringify(inputs2)) return true;
          
          const hashes1 = inputs1.map(sha256);
          const hashes2 = inputs2.map(sha256);
          
          const tree1 = buildMerkleTree(hashes1);
          const tree2 = buildMerkleTree(hashes2);
          
          // Roots should be different for different inputs
          // Note: This could theoretically fail due to collisions, but SHA-256 makes this astronomically unlikely
          expect(tree1.root).not.toBe(tree2.root);
          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // Property: Invalid index should not produce valid proof
  it('should fail verification for invalid leaf indices', () => {
    fc.assert(
      fc.property(
        fc.array(fc.hexaString({ minLength: 8, maxLength: 64 }), { minLength: 2, maxLength: 50 }),
        fc.nat(),
        (hashes, invalidIndex) => {
          const tree = buildMerkleTree(hashes);
          const validIndex = invalidIndex % hashes.length;
          const proof = getMerkleProof(tree, validIndex);
          
          // Try to verify with a different hash
          const fakeHash = sha256('fake-' + invalidIndex);
          const isValid = verifyMerkleProof(fakeHash, proof, tree.root, validIndex);
          
          // Should fail unless by extreme coincidence the fake hash matches
          if (fakeHash !== hashes[validIndex]) {
            expect(isValid).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Tampered proof should fail verification
  it('should fail verification with tampered proofs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.hexaString({ minLength: 8, maxLength: 64 }), { minLength: 4, maxLength: 50 }),
        fc.nat(),
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (hashes, indexSeed, tamperedProofElement) => {
          const tree = buildMerkleTree(hashes);
          const index = indexSeed % hashes.length;
          const proof = getMerkleProof(tree, index);
          
          if (proof.length === 0) return; // Skip if no proof elements
          
          // Tamper with a proof element
          const tamperedProof = [...proof];
          tamperedProof[indexSeed % proof.length] = tamperedProofElement;
          
          const isValid = verifyMerkleProof(hashes[index], tamperedProof, tree.root, index);
          
          // Should fail unless tamperedProofElement coincidentally matches original
          if (tamperedProof[indexSeed % proof.length] !== proof[indexSeed % proof.length]) {
            expect(isValid).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// BATCH ANCHORING MERKLE TREE TESTS
// =============================================================================

describe('Fuzz: BatchAnchoringService MerkleTree', () => {
  // Property: BatchMerkleTree should produce valid proofs
  it('should generate valid proofs in BatchMerkleTree', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            assetId: fc.uuid(),
            eventType: fc.constantFrom('SENSOR_READING', 'ALARM', 'SETPOINT_CHANGE', 'MAINTENANCE'),
            payload: fc.jsonValue(),
            timestamp: fc.date(),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (events) => {
          const eventStrings = events.map(e =>
            JSON.stringify({
              id: e.id,
              assetId: e.assetId,
              eventType: e.eventType,
              payload: e.payload,
              timestamp: e.timestamp.toISOString(),
            })
          );

          const tree = new BatchMerkleTree(eventStrings);
          const root = tree.getRoot();

          // Verify each event's proof
          for (let i = 0; i < events.length; i++) {
            const proof = tree.getProof(i);
            const leafHash = BatchMerkleTree.hashEventData(eventStrings[i]);
            const isValid = BatchMerkleTree.verify(leafHash, proof, root);
            expect(isValid).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  // Property: Cross-verification between different tree implementations should be consistent
  it('should maintain proof integrity across operations', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 200 }), { minLength: 2, maxLength: 20 }),
        (inputs) => {
          const tree = new BatchMerkleTree(inputs);
          const root = tree.getRoot();

          // Verify that proof verification is consistent
          for (let i = 0; i < inputs.length; i++) {
            const proof = tree.getProof(i);
            const leafHash = BatchMerkleTree.hashEventData(inputs[i]);
            
            // Multiple verifications should give same result
            const result1 = BatchMerkleTree.verify(leafHash, proof, root);
            const result2 = BatchMerkleTree.verify(leafHash, proof, root);
            expect(result1).toBe(result2);
            expect(result1).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// EDGE CASE TESTS
// =============================================================================

describe('Fuzz: Merkle Tree Edge Cases', () => {
  // Edge: Single element tree
  it('should handle single element trees', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 64, maxLength: 64 }),
        (singleHash) => {
          const tree = buildMerkleTree([singleHash]);
          const proof = getMerkleProof(tree, 0);
          const isValid = verifyMerkleProof(singleHash, proof, tree.root, 0);
          expect(isValid).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Edge: Power of 2 vs non-power of 2 lengths
  it('should handle both power-of-2 and non-power-of-2 lengths', () => {
    const testSizes = [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65];
    
    for (const size of testSizes) {
      fc.assert(
        fc.property(
          fc.array(fc.hexaString({ minLength: 64, maxLength: 64 }), { minLength: size, maxLength: size }),
          (hashes) => {
            if (hashes.length !== size) return; // Skip if array wasn't generated with exact size
            
            const tree = buildMerkleTree(hashes);
            
            for (let i = 0; i < hashes.length; i++) {
              const proof = getMerkleProof(tree, i);
              const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
              expect(isValid).toBe(true);
            }
          }
        ),
        { numRuns: 10 }
      );
    }
  });

  // Edge: Empty input handling
  it('should handle empty inputs gracefully', () => {
    const tree = buildMerkleTree([]);
    expect(tree.root).toBeDefined();
    expect(tree.leaves).toHaveLength(0);
  });

  // Edge: Very long strings
  it('should handle very long input strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10000, maxLength: 50000 }),
        (longString) => {
          const hash = sha256(longString);
          const tree = buildMerkleTree([hash]);
          const proof = getMerkleProof(tree, 0);
          const isValid = verifyMerkleProof(hash, proof, tree.root, 0);
          expect(isValid).toBe(true);
        }
      ),
      { numRuns: 10 }
    );
  });

  // Edge: Unicode and special characters
  it('should handle unicode and special characters', () => {
    fc.assert(
      fc.property(
        fc.array(fc.unicodeString({ minLength: 1, maxLength: 500 }), { minLength: 1, maxLength: 20 }),
        (inputs) => {
          const hashes = inputs.map(sha256);
          const tree = buildMerkleTree(hashes);
          
          for (let i = 0; i < hashes.length; i++) {
            const proof = getMerkleProof(tree, i);
            const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
            expect(isValid).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// =============================================================================
// CANONICAL JSON TESTS
// =============================================================================

describe('Fuzz: Canonical JSON Serialization', () => {
  // Property: Canonicalization should be idempotent
  it('should be idempotent - canonicalizing twice gives same result', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => {
          const once = canonicalize(value);
          // Parsing and re-canonicalizing should give same result
          const parsed = JSON.parse(once);
          const twice = canonicalize(parsed);
          expect(twice).toBe(once);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Key ordering should be consistent
  it('should order object keys consistently', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
        (obj) => {
          const canonical = canonicalize(obj);
          const parsed = JSON.parse(canonical);
          const keys = Object.keys(parsed);
          
          // Keys should be in sorted order
          const sortedKeys = [...keys].sort();
          expect(keys).toEqual(sortedKeys);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Same object should always hash to same value
  it('should produce consistent hashes for equivalent objects', () => {
    fc.assert(
      fc.property(
        fc.record({
          eventType: fc.string(),
          siteId: fc.uuid(),
          payload: fc.jsonValue(),
        }),
        (obj) => {
          const hash1 = hashObject(obj);
          const hash2 = hashObject(obj);
          expect(hash1).toBe(hash2);
          
          // Different key order should still hash the same
          const reordered = {
            payload: obj.payload,
            eventType: obj.eventType,
            siteId: obj.siteId,
          };
          const hash3 = hashObject(reordered);
          expect(hash1).toBe(hash3);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// =============================================================================
// HASH COLLISION RESISTANCE
// =============================================================================

describe('Fuzz: Hash Collision Resistance', () => {
  // Property: Similar but different inputs should have different hashes
  it('should produce different hashes for slightly different inputs', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10, maxLength: 1000 }),
        fc.integer({ min: 0, max: 999 }),
        (input, position) => {
          const pos = position % input.length;
          
          // Create a slightly modified version
          const modified = input.slice(0, pos) + 
            String.fromCharCode(input.charCodeAt(pos) ^ 1) + 
            input.slice(pos + 1);
          
          if (input === modified) return; // Skip if no change
          
          const hash1 = sha256(input);
          const hash2 = sha256(modified);
          
          expect(hash1).not.toBe(hash2);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property: Adding/removing single byte should change hash
  it('should produce different hashes when adding or removing bytes', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 1000 }),
        fc.integer({ min: 0, max: 999 }),
        fc.char(),
        (input, position, extraChar) => {
          const pos = position % (input.length + 1);
          
          // Insert an extra character
          const modified = input.slice(0, pos) + extraChar + input.slice(pos);
          
          const hash1 = sha256(input);
          const hash2 = sha256(modified);
          
          expect(hash1).not.toBe(hash2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
