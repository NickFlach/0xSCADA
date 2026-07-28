/**
 * NL process query — grammar, resolution, and answer-integrity tests (#216).
 *
 * The maintainer review praised three properties of the previous attempt and
 * asked that they be carried forward rather than rewritten: the ordered
 * 6-intent regex grammar, the token-overlap tag scoring, and a resolver that
 * refuses to guess between ambiguous tags. Those are pinned here.
 *
 * The remaining tests enforce the repository integrity rule on this surface:
 * an answer never contains a value the data port did not return, and
 * "the store could not be consulted" never reads as "the process is quiet".
 */

import { describe, expect, it } from 'vitest';

import type {
  ActiveAlarmPage,
  HistorySlice,
  NLQueryDataPort,
  PortResult,
  TagCatalogue,
  TagReading,
} from '@shared/types/nl-query';
import { NLQueryEngine } from '../engine';
import { parseDurationMs, parseIntent } from '../parser';
import { TagResolver, tokenize } from '../resolver';

const NOW = 1_800_000_000_000;

// ── Test doubles ───────────────────────────────────────────────────────────

interface StubOptions {
  tags?: string[];
  latest?: Record<string, TagReading>;
  history?: Record<string, TagReading[]>;
  alarms?: ActiveAlarmPage['alarms'];
  /** Force a store to report itself unavailable, with this reason. */
  unavailable?: Partial<Record<'tags' | 'latest' | 'history' | 'alarms', string>>;
}

function stubPort(options: StubOptions = {}): NLQueryDataPort {
  const unavailable = options.unavailable ?? {};
  return {
    async listTags(limit): Promise<PortResult<TagCatalogue>> {
      if (unavailable.tags) return { available: false, reason: unavailable.tags };
      const tags = options.tags ?? [];
      return {
        available: true,
        value: { tagIds: tags.slice(0, limit), truncated: tags.length > limit },
      };
    },
    async readLatest(tagId): Promise<PortResult<TagReading | null>> {
      if (unavailable.latest) return { available: false, reason: unavailable.latest };
      return { available: true, value: options.latest?.[tagId] ?? null };
    },
    async readHistory(tagId, startMs, endMs, maxSamples): Promise<PortResult<HistorySlice>> {
      if (unavailable.history) return { available: false, reason: unavailable.history };
      const all = options.history?.[tagId] ?? [];
      const inWindow = all.filter((p) => p.timestamp >= startMs && p.timestamp <= endMs);
      return {
        available: true,
        value: {
          samples: inWindow.slice(0, maxSamples),
          truncated: inWindow.length > maxSamples,
        },
      };
    },
    async listActiveAlarms(limit): Promise<PortResult<ActiveAlarmPage>> {
      if (unavailable.alarms) return { available: false, reason: unavailable.alarms };
      const alarms = options.alarms ?? [];
      return {
        available: true,
        value: { alarms: alarms.slice(0, limit), truncated: alarms.length > limit },
      };
    },
  };
}

function reading(
  tagId: string,
  value: number | string,
  timestamp = NOW,
  source: TagReading['source'] = 'historian',
): TagReading {
  return { tagId, value, timestamp, source };
}

function engineWith(options: StubOptions = {}): NLQueryEngine {
  return new NLQueryEngine({ dataPort: stubPort(options) });
}

// ── Parser: ordered grammar ────────────────────────────────────────────────

describe('intent grammar ordering', () => {
  it('recognises a status question as status, not as the read_tag catch-all', () => {
    // The ordering regression the reviewed implementation was built to fix:
    // with read_tag first, this matches the catch-all and status is dead code.
    expect(parseIntent('what is the status of pump 1', NOW).type).toBe('status');
  });

  it('recognises a tag listing before the read_tag catch-all', () => {
    expect(parseIntent('what tags are available?', NOW).type).toBe('list_tags');
    expect(parseIntent('list tags', NOW).type).toBe('list_tags');
  });

  it('recognises alarms, including scoped alarms', () => {
    expect(parseIntent('any active alarms?', NOW).type).toBe('alarms');
    const scoped = parseIntent('alarms on tank 3', NOW);
    expect(scoped.type).toBe('alarms');
    expect(scoped.subjects).toEqual(['tank 3']);
  });

  it('recognises a trend with a duration', () => {
    const intent = parseIntent('trend of transformer temperature over the last 2 hours', NOW);
    expect(intent.type).toBe('trend');
    expect(intent.subjects).toEqual(['transformer temperature']);
    expect(NOW - (intent.timeRange?.start ?? 0)).toBe(2 * 3_600_000);
  });

  it('recognises a comparison and keeps both subjects', () => {
    const intent = parseIntent('compare FEEDER-01.CURRENT and FEEDER-02.CURRENT', NOW);
    expect(intent.type).toBe('compare');
    expect(intent.subjects).toEqual(['FEEDER-01.CURRENT', 'FEEDER-02.CURRENT']);
  });

  it('keeps measurement and location together for a read', () => {
    const intent = parseIntent('What is the pressure in tank 3?', NOW);
    expect(intent.type).toBe('read_tag');
    expect(intent.subjects).toEqual(['pressure tank 3']);
  });

  it('returns unknown for an unparseable question rather than guessing', () => {
    expect(parseIntent('hello there', NOW).type).toBe('unknown');
  });
});

describe('duration parsing', () => {
  it('parses supported units', () => {
    expect(parseDurationMs(2, 'hours')).toBe(7_200_000);
    expect(parseDurationMs(30, 'min')).toBe(1_800_000);
    expect(parseDurationMs(1, 'd')).toBe(86_400_000);
  });

  it('rejects unknown units and non-positive amounts', () => {
    expect(parseDurationMs(2, 'fortnights')).toBeNull();
    expect(parseDurationMs(0, 'hours')).toBeNull();
    expect(parseDurationMs(-1, 'hours')).toBeNull();
  });
});

// ── Resolver: precision and refusal to guess ───────────────────────────────

describe('tag resolution', () => {
  const tags = [
    'TANK-3.PRESSURE',
    'TANK-12.PRESSURE',
    'FEEDER-01.CURRENT',
    'TRANSFORMER.TEMPERATURE',
  ];

  it('tokenizes tag ids and phrases the same way', () => {
    expect(tokenize('TANK-3.PRESSURE')).toEqual(['tank', '3', 'pressure']);
    expect(tokenize('the pressure in tank 03')).toEqual(['pressure', 'tank', '3']);
  });

  it('resolves a measurement + location phrase to the right tag', () => {
    const r = new TagResolver().resolve('pressure tank 3', tags);
    expect(r.tagId).toBe('TANK-3.PRESSURE');
  });

  it('treats numeric tokens as equipment identity — tank 12 is never tank 3', () => {
    const r = new TagResolver().resolve('pressure tank 12', tags);
    expect(r.tagId).toBe('TANK-12.PRESSURE');
  });

  it('matches a prefix like "temp" against "TEMPERATURE"', () => {
    const r = new TagResolver().resolve('transformer temp', tags);
    expect(r.tagId).toBe('TRANSFORMER.TEMPERATURE');
  });

  it('refuses to guess between equally-scored candidates', () => {
    // "pressure" alone scores identically against both pressure tags.
    const r = new TagResolver().resolve('pressure', tags);
    expect(r.tagId).toBeNull();
    expect(r.candidates).toEqual(
      expect.arrayContaining(['TANK-3.PRESSURE', 'TANK-12.PRESSURE']),
    );
  });

  it('returns null with no candidates for an unmatched phrase', () => {
    const r = new TagResolver().resolve('reactor coolant flow', tags);
    expect(r.tagId).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it('never invents a tag id that is absent from the catalogue', () => {
    const r = new TagResolver().resolve('pressure in tank 99', tags);
    expect(r.tagId).toBeNull();
    for (const candidate of r.candidates) expect(tags).toContain(candidate);
  });

  it('prefers an exact tag id, case-insensitively', () => {
    const r = new TagResolver().resolve('tank-3.pressure', tags);
    expect(r.tagId).toBe('TANK-3.PRESSURE');
  });

  it('honours an explicit alias over scoring', () => {
    const resolver = new TagResolver();
    resolver.registerAlias('main feed pressure', 'TANK-3.PRESSURE');
    expect(resolver.resolve('main feed pressure', tags).tagId).toBe('TANK-3.PRESSURE');
    expect(resolver.listAliases()).toEqual([
      { alias: 'main feed pressure', tagId: 'TANK-3.PRESSURE' },
    ]);
  });
});

// ── Engine: real answers ───────────────────────────────────────────────────

describe('answering from data', () => {
  it('reads the current value of a resolved tag and cites its provenance', async () => {
    const engine = engineWith({
      tags: ['TANK-3.PRESSURE'],
      latest: { 'TANK-3.PRESSURE': reading('TANK-3.PRESSURE', 42.5, NOW, 'live-stream') },
    });

    const result = await engine.execute('What is the pressure in tank 3?', NOW);

    expect(result.success).toBe(true);
    expect(result.answer).toContain('TANK-3.PRESSURE is 42.5');
    expect(result.answer).toContain('live tag stream');
    expect(result.parsedBy).toBe('regex');
  });

  it('compares two tags and reports the difference', async () => {
    const engine = engineWith({
      tags: ['FEEDER-01.CURRENT', 'FEEDER-02.CURRENT'],
      latest: {
        'FEEDER-01.CURRENT': reading('FEEDER-01.CURRENT', 10),
        'FEEDER-02.CURRENT': reading('FEEDER-02.CURRENT', 4),
      },
    });

    const result = await engine.execute(
      'compare FEEDER-01.CURRENT and FEEDER-02.CURRENT',
      NOW,
    );

    expect(result.success).toBe(true);
    expect(result.data.difference).toBe(6);
  });

  it('summarises a trend over real samples', async () => {
    const engine = engineWith({
      tags: ['TANK-3.PRESSURE'],
      history: {
        'TANK-3.PRESSURE': [
          reading('TANK-3.PRESSURE', 10, NOW - 3_000),
          reading('TANK-3.PRESSURE', 20, NOW - 2_000),
          reading('TANK-3.PRESSURE', 30, NOW - 1_000),
        ],
      },
    });

    const result = await engine.execute('trend of TANK-3.PRESSURE', NOW);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      samples: 3,
      min: 10,
      max: 30,
      avg: 20,
      delta: 20,
      direction: 'rising',
    });
  });

  it('reports status as the last recorded value, not an invented run state', async () => {
    const engine = engineWith({
      tags: ['BK-FEEDER-01.STATE'],
      latest: { 'BK-FEEDER-01.STATE': reading('BK-FEEDER-01.STATE', 1, NOW - 5_000) },
    });

    const result = await engine.execute('What is the status of BK-FEEDER-01.STATE?', NOW);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ageSeconds: 5 });
    // No equipment state model exists, so no running/stopped verdict is claimed.
    expect(result.answer).toMatch(/not a running\/stopped verdict/i);
  });

  it('lists real tags', async () => {
    const engine = engineWith({ tags: ['A.B', 'C.D'] });
    const result = await engine.execute('what tags are available?', NOW);
    expect(result.success).toBe(true);
    expect(result.data.tags).toEqual(['A.B', 'C.D']);
  });

  it('reports active alarms and scopes them to a resolved tag', async () => {
    const alarms = [
      {
        id: 'A1',
        name: 'HIGH PRESSURE',
        tagId: 'TANK-3.PRESSURE',
        severity: 'critical',
        state: 'active',
        message: 'over limit',
        timestamp: NOW,
      },
      {
        id: 'A2',
        name: 'LOW CURRENT',
        tagId: 'FEEDER-01.CURRENT',
        severity: 'warning',
        state: 'active',
        message: 'under limit',
        timestamp: NOW,
      },
    ];
    const engine = engineWith({ tags: ['TANK-3.PRESSURE'], alarms });

    const all = await engine.execute('any active alarms?', NOW);
    expect(all.data.total).toBe(2);

    const scoped = await engine.execute('alarms on tank 3', NOW);
    expect(scoped.success).toBe(true);
    expect(scoped.data.total).toBe(1);
    expect(scoped.answer).toContain('HIGH PRESSURE');
  });
});

// ── Engine: integrity — never invent, never mislead ────────────────────────

describe('answer integrity', () => {
  it('refuses to answer an ambiguous phrase and offers candidates', async () => {
    const engine = engineWith({ tags: ['TANK-3.PRESSURE', 'TANK-12.PRESSURE'] });

    const result = await engine.execute('what is the pressure', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/couldn't uniquely identify/i);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it('says no tag matched rather than querying an invented id', async () => {
    const engine = engineWith({ tags: ['TANK-3.PRESSURE'] });
    const result = await engine.execute('what is the coolant flow in reactor 9', NOW);
    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/couldn't find any tag/i);
  });

  it('distinguishes "no data recorded" from "store unavailable"', async () => {
    const noRows = engineWith({ tags: ['TANK-3.PRESSURE'] });
    const noRowsResult = await noRows.execute('what is TANK-3.PRESSURE', NOW);
    expect(noRowsResult.success).toBe(false);
    expect(noRowsResult.answer).toMatch(/no data is recorded/i);

    const down = engineWith({
      tags: ['TANK-3.PRESSURE'],
      unavailable: { latest: 'historian unreachable' },
    });
    const downResult = await down.execute('what is TANK-3.PRESSURE', NOW);
    expect(downResult.success).toBe(false);
    expect(downResult.answer).toMatch(/could not read/i);
    expect(downResult.answer).toContain('historian unreachable');
    // Crucially it must NOT claim there is no data.
    expect(downResult.answer).not.toMatch(/no data is recorded/i);
  });

  it('never reports an all-clear when the alarm store is unreachable', async () => {
    const engine = engineWith({ unavailable: { alarms: 'correlation engine down' } });

    const result = await engine.execute('any active alarms?', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).not.toMatch(/no active alarms/i);
    expect(result.answer).toContain('correlation engine down');
  });

  it('does not treat an unresolved alarm scope as an all-clear', async () => {
    const alarms = [
      {
        id: 'A1',
        name: 'HIGH PRESSURE',
        tagId: 'TANK-3.PRESSURE',
        severity: 'critical',
        state: 'active',
        message: 'over limit',
        timestamp: NOW,
      },
    ];
    const engine = engineWith({ tags: ['TANK-3.PRESSURE'], alarms });

    const result = await engine.execute('alarms on reactor 9', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).not.toMatch(/no active alarms/i);
    // The operator is still told alarms exist, just not scoped to their phrase.
    expect(result.answer).toMatch(/1 active alarm/);
  });

  it('reports missing data in a comparison instead of coercing it to zero', async () => {
    const engine = engineWith({
      tags: ['FEEDER-01.CURRENT', 'FEEDER-02.CURRENT'],
      latest: { 'FEEDER-01.CURRENT': reading('FEEDER-01.CURRENT', 10) },
    });

    const result = await engine.execute(
      'compare FEEDER-01.CURRENT and FEEDER-02.CURRENT',
      NOW,
    );

    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/No data is recorded for FEEDER-02\.CURRENT/);
    expect(result.data.difference).toBeUndefined();
    // 10 - 0 = 10 must never appear as a difference.
    expect(result.answer).not.toContain('difference');
  });

  it('refuses to subtract non-numeric values', async () => {
    const engine = engineWith({
      tags: ['A.MODE', 'B.MODE'],
      latest: {
        'A.MODE': reading('A.MODE', 'AUTO'),
        'B.MODE': reading('B.MODE', 'MANUAL'),
      },
    });

    const result = await engine.execute('compare A.MODE and B.MODE', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/not both\s+numeric/i);
  });

  // A `historian_data` row carries either a numeric `value` or a text
  // `string_value`, so a stored reading legitimately reaches the comparison as
  // a string. `Number()` turns several of those into plausible readings — the
  // empty string and whitespace become 0, "0x10" becomes 16 — which would make
  // the engine state a value no sensor produced, with `success: true`. Each
  // case must land in the non-numeric refusal instead.
  it.each([
    ['an empty stored string', ''],
    ['a whitespace-only stored string', '   '],
    ['a hexadecimal stored string', '0x10'],
    ['a binary-literal stored string', '0b101'],
    ['an Infinity stored string', 'Infinity'],
  ])('never coerces %s into a number in a comparison', async (_label, stored) => {
    const engine = engineWith({
      tags: ['A.X', 'B.X'],
      latest: {
        'A.X': reading('A.X', stored),
        'B.X': reading('B.X', 5),
      },
    });

    const result = await engine.execute('compare A.X and B.X', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/not both\s+numeric/i);
    // The refusal legitimately says "I cannot compute a difference"; what must
    // never appear is a computed one.
    expect(result.answer).not.toMatch(/a difference of/i);
    expect(result.data.difference).toBeUndefined();
    // The specific fabrications this guards against.
    expect(result.answer).not.toMatch(/A\.X is 0\b/);
    expect(result.answer).not.toMatch(/A\.X is 16\b/);
  });

  it('still compares a numeric value stored as a decimal string', async () => {
    const engine = engineWith({
      tags: ['A.X', 'B.X'],
      latest: {
        'A.X': reading('A.X', '12.5'),
        'B.X': reading('B.X', 5),
      },
    });

    const result = await engine.execute('compare A.X and B.X', NOW);

    expect(result.success).toBe(true);
    expect(result.data.difference).toBe(7.5);
  });

  it('reports an empty trend window honestly', async () => {
    const engine = engineWith({ tags: ['TANK-3.PRESSURE'], history: {} });
    const result = await engine.execute('trend of TANK-3.PRESSURE', NOW);
    expect(result.success).toBe(false);
    expect(result.answer).toMatch(/no numeric samples are recorded/i);
  });

  it('cannot resolve any tag when the catalogue itself is unreachable', async () => {
    const engine = engineWith({ unavailable: { tags: 'database not initialized' } });

    const result = await engine.execute('What is the pressure in tank 3?', NOW);

    expect(result.success).toBe(false);
    expect(result.answer).toContain('database not initialized');
    expect(result.resolved).toEqual([]);
  });

  it('answers an unparseable question with examples, never with data', async () => {
    const engine = engineWith({
      tags: ['TANK-3.PRESSURE'],
      latest: { 'TANK-3.PRESSURE': reading('TANK-3.PRESSURE', 42.5) },
    });

    const result = await engine.execute('hello there', NOW);

    expect(result.success).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.answer).not.toContain('42.5');
  });
});

// ── History: bounded and process-local ─────────────────────────────────────

describe('query history', () => {
  it('records executed queries newest-first', async () => {
    const engine = engineWith({ tags: ['A.B'] });
    await engine.execute('what tags are available?', NOW);
    await engine.execute('list tags', NOW);

    const history = engine.getHistory(10);
    expect(history).toHaveLength(2);
    expect(history[0].query).toBe('list tags');
    expect(history[0].id).not.toBe(history[1].id);
  });

  it('records unsuccessful queries too, so a refusal is auditable in-process', async () => {
    const engine = engineWith({ tags: [] });
    await engine.execute('what is the pressure in tank 3', NOW);
    const history = engine.getHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0].success).toBe(false);
  });

  it('treats a non-positive limit as empty rather than returning everything', async () => {
    const engine = engineWith({ tags: ['A.B'] });
    await engine.execute('list tags', NOW);
    expect(engine.getHistory(0)).toEqual([]);
    expect(engine.getHistory(-5)).toEqual([]);
  });
});
