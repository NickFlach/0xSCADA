/**
 * Bounded-execution proofs for the NL process query surface (#216).
 *
 * The rebuild brief requires that "query execution should be bounded (result
 * caps, timeouts) before this surface returns". Every named constant in
 * `server/services/nlquery/limits.ts` gets a test here that proves the bound
 * actually holds — not that the constant exists.
 *
 * Contract: docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

import type {
  ActiveAlarmPage,
  HistorySlice,
  NLQueryDataPort,
  PortResult,
  TagCatalogue,
  TagReading,
} from '@shared/types/nl-query';
import { _resetControlPlaneAuthCache } from '../../../middleware/control-plane-auth';
import { intelligenceRoutes } from '../../../routes/intelligence';
import { NLQueryEngine } from '../engine';
import {
  MAX_ALARM_SCAN,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_PAGE,
  MAX_HISTORY_SAMPLES,
  MAX_QUERY_LENGTH,
  MAX_RESOLVER_CANDIDATE_TAGS,
  MAX_RESULT_ITEMS,
  MAX_TREND_WINDOW_MS,
  QUERY_TIMEOUT_MS,
} from '../limits';
import { parseIntent } from '../parser';

/** Records the caps the engine actually pushes down to the port. */
interface RecordedCalls {
  listTagsLimit: number[];
  historyMaxSamples: number[];
  alarmLimit: number[];
}

interface FakePortOptions {
  tags?: string[];
  catalogueTruncated?: boolean;
  history?: TagReading[];
  historyTruncated?: boolean;
  alarms?: ActiveAlarmPage['alarms'];
  alarmsTruncated?: boolean;
  latest?: TagReading | null;
  /** Delay every read by this many ms, to exercise the timeout. */
  delayMs?: number;
}

function fakePort(options: FakePortOptions = {}): {
  port: NLQueryDataPort;
  calls: RecordedCalls;
} {
  const calls: RecordedCalls = {
    listTagsLimit: [],
    historyMaxSamples: [],
    alarmLimit: [],
  };
  const wait = async (): Promise<void> => {
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  };

  const port: NLQueryDataPort = {
    async listTags(limit): Promise<PortResult<TagCatalogue>> {
      calls.listTagsLimit.push(limit);
      await wait();
      const tags = options.tags ?? [];
      return {
        available: true,
        value: {
          tagIds: tags.slice(0, limit),
          truncated: options.catalogueTruncated ?? tags.length > limit,
        },
      };
    },
    async readLatest(): Promise<PortResult<TagReading | null>> {
      await wait();
      return { available: true, value: options.latest ?? null };
    },
    async readHistory(_tagId, _start, _end, maxSamples): Promise<PortResult<HistorySlice>> {
      calls.historyMaxSamples.push(maxSamples);
      await wait();
      return {
        available: true,
        value: {
          samples: options.history ?? [],
          truncated: options.historyTruncated ?? false,
        },
      };
    },
    async listActiveAlarms(limit): Promise<PortResult<ActiveAlarmPage>> {
      calls.alarmLimit.push(limit);
      await wait();
      return {
        available: true,
        value: {
          alarms: options.alarms ?? [],
          truncated: options.alarmsTruncated ?? false,
        },
      };
    },
  };
  return { port, calls };
}

function reading(tagId: string, value: number, timestamp: number): TagReading {
  return { tagId, value, timestamp, source: 'historian' };
}

// ── MAX_QUERY_LENGTH ───────────────────────────────────────────────────────

describe('MAX_QUERY_LENGTH', () => {
  let server: Server;
  let baseUrl: string;
  const originalApiKeys = process.env.API_KEYS;
  const auth = { 'x-api-key': 'nlq-key', 'content-type': 'application/json' };

  beforeAll(async () => {
    process.env.API_KEYS = 'nlq-key:nlq-reader:nlquery.read';
    _resetControlPlaneAuthCache();
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/intelligence', intelligenceRoutes);
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    _resetControlPlaneAuthCache();
  });

  it('accepts a query exactly at the limit', async () => {
    const res = await fetch(`${baseUrl}/api/intelligence/nlquery`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ query: `show ${'a'.repeat(MAX_QUERY_LENGTH - 5)}` }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects one character over the limit with 400 — and does NOT truncate', async () => {
    const oversized = 'x'.repeat(MAX_QUERY_LENGTH + 1);
    const res = await fetch(`${baseUrl}/api/intelligence/nlquery`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ query: oversized }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; limits: { maxQueryLength: number } };
    expect(body.error).toBe('invalid_request');
    expect(body.limits.maxQueryLength).toBe(MAX_QUERY_LENGTH);
  });

  it('rejects an empty query rather than answering a question nobody asked', async () => {
    const res = await fetch(`${baseUrl}/api/intelligence/nlquery`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('caps GET /nlquery/history at MAX_HISTORY_PAGE', async () => {
    const res = await fetch(
      `${baseUrl}/api/intelligence/nlquery/history?limit=${MAX_HISTORY_PAGE + 1}`,
      { headers: { 'x-api-key': 'nlq-key' } },
    );
    expect(res.status).toBe(400);
  });

  it('reports history as process-local, not persisted', async () => {
    const res = await fetch(`${baseUrl}/api/intelligence/nlquery/history`, {
      headers: { 'x-api-key': 'nlq-key' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persistence: string; persistenceNote: string };
    expect(body.persistence).toBe('process-local');
    expect(body.persistenceNote).toMatch(/lost on restart/i);
  });
});

// ── QUERY_TIMEOUT_MS ───────────────────────────────────────────────────────

describe('QUERY_TIMEOUT_MS', () => {
  it('returns an explicit, unsuccessful timeout answer rather than hanging', async () => {
    const { port } = fakePort({ tags: ['TANK-3.PRESSURE'], delayMs: 200 });
    const engine = new NLQueryEngine({ dataPort: port, timeoutMs: 20 });

    const result = await engine.execute('What is the pressure in tank 3?');

    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/time limit/i);
    expect(result.data).toMatchObject({ timedOut: true, timeoutMs: 20 });
    // The critical property: no value is reported when the read did not finish.
    expect(result.answer).not.toMatch(/\bis \d/);
  });

  it('does not time out a fast query', async () => {
    const { port } = fakePort({ tags: ['TANK-3.PRESSURE'] });
    const engine = new NLQueryEngine({ dataPort: port, timeoutMs: 1_000 });
    const result = await engine.execute('What tags are available?');
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('timedOut');
  });

  it('defaults to the documented QUERY_TIMEOUT_MS', () => {
    expect(QUERY_TIMEOUT_MS).toBe(2_000);
  });
});

// ── The bound VALUES themselves ────────────────────────────────────────────

/**
 * Every other test in this file states its expectation in terms of the
 * constant it is testing, which proves the mechanism but not the magnitude:
 * raising MAX_RESOLVER_CANDIDATE_TAGS to ten million would keep them all
 * green while unbounding the surface in practice. Pin the literals too, so
 * loosening a bound has to be a deliberate, reviewable edit to this list.
 */
describe('documented bound values', () => {
  it.each([
    ['MAX_QUERY_LENGTH', MAX_QUERY_LENGTH, 512],
    ['QUERY_TIMEOUT_MS', QUERY_TIMEOUT_MS, 2_000],
    ['MAX_RESOLVER_CANDIDATE_TAGS', MAX_RESOLVER_CANDIDATE_TAGS, 2_000],
    ['MAX_HISTORY_SAMPLES', MAX_HISTORY_SAMPLES, 5_000],
    ['MAX_TREND_WINDOW_MS', MAX_TREND_WINDOW_MS, 7 * 24 * 60 * 60 * 1_000],
    ['MAX_RESULT_ITEMS', MAX_RESULT_ITEMS, 50],
    ['MAX_ALARM_SCAN', MAX_ALARM_SCAN, 500],
    ['MAX_HISTORY_ENTRIES', MAX_HISTORY_ENTRIES, 100],
    ['MAX_HISTORY_PAGE', MAX_HISTORY_PAGE, 50],
  ])('%s is %i', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('never lets a page exceed the ring it pages over', () => {
    expect(MAX_HISTORY_PAGE).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES);
  });

  it('scans more alarms than it serialises, so the reported total is real', () => {
    expect(MAX_ALARM_SCAN).toBeGreaterThan(MAX_RESULT_ITEMS);
  });
});

// ── MAX_RESOLVER_CANDIDATE_TAGS ────────────────────────────────────────────

describe('MAX_RESOLVER_CANDIDATE_TAGS', () => {
  it('asks the port for at most the candidate cap — the O(tags x tokens) bound', async () => {
    const { port, calls } = fakePort({ tags: ['A.B'] });
    const engine = new NLQueryEngine({ dataPort: port });
    await engine.execute('What is the pressure in tank 3?');
    expect(calls.listTagsLimit).toEqual([MAX_RESOLVER_CANDIDATE_TAGS]);
  });

  it('scores no more tags than the cap even when the site has far more', async () => {
    const many = Array.from(
      { length: MAX_RESOLVER_CANDIDATE_TAGS + 500 },
      (_v, i) => `TANK-${i}.PRESSURE`,
    );
    const { port } = fakePort({ tags: many });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('What tags are available?');

    expect(result.data.count).toBe(MAX_RESOLVER_CANDIDATE_TAGS);
    expect(result.truncation.tagCatalogue).toBe(true);
    expect(result.data.countIsCapped).toBe(true);
    // The count must be presented as a floor, not as the site's tag total.
    expect(result.answer).toMatch(/capped/i);
  });

  it('re-applies the candidate cap when a port ignores the limit it was given', async () => {
    // Defence in depth: the resolver's O(tags x tokens) scoring is the only CPU
    // bound on this path, so the engine must not depend on every port
    // implementation having honoured the cap it was passed.
    const overRun = Array.from(
      { length: MAX_RESOLVER_CANDIDATE_TAGS + 5_000 },
      (_v, i) => `TANK-${i}.PRESSURE`,
    );
    const engine = new NLQueryEngine({
      dataPort: {
        listTags: async () => ({
          available: true,
          // Deliberately ignores `limit` and reports itself un-truncated.
          value: { tagIds: overRun, truncated: false },
        }),
        readLatest: async () => ({ available: true, value: null }),
        readHistory: async () => ({
          available: true,
          value: { samples: [], truncated: false },
        }),
        listActiveAlarms: async () => ({
          available: true,
          value: { alarms: [], truncated: false },
        }),
      },
    });

    const result = await engine.execute('What tags are available?');

    expect(result.data.count).toBe(MAX_RESOLVER_CANDIDATE_TAGS);
    expect(result.truncation.tagCatalogue).toBe(true);
    expect(result.answer).toMatch(/capped/i);
  });

  it('says a miss under truncation is not proof the tag does not exist', async () => {
    const { port } = fakePort({ tags: ['UNRELATED.TAG'], catalogueTruncated: true });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('What is the pressure in tank 3?');

    expect(result.success).toBe(false);
    expect(result.resolved[0].searchTruncated).toBe(true);
    expect(result.answer).toMatch(/does not mean the tag does not exist/i);
  });
});

// ── MAX_HISTORY_SAMPLES ────────────────────────────────────────────────────

describe('MAX_HISTORY_SAMPLES', () => {
  it('pushes the sample cap down to the port', async () => {
    const { port, calls } = fakePort({
      tags: ['TANK-3.PRESSURE'],
      history: [reading('TANK-3.PRESSURE', 1, 1_000)],
    });
    const engine = new NLQueryEngine({ dataPort: port });
    await engine.execute('trend of TANK-3.PRESSURE');
    expect(calls.historyMaxSamples).toEqual([MAX_HISTORY_SAMPLES]);
  });

  it('reports sample truncation explicitly instead of silently trimming', async () => {
    const samples = Array.from({ length: 10 }, (_v, i) =>
      reading('TANK-3.PRESSURE', i, 1_000 + i),
    );
    const { port } = fakePort({
      tags: ['TANK-3.PRESSURE'],
      history: samples,
      historyTruncated: true,
    });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('trend of TANK-3.PRESSURE');

    expect(result.success).toBe(true);
    expect(result.truncation.historySamples).toBe(true);
    expect(result.data.sampleCapReached).toBe(true);
    expect(result.answer).toMatch(/sample cap/i);
    // The aggregate must be described as covering the subset, not the window.
    expect(result.answer).toMatch(/not the whole window/i);
  });
});

// ── MAX_TREND_WINDOW_MS ────────────────────────────────────────────────────

describe('MAX_TREND_WINDOW_MS', () => {
  it('clamps an over-long trend window and flags the clamp', () => {
    const now = 1_800_000_000_000;
    const intent = parseIntent('trend of TANK-3.PRESSURE over the last 3650 days', now);

    expect(intent.type).toBe('trend');
    expect(intent.timeRangeClamped).toBe(true);
    expect(intent.timeRange).toBeDefined();
    expect(now - (intent.timeRange?.start ?? 0)).toBe(MAX_TREND_WINDOW_MS);
  });

  it('leaves a window inside the maximum unclamped', () => {
    const now = 1_800_000_000_000;
    const intent = parseIntent('trend of TANK-3.PRESSURE over the last 2 hours', now);
    expect(intent.timeRangeClamped).toBe(false);
    expect(now - (intent.timeRange?.start ?? 0)).toBe(2 * 3_600_000);
  });

  it('surfaces the clamp in the answer', async () => {
    const { port } = fakePort({
      tags: ['TANK-3.PRESSURE'],
      history: [
        reading('TANK-3.PRESSURE', 1, 1_000),
        reading('TANK-3.PRESSURE', 3, 2_000),
      ],
    });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('trend of TANK-3.PRESSURE over the last 400 days');

    expect(result.truncation.timeRange).toBe(true);
    expect(result.answer).toMatch(/clamped/i);
  });
});

// ── MAX_RESULT_ITEMS / MAX_ALARM_SCAN ──────────────────────────────────────

describe('MAX_RESULT_ITEMS', () => {
  it('caps the serialized tag list and reports the truncation', async () => {
    const tags = Array.from({ length: MAX_RESULT_ITEMS + 25 }, (_v, i) => `T-${i}.V`);
    const { port } = fakePort({ tags, catalogueTruncated: false });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('What tags are available?');

    expect((result.data.tags as string[]).length).toBe(MAX_RESULT_ITEMS);
    // The true total is still reported — only the listing is capped.
    expect(result.data.count).toBe(MAX_RESULT_ITEMS + 25);
    expect(result.truncation.resultItems).toBe(true);
    expect(result.answer).toMatch(new RegExp(`showing ${MAX_RESULT_ITEMS}`));
  });

  it('caps the serialized alarm list and reports the true total', async () => {
    const alarms = Array.from({ length: MAX_RESULT_ITEMS + 10 }, (_v, i) => ({
      id: `A-${i}`,
      name: `ALARM-${i}`,
      tagId: `T-${i}.V`,
      severity: 'high',
      state: 'active',
      message: 'test',
      timestamp: 1_000 + i,
    }));
    const { port } = fakePort({ alarms });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('any active alarms?');

    expect((result.data.alarms as unknown[]).length).toBe(MAX_RESULT_ITEMS);
    expect(result.data.total).toBe(MAX_RESULT_ITEMS + 10);
    expect(result.truncation.resultItems).toBe(true);
  });

  it('pushes MAX_ALARM_SCAN down to the port', async () => {
    const { port, calls } = fakePort({ alarms: [] });
    const engine = new NLQueryEngine({ dataPort: port });
    await engine.execute('any active alarms?');
    expect(calls.alarmLimit).toEqual([MAX_ALARM_SCAN]);
  });

  it('never reports a bare all-clear when the alarm scan was truncated', async () => {
    const { port } = fakePort({ alarms: [], alarmsTruncated: true });
    const engine = new NLQueryEngine({ dataPort: port });

    const result = await engine.execute('any active alarms?');

    // "No active alarms." full stop would be a dangerous claim here.
    expect(result.answer).toMatch(/beyond that cap/i);
  });
});

// ── MAX_HISTORY_ENTRIES ────────────────────────────────────────────────────

describe('MAX_HISTORY_ENTRIES', () => {
  it('bounds the in-memory history ring buffer', async () => {
    const { port } = fakePort({ tags: ['A.B'] });
    const engine = new NLQueryEngine({ dataPort: port, maxHistory: 5 });

    for (let i = 0; i < 20; i++) {
      await engine.execute(`What tags are available? ${i}`);
    }

    const history = engine.getHistory(1_000);
    expect(history.length).toBe(5);
    // Newest first, and the oldest entries are gone.
    expect(history[0].query).toContain('19');
    expect(history.map((h) => h.query).some((q) => q.includes(' 0'))).toBe(false);
  });

  it('never returns more than the ring size even when asked for more', async () => {
    const { port } = fakePort({ tags: ['A.B'] });
    const engine = new NLQueryEngine({ dataPort: port, maxHistory: 3 });
    await engine.execute('What tags are available?');
    expect(engine.getHistory(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(3);
  });

  it('uses the documented default ring size', () => {
    expect(MAX_HISTORY_ENTRIES).toBe(100);
  });
});
