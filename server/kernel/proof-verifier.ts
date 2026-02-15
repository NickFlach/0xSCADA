/**
 * Proof Verifier — O(log n) Merkle proof verification
 *
 * Issue #155 — Verify L2 proofs in kernel space with O(log n)
 *
 * Implements standard and sparse Merkle trees with proof compression
 * and batch verification for efficient L2 state proof validation.
 */

import * as crypto from "crypto";

// =============================================================================
// TYPES
// =============================================================================

export type HashFunction = (data: Buffer) => Buffer;

export interface MerkleProof {
  leaf: string;
  leafIndex: number;
  siblings: string[];
  /** Bitmap indicating left (0) or right (1) sibling position */
  path: number;
  root: string;
}

export interface CompressedProof {
  leaf: string;
  leafIndex: number;
  /** Only non-default siblings (sparse tree optimization) */
  compressedSiblings: Array<{ depth: number; hash: string }>;
  path: number;
  root: string;
  treeDepth: number;
}

export interface BatchVerificationResult {
  total: number;
  valid: number;
  invalid: number;
  results: Array<{ index: number; valid: boolean; leaf: string }>;
  durationMs: number;
}

export interface SparseMerkleNode {
  hash: string;
  left?: SparseMerkleNode;
  right?: SparseMerkleNode;
  isDefault: boolean;
}

// =============================================================================
// HASH UTILITIES
// =============================================================================

export function sha256Hash(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

export function keccak256Hash(data: Buffer): Buffer {
  // Node.js doesn't have keccak natively; use sha3-256 as close approximation
  // In production, use @noble/hashes or ethers keccak256
  return crypto.createHash("sha3-256").update(data).digest();
}

function hashPair(left: string, right: string, hashFn: HashFunction): string {
  const combined = Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")]);
  return hashFn(combined).toString("hex");
}

// =============================================================================
// STANDARD MERKLE TREE
// =============================================================================

export class MerkleTree {
  private leaves: string[];
  private layers: string[][];
  private hashFn: HashFunction;

  constructor(leaves: string[], hashFn: HashFunction = sha256Hash) {
    this.hashFn = hashFn;
    this.leaves = leaves.length > 0 ? leaves : ["0".repeat(64)];
    this.layers = this.buildTree();
  }

  get root(): string {
    return this.layers[this.layers.length - 1][0];
  }

  get depth(): number {
    return this.layers.length - 1;
  }

  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of range`);
    }

    const siblings: string[] = [];
    let path = 0;
    let idx = leafIndex;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (isRight) path |= 1 << i;

      siblings.push(siblingIdx < layer.length ? layer[siblingIdx] : layer[layer.length - 1]);
      idx = Math.floor(idx / 2);
    }

    return {
      leaf: this.leaves[leafIndex],
      leafIndex,
      siblings,
      path,
      root: this.root,
    };
  }

  private buildTree(): string[][] {
    const layers: string[][] = [this.leaves];
    let current = this.leaves;

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] || left; // duplicate last if odd
        next.push(hashPair(left, right, this.hashFn));
      }
      layers.push(next);
      current = next;
    }

    return layers;
  }
}

// =============================================================================
// SPARSE MERKLE TREE
// =============================================================================

/**
 * Sparse Merkle Tree — efficient for large address spaces with few entries.
 * Default (empty) subtrees are precomputed, enabling O(log n) proof
 * generation even for 2^256-sized trees.
 */
export class SparseMerkleTree {
  private readonly depth: number;
  private readonly defaultHashes: string[];
  private readonly hashFn: HashFunction;
  private nodes: Map<string, string> = new Map(); // "depth:index" → hash

  constructor(depth: number = 32, hashFn: HashFunction = sha256Hash) {
    this.depth = depth;
    this.hashFn = hashFn;
    this.defaultHashes = this.computeDefaultHashes();
  }

  get root(): string {
    return this.nodes.get(`${this.depth}:0`) || this.defaultHashes[this.depth];
  }

  /**
   * Insert or update a leaf at the given index.
   * O(log n) — updates only the path from leaf to root.
   */
  insert(index: number, leafHash: string): void {
    const key = `0:${index}`;
    this.nodes.set(key, leafHash);

    let idx = index;
    for (let d = 0; d < this.depth; d++) {
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const siblingKey = `${d}:${siblingIdx}`;
      const sibling = this.nodes.get(siblingKey) || this.defaultHashes[d];

      const parentIdx = Math.floor(idx / 2);
      const left = isRight ? sibling : (this.nodes.get(`${d}:${idx}`) || this.defaultHashes[d]);
      const right = isRight ? (this.nodes.get(`${d}:${idx}`) || this.defaultHashes[d]) : sibling;
      const parentHash = hashPair(left, right, this.hashFn);

      this.nodes.set(`${d + 1}:${parentIdx}`, parentHash);
      idx = parentIdx;
    }
  }

  /**
   * Generate a proof for the leaf at the given index.
   * Returns compressed proof (only non-default siblings).
   */
  getProof(index: number): CompressedProof {
    const leaf = this.nodes.get(`0:${index}`) || this.defaultHashes[0];
    const compressedSiblings: Array<{ depth: number; hash: string }> = [];
    let path = 0;
    let idx = index;

    for (let d = 0; d < this.depth; d++) {
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const siblingKey = `${d}:${siblingIdx}`;
      const sibling = this.nodes.get(siblingKey) || this.defaultHashes[d];

      if (isRight) path |= 1 << d;

      // Only store non-default siblings (compression)
      if (sibling !== this.defaultHashes[d]) {
        compressedSiblings.push({ depth: d, hash: sibling });
      }

      idx = Math.floor(idx / 2);
    }

    return {
      leaf,
      leafIndex: index,
      compressedSiblings,
      path,
      root: this.root,
      treeDepth: this.depth,
    };
  }

  private computeDefaultHashes(): string[] {
    const defaults: string[] = ["0".repeat(64)]; // empty leaf
    for (let i = 0; i < this.depth; i++) {
      defaults.push(hashPair(defaults[i], defaults[i], this.hashFn));
    }
    return defaults;
  }
}

// =============================================================================
// PROOF VERIFIER
// =============================================================================

export class ProofVerifier {
  private hashFn: HashFunction;
  private cache: Map<string, boolean> = new Map();
  private cacheMaxSize: number;

  constructor(hashFn: HashFunction = sha256Hash, cacheMaxSize = 4096) {
    this.hashFn = hashFn;
    this.cacheMaxSize = cacheMaxSize;
  }

  /**
   * Verify a standard Merkle proof. O(log n) — walks siblings to root.
   */
  verify(proof: MerkleProof): boolean {
    const cacheKey = `${proof.leaf}:${proof.root}:${proof.path}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)!;

    let hash = proof.leaf;

    for (let i = 0; i < proof.siblings.length; i++) {
      const isRight = (proof.path >> i) & 1;
      if (isRight) {
        hash = hashPair(proof.siblings[i], hash, this.hashFn);
      } else {
        hash = hashPair(hash, proof.siblings[i], this.hashFn);
      }
    }

    const valid = hash === proof.root;
    this.cacheResult(cacheKey, valid);
    return valid;
  }

  /**
   * Verify a compressed sparse Merkle proof. O(log n).
   */
  verifyCompressed(proof: CompressedProof, defaultHashes: string[]): boolean {
    let hash = proof.leaf;
    let siblingMap = new Map(proof.compressedSiblings.map((s) => [s.depth, s.hash]));

    for (let d = 0; d < proof.treeDepth; d++) {
      const sibling = siblingMap.get(d) || defaultHashes[d];
      const isRight = (proof.path >> d) & 1;
      hash = isRight ? hashPair(sibling, hash, this.hashFn) : hashPair(hash, sibling, this.hashFn);
    }

    return hash === proof.root;
  }

  /**
   * Batch verify multiple proofs. Shares cache and reports aggregate results.
   */
  batchVerify(proofs: MerkleProof[]): BatchVerificationResult {
    const start = Date.now();
    const results = proofs.map((proof, index) => ({
      index,
      valid: this.verify(proof),
      leaf: proof.leaf,
    }));

    return {
      total: proofs.length,
      valid: results.filter((r) => r.valid).length,
      invalid: results.filter((r) => !r.valid).length,
      results,
      durationMs: Date.now() - start,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private cacheResult(key: string, result: boolean): void {
    if (this.cache.size >= this.cacheMaxSize) {
      // Evict oldest quarter
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < keys.length / 4; i++) {
        this.cache.delete(keys[i]);
      }
    }
    this.cache.set(key, result);
  }
}
