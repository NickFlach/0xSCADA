/**
 * Tag Resolver
 * ADR-0013 [13.5] — Issue #216
 *
 * Resolves natural-language phrases ("pressure in tank 3") against the
 * actual tag universe by token scoring, with explicit aliases taking
 * precedence. An unresolvable or ambiguous phrase resolves to null with
 * candidate suggestions — the Wave-2 engine fabricated snake_case tag ids
 * from the phrase and silently queried them.
 */

import type { ResolvedSubject } from '@shared/types/nl-query';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'of', 'for', 'is', 'me', 'current',
  'value', 'level', 'and', 'to', 'from', 'what', 'show',
]);

/** Split a phrase or tag id into normalized comparable tokens */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s._\-/:]+/)
    .map((t) => t.toLowerCase().replace(/^0+(?=\d)/, ''))
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

export class TagResolver {
  private aliases: Map<string, string> = new Map();

  registerAlias(alias: string, tagId: string): void {
    this.aliases.set(alias.trim().toLowerCase(), tagId);
  }

  listAliases(): Array<{ alias: string; tagId: string }> {
    return Array.from(this.aliases.entries()).map(([alias, tagId]) => ({ alias, tagId }));
  }

  /**
   * Resolve a phrase against the available tags. Result is a unique best
   * match, or null with candidates when nothing matches well enough or
   * several tags tie.
   */
  resolve(phrase: string, availableTags: string[]): ResolvedSubject {
    const trimmed = phrase.trim();

    // Exact tag id (case-insensitive) always wins
    const exact = availableTags.find((t) => t.toLowerCase() === trimmed.toLowerCase());
    if (exact) return { phrase, tagId: exact, candidates: [exact] };

    // Explicit alias
    const alias = this.aliases.get(trimmed.toLowerCase());
    if (alias) return { phrase, tagId: alias, candidates: [alias] };

    // Token scoring: fraction of phrase tokens found among the tag's tokens
    const phraseTokens = tokenize(trimmed);
    if (phraseTokens.length === 0) return { phrase, tagId: null, candidates: [] };

    const scored = availableTags
      .map((tagId) => {
        const tagTokens = new Set(tokenize(tagId));
        let matched = 0;
        for (const token of phraseTokens) {
          // Numeric tokens are equipment identity — they must match exactly.
          // "tank 12" must never resolve to TANK-3.PRESSURE.
          if (/^\d+$/.test(token) && !tagTokens.has(token)) {
            return { tagId, score: 0 };
          }
          if (tagTokens.has(token)) {
            matched++;
          } else if (
            // Loose singular/plural and prefix matching ("temp" ~ "temperature")
            [...tagTokens].some(
              (t) =>
                (token.length >= 3 && t.startsWith(token)) ||
                (t.length >= 3 && token.startsWith(t))
            )
          ) {
            matched += 0.75;
          }
        }
        return { tagId, score: matched / phraseTokens.length };
      })
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { phrase, tagId: null, candidates: [] };

    const best = scored[0];
    const ties = scored.filter((s) => s.score === best.score);
    if (ties.length > 1) {
      // Ambiguous — never guess between equally good matches
      return { phrase, tagId: null, candidates: ties.slice(0, 5).map((s) => s.tagId) };
    }
    return { phrase, tagId: best.tagId, candidates: scored.slice(0, 5).map((s) => s.tagId) };
  }
}
