/**
 * Natural Language Process Query Engine
 * ADR-0013 [13.5] — "What's the pressure in tank 3?" → parse → query → respond
 */

export interface QueryIntent {
  type: 'read_tag' | 'read_multiple' | 'compare' | 'trend' | 'status' | 'alarm' | 'unknown';
  tags: string[];
  timeRange?: { start: number; end: number };
  aggregation?: 'latest' | 'average' | 'min' | 'max' | 'sum';
  raw: string;
}

export interface QueryResult {
  intent: QueryIntent;
  success: boolean;
  data: Record<string, unknown>;
  naturalResponse: string;
  timestamp: number;
}

export interface TagResolver {
  resolve(name: string): string | null; // natural name -> tagId
  search(query: string): string[]; // fuzzy search
}

export interface TagDataSource {
  readTag(tagId: string): Promise<{ value: number; timestamp: number; unit: string } | null>;
  readHistory(tagId: string, start: number, end: number): Promise<Array<{ value: number; timestamp: number }>>;
}

export interface LLMBackend {
  parseQuery(query: string): Promise<QueryIntent>;
  formatResponse(intent: QueryIntent, data: Record<string, unknown>): Promise<string>;
}

// ── Pattern-Based Intent Parser (MVP) ─────────────────────────────

const PATTERNS: Array<{ regex: RegExp; type: QueryIntent['type']; extract: (m: RegExpMatchArray) => Partial<QueryIntent> }> = [
  {
    regex: /(?:what(?:'s| is)|show|get|read)\s+(?:the\s+)?(.+?)\s+(?:in|on|at|of|for)\s+(.+?)(?:\?|$)/i,
    type: 'read_tag',
    extract: (m) => ({ tags: [resolveTagHint(m[1], m[2])] }),
  },
  {
    regex: /(?:what(?:'s| is)|show|get|read)\s+(?:the\s+)?(?:current\s+)?(?:value\s+(?:of|for)\s+)?(.+?)(?:\?|$)/i,
    type: 'read_tag',
    extract: (m) => ({ tags: [m[1].trim()] }),
  },
  {
    regex: /(?:compare|difference|diff)\s+(.+?)\s+(?:and|vs|versus|with)\s+(.+?)(?:\?|$)/i,
    type: 'compare',
    extract: (m) => ({ tags: [m[1].trim(), m[2].trim()] }),
  },
  {
    regex: /(?:trend|history|graph|chart)\s+(?:of\s+|for\s+)?(.+?)(?:\s+(?:last|past)\s+(\d+)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|d(?:ays?)?))?(?:\?|$)/i,
    type: 'trend',
    extract: (m) => {
      const duration = m[2] ? parseDuration(parseInt(m[2]), m[3]) : 3600000;
      const now = Date.now();
      return { tags: [m[1].trim()], timeRange: { start: now - duration, end: now } };
    },
  },
  {
    regex: /(?:any\s+)?(?:active\s+)?alarms?(?:\s+(?:on|for|in)\s+(.+?))?(?:\?|$)/i,
    type: 'alarm',
    extract: (m) => ({ tags: m[1] ? [m[1].trim()] : [] }),
  },
  {
    regex: /(?:status|state|health)\s+(?:of\s+)?(.+?)(?:\?|$)/i,
    type: 'status',
    extract: (m) => ({ tags: [m[1].trim()] }),
  },
];

function resolveTagHint(measurement: string, location: string): string {
  return `${location.trim()}.${measurement.trim()}`.replace(/\s+/g, '_').toLowerCase();
}

function parseDuration(value: number, unit: string): number {
  if (unit.startsWith('h')) return value * 3600000;
  if (unit.startsWith('m')) return value * 60000;
  if (unit.startsWith('d')) return value * 86400000;
  return value * 3600000;
}

export function parseIntent(query: string): QueryIntent {
  const normalized = query.trim();

  for (const pattern of PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (match) {
      return {
        type: pattern.type,
        tags: [],
        aggregation: 'latest',
        raw: normalized,
        ...pattern.extract(match),
      };
    }
  }

  return { type: 'unknown', tags: [], raw: normalized };
}

// ── Simple Tag Resolver ───────────────────────────────────────────

export class SimpleTagResolver implements TagResolver {
  private aliases: Map<string, string> = new Map();
  private allTags: string[] = [];

  registerTag(tagId: string, ...aliases: string[]): void {
    this.allTags.push(tagId);
    for (const alias of aliases) {
      this.aliases.set(alias.toLowerCase(), tagId);
    }
    this.aliases.set(tagId.toLowerCase(), tagId);
  }

  resolve(name: string): string | null {
    return this.aliases.get(name.toLowerCase()) ?? null;
  }

  search(query: string): string[] {
    const lower = query.toLowerCase();
    const exact = this.aliases.get(lower);
    if (exact) return [exact];

    return this.allTags.filter(
      (t) => t.toLowerCase().includes(lower) ||
        [...this.aliases.entries()]
          .filter(([, v]) => v === t)
          .some(([k]) => k.includes(lower))
    );
  }
}

// ── NL Query Engine ───────────────────────────────────────────────

export class NLQueryEngine {
  private tagResolver: TagResolver;
  private dataSource: TagDataSource | null = null;
  private llmBackend: LLMBackend | null = null;

  constructor(tagResolver: TagResolver) {
    this.tagResolver = tagResolver;
  }

  setDataSource(source: TagDataSource): void {
    this.dataSource = source;
  }

  setLLMBackend(backend: LLMBackend): void {
    this.llmBackend = backend;
  }

  async query(input: string): Promise<QueryResult> {
    // Parse intent (use LLM if available, fallback to regex)
    let intent: QueryIntent;
    if (this.llmBackend) {
      try {
        intent = await this.llmBackend.parseQuery(input);
      } catch {
        intent = parseIntent(input);
      }
    } else {
      intent = parseIntent(input);
    }

    // Resolve tag names
    intent.tags = intent.tags.map((t) => this.tagResolver.resolve(t) ?? t);

    // Execute query
    if (!this.dataSource) {
      return {
        intent,
        success: false,
        data: {},
        naturalResponse: 'No data source configured.',
        timestamp: Date.now(),
      };
    }

    const data: Record<string, unknown> = {};

    try {
      switch (intent.type) {
        case 'read_tag':
        case 'read_multiple':
        case 'status': {
          for (const tagId of intent.tags) {
            const val = await this.dataSource.readTag(tagId);
            data[tagId] = val;
          }
          break;
        }
        case 'trend': {
          for (const tagId of intent.tags) {
            if (intent.timeRange) {
              data[tagId] = await this.dataSource.readHistory(
                tagId,
                intent.timeRange.start,
                intent.timeRange.end
              );
            }
          }
          break;
        }
        case 'compare': {
          for (const tagId of intent.tags) {
            data[tagId] = await this.dataSource.readTag(tagId);
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      return {
        intent,
        success: false,
        data: {},
        naturalResponse: `Error querying data: ${err instanceof Error ? err.message : 'unknown'}`,
        timestamp: Date.now(),
      };
    }

    // Format response
    let naturalResponse: string;
    if (this.llmBackend) {
      try {
        naturalResponse = await this.llmBackend.formatResponse(intent, data);
      } catch {
        naturalResponse = this.formatResponse(intent, data);
      }
    } else {
      naturalResponse = this.formatResponse(intent, data);
    }

    return { intent, success: true, data, naturalResponse, timestamp: Date.now() };
  }

  private formatResponse(intent: QueryIntent, data: Record<string, unknown>): string {
    const entries = Object.entries(data);
    if (entries.length === 0) return "I couldn't find any data for that query.";

    switch (intent.type) {
      case 'read_tag':
      case 'read_multiple': {
        const parts = entries.map(([tag, val]) => {
          const v = val as { value: number; unit: string } | null;
          return v ? `${tag}: ${v.value} ${v.unit}` : `${tag}: no data`;
        });
        return parts.join(', ');
      }
      case 'compare': {
        const vals = entries.map(([tag, val]) => {
          const v = val as { value: number; unit: string } | null;
          return { tag, value: v?.value ?? 0, unit: v?.unit ?? '' };
        });
        if (vals.length === 2) {
          const diff = vals[0].value - vals[1].value;
          return `${vals[0].tag} is ${vals[0].value} ${vals[0].unit}, ${vals[1].tag} is ${vals[1].value} ${vals[1].unit}. Difference: ${diff.toFixed(2)} ${vals[0].unit}.`;
        }
        return vals.map((v) => `${v.tag}: ${v.value} ${v.unit}`).join(', ');
      }
      case 'trend': {
        const parts = entries.map(([tag, val]) => {
          const points = val as Array<{ value: number }> | null;
          if (!points || points.length === 0) return `${tag}: no history`;
          const min = Math.min(...points.map((p) => p.value));
          const max = Math.max(...points.map((p) => p.value));
          const avg = points.reduce((s, p) => s + p.value, 0) / points.length;
          return `${tag}: min=${min.toFixed(1)}, max=${max.toFixed(1)}, avg=${avg.toFixed(1)} (${points.length} points)`;
        });
        return parts.join('\n');
      }
      default:
        return JSON.stringify(data, null, 2);
    }
  }
}
