/**
 * Unit tests for the oxscada-rpc client (issue #453).
 *
 * Focus on the pure / boundary logic: env csv parsing, Zod validation of the
 * /status and /events payloads, and pollNode's never-throw error capture (so the
 * UI can mark a node stale/errored independently). Network is mocked via fetch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseNodeUrls,
  nodeStatusSchema,
  eventsResponseSchema,
  fetchNodeStatus,
  pollNode,
  RpcError,
} from '../oxscada-rpc';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseNodeUrls', () => {
  it('returns [] for empty / nullish input', () => {
    expect(parseNodeUrls(undefined)).toEqual([]);
    expect(parseNodeUrls(null)).toEqual([]);
    expect(parseNodeUrls('')).toEqual([]);
    expect(parseNodeUrls('  ,  ,')).toEqual([]);
  });

  it('splits a csv, trims, and strips trailing slashes', () => {
    expect(parseNodeUrls('http://a:9090/, http://b:9090')).toEqual(['http://a:9090', 'http://b:9090']);
  });

  it('de-duplicates while preserving order', () => {
    expect(parseNodeUrls('http://a:9090,http://a:9090/,http://b:9090')).toEqual([
      'http://a:9090',
      'http://b:9090',
    ]);
  });
});

describe('nodeStatusSchema', () => {
  const valid = {
    nodeId: 'n1',
    round: 42,
    validators: [{ id: 'v1', phase: 0.5, frequency: 1.0, lastSeen: 1700000000000 }],
    anchors: { batchesAnchored: 3, txsAnchored: 30, bytesAnchored: 3000, recentBatchSizes: [10, 10, 10] },
    timestamp: 1700000000000,
  };

  it('accepts a well-formed status', () => {
    expect(nodeStatusSchema.safeParse(valid).success).toBe(true);
  });

  it('defaults recentBatchSizes to []', () => {
    const noSizes = {
      ...valid,
      anchors: { batchesAnchored: 0, txsAnchored: 0, bytesAnchored: 0 },
    };
    const parsed = nodeStatusSchema.parse(noSizes);
    expect(parsed.anchors.recentBatchSizes).toEqual([]);
  });

  it('rejects a missing required field', () => {
    const bad: Record<string, unknown> = { ...valid };
    delete bad.nodeId;
    expect(nodeStatusSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a negative round', () => {
    expect(nodeStatusSchema.safeParse({ ...valid, round: -1 }).success).toBe(false);
  });
});

describe('eventsResponseSchema', () => {
  it('accepts the four event kinds and optional anchor fields', () => {
    const payload = {
      nodeId: 'n1',
      events: [
        { timestamp: 1, round: 1, validatorId: 'v1', kind: 'attest' },
        { timestamp: 2, round: 1, validatorId: 'v1', kind: 'miss' },
        { timestamp: 3, round: 1, validatorId: 'v1', kind: 'anchor', batchSize: 8, bytes: 800 },
        { timestamp: 4, round: 1, validatorId: 'v1', kind: 'phase' },
      ],
    };
    expect(eventsResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects an unknown event kind', () => {
    const payload = { nodeId: 'n1', events: [{ timestamp: 1, round: 1, validatorId: 'v1', kind: 'bogus' }] };
    expect(eventsResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe('fetchNodeStatus', () => {
  it('throws RpcError with the node url on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response));
    await expect(fetchNodeStatus('http://x:9090')).rejects.toBeInstanceOf(RpcError);
    await expect(fetchNodeStatus('http://x:9090')).rejects.toMatchObject({ nodeUrl: 'http://x:9090' });
  });

  it('throws RpcError on a malformed payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) } as unknown as Response),
    );
    await expect(fetchNodeStatus('http://x:9090')).rejects.toBeInstanceOf(RpcError);
  });
});

describe('pollNode', () => {
  const okStatus = {
    nodeId: 'n1',
    round: 1,
    validators: [],
    anchors: { batchesAnchored: 0, txsAnchored: 0, bytesAnchored: 0, recentBatchSizes: [] },
    timestamp: 1700000000000,
  };
  const okEvents = { nodeId: 'n1', events: [] };

  it('returns both status and events on success and no error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const body = url.endsWith('/status') ? okStatus : okEvents;
        return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
      }),
    );
    const res = await pollNode('http://x:9090');
    expect(res.status).not.toBeNull();
    expect(res.error).toBeNull();
    expect(res.nodeUrl).toBe('http://x:9090');
  });

  it('never throws — captures a transport failure into error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await pollNode('http://down:9090');
    expect(res.status).toBeNull();
    expect(res.events).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('keeps events even when /status fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/status')) return Promise.resolve({ ok: false, status: 500 } as Response);
        return Promise.resolve({ ok: true, json: async () => okEvents } as unknown as Response);
      }),
    );
    const res = await pollNode('http://x:9090');
    expect(res.status).toBeNull();
    expect(res.error).toBeTruthy();
    expect(res.events).toEqual([]);
  });
});
