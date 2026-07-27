/**
 * Unit tests for the PURE validator-dashboard presentation logic (issue #453).
 *
 * Covers stale detection against the client clock, clock-discipline helpers
 * (server clock vs node clock), the coherence threshold, and the
 * self-reported-vs-derived order-parameter cross-check that exists because node
 * reports are unsigned.
 */

import { describe, it, expect } from 'vitest';
import {
  STALE_THRESHOLD_MS,
  COHERENCE_RED_THRESHOLD,
  classifyNodeHealth,
  formatAge,
  isCoherenceCritical,
  nodeSampleLagMs,
  orderParameterDivergence,
  shortId,
  validatorSampleAgeMs,
} from '../validator-metrics';
import type {
  ValidatorNodeView,
  ValidatorOverview,
} from '@shared/types/services/validator-dashboard';

const NOW = 1_700_000_000_000;

function nodeView(over: Partial<ValidatorNodeView> = {}): ValidatorNodeView {
  return {
    label: 'node-a:9090',
    reachable: true,
    error: null,
    observedAt: NOW,
    status: {
      nodeId: 'node-a',
      height: 10,
      role: 'validator',
      reportedOrderParameter: 0.98,
      reportedMeanPhase: 1.2,
      localPhase: 1.19,
      peers: 1,
      mempool: 0,
      uptimeTicks: 5,
      peerPhases: [],
    },
    ...over,
  };
}

function overviewWith(nodes: ValidatorNodeView[], r: number): ValidatorOverview {
  return {
    configured: true,
    generatedAt: NOW,
    cached: false,
    provenance: { verified: false, method: 'none', detail: 'unsigned' },
    nodes,
    validators: [],
    coherence: { r, meanPhase: 0, count: nodes.length },
    unavailableMetrics: [],
  };
}

describe('classifyNodeHealth', () => {
  it('is live for a reachable node with a fresh overview', () => {
    expect(classifyNodeHealth(nodeView(), 0)).toBe('live');
  });

  it('turns stale strictly under 10s so a dead validator surfaces in time', () => {
    expect(STALE_THRESHOLD_MS).toBeLessThan(10_000);
    expect(classifyNodeHealth(nodeView(), STALE_THRESHOLD_MS)).toBe('stale');
  });

  it('stays live one millisecond before the threshold', () => {
    expect(classifyNodeHealth(nodeView(), STALE_THRESHOLD_MS - 1)).toBe('live');
  });

  it('reports error when the server could not reach the node, however fresh', () => {
    expect(classifyNodeHealth(nodeView({ reachable: false, status: null }), 0)).toBe('error');
  });

  it('keeps error precedence over staleness', () => {
    expect(classifyNodeHealth({ reachable: false }, 60_000)).toBe('error');
  });
});

describe('nodeSampleLagMs', () => {
  it('measures a node sample against the aggregate on the same (server) clock', () => {
    expect(nodeSampleLagMs({ generatedAt: NOW }, { observedAt: NOW - 1500 })).toBe(1500);
  });

  it('clamps negative skew to zero', () => {
    expect(nodeSampleLagMs({ generatedAt: NOW }, { observedAt: NOW + 5000 })).toBe(0);
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

describe('validatorSampleAgeMs', () => {
  it('converts the node-reported unix SECONDS into an age in millis', () => {
    const tenSecondsAgo = NOW / 1000 - 10;
    expect(validatorSampleAgeMs({ lastUpdatedUnixSeconds: tenSecondsAgo }, NOW)).toBe(10_000);
  });

  it('returns null when the node did not timestamp the sample', () => {
    // /status has no per-oscillator timestamp for a node's own local_phase.
    expect(validatorSampleAgeMs({ lastUpdatedUnixSeconds: null }, NOW)).toBeNull();
  });

  it('clamps a node clock running ahead of the server to zero', () => {
    expect(validatorSampleAgeMs({ lastUpdatedUnixSeconds: NOW / 1000 + 60 }, NOW)).toBe(0);
  });
});

describe('isCoherenceCritical', () => {
  it('flags below the default threshold and not at or above it', () => {
    expect(isCoherenceCritical(COHERENCE_RED_THRESHOLD - 0.01)).toBe(true);
    expect(isCoherenceCritical(COHERENCE_RED_THRESHOLD)).toBe(false);
    expect(isCoherenceCritical(0.99)).toBe(false);
  });

  it('respects a custom threshold', () => {
    expect(isCoherenceCritical(0.85, 0.9)).toBe(true);
  });
});

describe('orderParameterDivergence', () => {
  it('returns null when no reachable node reported an order parameter', () => {
    const overview = overviewWith([nodeView({ reachable: false, status: null })], 0.9);
    expect(orderParameterDivergence(overview)).toBeNull();
  });

  it('reports the worst gap between a node’s claim and the derived value', () => {
    const overview = overviewWith(
      [
        nodeView(),
        nodeView({
          label: 'node-b:9090',
          status: { ...nodeView().status!, nodeId: 'node-b', reportedOrderParameter: 0.5 },
        }),
      ],
      0.98,
    );
    // node-b claims 0.5 while the phases it published derive to 0.98.
    expect(orderParameterDivergence(overview)).toBeCloseTo(0.48, 6);
  });

  it('is ~0 when every node’s claim matches the derived value', () => {
    expect(orderParameterDivergence(overviewWith([nodeView()], 0.98))).toBeCloseTo(0, 6);
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
