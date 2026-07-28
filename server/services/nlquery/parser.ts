/**
 * Intent Parser (regex grammar)
 * Issue #216; contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * Ported unchanged in substance from the reviewed implementation: an ORDERED
 * grammar with the specific intents first and the generic `read_tag` catch-all
 * last. Ordering is the whole trick — with `read_tag` first, "what is the
 * status of X" matches the catch-all and can never be recognised as a status
 * query. The ordering regressions are pinned by tests.
 *
 * This module is pure: `(query, nowMs) => QueryIntent`, no I/O, no clock, no
 * `eval`, no dynamic `RegExp` construction from operator input. It is also the
 * single seam any future parsing strategy would replace (ADR-0027).
 *
 * Regex safety: every pattern below is linear-time on the input. The only
 * repetition operators applied to operator-controlled text are `.+?`/`.*`,
 * which are not nested inside another quantifier, so there is no
 * catastrophic-backtracking path. Input is additionally capped at
 * MAX_QUERY_LENGTH before it reaches this module.
 */

import type { QueryIntent } from '@shared/types/nl-query';
import { DEFAULT_TREND_WINDOW_MS, MAX_TREND_WINDOW_MS } from './limits';

const DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** Unknown units return null so the caller falls back to the default window. */
export function parseDurationMs(amount: number, unit: string): number | null {
  const ms = DURATION_UNITS[unit.toLowerCase()];
  if (ms === undefined) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * ms;
}

function clean(phrase: string): string {
  return phrase.replace(/[?.!]+$/, '').replace(/^the\s+/i, '').trim();
}

/**
 * Build a trend window, clamped to MAX_TREND_WINDOW_MS. The clamp is reported
 * rather than applied silently: `timeRangeClamped` reaches the response so the
 * operator sees that a narrower window than requested was searched.
 */
function windowFor(
  requestedMs: number | null,
  nowMs: number,
): { start: number; end: number; clamped: boolean } {
  const desired = requestedMs ?? DEFAULT_TREND_WINDOW_MS;
  const clamped = desired > MAX_TREND_WINDOW_MS;
  const width = clamped ? MAX_TREND_WINDOW_MS : desired;
  return { start: nowMs - width, end: nowMs, clamped };
}

interface Pattern {
  regex: RegExp;
  build: (match: RegExpMatchArray, raw: string, nowMs: number) => QueryIntent;
}

const PATTERNS: readonly Pattern[] = [
  // list_tags — "what tags are available", "list tags", "show all tags"
  {
    regex: /\b(?:list|show|what|which)\b.*\btags?\b(?:\s+(?:are|do)\b.*)?$/i,
    build: (_m, raw) => ({ type: 'list_tags', subjects: [], raw }),
  },
  // alarms — "any active alarms?", "alarms on tank 3"
  {
    regex: /\balarms?\b(?:\s+(?:on|for|in)\s+(.+?))?[?.!]*$/i,
    build: (m, raw) => ({
      type: 'alarms',
      subjects: m[1] ? [clean(m[1])] : [],
      raw,
    }),
  },
  // trend — "trend of pressure in tank 3 over the last 2 hours"
  {
    regex:
      /\b(?:trend|history|graph|chart)\b(?:\s+(?:of|for))?\s+(.+?)(?:\s+(?:over\s+the\s+|for\s+the\s+)?(?:last|past)\s+(\d+)\s*([a-z]+))?[?.!]*$/i,
    build: (m, raw, nowMs) => {
      const requested =
        m[2] && m[3] ? parseDurationMs(Number.parseInt(m[2], 10), m[3]) : null;
      const { start, end, clamped } = windowFor(requested, nowMs);
      return {
        type: 'trend',
        subjects: [clean(m[1])],
        timeRange: { start, end },
        timeRangeClamped: clamped,
        raw,
      };
    },
  },
  // status — "what is the status of pump 1", "health of feeder 2"
  {
    regex: /\b(?:status|state|health)\b\s+(?:of|for)?\s*(.+?)[?.!]*$/i,
    build: (m, raw) => ({ type: 'status', subjects: [clean(m[1])], raw }),
  },
  // compare — "compare X and Y", "difference between X and Y"
  {
    regex:
      /\b(?:compare|difference(?:\s+between)?|diff)\s+(.+?)\s+(?:and|vs\.?|versus|with)\s+(.+?)[?.!]*$/i,
    build: (m, raw) => ({
      type: 'compare',
      subjects: [clean(m[1]), clean(m[2])],
      raw,
    }),
  },
  // read_tag with measurement + location — "what is the pressure in tank 3"
  {
    regex:
      /\b(?:what(?:'s|\s+is)?|show(?:\s+me)?|get|read|give\s+me)\s+(?:the\s+)?(?:current\s+)?(.+?)\s+(?:in|on|at|of|for)\s+(.+?)[?.!]*$/i,
    build: (m, raw) => ({
      type: 'read_tag',
      // Keep the full phrase — resolution scores measurement AND location
      subjects: [`${clean(m[1])} ${clean(m[2])}`],
      raw,
    }),
  },
  // read_tag generic catch-all — "show FEEDER-01.CURRENT"
  {
    regex:
      /\b(?:what(?:'s|\s+is)?|show(?:\s+me)?|get|read|value\s+of)\s+(?:the\s+)?(?:current\s+)?(?:value\s+(?:of|for)\s+)?(.+?)[?.!]*$/i,
    build: (m, raw) => ({ type: 'read_tag', subjects: [clean(m[1])], raw }),
  },
];

/**
 * Match the ordered grammar. An unmatched question yields `unknown`, which the
 * engine answers with example queries — never with a guess.
 */
export function parseIntent(query: string, nowMs: number): QueryIntent {
  const trimmed = query.trim();
  for (const pattern of PATTERNS) {
    const match = trimmed.match(pattern.regex);
    if (match) {
      return pattern.build(match, trimmed, nowMs);
    }
  }
  return { type: 'unknown', subjects: [], raw: trimmed };
}
