/**
 * Merkle Tree Syscalls — kernel-style interface for Merkle operations
 * Issue #150: [Kernel] Create syscalls for Merkle tree operations
 *
 * Provides: merkle_insert, merkle_prove, merkle_verify, merkle_root
 * Uses SHA-256 by default; pluggable hash function.
 */

import { createHash } from 'crypto';
import type { Hash, MerkleProof, MerkleProofNode, MerkleSyscallResult, MerkleTreeInfo } from '@shared/types/merkle';

// ─── Hash Utilities ──────────────────────────────────────────────────────────

export type HashFn = (data: Buffer) => Hash;

export const sha256: HashFn = (data: Buffer): Hash =>
  createHash('sha256').update(data).digest('hex');

export const hashPair = (left: Hash, right: Hash, hashFn: HashFn = sha256): Hash =>
  hashFn(Buffer.from(left + right, 'utf-8'));

export const hashLeaf = (data: Buffer | string, hashFn: HashFn = sha256): Hash =>
  hashFn(Buffer.from(typeof data === 'string' ? data : data));

// ─── Merkle Tree ─────────────────────────────────────────────────────────────

export class MerkleTree {
  private leaves: Hash[] = [];
  private layers: Hash[][] = [];
  private hashFn: HashFn;

  constructor(hashFn: HashFn = sha256) {
    this.hashFn = hashFn;
  }

  /** Rebuild internal layers from current leaves */
  private rebuild(): void {
    if (this.leaves.length === 0) {
      this.layers = [[]];
      return;
    }

    this.layers = [this.leaves.slice()];
    let current = this.leaves.slice();

    while (current.length > 1) {
      const next: Hash[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] ?? left; // duplicate last if odd
        next.push(hashPair(left, right, this.hashFn));
      }
      this.layers.push(next);
      current = next;
    }
  }

  // ─── Syscalls ────────────────────────────────────────────────────────

  /** SYSCALL: merkle_insert — add a leaf to the tree */
  merkle_insert(data: Buffer | string): MerkleSyscallResult<{ index: number; leaf: Hash }> {
    try {
      const leaf = hashLeaf(data, this.hashFn);
      const index = this.leaves.length;
      this.leaves.push(leaf);
      this.rebuild();
      return { success: true, data: { index, leaf } };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /** SYSCALL: merkle_root — return current Merkle root */
  merkle_root(): MerkleSyscallResult<MerkleTreeInfo> {
    if (this.leaves.length === 0) {
      return { success: true, data: { root: '', leafCount: 0, depth: 0, algorithm: 'sha256' } };
    }
    return {
      success: true,
      data: {
        root: this.layers[this.layers.length - 1][0],
        leafCount: this.leaves.length,
        depth: this.layers.length - 1,
        algorithm: 'sha256',
      },
    };
  }

  /** SYSCALL: merkle_prove — generate an inclusion proof for a leaf index */
  merkle_prove(index: number): MerkleSyscallResult<MerkleProof> {
    if (index < 0 || index >= this.leaves.length) {
      return { success: false, error: `Index ${index} out of range [0, ${this.leaves.length})` };
    }

    const path: MerkleProofNode[] = [];
    let idx = index;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const siblingHash = siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];

      path.push({ hash: siblingHash, left: isRight });
      idx = Math.floor(idx / 2);
    }

    const rootInfo = this.merkle_root();
    return {
      success: true,
      data: {
        leaf: this.leaves[index],
        path,
        root: rootInfo.data!.root,
        index,
      },
    };
  }

  /** SYSCALL: merkle_verify — verify an inclusion proof */
  static merkle_verify(proof: MerkleProof, hashFn: HashFn = sha256): MerkleSyscallResult<boolean> {
    try {
      let current = proof.leaf;
      for (const node of proof.path) {
        current = node.left
          ? hashPair(node.hash, current, hashFn)
          : hashPair(current, node.hash, hashFn);
      }
      return { success: true, data: current === proof.root };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /** Bulk insert from array */
  merkle_insert_batch(items: (Buffer | string)[]): MerkleSyscallResult<{ count: number; root: Hash }> {
    for (const item of items) {
      this.leaves.push(hashLeaf(item, this.hashFn));
    }
    this.rebuild();
    const root = this.layers[this.layers.length - 1]?.[0] ?? '';
    return { success: true, data: { count: items.length, root } };
  }

  /** Get all leaves */
  getLeaves(): Hash[] {
    return this.leaves.slice();
  }
}
