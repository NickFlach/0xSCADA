/**
 * Unit tests for the PURE validator-metrics logic (issue #453).
 *
 * Covers the verification-critical pieces: stale detection (<10s window),
 * attestation-rate over last N rounds, Kuramoto coherence, and throughput
 * aggregation / batch-size distribution.
 */

import { describe, it, expect } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  COHERENCE_RED_THRESHOLD,
  classifyNodeHealth,
  lastSeenMillis,
  formatAge,
  attestationRate,
  kuramotoCoherence,
  isCoherenceCritical,
  aggregateThroughput,
  buildValidatorRows,
  shortId,
} from '../validator-metrics';
import type { NodeStatus, ValidatorEvent } from '../oxscada-rpc';

const NOW = 1_700_000_000_000;

function statusAt(ts: number): NodeStatus {
  return {
    nodeId: 'n1',
    round: 100,
    validators: [],
    anchors: { batchesAnchored: 0, txsAnchored: 0, bytesAnchored: 0, recentBatchSizes: [] },
    timestamp: ts,
  };
}

describe('classifyNodeHealth (stale detection)', () => {
  it('is live when a fresh status arrived within the threshold', () => {
    const r = { status: statusAt(NOW), error: null, fetchedAt: NOW };
    expect(classifyNodeHealth(r, NOW)).toBe('live');
  });

  it('turns stale strictly under 10s after a node stops responding', () => {
    // The threshold must be < 10s so the verification criterion holds.
    expect(STALE_THRESHOLD_MS).toBeLessThan(10_000);
    // Node last answered STALE_THRESHOLD_MS ago and has not been re-polled since.
    const lastOk = NOW - STALE_THRESHOLD_MS;
    const r = { status: statusAt(lastOk), error: null, fetchedAt: lastOk };
    expect(classifyNodeHealth(r, NOW)).toBe('stale');
  });

  it('stays live one millisecond before the threshold', () => {
    const lastOk = NOW - (STALE_THRESHOLD_MS - 1);
    const r = { status: statusAt(lastOk), error: null, fetchedAt: lastOk };
    expect(classifyNodeHealth(r, NOW)).toBe('live');
  });

  it('reports error on a hard transport failure with no prior data', () => {
    const r = { status: null, error: 'HTTP 503', fetchedAt: NOW };
    expect(classifyNodeHealth(r, NOW)).toBe('error');
  });

  it('uses the most recent of status.timestamp and fetchedAt', () => {
    // fetchedAt is fresh even though the node-reported timestamp is old.
    const r = { status: statusAt(NOW - 60_000), error: null, fetchedAt: NOW };
    expect(lastSeenMillis(r)).toBe(NOW);
    expect(classifyNodeHealth(r, NOW)).toBe('live');
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatAge(3_000)).toBe('3s ago');
    expect(formatAge(90_000)).toBe('1m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
  });
  it('clamps negative ages to 0', () => {
    expect(formatAge(-5)).toBe('0s ago');
  });
});

describe('attestationRate', () => {
  const ev = (round: number, validatorId: string, kind: ValidatorEvent['kind']): ValidatorEvent => ({
    timestamp: NOW,
    round,
    validatorId,
    kind,
  });

  it('returns null when there is no attestation data', () => {
    expect(attestationRate([], 'v1', 16)).toBeNull();
    expect(attestationRate([ev(1, 'v1', 'anchor')], 'v1', 16)).toBeNull();
  });

  it('computes the fraction of attested rounds in the window', () => {
    const events = [
      ev(1, 'v1', 'attest'),
      ev(2, 'v1', 'attest'),
      ev(3, 'v1', 'miss'),
      ev(4, 'v1', 'attest'),
    ];
    // 3 of 4 rounds attested.
    expect(attestationRate(events, 'v1', 16)).toBeCloseTo(0.75);
  });

  it('limits to the most recent N rounds', () => {
    const events = [
      ev(1, 'v1', 'miss'),
      ev(2, 'v1', 'miss'),
      ev(3, 'v1', 'attest'),
      ev(4, 'v1', 'attest'),
    ];
    // Window of 2 → only rounds 3 & 4 → 100%.
    expect(attestationRate(events, 'v1', 2)).toBe(1);
  });

  it('ignores events from other validators', () => {
    const events = [ev(1, 'v1', 'attest'), ev(1, 'v2', 'miss')];
    expect(attestationRate(events, 'v1', 16)).toBe(1);
    expect(attestationRate(events, 'v2', 16)).toBe(0);
  });

  it('treats a round with both attest and miss as attested', () => {
    const events = [ev(5, 'v1', 'miss'), ev(5, 'v1', 'attest')];
    expect(attestationRate(events, 'v1', 16)).toBe(1);
  });

  it('returns null for a non-positive window', () => {
    expect(attestationRate([ev(1, 'v1', 'attest')], 'v1', 0)).toBeNull();
  });
});

describe('kuramotoCoherence', () => {
  it('returns r=0 for an empty set', () => {
    expect(kuramotoCoherence([]).r).toBe(0);
  });

  it('returns r=1 for perfectly aligned phases', () => {
    const res = kuramotoCoherence([{ phase: 1.2 }, { phase: 1.2 }, { phase: 1.2 }]);
    expect(res.r).toBeCloseTo(1, 6);
    expect(res.count).toBe(3);
  });

  it('returns r≈0 for anti-phase oscillators', () => {
    const res = kuramotoCoherence([{ phase: 0 }, { phase: Math.PI }]);
    expect(res.r).toBeCloseTo(0, 6);
  });

  it('gives r=1 for a single oscillator', () => {
    expect(kuramotoCoherence([{ phase: 2.5 }]).r).toBeCloseTo(1, 6);
  });

  it('is rotation-invariant (mean phase tracks the cluster)', () => {
    const a = kuramotoCoherence([{ phase: 0 }, { phase: 0.1 }, { phase: -0.1 }]);
    const b = kuramotoCoherence([{ phase: 1 }, { phase: 1.1 }, { phase: 0.9 }]);
    expect(a.r).toBeCloseTo(b.r, 6);
    expect(b.meanPhase).toBeCloseTo(1, 6);
  });
});

describe('isCoherenceCritical', () => {
  it('flags below the default threshold and not above it', () => {
    expect(isCoherenceCritical(COHERENCE_RED_THRESHOLD - 0.01)).toBe(true);
    expect(isCoherenceCritical(COHERENCE_RED_THRESHOLD)).toBe(false);
    expect(isCoherenceCritical(0.99)).toBe(false);
  });
  it('respects a custom threshold', () => {
    expect(isCoherenceCritical(0.85, 0.9)).toBe(true);
  });
});

describe('aggregateThroughput', () => {
  const anchor = (timestamp: number, batchSize: number, bytes: number): ValidatorEvent => ({
    timestamp,
    round: 1,
    validatorId: 'v1',
    kind: 'anchor',
    batchSize,
    bytes,
  });

  it('buckets anchor events per minute and computes rolling rates', () => {
    // Bucketing floors each timestamp to its absolute UTC minute. NOW is a minute
    // boundary, so -20s and -30s straddle it into different minutes; these three
    // events therefore land in three distinct minute buckets.
    const events = [
      anchor(NOW - 30_000, 4, 400),
      anchor(NOW - 20_000, 6, 600),
      anchor(NOW - 90_000, 5, 500),
    ];
    const out = aggregateThroughput(events, NOW);
    // Three distinct minute buckets, emitted oldest first.
    expect(out.series).toHaveLength(3);
    expect(out.series[0].bucketStart).toBeLessThan(out.series[1].bucketStart);
    expect(out.series[1].bucketStart).toBeLessThan(out.series[2].bucketStart);
    // Each event's tx count lands in its own bucket.
    expect(out.series.map((p) => p.txs).sort((a, b) => a - b)).toEqual([4, 5, 6]);
    // Total txs = 4+6+5 = 15 over a 10-minute window → 1.5 txs/min.
    expect(out.txsPerMin).toBeCloseTo(1.5);
    expect(out.bytesPerMin).toBeCloseTo(150);
  });

  it('groups multiple events that share an absolute minute bucket', () => {
    // A round minute boundary; both events fall strictly inside the same minute.
    const base = 1_700_000_040_000; // divisible by 60_000
    const events = [anchor(base + 5_000, 4, 400), anchor(base + 50_000, 6, 600)];
    const out = aggregateThroughput(events, base + 55_000);
    expect(out.series).toHaveLength(1);
    expect(out.series[0].txs).toBe(10);
    expect(out.series[0].bytes).toBe(1000);
  });

  it('excludes events outside the window and non-anchor events', () => {
    const events = [
      anchor(NOW - 60 * 60 * 1000, 9, 900), // an hour ago → excluded
      { timestamp: NOW, round: 1, validatorId: 'v1', kind: 'attest' } as ValidatorEvent,
      anchor(NOW - 10_000, 3, 300),
    ];
    const out = aggregateThroughput(events, NOW);
    expect(out.series).toHaveLength(1);
    expect(out.series[0].txs).toBe(3);
  });

  it('builds an ascending batch-size distribution', () => {
    const events = [
      anchor(NOW - 1_000, 2, 100),
      anchor(NOW - 2_000, 2, 100),
      anchor(NOW - 3_000, 5, 250),
    ];
    const out = aggregateThroughput(events, NOW);
    expect(out.batchSizeDistribution).toEqual([
      { size: 2, count: 2 },
      { size: 5, count: 1 },
    ]);
  });

  it('returns empty summary with no anchor events', () => {
    const out = aggregateThroughput([], NOW);
    expect(out.series).toHaveLength(0);
    expect(out.txsPerMin).toBe(0);
    expect(out.batchSizeDistribution).toHaveLength(0);
  });
});

describe('buildValidatorRows', () => {
  it('dedupes validators across nodes, keeping the most recent sample', () => {
    const s1: NodeStatus = {
      ...statusAt(NOW),
      nodeId: 'n1',
      validators: [{ id: 'v1', phase: 0.1, frequency: 1, lastSeen: NOW - 5000 }],
    };
    const s2: NodeStatus = {
      ...statusAt(NOW),
      nodeId: 'n2',
      validators: [{ id: 'v1', phase: 0.2, frequency: 1, lastSeen: NOW }],
    };
    const rows = buildValidatorRows([s1, s2], [], 16);
    expect(rows).toHaveLength(1);
    // The fresher sample (lastSeen NOW, phase 0.2) wins.
    expect(rows[0].phase).toBeCloseTo(0.2);
    expect(rows[0].lastSeen).toBe(NOW);
  });

  it('sorts rows by label and attaches attestation rate', () => {
    const s: NodeStatus = {
      ...statusAt(NOW),
      validators: [
        { id: 'b', label: 'Bravo', phase: 0, frequency: 1, lastSeen: NOW },
        { id: 'a', label: 'Alpha', phase: 0, frequency: 1, lastSeen: NOW },
      ],
    };
    const events: ValidatorEvent[] = [
      { timestamp: NOW, round: 1, validatorId: 'a', kind: 'attest' },
      { timestamp: NOW, round: 2, validatorId: 'a', kind: 'miss' },
    ];
    const rows = buildValidatorRows([s], events, 16);
    expect(rows.map((r) => r.label)).toEqual(['Alpha', 'Bravo']);
    expect(rows[0].attestationRate).toBeCloseTo(0.5);
    expect(rows[1].attestationRate).toBeNull();
  });

  it('falls back to a shortened id when label is absent', () => {
    const s: NodeStatus = {
      ...statusAt(NOW),
      validators: [{ id: '0x1234567890abcdef1234', phase: 0, frequency: 1, lastSeen: NOW }],
    };
    const rows = buildValidatorRows([s], [], 16);
    expect(rows[0].label).toBe(shortId('0x1234567890abcdef1234'));
  });
});

describe('shortId', () => {
  it('leaves short ids untouched', () => {
    expect(shortId('node-1')).toBe('node-1');
  });
  it('truncates long ids with an ellipsis', () => {
    expect(shortId('0x1234567890abcdef1234')).toBe('0x1234…1234');
  });
});
