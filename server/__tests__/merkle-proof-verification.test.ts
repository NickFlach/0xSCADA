/**
 * Merkle Proof Verification Test Suite
 * 
 * Issue #14: [Track Q2.1] Create Merkle Proof Verification Test Suite
 * 
 * Comprehensive tests for Merkle tree construction and proof verification:
 * - Various tree sizes (1, 2, 4, 8, 100, 1000 events)
 * - Proof generation and verification
 * - Edge cases (single event, power-of-2, non-power-of-2)
 * - Property-based tests for tree invariants
 */

import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  sha256,
  type MerkleTree,
} from "../crypto";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate deterministic test hashes
 */
function generateHashes(count: number, prefix: string = "event"): string[] {
  return Array.from({ length: count }, (_, i) => sha256(`${prefix}-${i}`));
}

/**
 * Check if a number is a power of 2
 */
function isPowerOf2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Get the next power of 2 >= n
 */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(n)));
}

// =============================================================================
// MERKLE TREE CONSTRUCTION TESTS
// =============================================================================

describe("Merkle Tree Construction", () => {
  describe("Tree with various sizes", () => {
    it("should handle empty tree", () => {
      const tree = buildMerkleTree([]);
      expect(tree.root).toBeDefined();
      expect(tree.leaves).toHaveLength(0);
      expect(tree.layers).toHaveLength(1);
    });

    it("should build tree with 1 event", () => {
      const hashes = generateHashes(1);
      const tree = buildMerkleTree(hashes);

      expect(tree.root).toBe(hashes[0]);
      expect(tree.leaves).toHaveLength(1);
      expect(tree.layers.length).toBeGreaterThanOrEqual(1);
    });

    it("should build tree with 2 events", () => {
      const hashes = generateHashes(2);
      const tree = buildMerkleTree(hashes);

      expect(tree.leaves).toHaveLength(2);
      expect(tree.root).toBe(sha256(hashes[0] + hashes[1]));
    });

    it("should build tree with 4 events", () => {
      const hashes = generateHashes(4);
      const tree = buildMerkleTree(hashes);

      expect(tree.leaves).toHaveLength(4);
      // Verify tree structure: 4 leaves -> 2 nodes -> 1 root
      expect(tree.layers).toHaveLength(3);
      expect(tree.layers[0]).toHaveLength(4);
      expect(tree.layers[1]).toHaveLength(2);
      expect(tree.layers[2]).toHaveLength(1);
    });

    it("should build tree with 8 events", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);

      expect(tree.leaves).toHaveLength(8);
      // 8 -> 4 -> 2 -> 1
      expect(tree.layers).toHaveLength(4);
    });

    it("should build tree with 100 events", () => {
      const hashes = generateHashes(100);
      const tree = buildMerkleTree(hashes);

      expect(tree.leaves).toHaveLength(100);
      expect(tree.root).toBeDefined();
      expect(tree.root.length).toBe(64); // SHA-256 hex
    });

    it("should build tree with 1000 events", () => {
      const hashes = generateHashes(1000);
      const tree = buildMerkleTree(hashes);

      expect(tree.leaves).toHaveLength(1000);
      expect(tree.root).toBeDefined();
      expect(tree.root.length).toBe(64);
    });
  });

  describe("Power of 2 edge cases", () => {
    const sizes = [1, 2, 4, 8, 16, 32, 64, 128, 256];

    sizes.forEach((size) => {
      it(`should correctly build tree with ${size} events (power of 2)`, () => {
        const hashes = generateHashes(size);
        const tree = buildMerkleTree(hashes);

        expect(tree.leaves).toHaveLength(size);
        expect(tree.root).toBeDefined();
        
        // Verify layer count: log2(size) + 1 layers
        const expectedLayers = size === 1 ? 1 : Math.log2(size) + 1;
        expect(tree.layers.length).toBe(expectedLayers);
      });
    });
  });

  describe("Non-power of 2 edge cases", () => {
    const sizes = [3, 5, 7, 9, 15, 17, 31, 33, 63, 65, 99, 127, 129, 255, 257];

    sizes.forEach((size) => {
      it(`should correctly build tree with ${size} events (non-power of 2)`, () => {
        const hashes = generateHashes(size);
        const tree = buildMerkleTree(hashes);

        expect(tree.leaves).toHaveLength(size);
        expect(tree.root).toBeDefined();
        expect(tree.root.length).toBe(64);
      });
    });
  });

  describe("Tree structure invariants", () => {
    it("should produce consistent root for same inputs", () => {
      const hashes = generateHashes(10);
      const tree1 = buildMerkleTree(hashes);
      const tree2 = buildMerkleTree(hashes);

      expect(tree1.root).toBe(tree2.root);
    });

    it("should produce different roots for different inputs", () => {
      const hashes1 = generateHashes(10, "prefix1");
      const hashes2 = generateHashes(10, "prefix2");
      
      const tree1 = buildMerkleTree(hashes1);
      const tree2 = buildMerkleTree(hashes2);

      expect(tree1.root).not.toBe(tree2.root);
    });

    it("should change root when any leaf changes", () => {
      const hashes = generateHashes(8);
      const tree1 = buildMerkleTree(hashes);

      // Modify one hash
      const modifiedHashes = [...hashes];
      modifiedHashes[3] = sha256("modified");
      const tree2 = buildMerkleTree(modifiedHashes);

      expect(tree1.root).not.toBe(tree2.root);
    });

    it("should have all layers with proper sizes", () => {
      const hashes = generateHashes(16);
      const tree = buildMerkleTree(hashes);

      // Verify each layer halves in size
      for (let i = 1; i < tree.layers.length; i++) {
        expect(tree.layers[i].length).toBeLessThanOrEqual(
          Math.ceil(tree.layers[i - 1].length / 2)
        );
      }

      // Final layer should have exactly one element (root)
      expect(tree.layers[tree.layers.length - 1]).toHaveLength(1);
    });
  });
});

// =============================================================================
// MERKLE PROOF GENERATION TESTS
// =============================================================================

describe("Merkle Proof Generation", () => {
  describe("Proof generation for various tree sizes", () => {
    const sizes = [1, 2, 4, 8, 16, 32, 100];

    sizes.forEach((size) => {
      it(`should generate valid proofs for tree with ${size} events`, () => {
        const hashes = generateHashes(size);
        const tree = buildMerkleTree(hashes);

        // Generate proof for each leaf
        for (let i = 0; i < hashes.length; i++) {
          const proof = getMerkleProof(tree, i);
          expect(Array.isArray(proof)).toBe(true);
          
          // Proof length should be approximately log2(paddedSize)
          const expectedMaxProofLength = Math.ceil(Math.log2(nextPowerOf2(size)));
          expect(proof.length).toBeLessThanOrEqual(expectedMaxProofLength);
        }
      });
    });
  });

  describe("Proof structure", () => {
    it("should generate empty proof for single-element tree", () => {
      const hashes = generateHashes(1);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      // Single element tree: root IS the leaf, no siblings needed
      expect(proof.length).toBe(0);
    });

    it("should generate proof with one element for two-element tree", () => {
      const hashes = generateHashes(2);
      const tree = buildMerkleTree(hashes);

      const proof0 = getMerkleProof(tree, 0);
      const proof1 = getMerkleProof(tree, 1);

      expect(proof0).toHaveLength(1);
      expect(proof1).toHaveLength(1);
      expect(proof0[0]).toBe(hashes[1]); // Sibling
      expect(proof1[0]).toBe(hashes[0]); // Sibling
    });

    it("should include correct siblings in proof", () => {
      const hashes = generateHashes(4);
      const tree = buildMerkleTree(hashes);

      // For index 0, sibling at layer 0 is index 1
      const proof0 = getMerkleProof(tree, 0);
      expect(proof0[0]).toBe(hashes[1]);

      // For index 1, sibling at layer 0 is index 0
      const proof1 = getMerkleProof(tree, 1);
      expect(proof1[0]).toBe(hashes[0]);
    });
  });
});

// =============================================================================
// MERKLE PROOF VERIFICATION TESTS
// =============================================================================

describe("Merkle Proof Verification", () => {
  describe("Valid proofs", () => {
    const sizes = [1, 2, 4, 8, 16, 32, 64, 100, 500, 1000];

    sizes.forEach((size) => {
      it(`should verify all valid proofs in tree with ${size} events`, () => {
        const hashes = generateHashes(size);
        const tree = buildMerkleTree(hashes);

        // Verify proof for each leaf
        for (let i = 0; i < hashes.length; i++) {
          const proof = getMerkleProof(tree, i);
          const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
          expect(isValid).toBe(true);
        }
      });
    });
  });

  describe("Invalid proofs", () => {
    it("should reject proof with wrong leaf", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      const wrongLeaf = sha256("wrong-leaf");
      const isValid = verifyMerkleProof(wrongLeaf, proof, tree.root, 0);
      expect(isValid).toBe(false);
    });

    it("should reject proof with wrong root", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      const wrongRoot = sha256("wrong-root");
      const isValid = verifyMerkleProof(hashes[0], proof, wrongRoot, 0);
      expect(isValid).toBe(false);
    });

    it("should reject proof with wrong index", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      // Use correct leaf and proof but wrong index
      const isValid = verifyMerkleProof(hashes[0], proof, tree.root, 1);
      expect(isValid).toBe(false);
    });

    it("should reject proof with modified proof element", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      if (proof.length > 0) {
        const modifiedProof = [...proof];
        modifiedProof[0] = sha256("tampered");
        const isValid = verifyMerkleProof(hashes[0], modifiedProof, tree.root, 0);
        expect(isValid).toBe(false);
      }
    });

    it("should reject proof with missing element", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      if (proof.length > 1) {
        const truncatedProof = proof.slice(0, -1);
        const isValid = verifyMerkleProof(hashes[0], truncatedProof, tree.root, 0);
        expect(isValid).toBe(false);
      }
    });

    it("should reject proof with extra element", () => {
      const hashes = generateHashes(8);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      const extendedProof = [...proof, sha256("extra")];
      const isValid = verifyMerkleProof(hashes[0], extendedProof, tree.root, 0);
      expect(isValid).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("should verify single-element tree", () => {
      const hashes = generateHashes(1);
      const tree = buildMerkleTree(hashes);
      const proof = getMerkleProof(tree, 0);

      const isValid = verifyMerkleProof(hashes[0], proof, tree.root, 0);
      expect(isValid).toBe(true);
    });

    it("should handle proof for last element", () => {
      const hashes = generateHashes(7); // Non-power of 2
      const tree = buildMerkleTree(hashes);
      const lastIndex = hashes.length - 1;
      const proof = getMerkleProof(tree, lastIndex);

      const isValid = verifyMerkleProof(hashes[lastIndex], proof, tree.root, lastIndex);
      expect(isValid).toBe(true);
    });

    it("should handle proof for middle element in odd-sized tree", () => {
      const hashes = generateHashes(7);
      const tree = buildMerkleTree(hashes);
      const middleIndex = 3;
      const proof = getMerkleProof(tree, middleIndex);

      const isValid = verifyMerkleProof(hashes[middleIndex], proof, tree.root, middleIndex);
      expect(isValid).toBe(true);
    });
  });
});

// =============================================================================
// PROPERTY-BASED TESTS
// =============================================================================

describe("Property-Based Tests", () => {
  describe("Tree invariants", () => {
    it("any valid tree should have verifiable proofs for all leaves", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          (size) => {
            const hashes = generateHashes(size);
            const tree = buildMerkleTree(hashes);

            for (let i = 0; i < hashes.length; i++) {
              const proof = getMerkleProof(tree, i);
              const isValid = verifyMerkleProof(hashes[i], proof, tree.root, i);
              if (!isValid) return false;
            }
            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("root should be deterministic for same input", () => {
      fc.assert(
        fc.property(
          fc.array(fc.hexaString({ minLength: 64, maxLength: 64 }), { minLength: 1, maxLength: 50 }),
          (hashes) => {
            const tree1 = buildMerkleTree(hashes);
            const tree2 = buildMerkleTree(hashes);
            return tree1.root === tree2.root;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("changing any leaf should change the root", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }),
          fc.integer({ min: 0, max: 49 }),
          (size, changeIdx) => {
            const actualChangeIdx = changeIdx % size;
            const hashes = generateHashes(size);
            const tree1 = buildMerkleTree(hashes);

            const modifiedHashes = [...hashes];
            modifiedHashes[actualChangeIdx] = sha256("modified-" + Date.now());
            const tree2 = buildMerkleTree(modifiedHashes);

            return tree1.root !== tree2.root;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("proof length should be logarithmic in tree size", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 0, max: 999 }),
          (size, idx) => {
            const actualIdx = idx % size;
            const hashes = generateHashes(size);
            const tree = buildMerkleTree(hashes);
            const proof = getMerkleProof(tree, actualIdx);

            // Proof length should be at most ceil(log2(nextPowerOf2(size)))
            const maxExpectedLength = Math.ceil(Math.log2(nextPowerOf2(size)));
            return proof.length <= maxExpectedLength;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("swapping leaf order should produce different root", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 20 }),
          (size) => {
            const hashes = generateHashes(size);
            const tree1 = buildMerkleTree(hashes);

            // Swap first two elements
            const swappedHashes = [...hashes];
            [swappedHashes[0], swappedHashes[1]] = [swappedHashes[1], swappedHashes[0]];
            const tree2 = buildMerkleTree(swappedHashes);

            return tree1.root !== tree2.root;
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Proof verification invariants", () => {
    it("valid proof should always verify", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 99 }),
          (size, idx) => {
            const actualIdx = idx % size;
            const hashes = generateHashes(size);
            const tree = buildMerkleTree(hashes);
            const proof = getMerkleProof(tree, actualIdx);

            return verifyMerkleProof(hashes[actualIdx], proof, tree.root, actualIdx);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("proof for wrong leaf should fail", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }),
          fc.integer({ min: 0, max: 49 }),
          fc.integer({ min: 0, max: 49 }),
          (size, proofIdx, wrongIdx) => {
            const actualProofIdx = proofIdx % size;
            let actualWrongIdx = wrongIdx % size;
            
            // Make sure indices are different
            if (actualWrongIdx === actualProofIdx) {
              actualWrongIdx = (actualWrongIdx + 1) % size;
            }

            const hashes = generateHashes(size);
            const tree = buildMerkleTree(hashes);
            const proof = getMerkleProof(tree, actualProofIdx);

            // Use proof from one index but leaf from another
            return !verifyMerkleProof(hashes[actualWrongIdx], proof, tree.root, actualProofIdx);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("tampered proof should fail verification", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 4, max: 50 }),
          fc.integer({ min: 0, max: 49 }),
          fc.hexaString({ minLength: 64, maxLength: 64 }),
          (size, idx, tamperHash) => {
            const actualIdx = idx % size;
            const hashes = generateHashes(size);
            const tree = buildMerkleTree(hashes);
            const proof = getMerkleProof(tree, actualIdx);

            if (proof.length === 0) return true; // Skip single-element trees

            // Tamper with a proof element
            const tamperedProof = [...proof];
            tamperedProof[0] = tamperHash;

            return !verifyMerkleProof(hashes[actualIdx], tamperedProof, tree.root, actualIdx);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// =============================================================================
// LARGE-TREE COMPLEXITY INVARIANTS
// =============================================================================

describe("Large-tree complexity invariants", () => {
  it("should build a 10000-event tree with a linear total node count", () => {
    const hashes = generateHashes(10000);
    const tree = buildMerkleTree(hashes);
    const paddedLeafCount = nextPowerOf2(hashes.length);
    const layerSizes = tree.layers.map((layer) => layer.length);

    expect(tree.root).toBeDefined();
    expect(tree.leaves).toHaveLength(hashes.length);
    expect(layerSizes[0]).toBe(paddedLeafCount);
    expect(layerSizes).toHaveLength(Math.log2(paddedLeafCount) + 1);
    for (let i = 1; i < layerSizes.length; i++) {
      expect(layerSizes[i]).toBe(layerSizes[i - 1] / 2);
    }
    // A complete binary tree has 2n - 1 total nodes: construction work and
    // retained structure therefore grow linearly with the padded leaf count.
    expect(layerSizes.reduce((total, size) => total + size, 0)).toBe(
      2 * paddedLeafCount - 1,
    );
  });

  it("should generate logarithmic proofs and verify them for a large tree", () => {
    const hashes = generateHashes(10000);
    const tree = buildMerkleTree(hashes);
    const expectedProofLength = Math.log2(nextPowerOf2(hashes.length));

    // Cover 100 deterministic positions spread through the tree. Proof
    // generation walks one sibling per layer and verification consumes exactly
    // that proof, so this pins O(log n) work without consulting wall clock.
    for (let i = 0; i < 100; i++) {
      const idx = (i * 7919) % hashes.length;
      const proof = getMerkleProof(tree, idx);
      expect(proof).toHaveLength(expectedProofLength);
      expect(verifyMerkleProof(hashes[idx], proof, tree.root, idx)).toBe(true);
    }
  });
});

// =============================================================================
// CROSS-VERIFICATION TESTS
// =============================================================================

describe("Cross-Verification", () => {
  it("should produce proofs compatible with manual verification", () => {
    // Build a simple 4-element tree and verify manually
    const h0 = sha256("leaf-0");
    const h1 = sha256("leaf-1");
    const h2 = sha256("leaf-2");
    const h3 = sha256("leaf-3");

    const tree = buildMerkleTree([h0, h1, h2, h3]);

    // Manual computation of intermediate nodes
    const n01 = sha256(h0 + h1);
    const n23 = sha256(h2 + h3);
    const root = sha256(n01 + n23);

    expect(tree.root).toBe(root);

    // Verify proof for h0: should be [h1, n23]
    const proof0 = getMerkleProof(tree, 0);
    expect(proof0).toContain(h1);
    expect(proof0).toContain(n23);

    // Verify proof for h2: should be [h3, n01]
    const proof2 = getMerkleProof(tree, 2);
    expect(proof2).toContain(h3);
    expect(proof2).toContain(n01);
  });

  it("should handle odd-sized tree padding correctly", () => {
    const h0 = sha256("leaf-0");
    const h1 = sha256("leaf-1");
    const h2 = sha256("leaf-2");

    const tree = buildMerkleTree([h0, h1, h2]);

    // Tree should pad h2 to make 4 leaves: [h0, h1, h2, h2]
    // Then: n01 = hash(h0+h1), n22 = hash(h2+h2)
    // Root = hash(n01 + n22)

    expect(tree.leaves).toHaveLength(3);
    expect(tree.root).toBeDefined();

    // All three leaves should have valid proofs
    for (let i = 0; i < 3; i++) {
      const proof = getMerkleProof(tree, i);
      const leaf = [h0, h1, h2][i];
      const isValid = verifyMerkleProof(leaf, proof, tree.root, i);
      expect(isValid).toBe(true);
    }
  });
});
