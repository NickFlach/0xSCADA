/**
 * Bounded execution limits for the NL process query surface.
 * Issue #216; contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 *
 * Every bound the query path enforces is named here and nowhere else, so the
 * set of things an operator-supplied string can grow is auditable by reading
 * one file. Each constant is covered by a test that proves the bound holds
 * (server/services/nlquery/__tests__/nl-query-bounds.test.ts).
 *
 * The threat model is not a malicious operator so much as an ordinary one on a
 * large site: a plant with 200k historian tags, a question phrased as "trend of
 * everything over the last year", or a paste of a log file into the question
 * box. None of those may be allowed to occupy the API process.
 */

/**
 * Longest accepted question, in UTF-16 code units.
 *
 * Rejected with 400 rather than truncated: silently answering a question the
 * operator did not finish asking is exactly the failure mode this feature must
 * not have. 512 comfortably exceeds any real question — the longest example in
 * the grammar is 62 characters.
 */
export const MAX_QUERY_LENGTH = 512;

/**
 * Wall-clock ceiling on one `execute()` call, covering parse, resolve, and
 * every port read. On expiry the engine returns an explicit timeout answer
 * with `success: false`; it never returns a partial reading as if it were
 * complete.
 *
 * 2s is ~10x the p99 of the two indexed historian queries this path issues
 * (`idx_historian_tag_timestamp` covers both) while staying well inside a
 * default 30s HTTP client timeout.
 */
export const QUERY_TIMEOUT_MS = 2_000;

/**
 * Most tags the resolver will score in one query.
 *
 * Token-overlap scoring is O(tags x tokens), so this is the only real CPU
 * bound on the path. A site with more tags than this is not an error: the
 * catalogue read is capped at this value, `searchTruncated` is set, and an
 * unresolved phrase is reported as "no match among the N tags I examined"
 * rather than "no such tag" — a claim the engine cannot support once it has
 * only seen part of the catalogue. Exact-id and alias lookups are unaffected,
 * because both are hash lookups the truncation does not reach.
 */
export const MAX_RESOLVER_CANDIDATE_TAGS = 2_000;

/**
 * Most historian samples pulled into memory for one trend query. The port
 * pushes this down as a SQL LIMIT (plus one, to detect truncation) — the
 * oversized row set is never materialised.
 */
export const MAX_HISTORY_SAMPLES = 5_000;

/**
 * Longest trend window accepted. A larger request is clamped to this and the
 * response sets `truncation.timeRange`, so a clamped window is never mistaken
 * for the one that was asked for.
 */
export const MAX_TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** Default trend window when the question names no duration. */
export const DEFAULT_TREND_WINDOW_MS = 60 * 60 * 1_000;

/**
 * Most list items (tag ids, alarm summaries) embedded in one response body.
 * Aggregates computed over a larger sample set still report the true sample
 * count; this caps what is serialised, and sets `truncation.resultItems`.
 */
export const MAX_RESULT_ITEMS = 50;

/**
 * Most alarms fetched from the correlation engine for one query.
 * Larger than MAX_RESULT_ITEMS so the reported total is accurate up to this
 * point rather than being pinned to the display cap.
 */
export const MAX_ALARM_SCAN = 500;

/**
 * Entries retained by the process-local query history ring buffer.
 *
 * History is deliberately NOT persisted (ADR-0027): it is bounded, in-memory,
 * and lost on restart, and both the API response and the docs say so. The ring
 * is what keeps that choice safe — a long-running process cannot grow this
 * buffer without bound.
 */
export const MAX_HISTORY_ENTRIES = 100;

/** Most history rows returned by `GET /nlquery/history` in one response. */
export const MAX_HISTORY_PAGE = 50;
