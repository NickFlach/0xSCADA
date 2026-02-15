import { describe, it, expect } from 'vitest';
import { MerkleTree } from '../merkle-syscalls';

describe('MerkleTree syscalls', () => {
  it('merkle_insert adds leaves and computes root', () => {
    const tree = new MerkleTree();
    const r1 = tree.merkle_insert('hello');
    expect(r1.success).toBe(true);
    expect(r1.data!.index).toBe(0);

    const r2 = tree.merkle_insert('world');
    expect(r2.success).toBe(true);
    expect(r2.data!.index).toBe(1);

    const root = tree.merkle_root();
    expect(root.success).toBe(true);
    expect(root.data!.leafCount).toBe(2);
    expect(root.data!.root).toBeTruthy();
  });

  it('merkle_prove generates valid proof', () => {
    const tree = new MerkleTree();
    tree.merkle_insert('a');
    tree.merkle_insert('b');
    tree.merkle_insert('c');
    tree.merkle_insert('d');

    const proof = tree.merkle_prove(2);
    expect(proof.success).toBe(true);
    expect(proof.data!.path.length).toBeGreaterThan(0);

    const verified = MerkleTree.merkle_verify(proof.data!);
    expect(verified.success).toBe(true);
    expect(verified.data).toBe(true);
  });

  it('merkle_verify rejects tampered proof', () => {
    const tree = new MerkleTree();
    tree.merkle_insert('a');
    tree.merkle_insert('b');

    const proof = tree.merkle_prove(0);
    expect(proof.success).toBe(true);

    // Tamper with the root
    const tampered = { ...proof.data!, root: 'deadbeef' };
    const verified = MerkleTree.merkle_verify(tampered);
    expect(verified.data).toBe(false);
  });

  it('merkle_prove rejects out-of-range index', () => {
    const tree = new MerkleTree();
    tree.merkle_insert('x');
    const result = tree.merkle_prove(5);
    expect(result.success).toBe(false);
  });

  it('merkle_insert_batch works', () => {
    const tree = new MerkleTree();
    const result = tree.merkle_insert_batch(['a', 'b', 'c']);
    expect(result.success).toBe(true);
    expect(result.data!.count).toBe(3);
    expect(result.data!.root).toBeTruthy();
  });

  it('single leaf tree works', () => {
    const tree = new MerkleTree();
    tree.merkle_insert('only');
    const root = tree.merkle_root();
    expect(root.data!.leafCount).toBe(1);
    expect(root.data!.depth).toBe(0);

    const proof = tree.merkle_prove(0);
    expect(proof.success).toBe(true);
    const verified = MerkleTree.merkle_verify(proof.data!);
    expect(verified.data).toBe(true);
  });
});
