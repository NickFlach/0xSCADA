/**
 * NL Query Engine tests
 * ADR-0013 [13.5] — Issue #216
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMBackend, QueryIntent } from '@shared/types/nl-query';
import { parseIntent, parseDurationMs } from '../parser';
import { TagResolver, tokenize } from '../resolver';
import { NLQueryEngine } from '../engine';
import { InMemoryTagStore, NLQueryService } from '../index';

const NOW = 1_800_000_000_000;

function storeWithData(): InMemoryTagStore {
  const store = new InMemoryTagStore();
  for (let i = 0; i < 10; i++) {
    store.ingest({ tagId: 'TANK-3.PRESSURE', value: 40 + i, timestamp: NOW - (10 - i) * 60_000 });
    store.ingest({ tagId: 'FEEDER-01.CURRENT', value: 800 + i, timestamp: NOW - (10 - i) * 60_000 });
    store.ingest({ tagId: 'FEEDER-02.CURRENT', value: 700 + i, timestamp: NOW - (10 - i) * 60_000 });
  }
  store.ingest({ tagId: 'TR-MAIN-01.STATUS', value: 'OK', quality: 'good', timestamp: NOW - 5_000 });
  return store;
}

// ── Parser ────────────────────────────────────────────────────────────────

describe('parseIntent (ordering regressions)', () => {
  it('routes status questions to status, not the read_tag catch-all', () => {
    // Wave-2 put read_tag first, making this unreachable
    const intent = parseIntent('What is the status of pump 1?', NOW);
    expect(intent.type).toBe('status');
    expect(intent.subjects).toEqual(['pump 1']);
  });

  it('parses the canonical read_tag question with measurement and location', () => {
    const intent = parseIntent('What is the pressure in tank 3?', NOW);
    expect(intent.type).toBe('read_tag');
    expect(intent.subjects).toEqual(['pressure tank 3']);
  });

  it('parses alarms with and without a subject', () => {
    expect(parseIntent('Any active alarms?', NOW).type).toBe('alarms');
    const scoped = parseIntent('alarms on tank 3', NOW);
    expect(scoped.type).toBe('alarms');
    expect(scoped.subjects).toEqual(['tank 3']);
  });

  it('parses trend with an explicit duration', () => {
    const intent = parseIntent('Trend of pressure in tank 3 over the last 2 hours', NOW);
    expect(intent.type).toBe('trend');
    expect(intent.timeRange).toEqual({ start: NOW - 2 * 3_600_000, end: NOW });
  });

  it('defaults trend to the last hour when no duration is given', () => {
    const intent = parseIntent('history of FEEDER-01.CURRENT', NOW);
    expect(intent.type).toBe('trend');
    expect(intent.timeRange).toEqual({ start: NOW - 3_600_000, end: NOW });
  });

  it('parses compare with two subjects', () => {
    const intent = parseIntent('Compare FEEDER-01 current and FEEDER-02 current', NOW);
    expect(intent.type).toBe('compare');
    expect(intent.subjects).toHaveLength(2);
  });

  it('parses list_tags and falls through to unknown', () => {
    expect(parseIntent('What tags are available?', NOW).type).toBe('list_tags');
    expect(parseIntent('make me a sandwich', NOW).type).toBe('unknown');
  });

  it('parses durations', () => {
    expect(parseDurationMs(30, 'minutes')).toBe(30 * 60_000);
    expect(parseDurationMs(3, 'd')).toBe(3 * 86_400_000);
    expect(parseDurationMs(1, 'fortnight')).toBeNull();
  });
});

// ── Resolver ──────────────────────────────────────────────────────────────

describe('TagResolver', () => {
  const tags = ['TANK-3.PRESSURE', 'TANK-3.LEVEL', 'TANK-12.PRESSURE', 'FEEDER-01.CURRENT'];

  it('tokenizes tags and phrases comparably', () => {
    expect(tokenize('TANK-3.PRESSURE')).toEqual(['tank', '3', 'pressure']);
    expect(tokenize('the pressure in tank 03')).toEqual(['pressure', 'tank', '3']);
  });

  it('resolves a natural phrase to the right tag', () => {
    const resolver = new TagResolver();
    const result = resolver.resolve('pressure tank 3', tags);
    expect(result.tagId).toBe('TANK-3.PRESSURE');
  });

  it('returns null with candidates when ambiguous — never guesses', () => {
    const resolver = new TagResolver();
    // "tank 3" matches PRESSURE and LEVEL equally
    const result = resolver.resolve('tank 3', tags);
    expect(result.tagId).toBeNull();
    expect(result.candidates).toEqual(
      expect.arrayContaining(['TANK-3.PRESSURE', 'TANK-3.LEVEL'])
    );
  });

  it('returns null with no candidates for nonsense — no fabricated tag ids', () => {
    const resolver = new TagResolver();
    const result = resolver.resolve('warp core temperature', tags);
    expect(result.tagId).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('honors explicit aliases and exact ids', () => {
    const resolver = new TagResolver();
    resolver.registerAlias('main feeder amps', 'FEEDER-01.CURRENT');
    expect(resolver.resolve('main feeder amps', tags).tagId).toBe('FEEDER-01.CURRENT');
    expect(resolver.resolve('tank-3.pressure', tags).tagId).toBe('TANK-3.PRESSURE');
  });
});

// ── Engine ────────────────────────────────────────────────────────────────

describe('NLQueryEngine', () => {
  it('answers the canonical question end-to-end', async () => {
    const engine = new NLQueryEngine({ dataSource: storeWithData() });
    const result = await engine.execute('What is the pressure in tank 3?', NOW);
    expect(result.success).toBe(true);
    expect(result.intent.type).toBe('read_tag');
    expect(result.answer).toContain('TANK-3.PRESSURE');
    expect(result.answer).toContain('49'); // latest value
    expect(result.parsedBy).toBe('regex');
  });

  it('reports missing data explicitly in comparisons — never coerces to 0', async () => {
    const store = storeWithData();
    const engine = new NLQueryEngine({ dataSource: store });
    const ok = await engine.execute('Compare FEEDER-01 current and FEEDER-02 current', NOW);
    expect(ok.success).toBe(true);
    expect(ok.data.difference).toBe(100);

    const missing = await engine.execute('Compare FEEDER-01 current and TANK-12 pressure', NOW);
    expect(missing.success).toBe(false);
    expect(missing.answer).toMatch(/couldn't|No data/i);
    expect(missing.data.difference).toBeUndefined();
  });

  it('computes trend statistics from history', async () => {
    const engine = new NLQueryEngine({ dataSource: storeWithData() });
    const result = await engine.execute('Trend of tank 3 pressure over the last 30 minutes', NOW);
    expect(result.success).toBe(true);
    expect(result.data.direction).toBe('rising');
    expect(result.data.min).toBeGreaterThanOrEqual(40);
  });

  it('answers unresolved subjects with suggestions, not fabricated data', async () => {
    const engine = new NLQueryEngine({ dataSource: storeWithData() });
    const result = await engine.execute('What is the flux capacitor charge?', NOW);
    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/couldn't find/i);
  });

  it('executes the alarms intent against an alarm source', async () => {
    const engine = new NLQueryEngine({
      dataSource: storeWithData(),
      alarmSource: {
        getActiveAlarms: () => [
          { id: 'a1', name: 'BK-FEEDER-01 TRIP', severity: 'critical', message: 'trip', timestamp: NOW },
        ],
      },
    });
    const result = await engine.execute('Any active alarms?', NOW);
    expect(result.success).toBe(true);
    expect(result.answer).toContain('1 active alarm');
  });

  it('uses a registered LLM backend and validates its output', async () => {
    const backend: LLMBackend = {
      name: 'mock-llm',
      parseQuery: async (query): Promise<QueryIntent> => ({
        type: 'read_tag',
        subjects: ['TANK-3.PRESSURE'],
        raw: query,
      }),
      formatAnswer: async () => 'Tank 3 is sitting at 49 PSI.',
    };
    const engine = new NLQueryEngine({ dataSource: storeWithData() });
    engine.setLLMBackend(backend);

    const result = await engine.execute('how full is my favorite tank', NOW);
    expect(result.parsedBy).toBe('mock-llm');
    expect(result.success).toBe(true);
    expect(result.answer).toBe('Tank 3 is sitting at 49 PSI.');
  });

  it('falls back to regex when the backend errors, and surfaces the error', async () => {
    const errors: unknown[] = [];
    const backend: LLMBackend = {
      name: 'flaky-llm',
      parseQuery: async () => {
        throw new Error('model unavailable');
      },
      formatAnswer: async () => null,
    };
    const engine = new NLQueryEngine({ dataSource: storeWithData() });
    engine.on('backend-error', (e) => errors.push(e));
    engine.setLLMBackend(backend);

    const result = await engine.execute('What is the pressure in tank 3?', NOW);
    expect(result.success).toBe(true); // regex fallback answered
    expect(result.parsedBy).toContain('regex');
    expect(errors).toHaveLength(1);
  });

  it('keeps bounded query history', async () => {
    const engine = new NLQueryEngine({ dataSource: storeWithData(), maxHistory: 3 });
    for (let i = 0; i < 5; i++) {
      await engine.execute(`What tags are available? (${i})`, NOW + i);
    }
    const history = engine.getHistory();
    expect(history).toHaveLength(3);
    expect(history[2].query).toContain('(4)');
  });
});

// ── Store & service ───────────────────────────────────────────────────────

describe('InMemoryTagStore / NLQueryService', () => {
  it('bounds history per tag and tag count', () => {
    const store = new InMemoryTagStore({ maxTags: 2, maxPointsPerTag: 3 });
    for (let i = 0; i < 5; i++) store.ingest({ tagId: 'a', value: i, timestamp: i });
    expect(store.readHistory('a', 0, 10).map((p) => p.value)).toEqual([2, 3, 4]);

    store.ingest({ tagId: 'b', value: 1, timestamp: 10 });
    store.ingest({ tagId: 'a', value: 9, timestamp: 11 }); // refresh a
    store.ingest({ tagId: 'c', value: 1, timestamp: 12 }); // evicts b
    expect(store.listTags()).toEqual(expect.arrayContaining(['a', 'c']));
    expect(store.readLatest('b')).toBeNull();
  });

  it('ingests numeric strings as numbers and keeps text values as text', () => {
    const service = new NLQueryService();
    service.ingestTagUpdate({ tagName: 't', value: '42.5', timestamp: 1000 });
    service.ingestTagUpdate({ tagName: 't', value: 'RUNNING', timestamp: 2000 });
    const history = service.store.readHistory('t', 0, 3000);
    expect(history[0].value).toBe(42.5);
    expect(history[1].value).toBe('RUNNING');
  });

  it('reports health with backend info', async () => {
    const service = new NLQueryService();
    await service.initialize();
    const health = await service.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('backend: regex');
  });
});
