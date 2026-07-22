/**
 * NL Query Engine
 * ADR-0013 [13.5] — Issue #216
 *
 * Parse intent (LLM backend if configured, regex otherwise), resolve tag
 * names, execute the query read-only, answer in natural language. Every
 * intent has a real execution path; unknown intents and unresolved tags
 * report success: false with suggestions — never a fabricated answer.
 */

import { EventEmitter } from 'events';
import type {
  AlarmSource,
  LLMBackend,
  QueryIntent,
  QueryIntentType,
  QueryResult,
  ResolvedSubject,
  TagDataSource,
  TagReading,
} from '@shared/types/nl-query';
import { parseIntent } from './parser';
import { TagResolver } from './resolver';

const VALID_INTENTS: QueryIntentType[] = [
  'read_tag', 'compare', 'trend', 'status', 'alarms', 'list_tags', 'unknown',
];

const EXAMPLE_QUERIES = [
  'What is the pressure in tank 3?',
  'Compare FEEDER-01 current and FEEDER-02 current',
  'Trend of transformer temperature over the last 2 hours',
  'What is the status of BK-FEEDER-01?',
  'Any active alarms?',
  'What tags are available?',
];

export interface NLQueryEngineOptions {
  dataSource: TagDataSource;
  alarmSource?: AlarmSource;
  resolver?: TagResolver;
  maxHistory?: number;
}

export class NLQueryEngine extends EventEmitter {
  readonly resolver: TagResolver;

  private readonly dataSource: TagDataSource;
  private readonly alarmSource: AlarmSource | null;
  private readonly maxHistory: number;
  private llmBackend: LLMBackend | null = null;
  private history: QueryResult[] = [];
  private queryCounter = 0;
  private readonly bootId = Date.now().toString(36);

  constructor(options: NLQueryEngineOptions) {
    super();
    this.dataSource = options.dataSource;
    this.alarmSource = options.alarmSource ?? null;
    this.resolver = options.resolver ?? new TagResolver();
    this.maxHistory = options.maxHistory ?? 100;
  }

  setLLMBackend(backend: LLMBackend | null): void {
    this.llmBackend = backend;
  }

  getBackendInfo(): { name: string } | null {
    return this.llmBackend ? { name: this.llmBackend.name } : null;
  }

  getHistory(): QueryResult[] {
    return [...this.history];
  }

  async execute(query: string, nowMs = Date.now()): Promise<QueryResult> {
    const availableTags = this.dataSource.listTags();
    let intent: QueryIntent | null = null;
    let parsedBy = 'regex';

    if (this.llmBackend) {
      try {
        const parsed = await this.llmBackend.parseQuery(query, { availableTags });
        if (parsed && VALID_INTENTS.includes(parsed.type) && Array.isArray(parsed.subjects)) {
          intent = { ...parsed, raw: query };
          parsedBy = this.llmBackend.name;
        }
      } catch (error) {
        this.emit('backend-error', {
          backend: this.llmBackend.name,
          stage: 'parseQuery',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!intent) {
      intent = parseIntent(query, nowMs);
      parsedBy = parsedBy === 'regex' ? 'regex' : `${parsedBy} (fallback: regex)`;
    }

    const resolved = intent.subjects.map((s) => this.resolver.resolve(s, availableTags));
    const outcome = this.executeIntent(intent, resolved, nowMs);

    // Let the LLM backend phrase the answer; template answer is the fallback
    let answer = outcome.answer;
    if (this.llmBackend && outcome.success) {
      try {
        const formatted = await this.llmBackend.formatAnswer(intent, outcome.data);
        if (formatted && formatted.trim() !== '') answer = formatted;
      } catch (error) {
        this.emit('backend-error', {
          backend: this.llmBackend.name,
          stage: 'formatAnswer',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result: QueryResult = {
      id: `NLQ-${this.bootId}-${++this.queryCounter}`,
      query,
      intent,
      resolved,
      success: outcome.success,
      answer,
      interpretation: this.describe(intent, resolved),
      data: outcome.data,
      suggestions: outcome.suggestions,
      timestamp: nowMs,
      parsedBy,
    };

    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    return result;
  }

  // ── Private: intent execution ────────────────────────────────────────

  private executeIntent(
    intent: QueryIntent,
    resolved: ResolvedSubject[],
    nowMs: number
  ): { success: boolean; answer: string; data: Record<string, unknown>; suggestions: string[] } {
    switch (intent.type) {
      case 'read_tag':
        return this.executeRead(resolved);
      case 'compare':
        return this.executeCompare(resolved);
      case 'trend':
        return this.executeTrend(resolved, intent, nowMs);
      case 'status':
        return this.executeStatus(resolved, nowMs);
      case 'alarms':
        return this.executeAlarms(intent);
      case 'list_tags':
        return this.executeListTags();
      default:
        return {
          success: false,
          answer: "I couldn't understand that question.",
          data: {},
          suggestions: EXAMPLE_QUERIES,
        };
    }
  }

  private unresolvedResult(subject: ResolvedSubject) {
    return {
      success: false,
      answer:
        subject.candidates.length > 0
          ? `I couldn't uniquely identify a tag for "${subject.phrase}". Did you mean: ${subject.candidates.join(', ')}?`
          : `I couldn't find any tag matching "${subject.phrase}".`,
      data: { unresolved: subject.phrase, candidates: subject.candidates },
      suggestions: subject.candidates,
    };
  }

  private executeRead(resolved: ResolvedSubject[]) {
    const subject = resolved[0];
    if (!subject) {
      return { success: false, answer: 'What would you like to read?', data: {}, suggestions: EXAMPLE_QUERIES };
    }
    if (!subject.tagId) return this.unresolvedResult(subject);

    const reading = this.dataSource.readLatest(subject.tagId);
    if (!reading) {
      return {
        success: false,
        answer: `No data is available for ${subject.tagId}.`,
        data: { tagId: subject.tagId },
        suggestions: [],
      };
    }
    return {
      success: true,
      answer: `${subject.tagId} is ${reading.value}${reading.quality && reading.quality !== 'good' ? ` (quality: ${reading.quality})` : ''} as of ${new Date(reading.timestamp).toISOString()}.`,
      data: { reading },
      suggestions: [],
    };
  }

  private executeCompare(resolved: ResolvedSubject[]) {
    if (resolved.length < 2) {
      return { success: false, answer: 'A comparison needs two tags.', data: {}, suggestions: EXAMPLE_QUERIES };
    }
    for (const subject of resolved) {
      if (!subject.tagId) return this.unresolvedResult(subject);
    }
    const readings = resolved.map((s) => ({
      subject: s,
      reading: this.dataSource.readLatest(s.tagId!),
    }));
    // Missing data is reported explicitly — never coerced to 0 (Wave-2 bug)
    const missing = readings.find((r) => r.reading === null);
    if (missing) {
      return {
        success: false,
        answer: `No data is available for ${missing.subject.tagId} — cannot compare.`,
        data: { missing: missing.subject.tagId },
        suggestions: [],
      };
    }
    const [a, b] = readings.map((r) => r.reading as TagReading);
    const numericA = typeof a.value === 'number' ? a.value : Number(a.value);
    const numericB = typeof b.value === 'number' ? b.value : Number(b.value);
    if (!Number.isFinite(numericA) || !Number.isFinite(numericB)) {
      return {
        success: false,
        answer: `${a.tagId} (${a.value}) and ${b.tagId} (${b.value}) are not both numeric — cannot compute a difference.`,
        data: { a, b },
        suggestions: [],
      };
    }
    const difference = numericA - numericB;
    return {
      success: true,
      answer: `${a.tagId} is ${numericA} and ${b.tagId} is ${numericB} — a difference of ${Number(difference.toFixed(6))}.`,
      data: { a, b, difference },
      suggestions: [],
    };
  }

  private executeTrend(resolved: ResolvedSubject[], intent: QueryIntent, nowMs: number) {
    const subject = resolved[0];
    if (!subject) {
      return { success: false, answer: 'Which tag should I trend?', data: {}, suggestions: EXAMPLE_QUERIES };
    }
    if (!subject.tagId) return this.unresolvedResult(subject);

    const range = intent.timeRange ?? { start: nowMs - 3_600_000, end: nowMs };
    const points = this.dataSource
      .readHistory(subject.tagId, range.start, range.end)
      .filter((p) => typeof p.value === 'number') as Array<TagReading & { value: number }>;

    if (points.length === 0) {
      return {
        success: false,
        answer: `No history is available for ${subject.tagId} in that window (the in-memory buffer only covers recent values).`,
        data: { tagId: subject.tagId, range },
        suggestions: [],
      };
    }
    const values = points.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const delta = values[values.length - 1] - values[0];
    const direction = delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat';
    const minutes = Math.round((range.end - range.start) / 60_000);
    return {
      success: true,
      answer:
        `${subject.tagId} over the last ${minutes} minutes: ${points.length} samples, ` +
        `min ${min}, max ${max}, average ${Number(avg.toFixed(3))} — ${direction} ` +
        `(${delta >= 0 ? '+' : ''}${Number(delta.toFixed(3))}).`,
      data: { tagId: subject.tagId, range, samples: points.length, min, max, avg, delta, direction },
      suggestions: [],
    };
  }

  private executeStatus(resolved: ResolvedSubject[], nowMs: number) {
    const subject = resolved[0];
    if (!subject) {
      return { success: false, answer: 'Which tag or equipment?', data: {}, suggestions: EXAMPLE_QUERIES };
    }
    if (!subject.tagId) return this.unresolvedResult(subject);

    const reading = this.dataSource.readLatest(subject.tagId);
    if (!reading) {
      return {
        success: false,
        answer: `No data is available for ${subject.tagId}.`,
        data: { tagId: subject.tagId },
        suggestions: [],
      };
    }
    const ageSeconds = Math.max(0, Math.round((nowMs - reading.timestamp) / 1000));
    return {
      success: true,
      answer:
        `${subject.tagId}: last value ${reading.value}` +
        `${reading.quality ? `, quality ${reading.quality}` : ''}, updated ${ageSeconds}s ago.`,
      data: { reading, ageSeconds },
      suggestions: [],
    };
  }

  private executeAlarms(intent: QueryIntent) {
    if (!this.alarmSource) {
      return {
        success: false,
        answer: 'Alarm data is not connected to the query engine yet.',
        data: { alarms: [] },
        suggestions: [],
      };
    }
    const alarms = this.alarmSource.getActiveAlarms(intent.subjects[0]);
    if (alarms.length === 0) {
      return {
        success: true,
        answer: intent.subjects[0]
          ? `No active alarms matching "${intent.subjects[0]}".`
          : 'No active alarms.',
        data: { alarms: [] },
        suggestions: [],
      };
    }
    const summary = alarms
      .slice(0, 10)
      .map((a) => `${a.name} (${a.severity})`)
      .join('; ');
    return {
      success: true,
      answer: `${alarms.length} active alarm${alarms.length === 1 ? '' : 's'}: ${summary}.`,
      data: { alarms },
      suggestions: [],
    };
  }

  private executeListTags() {
    const tags = this.dataSource.listTags();
    const shown = tags.slice(0, 50);
    return {
      success: true,
      answer:
        tags.length === 0
          ? 'No tags are currently reporting data.'
          : `${tags.length} tags available${tags.length > 50 ? ' (showing 50)' : ''}: ${shown.join(', ')}.`,
      data: { count: tags.length, tags: shown },
      suggestions: [],
    };
  }

  private describe(intent: QueryIntent, resolved: ResolvedSubject[]): string {
    const subjects = resolved
      .map((r) => (r.tagId ? `"${r.phrase}" → ${r.tagId}` : `"${r.phrase}" (unresolved)`))
      .join(', ');
    return `intent: ${intent.type}${subjects ? `; subjects: ${subjects}` : ''}`;
  }
}
