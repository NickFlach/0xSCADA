import { describe, it, expect } from 'vitest';
import { SublinearSolver, CountMinSketch, HyperLogLog, BloomFilter } from '../sublinear-solver';
import { createHash } from 'crypto';

function makeTxHash(): string {
  return createHash('sha256').update(Math.random().toString()).digest('hex');
}

describe('CountMinSketch', () => {
  it('estimates frequencies', () => {
    const cms = new CountMinSketch();
    cms.add('tx1');
    cms.add('tx1');
    cms.add('tx2');
    expect(cms.estimate('tx1')).toBeGreaterThanOrEqual(2);
    expect(cms.estimate('tx2')).toBeGreaterThanOrEqual(1);
    expect(cms.estimate('tx3')).toBe(0);
  });
});

describe('HyperLogLog', () => {
  it('estimates cardinality within 20%', () => {
    const hll = new HyperLogLog();
    const n = 1000;
    for (let i = 0; i < n; i++) hll.add(`item-${i}`);
    const estimate = hll.estimate();
    expect(estimate).toBeGreaterThan(n * 0.8);
    expect(estimate).toBeLessThan(n * 1.2);
  });
});

describe('BloomFilter', () => {
  it('contains added items', () => {
    const bloom = new BloomFilter();
    bloom.add('hello');
    expect(bloom.mightContain('hello')).toBe(true);
    // False positive possible but unlikely for a single missing item
  });
});

describe('SublinearSolver', () => {
  it('validates a clean block', () => {
    const solver = new SublinearSolver();
    const txHashes = Array.from({ length: 100 }, makeTxHash);
    const result = solver.validate({
      blockNumber: 1,
      proposer: 'validator-1',
      txHashes,
      stateRoot: makeTxHash(),
      parentHash: makeTxHash(),
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.sampledTxCount).toBeLessThanOrEqual(Math.ceil(Math.sqrt(100)));
  });

  it('detects duplicate transactions', () => {
    const solver = new SublinearSolver({ duplicateThreshold: 1 });
    const dupHash = makeTxHash();
    const txHashes = [dupHash, dupHash, ...Array.from({ length: 10 }, makeTxHash)];
    const result = solver.validate({
      blockNumber: 2,
      proposer: 'validator-1',
      txHashes,
      stateRoot: makeTxHash(),
      parentHash: makeTxHash(),
      timestamp: Date.now(),
    });
    expect(result.duplicatesDetected.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });
});
