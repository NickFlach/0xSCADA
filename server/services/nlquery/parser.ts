/**
 * Intent Parser (regex MVP)
 * ADR-0013 [13.5] — Issue #216
 *
 * Ordered grammar with SPECIFIC intents first and the generic read_tag
 * catch-all last — the recovered Wave-2 engine put read_tag first, which
 * made "what is the status of X" unreachable as a status query.
 */

import type { QueryIntent } from '@shared/types/nl-query';

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

export function parseDurationMs(amount: number, unit: string): number | null {
  const ms = DURATION_UNITS[unit.toLowerCase()];
  return ms ? amount * ms : null;
}

function clean(phrase: string): string {
  return phrase.replace(/[?.!]+$/, '').replace(/^the\s+/i, '').trim();
}

interface Pattern {
  regex: RegExp;
  build: (match: RegExpMatchArray, raw: string, nowMs: number) => QueryIntent;
}

const PATTERNS: Pattern[] = [
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
      const duration =
        m[2] && m[3] ? parseDurationMs(parseInt(m[2], 10), m[3]) : null;
      const windowMs = duration ?? 3_600_000; // default: last hour
      return {
        type: 'trend',
        subjects: [clean(m[1])],
        timeRange: { start: nowMs - windowMs, end: nowMs },
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
