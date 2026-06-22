/**
 * Anchor Router — Projection & Dispatch Unit Tests (#455)
 *
 * Covers the PURE projection function (events/min routing, confirmation latency,
 * daily anchor cost) and the runtime router's backend-flip + fan-out dispatch.
 */

import { describe, it, expect } from 'vitest';
import {
  projectSwitch,
  backendsFor,
  parseBackendEnv,
  AnchorRouter,
  DEFAULT_BACKEND_PROFILES,
  type AnchorBackend,
} from '../bridge/anchor-router';

const MINUTES_PER_DAY = 60 * 24;

describe('backendsFor', () => {
  it('maps single backends to themselves', () => {
    expect(backendsFor('l2')).toEqual(['l2']);
    expect(backendsFor('node')).toEqual(['node']);
  });

  it('fans "both" out to l2 and node', () => {
    expect(backendsFor('both')).toEqual(['l2', 'node']);
  });
});

describe('parseBackendEnv', () => {
  it('accepts valid values', () => {
    expect(parseBackendEnv('l2')).toBe('l2');
    expect(parseBackendEnv('node')).toBe('node');
    expect(parseBackendEnv('both')).toBe('both');
  });

  it('defaults to node for unset/invalid values', () => {
    expect(parseBackendEnv(undefined)).toBe('node');
    expect(parseBackendEnv('')).toBe('node');
    expect(parseBackendEnv('garbage')).toBe('node');
  });
});

describe('projectSwitch', () => {
  it('routes the full stream to a single backend (l2)', () => {
    const epm = 120;
    const p = projectSwitch({ backend: 'l2', eventsPerMinute: epm });

    expect(p.backend).toBe('l2');
    expect(p.totalEventsPerMinute).toBe(epm);
    expect(p.routes).toHaveLength(1);

    const l2 = p.routes[0];
    expect(l2.backend).toBe('l2');
    expect(l2.eventsPerMinute).toBe(epm); // full stream, not split
    expect(l2.confirmationLatencyMs).toBe(DEFAULT_BACKEND_PROFILES.l2.confirmationLatencyMs);

    const expectedDaily =
      Math.round(epm * MINUTES_PER_DAY * DEFAULT_BACKEND_PROFILES.l2.costPerEventUsd * 100) / 100;
    expect(l2.dailyCostUsd).toBe(expectedDaily);
    expect(p.totalDailyCostUsd).toBe(expectedDaily);
    expect(p.effectiveConfirmationLatencyMs).toBe(DEFAULT_BACKEND_PROFILES.l2.confirmationLatencyMs);
  });

  it('node backend is free and fast by default', () => {
    const p = projectSwitch({ backend: 'node', eventsPerMinute: 500 });
    expect(p.routes).toHaveLength(1);
    expect(p.routes[0].dailyCostUsd).toBe(0);
    expect(p.totalDailyCostUsd).toBe(0);
    expect(p.effectiveConfirmationLatencyMs).toBe(DEFAULT_BACKEND_PROFILES.node.confirmationLatencyMs);
  });

  it('fans "both" out so EACH backend sees the full stream (not load-balanced)', () => {
    const epm = 240;
    const p = projectSwitch({ backend: 'both', eventsPerMinute: epm });

    expect(p.routes).toHaveLength(2);
    for (const r of p.routes) {
      expect(r.eventsPerMinute).toBe(epm); // fan-out, both see full stream
    }
    // total daily cost = sum of both backends' daily costs
    const sum = p.routes.reduce((a, r) => a + r.dailyCostUsd, 0);
    expect(p.totalDailyCostUsd).toBeCloseTo(sum, 2);
  });

  it('uses the SLOWER backend latency as effective latency for "both"', () => {
    const p = projectSwitch({ backend: 'both', eventsPerMinute: 100 });
    const slowest = Math.max(
      DEFAULT_BACKEND_PROFILES.l2.confirmationLatencyMs,
      DEFAULT_BACKEND_PROFILES.node.confirmationLatencyMs,
    );
    expect(p.effectiveConfirmationLatencyMs).toBe(slowest);
  });

  it('respects profile overrides', () => {
    const p = projectSwitch({
      backend: 'l2',
      eventsPerMinute: 60, // => 86400 events/day
      profiles: { l2: { costPerEventUsd: 0.001, confirmationLatencyMs: 30_000 } },
    });
    // 60 * 1440 = 86400 events/day * 0.001 = 86.40 USD
    expect(p.routes[0].dailyCostUsd).toBe(86.4);
    expect(p.routes[0].confirmationLatencyMs).toBe(30_000);
  });

  it('handles zero throughput (no cost, no events)', () => {
    const p = projectSwitch({ backend: 'both', eventsPerMinute: 0 });
    expect(p.totalDailyCostUsd).toBe(0);
    for (const r of p.routes) {
      expect(r.eventsPerMinute).toBe(0);
      expect(r.dailyCostUsd).toBe(0);
    }
  });

  it('rejects negative or non-finite throughput', () => {
    expect(() => projectSwitch({ backend: 'l2', eventsPerMinute: -1 })).toThrow();
    expect(() => projectSwitch({ backend: 'l2', eventsPerMinute: Number.NaN })).toThrow();
    expect(() => projectSwitch({ backend: 'l2', eventsPerMinute: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('AnchorRouter', () => {
  it('defaults backend from explicit option', () => {
    const r = new AnchorRouter({ backend: 'l2' });
    expect(r.getBackend()).toBe('l2');
  });

  it('setBackend flips and returns previous + current', () => {
    const r = new AnchorRouter({ backend: 'node' });
    const result = r.setBackend('both');
    expect(result.previous).toBe('node');
    expect(result.current).toBe('both');
    expect(r.getBackend()).toBe('both');
  });

  it('project() uses the active backend by default', () => {
    const r = new AnchorRouter({ backend: 'l2' });
    const p = r.project(120);
    expect(p.backend).toBe('l2');
  });

  it('dispatch fans out to every active backend for "both"', async () => {
    const r = new AnchorRouter({ backend: 'both' });
    const result = await r.dispatch([{ id: 'evt-12345678' }, { id: 'evt-2' }]);
    expect(result.backend).toBe('both');
    expect(result.acks).toHaveLength(2);
    expect(result.acks.map((a) => a.backend).sort()).toEqual(['l2', 'node']);
    for (const ack of result.acks) {
      expect(ack.eventCount).toBe(2);
      expect(ack.ref).toContain(ack.backend);
    }
  });

  it('dispatch to a single backend produces one ack', async () => {
    const r = new AnchorRouter({ backend: 'node' });
    const result = await r.dispatch([{ id: 'evt-1' }]);
    expect(result.acks).toHaveLength(1);
    expect(result.acks[0].backend).toBe('node');
  });

  it('dispatch handles an empty batch', async () => {
    const r = new AnchorRouter({ backend: 'l2' });
    const result = await r.dispatch([]);
    expect(result.acks).toHaveLength(1);
    expect(result.acks[0].eventCount).toBe(0);
    expect(result.acks[0].ref).toContain('empty');
  });
});

// Type-level sanity: the union is exhaustive (compile-time guard).
const _allBackends: AnchorBackend[] = ['l2', 'node', 'both'];
void _allBackends;
