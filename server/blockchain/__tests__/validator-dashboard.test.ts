/**
 * Unit tests for the Validator Dashboard server-side aggregation (issue #453).
 *
 * Covers the properties the review demanded:
 *   - the server, not the browser, owns node URLs and only speaks http(s)
 *   - outbound work is bounded: timeout, byte cap, concurrency cap, no retry
 *   - a slow or hostile node degrades to one errored row instead of hanging
 *   - provenance is reported as UNVERIFIED and never silently upgraded
 *   - metrics the node RPC cannot supply are declared, not synthesised
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_NODES,
  PHASE_DISAGREEMENT_RADIANS,
  UNAVAILABLE_METRICS,
  _resetValidatorDashboardCache,
  buildOverview,
  collectValidatorOverview,
  getValidatorOverview,
  kuramotoCoherence,
  loadValidatorDashboardConfig,
  mapWithConcurrency,
  mergeValidatorPhases,
  nodeLabel,
  parseNodeUrls,
  pollNodeStatus,
  toPhaseSamples,
  type DashboardFetch,
  type ValidatorDashboardConfig,
} from '../validator-dashboard';
import type {
  ValidatorNodeView,
  ValidatorPhaseSample,
} from '@shared/types/services/validator-dashboard';

const NOW = 1_700_000_000_000;

/** A payload in the authoritative 0xSCADA-node /status shape. */
function nodeStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'node-a',
    height: 1042,
    role: 'validator',
    order_parameter: 0.97,
    mean_phase: 1.234,
    local_phase: 1.229,
    peer_phases: [
      { node_id: 'node-b', phase: 1.24, natural_freq: 0.5, last_updated: 1_699_999_990 },
    ],
    peers: 2,
    mempool: 7,
    uptime_ticks: 123_456,
    ...overrides,
  };
}

function jsonFetch(payload: unknown, init: ResponseInit = {}): DashboardFetch {
  return () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200, ...init }));
}

afterEach(() => {
  _resetValidatorDashboardCache();
  vi.restoreAllMocks();
});

// ── Configuration ──────────────────────────────────────────────────────────

describe('parseNodeUrls', () => {
  it('returns [] for empty / nullish input', () => {
    expect(parseNodeUrls(undefined)).toEqual([]);
    expect(parseNodeUrls(null)).toEqual([]);
    expect(parseNodeUrls('')).toEqual([]);
    expect(parseNodeUrls(' , , ')).toEqual([]);
  });

  it('normalises, trims and de-duplicates while preserving order', () => {
    expect(parseNodeUrls('http://a:9090/, http://b:9090 , http://a:9090')).toEqual([
      'http://a:9090',
      'http://b:9090',
    ]);
  });

  it('drops non-http(s) schemes so a typo cannot become a file read', () => {
    expect(parseNodeUrls('file:///etc/passwd,data:text/plain;base64,AA,http://ok:9090')).toEqual([
      'http://ok:9090',
    ]);
  });

  it('drops unparseable entries instead of throwing', () => {
    expect(parseNodeUrls('not a url,http://ok:9090')).toEqual(['http://ok:9090']);
  });

  it('caps the node count regardless of how long the env value is', () => {
    const csv = Array.from({ length: MAX_NODES + 10 }, (_, i) => `http://n${i}:9090`).join(',');
    expect(parseNodeUrls(csv)).toHaveLength(MAX_NODES);
  });
});

describe('nodeLabel', () => {
  it('exposes host[:port] only — no scheme and no path', () => {
    expect(nodeLabel('http://validator-1.internal:9090')).toBe('validator-1.internal:9090');
    expect(nodeLabel('https://v2.example.com/rpc')).toBe('v2.example.com');
  });
});

describe('loadValidatorDashboardConfig', () => {
  it('defaults to no nodes, so nothing is polled until an operator opts in', () => {
    const config = loadValidatorDashboardConfig({});
    expect(config.nodeUrls).toEqual([]);
    expect(config.timeoutMs).toBe(3000);
    expect(config.maxConcurrency).toBe(4);
  });

  it('clamps hostile / absurd values into the supported range', () => {
    const high = loadValidatorDashboardConfig({
      VALIDATOR_RPC_TIMEOUT_MS: '99999999',
      VALIDATOR_RPC_MAX_CONCURRENCY: '10000',
      VALIDATOR_RPC_CACHE_TTL_MS: '99999999',
    });
    expect(high.timeoutMs).toBe(10_000);
    expect(high.maxConcurrency).toBe(16);
    expect(high.cacheTtlMs).toBe(60_000);

    const low = loadValidatorDashboardConfig({
      VALIDATOR_RPC_TIMEOUT_MS: '-5',
      VALIDATOR_RPC_MAX_CONCURRENCY: '0',
      VALIDATOR_RPC_CACHE_TTL_MS: '-1',
    });
    expect(low.timeoutMs).toBe(250);
    expect(low.maxConcurrency).toBe(1);
    expect(low.cacheTtlMs).toBe(0);
  });

  it('falls back to defaults for non-numeric values', () => {
    const config = loadValidatorDashboardConfig({ VALIDATOR_RPC_TIMEOUT_MS: 'soon' });
    expect(config.timeoutMs).toBe(3000);
  });
});

// ── Bounded transport ──────────────────────────────────────────────────────

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    const out = await mapWithConcurrency(items, 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it('treats a zero/negative limit as one worker rather than spawning none', async () => {
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(out).toEqual([1, 2]);
  });
});

describe('pollNodeStatus', () => {
  it('maps a real /status payload onto the dashboard view', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      fetchImpl: jsonFetch(nodeStatusPayload()),
      now: () => NOW,
    });

    expect(view.reachable).toBe(true);
    expect(view.error).toBeNull();
    expect(view.label).toBe('node-a:9090');
    expect(view.observedAt).toBe(NOW);
    expect(view.status).toMatchObject({
      nodeId: 'node-a',
      height: 1042,
      role: 'validator',
      reportedOrderParameter: 0.97,
      localPhase: 1.229,
      peers: 2,
      mempool: 7,
      uptimeTicks: 123_456,
    });
    expect(view.status?.peerPhases).toEqual([
      { nodeId: 'node-b', phase: 1.24, naturalFrequency: 0.5, lastUpdatedUnixSeconds: 1_699_999_990 },
    ]);
  });

  it('requests exactly /status on the configured base URL', async () => {
    const spy = vi.fn(jsonFetch(nodeStatusPayload()));
    await pollNodeStatus('http://node-a:9090', { timeoutMs: 1000, fetchImpl: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('http://node-a:9090/status');
  });

  it('captures a non-2xx response instead of throwing', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 503 })),
    });
    expect(view.reachable).toBe(false);
    expect(view.status).toBeNull();
    expect(view.error).toContain('503');
  });

  it('captures a schema-drifted payload instead of throwing', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      fetchImpl: jsonFetch({ node_id: 'a' }),
    });
    expect(view.reachable).toBe(false);
    expect(view.error).toBeTruthy();
  });

  it('captures invalid JSON instead of throwing', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      fetchImpl: () => Promise.resolve(new Response('{{{', { status: 200 })),
    });
    expect(view.reachable).toBe(false);
    expect(view.error).toBeTruthy();
  });

  it('rejects an oversized body declared through content-length', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      maxResponseBytes: 64,
      fetchImpl: jsonFetch(nodeStatusPayload(), { headers: { 'content-length': '999999' } }),
    });
    expect(view.reachable).toBe(false);
    expect(view.error).toContain('cap');
  });

  it('aborts a streamed body that exceeds the cap even without content-length', async () => {
    // A hostile node that answers fast and then never stops. Without the byte
    // cap only the timeout would bound this, which is long enough to stream a
    // great deal of memory into the process.
    let chunksSent = 0;
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });

    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 5000,
      maxResponseBytes: 4096,
      fetchImpl: () => Promise.resolve(new Response(flood, { status: 200 })),
    });

    expect(view.reachable).toBe(false);
    expect(view.error).toContain('cap');
    // Bounded: the read stopped shortly after crossing 4 KiB, not at infinity.
    expect(chunksSent).toBeLessThan(64);
  });

  it('times out a hanging node and makes exactly one attempt (no retry)', async () => {
    const fetchImpl = vi.fn<DashboardFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );

    const started = Date.now();
    const view = await pollNodeStatus('http://slow:9090', { timeoutMs: 30, fetchImpl });

    expect(view.reachable).toBe(false);
    expect(view.status).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('truncates a node-controlled error message', async () => {
    const view = await pollNodeStatus('http://node-a:9090', {
      timeoutMs: 1000,
      fetchImpl: () => Promise.reject(new Error('x'.repeat(5000))),
    });
    expect(view.error?.length).toBeLessThanOrEqual(200);
  });
});

// ── Pure aggregation ───────────────────────────────────────────────────────

describe('kuramotoCoherence', () => {
  it('returns r=0 for an empty set', () => {
    expect(kuramotoCoherence([]).r).toBe(0);
  });

  it('returns r=1 for perfectly aligned phases', () => {
    const out = kuramotoCoherence([1.2, 1.2, 1.2]);
    expect(out.r).toBeCloseTo(1, 6);
    expect(out.count).toBe(3);
  });

  it('returns r≈0 for anti-phase oscillators', () => {
    expect(kuramotoCoherence([0, Math.PI]).r).toBeCloseTo(0, 6);
  });

  it('is rotation-invariant and tracks the cluster mean phase', () => {
    const a = kuramotoCoherence([0, 0.1, -0.1]);
    const b = kuramotoCoherence([1, 1.1, 0.9]);
    expect(a.r).toBeCloseTo(b.r, 6);
    expect(b.meanPhase).toBeCloseTo(1, 6);
  });
});

describe('toPhaseSamples', () => {
  const view: ValidatorNodeView = {
    label: 'node-a:9090',
    reachable: true,
    error: null,
    observedAt: NOW,
    status: {
      nodeId: 'node-a',
      height: 1,
      role: 'validator',
      reportedOrderParameter: 0.9,
      reportedMeanPhase: 1,
      localPhase: 1.229,
      peers: 1,
      mempool: 0,
      uptimeTicks: 1,
      peerPhases: [
        { nodeId: 'node-b', phase: 1.24, naturalFrequency: 0.5, lastUpdatedUnixSeconds: 1_699_999_990 },
      ],
    },
  };

  it('emits the reporting node itself plus every peer', () => {
    const samples = toPhaseSamples(view);
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({ id: 'node-a', phase: 1.229, self: true });
    expect(samples[1]).toMatchObject({ id: 'node-b', phase: 1.24, self: false });
  });

  it('leaves the self entry without invented frequency or timestamp', () => {
    // /status exposes local_phase but no local natural_freq / last_updated.
    const self = toPhaseSamples(view)[0];
    expect(self.naturalFrequency).toBeNull();
    expect(self.lastUpdatedUnixSeconds).toBeNull();
  });

  it('emits nothing for an unreachable node', () => {
    expect(toPhaseSamples({ ...view, reachable: false, status: null })).toEqual([]);
  });
});

describe('mergeValidatorPhases', () => {
  const sample = (over: Partial<ValidatorPhaseSample>): ValidatorPhaseSample => ({
    id: 'v1',
    phase: 1,
    naturalFrequency: 0.5,
    lastUpdatedUnixSeconds: 100,
    self: false,
    reportedBy: 'node-a:9090',
    ...over,
  });

  it('dedupes by id and keeps the freshest sample', () => {
    const rows = mergeValidatorPhases([
      sample({ phase: 1.0, lastUpdatedUnixSeconds: 100, reportedBy: 'node-a:9090' }),
      sample({ phase: 1.01, lastUpdatedUnixSeconds: 200, reportedBy: 'node-b:9090' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBeCloseTo(1.01);
    expect(rows[0].reportedBy).toEqual(['node-a:9090', 'node-b:9090']);
  });

  it('flags disagreement instead of averaging conflicting reports away', () => {
    const rows = mergeValidatorPhases([
      sample({ phase: 0, lastUpdatedUnixSeconds: 100, reportedBy: 'node-a:9090' }),
      sample({ phase: 3, lastUpdatedUnixSeconds: 200, reportedBy: 'node-b:9090' }),
    ]);
    expect(rows[0].disputed).toBe(true);
  });

  it('does not flag agreement within the tolerance', () => {
    const rows = mergeValidatorPhases([
      sample({ phase: 1, reportedBy: 'node-a:9090' }),
      sample({ phase: 1 + PHASE_DISAGREEMENT_RADIANS / 2, reportedBy: 'node-b:9090' }),
    ]);
    expect(rows[0].disputed).toBe(false);
  });

  it('prefers a node’s first-hand report when timestamps cannot decide', () => {
    const rows = mergeValidatorPhases([
      sample({ id: 'node-a', phase: 9, lastUpdatedUnixSeconds: null, self: false, reportedBy: 'node-b:9090' }),
      sample({ id: 'node-a', phase: 2, lastUpdatedUnixSeconds: null, self: true, reportedBy: 'node-a:9090' }),
    ]);
    expect(rows[0].phase).toBe(2);
  });

  it('sorts rows by validator id', () => {
    const rows = mergeValidatorPhases([sample({ id: 'zz' }), sample({ id: 'aa' })]);
    expect(rows.map((r) => r.id)).toEqual(['aa', 'zz']);
  });
});

describe('buildOverview', () => {
  it('reports UNVERIFIED provenance and never claims verification', () => {
    const overview = buildOverview([], { configured: true, generatedAt: NOW, cached: false });
    expect(overview.provenance.verified).toBe(false);
    expect(overview.provenance.method).toBe('none');
    expect(overview.provenance.detail).toMatch(/unsigned/i);
  });

  it('declares the metrics the node RPC cannot supply instead of synthesising them', () => {
    const overview = buildOverview([], { configured: true, generatedAt: NOW, cached: false });
    expect(overview.unavailableMetrics.map((m) => m.metric)).toEqual(
      UNAVAILABLE_METRICS.map((m) => m.metric),
    );
    expect(overview.unavailableMetrics.length).toBeGreaterThan(0);
  });
});

// ── Collection + cache ─────────────────────────────────────────────────────

const twoNodeConfig: ValidatorDashboardConfig = {
  nodeUrls: ['http://node-a:9090', 'http://node-b:9090'],
  timeoutMs: 1000,
  maxConcurrency: 2,
  cacheTtlMs: 5000,
};

describe('collectValidatorOverview', () => {
  it('makes no outbound request when no nodes are configured', async () => {
    const fetchImpl = vi.fn<DashboardFetch>(jsonFetch(nodeStatusPayload()));
    const overview = await collectValidatorOverview({
      config: { ...twoNodeConfig, nodeUrls: [] },
      fetchImpl,
      now: () => NOW,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(overview.configured).toBe(false);
    expect(overview.nodes).toEqual([]);
    expect(overview.validators).toEqual([]);
  });

  it('aggregates every reachable node and derives coherence from merged phases', async () => {
    const fetchImpl: DashboardFetch = (url) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.startsWith('http://node-a')
              ? nodeStatusPayload()
              : nodeStatusPayload({
                  node_id: 'node-b',
                  local_phase: 1.24,
                  peer_phases: [
                    { node_id: 'node-a', phase: 1.229, natural_freq: 0.4, last_updated: 1_699_999_995 },
                  ],
                }),
          ),
          { status: 200 },
        ),
      );

    const overview = await collectValidatorOverview({
      config: twoNodeConfig,
      fetchImpl,
      now: () => NOW,
    });

    expect(overview.configured).toBe(true);
    expect(overview.nodes.map((n) => n.label)).toEqual(['node-a:9090', 'node-b:9090']);
    expect(overview.validators.map((v) => v.id)).toEqual(['node-a', 'node-b']);
    // Both phases are ~1.23 rad apart by 0.011 → near-perfect coherence.
    expect(overview.coherence.count).toBe(2);
    expect(overview.coherence.r).toBeGreaterThan(0.99);
  });

  it('degrades one dead node into an errored row without failing the request', async () => {
    const fetchImpl: DashboardFetch = (url) =>
      url.startsWith('http://node-a')
        ? Promise.resolve(new Response(JSON.stringify(nodeStatusPayload()), { status: 200 }))
        : Promise.reject(new Error('ECONNREFUSED'));

    const overview = await collectValidatorOverview({
      config: twoNodeConfig,
      fetchImpl,
      now: () => NOW,
    });

    expect(overview.nodes[0].reachable).toBe(true);
    expect(overview.nodes[1].reachable).toBe(false);
    expect(overview.nodes[1].error).toContain('ECONNREFUSED');
    // The reachable node's data still renders.
    expect(overview.validators.length).toBeGreaterThan(0);
  });
});

describe('getValidatorOverview caching', () => {
  it('serves a second call from cache instead of re-polling the fleet', async () => {
    const fetchImpl = vi.fn<DashboardFetch>(jsonFetch(nodeStatusPayload()));
    let clock = NOW;

    const first = await getValidatorOverview({
      config: twoNodeConfig,
      fetchImpl,
      now: () => clock,
    });
    expect(first.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 100;
    const second = await getValidatorOverview({
      config: twoNodeConfig,
      fetchImpl,
      now: () => clock,
    });
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent requests into a single fleet poll', async () => {
    const fetchImpl = vi.fn<DashboardFetch>(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(new Response(JSON.stringify(nodeStatusPayload()), { status: 200 })),
            5,
          ),
        ),
    );

    const [a, b, c] = await Promise.all([
      getValidatorOverview({ config: twoNodeConfig, fetchImpl, now: () => NOW }),
      getValidatorOverview({ config: twoNodeConfig, fetchImpl, now: () => NOW }),
      getValidatorOverview({ config: twoNodeConfig, fetchImpl, now: () => NOW }),
    ]);

    // Two nodes polled once between them, not six times.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(a.generatedAt).toBe(b.generatedAt);
    expect(b.generatedAt).toBe(c.generatedAt);
  });

  it('re-polls once the cache expires', async () => {
    const fetchImpl = vi.fn<DashboardFetch>(jsonFetch(nodeStatusPayload()));
    let clock = NOW;
    const config = { ...twoNodeConfig, cacheTtlMs: 1000 };

    await getValidatorOverview({ config, fetchImpl, now: () => clock });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    clock += 1001;
    const refreshed = await getValidatorOverview({ config, fetchImpl, now: () => clock });
    expect(refreshed.cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
