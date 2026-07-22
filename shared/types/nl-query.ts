/**
 * Natural Language Process Query Types
 * ADR-0013 [13.5] — Issue #216
 *
 * Regex-based intent parsing MVP with a pluggable LLM backend interface.
 * The engine is read-only over process data (ADR-0008 capability scoping):
 * it answers questions, it never writes.
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
  raw: string;
}

/**
 * Resolution of one subject phrase against the known tag universe.
 * An unresolvable phrase yields tagId null plus candidates — it is never
 * silently passed through as if it were a tag id.
 */
export interface ResolvedSubject {
  phrase: string;
  tagId: string | null;
  candidates: string[];
}

export interface TagReading {
  tagId: string;
  value: number | string;
  quality?: string;
  /** Epoch ms */
  timestamp: number;
}

/** Read-only data access the engine answers from */
export interface TagDataSource {
  listTags(): string[];
  readLatest(tagId: string): TagReading | null;
  readHistory(tagId: string, startMs: number, endMs: number): TagReading[];
}

export interface ActiveAlarmSummary {
  id: string;
  name: string;
  severity: string;
  message: string;
  timestamp: number;
}

/** Read-only alarm access; implementations may scope by subject phrase */
export interface AlarmSource {
  getActiveAlarms(subject?: string): ActiveAlarmSummary[];
}

export interface QueryResult {
  id: string;
  query: string;
  intent: QueryIntent;
  resolved: ResolvedSubject[];
  success: boolean;
  /** Natural-language answer */
  answer: string;
  /** Human-readable description of how the query was interpreted */
  interpretation: string;
  /** Structured data backing the answer */
  data: Record<string, unknown>;
  suggestions: string[];
  timestamp: number;
  /** 'regex' or the LLM backend's name */
  parsedBy: string;
}

/**
 * Pluggable LLM backend contract. Both methods are optional-decline: return
 * null to fall back to the regex parser / template formatter. Methods are
 * async so a real implementation can call a hosted model (e.g. the
 * Anthropic SDK with structured outputs constraining parseQuery's result
 * to the QueryIntent schema). Backend errors are surfaced by the engine as
 * 'backend-error' events and then fall back — never silently swallowed.
 */
export interface LLMBackend {
  readonly name: string;
  parseQuery(
    query: string,
    context: { availableTags: string[] }
  ): Promise<QueryIntent | null>;
  formatAnswer(
    intent: QueryIntent,
    data: Record<string, unknown>
  ): Promise<string | null>;
}
