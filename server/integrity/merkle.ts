/**
 * Merkle Tree Construction
 * 
 * Build Merkle trees from event batches, generate inclusion proofs, and verify proofs.
 * Clean implementation using native SHA-256, no external dependencies.
 * Part of the Dual-Time Control Plane (ADR-0021).
 */

import { createHash } from 'crypto';

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: string; // Only for leaf nodes
  index?: number; // Only for leaf nodes
}

export interface MerkleProof {
  leaf: string;
  leafIndex: number;
  root: string;
  proof: Array<{
    hash: string;
    position: 'left' | 'right';
  }>;
}

export interface MerkleTreeResult {
  root: string;
  tree: MerkleNode;
  leaves: string[];
  depth: number;
}

export class MerkleTreeBuilder {
  private static readonly EMPTY_HASH = '0'.repeat(64);

  /**
   * Build a Merkle tree from an array of data items
   */
  static buildTree(data: string[]): MerkleTreeResult {
    if (data.length === 0) {
      throw new Error('Cannot build Merkle tree from empty data');
    }

    // Create leaf nodes
    const leaves = data.map((item, index) => ({
      hash: this.hash(item),
      data: item,
      index,
    }));

    // Build tree bottom-up
    const tree = this.buildTreeRecursive(leaves);
    const depth = this.calculateDepth(tree);

    return {
      root: tree.hash,
      tree,
      leaves: data,
      depth,
    };
  }

  /**
   * Build Merkle tree from event batch hashes
   */
  static buildFromEventHashes(eventHashes: string[]): MerkleTreeResult {
    return this.buildTree(eventHashes);
  }

  /**
   * Generate inclusion proof for a specific leaf
   */
  static generateProof(tree: MerkleNode, leafData: string, leafIndex: number): MerkleProof {
    const leafHash = this.hash(leafData);
    const proof: Array<{ hash: string; position: 'left' | 'right' }> = [];

    if (!this.generateProofRecursive(tree, leafHash, leafIndex, proof)) {
      throw new Error(`Leaf not found in tree: ${leafData} at index ${leafIndex}`);
    }

    // generateProofRecursive collects siblings top-down (root level first), but
    // verifyProof folds from the leaf upward. Store siblings in leaf→root order.
    proof.reverse();

    return {
      leaf: leafData,
      leafIndex,
      root: tree.hash,
      proof,
    };
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(proof: MerkleProof): boolean {
    try {
      let currentHash = this.hash(proof.leaf);
      let currentIndex = proof.leafIndex;

      for (const step of proof.proof) {
        if (step.position === 'left') {
          currentHash = this.hashPair(step.hash, currentHash);
          currentIndex = Math.floor(currentIndex / 2);
        } else {
          currentHash = this.hashPair(currentHash, step.hash);
          currentIndex = Math.floor(currentIndex / 2);
        }
      }

      return currentHash === proof.root;
    } catch (error) {
      return false;
    }
  }

  /**
   * Verify multiple proofs against the same root
   */
  static verifyBatchProofs(proofs: MerkleProof[]): boolean {
    if (proofs.length === 0) {
      return false;
    }

    const root = proofs[0].root;
    return proofs.every(proof => 
      proof.root === root && this.verifyProof(proof)
    );
  }

  /**
   * Create a batch proof for multiple leaves
   */
  static generateBatchProof(tree: MerkleNode, leafData: string[], leafIndices: number[]): MerkleProof[] {
    if (leafData.length !== leafIndices.length) {
      throw new Error('Leaf data and indices arrays must have same length');
    }

    return leafData.map((data, i) => 
      this.generateProof(tree, data, leafIndices[i])
    );
  }

  /**
   * Build tree recursively from leaf nodes
   */
  private static buildTreeRecursive(nodes: MerkleNode[]): MerkleNode {
    if (nodes.length === 1) {
      return nodes[0];
    }

    const parentNodes: MerkleNode[] = [];

    // Process pairs of nodes
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : this.createEmptyNode();

      const parent: MerkleNode = {
        hash: this.hashPair(left.hash, right.hash),
        left,
        right,
      };

      parentNodes.push(parent);
    }

    return this.buildTreeRecursive(parentNodes);
  }

  /**
   * Generate proof recursively by traversing tree
   */
  private static generateProofRecursive(
    node: MerkleNode,
    targetHash: string,
    targetIndex: number,
    proof: Array<{ hash: string; position: 'left' | 'right' }>,
    currentIndex: number = 0,
    depth: number = 0
  ): boolean {
    // Base case: leaf node
    if (!node.left && !node.right) {
      return node.hash === targetHash && currentIndex === targetIndex;
    }

    if (!node.left || !node.right) {
      return false;
    }

    // Calculate which subtree the target should be in
    const leftSubtreeSize = Math.pow(2, this.calculateDepth(node.left));
    const isInLeftSubtree = targetIndex < currentIndex + leftSubtreeSize;

    if (isInLeftSubtree) {
      // Target is in left subtree, add right sibling to proof
      proof.push({
        hash: node.right.hash,
        position: 'right',
      });

      return this.generateProofRecursive(
        node.left,
        targetHash,
        targetIndex,
        proof,
        currentIndex,
        depth + 1
      );
    } else {
      // Target is in right subtree, add left sibling to proof
      proof.push({
        hash: node.left.hash,
        position: 'left',
      });

      return this.generateProofRecursive(
        node.right,
        targetHash,
        targetIndex,
        proof,
        currentIndex + leftSubtreeSize,
        depth + 1
      );
    }
  }

  /**
   * Calculate tree depth
   */
  private static calculateDepth(node: MerkleNode): number {
    if (!node.left && !node.right) {
      return 0;
    }

    const leftDepth = node.left ? this.calculateDepth(node.left) : 0;
    const rightDepth = node.right ? this.calculateDepth(node.right) : 0;

    return 1 + Math.max(leftDepth, rightDepth);
  }

  /**
   * Create empty node for odd number of leaves
   */
  private static createEmptyNode(): MerkleNode {
    return {
      hash: this.EMPTY_HASH,
    };
  }

  /**
   * Hash a single value
   */
  private static hash(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Hash a pair of values
   */
  private static hashPair(left: string, right: string): string {
    return createHash('sha256')
      .update(left + right, 'utf8')
      .digest('hex');
  }
}

/**
 * Merkle Tree Manager for handling multiple trees and batch operations
 */
export class MerkleTreeManager {
  private trees: Map<string, MerkleTreeResult> = new Map();

  /**
   * Create and store a tree for an event batch
   */
  createTreeForBatch(batchId: string, eventHashes: string[]): MerkleTreeResult {
    const tree = MerkleTreeBuilder.buildFromEventHashes(eventHashes);
    this.trees.set(batchId, tree);
    return tree;
  }

  /**
   * Get stored tree by batch ID
   */
  getTree(batchId: string): MerkleTreeResult | undefined {
    return this.trees.get(batchId);
  }

  /**
   * Generate proof for an event in a specific batch
   */
  generateEventProof(batchId: string, eventHash: string, eventIndex: number): MerkleProof | null {
    const tree = this.trees.get(batchId);
    if (!tree) {
      return null;
    }

    try {
      return MerkleTreeBuilder.generateProof(tree.tree, eventHash, eventIndex);
    } catch (error) {
      return null;
    }
  }

  /**
   * Verify an event proof
   */
  verifyEventProof(proof: MerkleProof): boolean {
    return MerkleTreeBuilder.verifyProof(proof);
  }

  /**
   * Get statistics about stored trees
   */
  getStats() {
    const stats = {
      treeCount: this.trees.size,
      batches: [] as Array<{
        batchId: string;
        root: string;
        leafCount: number;
        depth: number;
      }>,
    };

    this.trees.forEach((tree, batchId) => {
      stats.batches.push({
        batchId,
        root: tree.root,
        leafCount: tree.leaves.length,
        depth: tree.depth,
      });
    });

    return stats;
  }

  /**
   * Clear all stored trees
   */
  clear(): void {
    this.trees.clear();
  }

  /**
   * Remove a specific tree
   */
  removeTree(batchId: string): boolean {
    return this.trees.delete(batchId);
  }
}

export default MerkleTreeBuilder;