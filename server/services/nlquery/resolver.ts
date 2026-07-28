/**
 * Tag Resolver
 * Issue #216; contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * Resolves a natural-language phrase ("pressure in tank 3") against the actual
 * tag universe by token-overlap scoring, with exact ids and explicit aliases
 * taking precedence.
 *
 * Two behaviours are safety properties, not heuristics, and are pinned by
 * tests:
 *
 *   1. **It never invents a tag id.** There is no path from a phrase to a tag
 *      id other than matching a string the caller supplied in `availableTags`.
 *      An unmatched phrase resolves to null.
 *   2. **It never guesses between ambiguous candidates.** Equal top scores
 *      resolve to null plus the tied candidates, so the operator disambiguates.
 *      Silently picking one of two equally-good tags would put a reading from
 *      the wrong vessel in front of an operator.
 *
 * Numeric tokens are treated as equipment identity and must match exactly:
 * "tank 12" must never resolve to TANK-3.PRESSURE.
 *
 * Bounding: scoring is O(tags x tokens), so the caller passes an already-capped
 * `availableTags` (MAX_RESOLVER_CANDIDATE_TAGS) and sets `searchTruncated` when
 * the real catalogue was larger. Under truncation a miss is reported as "not
 * found among the tags examined" — the engine must not claim a tag does not
 * exist when it only looked at part of the catalogue.
 */

import type { ResolvedSubject } from '@shared/types/nl-query';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'of', 'for', 'is', 'me', 'current',
  'value', 'level', 'and', 'to', 'from', 'what', 'show',
]);

/** Most candidates echoed back to the caller for disambiguation. */
const MAX_CANDIDATES = 5;

/** Minimum token-overlap fraction for a tag to be considered a candidate. */
const MIN_SCORE = 0.5;

/** Split a phrase or tag id into normalized comparable tokens. */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s._\-/:]+/)
    .map((t) => t.toLowerCase().replace(/^0+(?=\d)/, ''))
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

export class TagResolver {
  private readonly aliases = new Map<string, string>();

  registerAlias(alias: string, tagId: string): void {
    this.aliases.set(alias.trim().toLowerCase(), tagId);
  }

  listAliases(): Array<{ alias: string; tagId: string }> {
    return [...this.aliases.entries()].map(([alias, tagId]) => ({ alias, tagId }));
  }

  /**
   * Resolve a phrase against the available tags.
   *
   * @param availableTags Already capped by the caller to
   *   MAX_RESOLVER_CANDIDATE_TAGS.
   * @param searchTruncated True when the real catalogue was larger than
   *   `availableTags`, so a null result means "no match here", not "no such tag".
   */
  resolve(
    phrase: string,
    availableTags: readonly string[],
    searchTruncated = false,
  ): ResolvedSubject {
    const trimmed = phrase.trim();
    const base = { phrase, searchTruncated };

    // Exact tag id (case-insensitive) always wins, and is unaffected by
    // catalogue truncation when the caller also consulted an index.
    const exact = availableTags.find((t) => t.toLowerCase() === trimmed.toLowerCase());
    if (exact) return { ...base, tagId: exact, candidates: [exact] };

    // Explicit alias — an operator-configured mapping outranks scoring.
    const alias = this.aliases.get(trimmed.toLowerCase());
    if (alias) return { ...base, tagId: alias, candidates: [alias] };

    const phraseTokens = tokenize(trimmed);
    if (phraseTokens.length === 0) return { ...base, tagId: null, candidates: [] };

    const scored: Array<{ tagId: string; score: number }> = [];
    for (const tagId of availableTags) {
      const score = this.scoreTag(tagId, phraseTokens);
      if (score >= MIN_SCORE) scored.push({ tagId, score });
    }
    scored.sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { ...base, tagId: null, candidates: [] };

    const best = scored[0];
    const ties = scored.filter((s) => s.score === best.score);
    if (ties.length > 1) {
      // Ambiguous — never guess between equally good matches.
      return {
        ...base,
        tagId: null,
        candidates: ties.slice(0, MAX_CANDIDATES).map((s) => s.tagId),
      };
    }
    return {
      ...base,
      tagId: best.tagId,
      candidates: scored.slice(0, MAX_CANDIDATES).map((s) => s.tagId),
    };
  }

  /** Fraction of phrase tokens found among the tag's tokens, 0 on identity mismatch. */
  private scoreTag(tagId: string, phraseTokens: readonly string[]): number {
    const tagTokens = new Set(tokenize(tagId));
    let matched = 0;
    for (const token of phraseTokens) {
      // Numeric tokens are equipment identity — they must match exactly.
      // "tank 12" must never resolve to TANK-3.PRESSURE.
      if (/^\d+$/.test(token)) {
        if (!tagTokens.has(token)) return 0;
        matched++;
        continue;
      }
      if (tagTokens.has(token)) {
        matched++;
        continue;
      }
      // Loose singular/plural and prefix matching ("temp" ~ "temperature")
      const prefixHit = [...tagTokens].some(
        (t) =>
          (token.length >= 3 && t.startsWith(token)) ||
          (t.length >= 3 && token.startsWith(t)),
      );
      if (prefixHit) matched += 0.75;
    }
    return matched / phraseTokens.length;
  }
}
