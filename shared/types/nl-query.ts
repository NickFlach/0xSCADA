/**
 * Natural Language Process Query — shared contract
 * ADR-0013 [13.5] (docs/decisions/ADR-0013-autonomous-agent-architecture.md),
 * refined for this route by docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 * Issue #216.
 *
 * The engine is READ-ONLY over process data. It answers questions; it never
 * writes a tag, a setpoint, or a controller parameter. `POST /nlquery` is a
 * POST only because the question travels in the request body — see ADR-0027.
 *
 * Two invariants are load-bearing for operator safety and are encoded in these
 * types rather than left to convention:
 *
 *   1. A phrase that does not resolve to exactly one tag yields `tagId: null`
 *      plus candidates. There is no code path that turns a phrase into a tag
 *      id by string munging.
 *   2. Every data read returns a {@link PortResult}, so "the historian is not
 *      reachable" is a distinct outcome from "the historian returned no rows".
 *      The engine reports both honestly and never substitutes a value.
 *
 * No language-model backend is defined here, imported here, or called
 * anywhere in this feature. See ADR-0027 §"No LLM backend ships".
 */

export type QueryIntentType =
  | 'read_tag'
  | 'compare'
  | 'trend'
  | 'status'
  | 'alarms'
  | 'list_tags'
  | 'unknown';

export interface QueryTimeRange {
  /** Epoch ms */
  start: number;
  end: number;
}

export interface QueryIntent {
  type: QueryIntentType;
  /** Natural-language phrases naming tags/equipment ("pressure in tank 3") */
  subjects: string[];
  timeRange?: QueryTimeRange;
  /**
   * True when the requested trend window exceeded MAX_TREND_WINDOW_MS and was
   * clamped. Surfaced to the caller so a clamped window is never mistaken for
   * the window that was asked for.
   */
  timeRangeClamped?: boolean;
  raw: string;
}

/**
 * Resolution of one subject phrase against the known tag universe.
 * An unresolvable or ambiguous phrase yields `tagId: null` plus candidates —
 * it is never silently passed through as if it were a tag id.
 */
export interface ResolvedSubject {
  phrase: string;
  tagId: string | null;
  candidates: string[];
  /**
   * True when the tag universe was larger than the resolver's candidate cap,
   * so scoring considered only part of it. The engine says so in its answer:
   * a miss under truncation means "not found in the tags I examined", which is
   * not the same claim as "no such tag exists".
   */
  searchTruncated?: boolean;
}

export interface TagReading {
  tagId: string;
  value: number | string;
  /** Historian quality code, or the tag-stream quality word, when known. */
  quality?: string;
  /** Epoch ms */
  timestamp: number;
  /** Where the value came from, so an answer can cite its provenance. */
  source: 'live-stream' | 'historian';
}

export interface ActiveAlarmSummary {
  id: string;
  name: string;
  tagId: string;
  severity: string;
  state: string;
  message: string;
  /** Epoch ms */
  timestamp: number;
}

/**
 * Result of one read against a backing store.
 *
 * `available: false` means the store could not be consulted (no database
 * configured, the SQLite development fallback has no historian tables, the
 * query failed). It is deliberately NOT collapsed into an empty array: an
 * operator must never be told "no data" when the truth is "not asked".
 */
export type PortResult<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export interface TagCatalogue {
  tagIds: string[];
  /** True when more tags exist than the requested cap allowed us to return. */
  truncated: boolean;
}

export interface HistorySlice {
  samples: TagReading[];
  /** True when the window held more samples than `maxSamples` allowed. */
  truncated: boolean;
}

export interface ActiveAlarmPage {
  alarms: ActiveAlarmSummary[];
  truncated: boolean;
}

/**
 * The narrow, injectable port the engine answers from.
 *
 * Every method takes an explicit cap: the port implementation is responsible
 * for pushing that cap down to the store (SQL LIMIT, map slice) so an
 * unbounded row set is never materialised in this process. Tests inject a
 * fake; production injects {@link ProcessDataPort} over the historian, the
 * live tag stream, and the alarm-correlation engine.
 */
export interface NLQueryDataPort {
  listTags(limit: number): Promise<PortResult<TagCatalogue>>;
  readLatest(tagId: string): Promise<PortResult<TagReading | null>>;
  readHistory(
    tagId: string,
    startMs: number,
    endMs: number,
    maxSamples: number,
  ): Promise<PortResult<HistorySlice>>;
  listActiveAlarms(limit: number): Promise<PortResult<ActiveAlarmPage>>;
}

/** What the bounds did to this particular answer, reported rather than hidden. */
export interface QueryTruncation {
  /** The tag catalogue hit MAX_RESOLVER_CANDIDATE_TAGS. */
  tagCatalogue: boolean;
  /** A history window hit MAX_HISTORY_SAMPLES. */
  historySamples: boolean;
  /** An alarm or tag list was cut to MAX_RESULT_ITEMS for the response body. */
  resultItems: boolean;
  /** The requested trend window exceeded MAX_TREND_WINDOW_MS and was clamped. */
  timeRange: boolean;
}

export interface QueryResult {
  id: string;
  query: string;
  intent: QueryIntent;
  resolved: ResolvedSubject[];
  /** False whenever the engine could not answer from real data. */
  success: boolean;
  /** Natural-language answer. Never contains a value the port did not return. */
  answer: string;
  /** Human-readable description of how the query was interpreted */
  interpretation: string;
  /** Structured data backing the answer */
  data: Record<string, unknown>;
  suggestions: string[];
  /** Epoch ms */
  timestamp: number;
  /** Wall-clock execution time, for operators comparing against the timeout. */
  durationMs: number;
  /** Which bounds bit this answer. */
  truncation: QueryTruncation;
  /**
   * How the intent was derived. Always `'regex'`: this feature ships no
   * language-model backend and calls none (ADR-0027).
   */
  parsedBy: 'regex';
}
