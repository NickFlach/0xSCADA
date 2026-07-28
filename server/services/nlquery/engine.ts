/**
 * NL Query Engine
 * Issue #216; contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * Parse intent (regex grammar), resolve tag names, read real process data
 * through an injected {@link NLQueryDataPort}, answer in natural language.
 *
 * The integrity rule drives the whole design. Every answer this engine emits
 * is assembled from values the port actually returned. There are exactly three
 * outcomes for any question:
 *
 *   - answered from real data (`success: true`);
 *   - "I could not identify that tag" / "no data is recorded for it"
 *     (`success: false`, with candidates or a plain statement);
 *   - "I could not consult the store" (`success: false`, carrying the port's
 *     reason).
 *
 * There is no fourth branch that produces a number. `PortResult.available`
 * keeps "the historian is unreachable" distinct from "the historian returned
 * no rows", because collapsing those two would let an outage read to an
 * operator as a quiet process.
 *
 * No language model is imported, constructed, or called here — see ADR-0027.
 */

import type {
  ActiveAlarmSummary,
  NLQueryDataPort,
  QueryIntent,
  QueryResult,
  QueryTruncation,
  ResolvedSubject,
  TagReading,
} from '@shared/types/nl-query';
import { parseIntent } from './parser';
import { TagResolver } from './resolver';
import {
  DEFAULT_TREND_WINDOW_MS,
  MAX_ALARM_SCAN,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_SAMPLES,
  MAX_RESOLVER_CANDIDATE_TAGS,
  MAX_RESULT_ITEMS,
  QUERY_TIMEOUT_MS,
} from './limits';

const EXAMPLE_QUERIES: readonly string[] = [
  'What is the pressure in tank 3?',
  'Compare FEEDER-01.CURRENT and FEEDER-02.CURRENT',
  'Trend of transformer temperature over the last 2 hours',
  'What is the status of BK-FEEDER-01?',
  'Any active alarms?',
  'What tags are available?',
];

/** One intent's execution outcome, before it is wrapped into a QueryResult. */
interface Outcome {
  success: boolean;
  answer: string;
  data: Record<string, unknown>;
  suggestions: string[];
}

class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`NL query exceeded ${timeoutMs}ms`);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Bound the wall-clock time the caller waits.
 *
 * Note honestly what this does and does not do: it bounds the *response*, not
 * the underlying work. A promise cannot be cancelled in JavaScript, so an
 * in-flight database query keeps running to completion. That residual work is
 * bounded separately and independently — every port read carries an explicit
 * row cap pushed down as a SQL LIMIT (MAX_HISTORY_SAMPLES,
 * MAX_RESOLVER_CANDIDATE_TAGS, MAX_ALARM_SCAN) — so a timed-out query cannot
 * leave unbounded work behind it.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface NLQueryEngineOptions {
  dataPort: NLQueryDataPort;
  resolver?: TagResolver;
  /** Override for tests; defaults to QUERY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Override for tests; defaults to MAX_HISTORY_ENTRIES. */
  maxHistory?: number;
}

export class NLQueryEngine {
  readonly resolver: TagResolver;

  private readonly dataPort: NLQueryDataPort;
  private readonly timeoutMs: number;
  private readonly maxHistory: number;
  /** Bounded ring buffer. Process-local by design (ADR-0027). */
  private readonly history: QueryResult[] = [];
  private queryCounter = 0;
  private readonly bootId = Date.now().toString(36);

  constructor(options: NLQueryEngineOptions) {
    this.dataPort = options.dataPort;
    this.resolver = options.resolver ?? new TagResolver();
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
    this.maxHistory = options.maxHistory ?? MAX_HISTORY_ENTRIES;
  }

  /** Newest first, capped by the caller. History is lost on restart. */
  getHistory(limit: number): QueryResult[] {
    // A non-finite limit must not become an unbounded read: `Math.min(NaN, n)`
    // is NaN, and `slice(-NaN)` is `slice(0)` — the whole buffer again.
    const requested = Number.isFinite(limit) ? limit : 0;
    const safeLimit = Math.max(0, Math.min(requested, this.maxHistory));
    // `slice(-0)` is `slice(0)`, which would return the entire buffer — the
    // exact opposite of the requested bound. Handle zero explicitly.
    if (safeLimit === 0) return [];
    return this.history.slice(-safeLimit).reverse();
  }

  async execute(query: string, nowMs = Date.now()): Promise<QueryResult> {
    const startedAt = Date.now();
    const truncation: QueryTruncation = {
      tagCatalogue: false,
      historySamples: false,
      resultItems: false,
      timeRange: false,
    };

    // Parsing is pure, synchronous and linear on an already length-capped
    // string, so it runs outside the timed section — which also means the
    // intent is known even if the data reads time out.
    const intent = parseIntent(query, nowMs);
    if (intent.timeRangeClamped) truncation.timeRange = true;

    let resolved: ResolvedSubject[] = [];
    let outcome: Outcome;
    try {
      const run = await withTimeout(
        this.resolveAndExecute(intent, nowMs, truncation),
        this.timeoutMs,
      );
      resolved = run.resolved;
      outcome = run.outcome;
    } catch (error) {
      outcome =
        error instanceof QueryTimeoutError
          ? {
              success: false,
              answer:
                `I could not answer within the ${this.timeoutMs}ms query time limit, `
                + 'so I have no result to report. Narrow the question (a shorter '
                + 'trend window, or a specific tag id) and try again.',
              data: { timedOut: true, timeoutMs: this.timeoutMs },
              suggestions: [],
            }
          : {
              success: false,
              answer:
                'I could not complete that query because the process data store '
                + 'returned an error. No value is available to report.',
              data: { failed: true },
              suggestions: [],
            };
    }

    const result: QueryResult = {
      id: `NLQ-${this.bootId}-${++this.queryCounter}`,
      query,
      intent,
      resolved,
      success: outcome.success,
      answer: outcome.answer,
      interpretation: describe(intent, resolved),
      data: outcome.data,
      suggestions: outcome.suggestions,
      timestamp: nowMs,
      durationMs: Date.now() - startedAt,
      truncation,
      parsedBy: 'regex',
    };

    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    return result;
  }

  // ── Resolution + dispatch ──────────────────────────────────────────────

  private async resolveAndExecute(
    intent: QueryIntent,
    nowMs: number,
    truncation: QueryTruncation,
  ): Promise<{ resolved: ResolvedSubject[]; outcome: Outcome }> {
    // `list_tags` needs the catalogue but has no subjects; `alarms` resolves
    // against the active alarm set instead of the tag catalogue. Both skip the
    // catalogue read they do not need.
    if (intent.type === 'alarms') {
      return this.executeAlarms(intent, truncation);
    }

    const catalogue = await this.dataPort.listTags(MAX_RESOLVER_CANDIDATE_TAGS);
    if (!catalogue.available) {
      return {
        resolved: [],
        outcome: {
          success: false,
          answer:
            'I could not read the tag catalogue, so I cannot resolve any tag '
            + `name or report a value. Reason: ${catalogue.reason}`,
          data: { tagCatalogueUnavailable: catalogue.reason },
          suggestions: [],
        },
      };
    }
    if (catalogue.value.truncated) truncation.tagCatalogue = true;

    // Defence in depth: MAX_RESOLVER_CANDIDATE_TAGS is the only CPU bound on
    // the O(tags x tokens) scoring path, so the engine re-applies it rather
    // than trusting every port to have honoured the cap it was passed. A port
    // that over-returns is then reported as truncated instead of scored.
    let tags = catalogue.value.tagIds;
    if (tags.length > MAX_RESOLVER_CANDIDATE_TAGS) {
      tags = tags.slice(0, MAX_RESOLVER_CANDIDATE_TAGS);
      truncation.tagCatalogue = true;
    }
    const resolved = intent.subjects.map((subject) =>
      this.resolver.resolve(subject, tags, truncation.tagCatalogue),
    );

    const outcome = await this.dispatch(intent, resolved, tags, nowMs, truncation);
    return { resolved, outcome };
  }

  private dispatch(
    intent: QueryIntent,
    resolved: ResolvedSubject[],
    tags: readonly string[],
    nowMs: number,
    truncation: QueryTruncation,
  ): Promise<Outcome> {
    switch (intent.type) {
      case 'read_tag':
        return this.executeRead(resolved);
      case 'compare':
        return this.executeCompare(resolved);
      case 'trend':
        return this.executeTrend(resolved, intent, nowMs, truncation);
      case 'status':
        return this.executeStatus(resolved, nowMs);
      case 'list_tags':
        return Promise.resolve(this.executeListTags(tags, truncation));
      // 'alarms' never reaches here — resolveAndExecute handles it before the
      // catalogue read, because it resolves against the active alarm set.
      case 'unknown':
      default:
        return Promise.resolve({
          success: false,
          answer:
            "I couldn't understand that question, so I have not run any query.",
          data: {},
          suggestions: [...EXAMPLE_QUERIES],
        });
    }
  }

  // ── Intent execution ───────────────────────────────────────────────────

  private async executeRead(resolved: ResolvedSubject[]): Promise<Outcome> {
    const subject = resolved[0];
    if (!subject) return missingSubject('What would you like to read?');
    if (!subject.tagId) return unresolved(subject);

    const read = await this.dataPort.readLatest(subject.tagId);
    if (!read.available) return storeUnavailable(subject.tagId, read.reason);
    if (read.value === null) return noData(subject.tagId);

    const reading = read.value;
    return {
      success: true,
      answer:
        `${reading.tagId} is ${reading.value}`
        + qualitySuffix(reading)
        + ` as of ${new Date(reading.timestamp).toISOString()} (${sourceLabel(reading)}).`,
      data: { reading },
      suggestions: [],
    };
  }

  private async executeCompare(resolved: ResolvedSubject[]): Promise<Outcome> {
    if (resolved.length < 2) {
      return missingSubject('A comparison needs two tags.');
    }
    for (const subject of resolved) {
      if (!subject.tagId) return unresolved(subject);
    }

    const readings: TagReading[] = [];
    for (const subject of resolved) {
      // Non-null asserted by the loop above; keep the check explicit for the
      // type checker rather than using a non-null assertion.
      const tagId = subject.tagId;
      if (tagId === null) return unresolved(subject);

      const read = await this.dataPort.readLatest(tagId);
      if (!read.available) return storeUnavailable(tagId, read.reason);
      if (read.value === null) {
        // Missing data is reported explicitly — never coerced to 0.
        return {
          success: false,
          answer: `No data is recorded for ${tagId}, so I cannot compare the two tags.`,
          data: { missing: tagId },
          suggestions: [],
        };
      }
      readings.push(read.value);
    }

    const [a, b] = readings;
    const numericA = numericValue(a.value);
    const numericB = numericValue(b.value);
    if (numericA === null || numericB === null) {
      return {
        success: false,
        answer:
          `${a.tagId} (${a.value}) and ${b.tagId} (${b.value}) are not both `
          + 'numeric, so I cannot compute a difference.',
        data: { a, b },
        suggestions: [],
      };
    }

    const difference = numericA - numericB;
    return {
      success: true,
      answer:
        `${a.tagId} is ${numericA} and ${b.tagId} is ${numericB} — `
        + `a difference of ${Number(difference.toFixed(6))}.`,
      data: { a, b, difference },
      suggestions: [],
    };
  }

  private async executeTrend(
    resolved: ResolvedSubject[],
    intent: QueryIntent,
    nowMs: number,
    truncation: QueryTruncation,
  ): Promise<Outcome> {
    const subject = resolved[0];
    if (!subject) return missingSubject('Which tag should I trend?');
    if (!subject.tagId) return unresolved(subject);

    const range = intent.timeRange ?? {
      start: nowMs - DEFAULT_TREND_WINDOW_MS,
      end: nowMs,
    };
    const read = await this.dataPort.readHistory(
      subject.tagId,
      range.start,
      range.end,
      MAX_HISTORY_SAMPLES,
    );
    if (!read.available) return storeUnavailable(subject.tagId, read.reason);
    if (read.value.truncated) truncation.historySamples = true;

    const points = read.value.samples.filter(
      (p): p is TagReading & { value: number } => typeof p.value === 'number',
    );
    if (points.length === 0) {
      return {
        success: false,
        answer:
          `No numeric samples are recorded for ${subject.tagId} between `
          + `${new Date(range.start).toISOString()} and `
          + `${new Date(range.end).toISOString()}, so there is no trend to report.`,
        data: { tagId: subject.tagId, range, samples: 0 },
        suggestions: [],
      };
    }

    const values = points.map((p) => p.value);
    let min = values[0];
    let max = values[0];
    let sum = 0;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }
    const avg = sum / values.length;
    const delta = values[values.length - 1] - values[0];
    const direction = delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat';
    const minutes = Math.round((range.end - range.start) / 60_000);

    const caveats: string[] = [];
    if (truncation.historySamples) {
      caveats.push(
        ` Only the first ${MAX_HISTORY_SAMPLES} samples in the window were read `
        + '(sample cap), so these figures describe that subset, not the whole window.',
      );
    }
    if (intent.timeRangeClamped) {
      caveats.push(' The requested window was longer than the maximum and was clamped.');
    }

    return {
      success: true,
      answer:
        `${subject.tagId} over the last ${minutes} minutes: ${points.length} samples, `
        + `min ${min}, max ${max}, average ${Number(avg.toFixed(3))} — ${direction} `
        + `(${delta >= 0 ? '+' : ''}${Number(delta.toFixed(3))}).`
        + caveats.join(''),
      data: {
        tagId: subject.tagId,
        range,
        samples: points.length,
        min,
        max,
        avg,
        delta,
        direction,
        sampleCapReached: truncation.historySamples,
        windowClamped: intent.timeRangeClamped === true,
      },
      suggestions: [],
    };
  }

  private async executeStatus(
    resolved: ResolvedSubject[],
    nowMs: number,
  ): Promise<Outcome> {
    const subject = resolved[0];
    if (!subject) return missingSubject('Which tag or equipment?');
    if (!subject.tagId) return unresolved(subject);

    const read = await this.dataPort.readLatest(subject.tagId);
    if (!read.available) return storeUnavailable(subject.tagId, read.reason);
    if (read.value === null) return noData(subject.tagId);

    const reading = read.value;
    const ageSeconds = Math.max(0, Math.round((nowMs - reading.timestamp) / 1000));
    return {
      success: true,
      // Deliberately reports the last recorded value and its age rather than a
      // running/stopped verdict: this repository has no equipment state model,
      // so inferring one would be an invention.
      answer:
        `${reading.tagId}: last recorded value ${reading.value}`
        + qualitySuffix(reading)
        + `, ${ageSeconds}s old (${sourceLabel(reading)}). `
        + 'No equipment state model is configured, so this is the tag value, '
        + 'not a running/stopped verdict.',
      data: { reading, ageSeconds },
      suggestions: [],
    };
  }

  private async executeAlarms(
    intent: QueryIntent,
    truncation: QueryTruncation,
  ): Promise<{ resolved: ResolvedSubject[]; outcome: Outcome }> {
    const read = await this.dataPort.listActiveAlarms(MAX_ALARM_SCAN);
    if (!read.available) {
      return {
        resolved: [],
        outcome: {
          success: false,
          answer:
            'I could not read the active alarm list, so I cannot tell you '
            + `whether any alarms are active. Reason: ${read.reason}`,
          data: { alarmsUnavailable: read.reason },
          suggestions: [],
        },
      };
    }

    const all = read.value.alarms;
    const scanTruncated = read.value.truncated;
    const phrase = intent.subjects[0];

    if (phrase === undefined) {
      return {
        resolved: [],
        outcome: this.summariseAlarms(all, scanTruncated, truncation, null),
      };
    }

    // Scope the question to equipment by resolving against the tag ids present
    // in the ACTIVE alarm set — the only universe in which the answer is
    // meaningful, and already bounded by MAX_ALARM_SCAN.
    const alarmTagIds = [...new Set(all.map((a) => a.tagId))];
    const subject = this.resolver.resolve(phrase, alarmTagIds, scanTruncated);
    if (!subject.tagId) {
      return {
        resolved: [subject],
        outcome: {
          success: false,
          // Critically NOT "no alarms" — an unresolved scope must not read as
          // an all-clear.
          answer:
            `I couldn't identify "${phrase}" among the tags with active alarms, `
            + `so I cannot scope the answer to it. There ${all.length === 1 ? 'is' : 'are'} `
            + `${all.length} active alarm${all.length === 1 ? '' : 's'} in total`
            + (subject.candidates.length > 0
              ? `. Did you mean: ${subject.candidates.join(', ')}?`
              : '.'),
          data: {
            unresolved: phrase,
            candidates: subject.candidates,
            totalActive: all.length,
          },
          suggestions: subject.candidates,
        },
      };
    }

    const scoped = all.filter((a) => a.tagId === subject.tagId);
    return {
      resolved: [subject],
      outcome: this.summariseAlarms(scoped, scanTruncated, truncation, subject.tagId),
    };
  }

  private summariseAlarms(
    alarms: readonly ActiveAlarmSummary[],
    scanTruncated: boolean,
    truncation: QueryTruncation,
    scopeTagId: string | null,
  ): Outcome {
    const scope = scopeTagId ? ` for ${scopeTagId}` : '';
    if (alarms.length === 0) {
      return {
        success: true,
        answer: scanTruncated
          ? `No active alarms${scope} among the first ${MAX_ALARM_SCAN} scanned; `
            + 'more active alarms exist beyond that cap.'
          : `No active alarms${scope}.`,
        data: { alarms: [], total: 0, scanTruncated },
        suggestions: [],
      };
    }

    const shown = alarms.slice(0, MAX_RESULT_ITEMS);
    if (shown.length < alarms.length) truncation.resultItems = true;
    const summary = shown.map((a) => `${a.name} (${a.severity})`).join('; ');
    return {
      success: true,
      answer:
        `${alarms.length} active alarm${alarms.length === 1 ? '' : 's'}${scope}`
        + (shown.length < alarms.length ? ` (showing ${shown.length})` : '')
        + `: ${summary}.`
        + (scanTruncated
          ? ` More active alarms exist beyond the ${MAX_ALARM_SCAN}-alarm scan cap.`
          : ''),
      data: { alarms: shown, total: alarms.length, scanTruncated },
      suggestions: [],
    };
  }

  private executeListTags(
    tags: readonly string[],
    truncation: QueryTruncation,
  ): Outcome {
    if (tags.length === 0) {
      return {
        success: true,
        answer: 'No tags are recorded in the process data store.',
        data: { count: 0, tags: [] },
        suggestions: [],
      };
    }
    const shown = tags.slice(0, MAX_RESULT_ITEMS);
    if (shown.length < tags.length) truncation.resultItems = true;
    return {
      success: true,
      answer:
        `${tags.length}${truncation.tagCatalogue ? '+' : ''} tags available`
        + (shown.length < tags.length ? ` (showing ${shown.length})` : '')
        + `: ${shown.join(', ')}.`
        + (truncation.tagCatalogue
          ? ` The catalogue was capped at ${MAX_RESOLVER_CANDIDATE_TAGS} tags, `
            + 'so more tags exist than this count reports.'
          : ''),
      data: {
        count: tags.length,
        countIsCapped: truncation.tagCatalogue,
        tags: shown,
      },
      suggestions: [],
    };
  }
}

// ── Shared outcome builders ──────────────────────────────────────────────

function missingSubject(prompt: string): Outcome {
  return {
    success: false,
    answer: prompt,
    data: {},
    suggestions: [...EXAMPLE_QUERIES],
  };
}

function unresolved(subject: ResolvedSubject): Outcome {
  const scopeNote = subject.searchTruncated
    ? ` I only searched the first ${MAX_RESOLVER_CANDIDATE_TAGS} tags, so this `
      + 'does not mean the tag does not exist.'
    : '';
  return {
    success: false,
    answer:
      subject.candidates.length > 0
        ? `I couldn't uniquely identify a tag for "${subject.phrase}". `
          + `Did you mean: ${subject.candidates.join(', ')}?${scopeNote}`
        : `I couldn't find any tag matching "${subject.phrase}".${scopeNote}`,
    data: {
      unresolved: subject.phrase,
      candidates: subject.candidates,
      searchTruncated: subject.searchTruncated === true,
    },
    suggestions: subject.candidates,
  };
}

function noData(tagId: string): Outcome {
  return {
    success: false,
    answer: `No data is recorded for ${tagId}.`,
    data: { tagId },
    suggestions: [],
  };
}

function storeUnavailable(tagId: string, reason: string): Outcome {
  return {
    success: false,
    answer:
      `I could not read ${tagId} from the process data store, so I have no `
      + `value to report. Reason: ${reason}`,
    data: { tagId, unavailable: reason },
    suggestions: [],
  };
}

/**
 * Strictly numeric interpretation of a stored reading, or null.
 *
 * `Number()` must NOT be used here. A `historian_data` row carries either a
 * numeric `value` or a text `string_value`, and JavaScript's coercion turns
 * several non-numeric strings into plausible readings: `Number("")` and
 * `Number("   ")` are `0`, and `Number("0x10")` is `16`. Feeding those into a
 * comparison made the engine state a value no sensor produced — `success:
 * true`, "A.X is 0 and B.X is 5 — a difference of -5" for a tag whose recorded
 * value was the empty string — which is exactly the fabrication this surface
 * exists to avoid, and which the "never coerced to 0" comment above already
 * promised did not happen.
 *
 * Only a plain decimal literal (optionally signed, optionally exponent) is
 * accepted. Anything else returns null and the caller reports that the two
 * readings are not both numeric, quoting the values as they were stored.
 */
const DECIMAL_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function numericValue(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!DECIMAL_LITERAL.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function qualitySuffix(reading: TagReading): string {
  return reading.quality && reading.quality !== 'good'
    ? ` (quality: ${reading.quality})`
    : '';
}

function sourceLabel(reading: TagReading): string {
  return reading.source === 'live-stream' ? 'live tag stream' : 'historian';
}

function describe(intent: QueryIntent, resolved: readonly ResolvedSubject[]): string {
  const subjects = resolved
    .map((r) => (r.tagId ? `"${r.phrase}" -> ${r.tagId}` : `"${r.phrase}" (unresolved)`))
    .join(', ');
  return `intent: ${intent.type}${subjects ? `; subjects: ${subjects}` : ''}`;
}

export type { Outcome as NLQueryOutcome };
export { QueryTimeoutError };

/** Exposed so the route and tests share one list of worked examples. */
export function exampleQueries(): string[] {
  return [...EXAMPLE_QUERIES];
}
