# ADR-0027: Natural-Language Process Query — Read Scope and Bounded Execution

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-07-28 |
| Author | Neel Modha |
| Refines | ADR-0013 [13.5], ADR-0026 |
| Issue | [#216](https://github.com/NickFlach/0xSCADA/issues/216) |

## Context

### The ADR-0013 citation

Issue #216's review noted that the cited `ADR-0013` "does not exist in
`docs/adr`". That is accurate about the directory and misleading about the
document. **ADR-0013 exists**, as
[`docs/decisions/ADR-0013-autonomous-agent-architecture.md`](../decisions/ADR-0013-autonomous-agent-architecture.md)
— Status *Accepted*, dated 2026-02-15 — and it is cited 87 times on `main` at
commit `0aec4ec99` by the whole `[13.x]` intelligence series (predictive maintenance
13.1, alarm correlation 13.2, digital twin 13.3, PID tuning 13.4, this feature
13.5, marketplace 13.6). The repository keeps ADRs in two directories,
`docs/adr/` and `docs/decisions/`, and the reviewer checked the one that does
not hold it.

So the citation is not dangling and does not need to be removed. What it needed
was a correct path, which the code comments now carry. This ADR is the
route-level contract that the review actually asked for: it records the
decisions #216 makes that ADR-0013 does not specify.

[`ADR-0026: Autonomous Agent Security and Integration Contract`](./ADR-0026-autonomous-agent-security-contract.md)
already names this module — "NL query | **Authenticated question** | Structured
process-data answer" — and lists Authentication and Authorization among its open
compliance gaps. This ADR closes those two rows for this surface.

### What went wrong the first time

The previous attempt at #216 was reviewed as "PARTIAL but clean on security".
The security properties it got right are preserved verbatim below. What it got
wrong, and what this decision addresses:

- `requireAuth` on the new routes was a no-op — an unauthenticated read path.
- Nothing bounded execution. Operator text drove an O(tags x tokens) scan with
  no cap, no timeout, and no result limit.
- The engine answered from an in-memory demo store, not from real process data.
- The `LLMBackend` interface was dead code: injected, never wired, never called.
- Query history lived in an unbounded process-local `Map` with no statement
  anywhere that it was not durable.

## Decision

### 1. Both routes require the `nlquery.read` scope

`POST /api/intelligence/nlquery` and `GET /api/intelligence/nlquery/history`
each carry a route-local
`requireControlPlaneAccess({ scopes: ["nlquery.read"] })` guard, following the
#576 pattern used by `/api/validators` and `/api/predictive`.

**`POST /nlquery` is a POST but semantically a READ, and must not require or
imply write privilege.** It is a POST for transport reasons only: the question
is operator free text, and a free-text query string lands in access logs, proxy
logs, and browser history. The handler reads the historian, the tag stream, and
the alarm-correlation engine; it writes nothing, anywhere.

Two consequences follow, and both are asserted in
`server/routes/__tests__/nlquery-auth.test.ts`:

- a credential holding **only** `nlquery.read` can ask questions;
- a credential holding `write` but not `nlquery.read` is **rejected with 403**.
  Write access is neither required nor sufficient.

The second half needs help from the gateway. `mutationAuthorizationMiddleware`
applies `DEFAULT_MUTATION_POLICY` (scope `write`) to every mutating `/api`
request, and a POST is mutating by method. Left alone, that floor would demand
`write` for a read-only route — locking read-only operators out and implying a
control privilege the route never exercises. `control-route-policy.ts` therefore
carries an explicit `nl-query-read` entry mapping `/api/intelligence/nlquery` to
`["nlquery.read"]`, so the gateway floor and the route-local guard agree.

The full matrix — anonymous → 401, unknown credential → 401, valid credential
with the wrong scope → 403, correct scope → 200, admin → 200 — is tested per
route, along with credential-in-query-string rejection and guard-before-validation
ordering.

### 2. Execution is bounded

Every bound is a named constant in `server/services/nlquery/limits.ts` and each
has a test in `server/services/nlquery/__tests__/nl-query-bounds.test.ts` that
proves the bound holds.

| Constant | Value | Bounds | On breach |
| --- | --- | --- | --- |
| `MAX_QUERY_LENGTH` | 512 chars | Input size | **400, never truncated** |
| `QUERY_TIMEOUT_MS` | 2 000 ms | Wall clock per query | Explicit timeout answer, `success: false` |
| `MAX_RESOLVER_CANDIDATE_TAGS` | 2 000 | Tags scored (the O(tags x tokens) bound) | `searchTruncated`; a miss is reported as "not found among the tags I examined" |
| `MAX_HISTORY_SAMPLES` | 5 000 | Historian rows per trend | `truncation.historySamples`; answer says the aggregate covers the subset |
| `MAX_TREND_WINDOW_MS` | 7 days | Trend window | Clamped, `truncation.timeRange` set and stated |
| `MAX_ALARM_SCAN` | 500 | Alarms fetched | `scanTruncated`; never a bare all-clear |
| `MAX_RESULT_ITEMS` | 50 | List items serialised | `truncation.resultItems`; true total still reported |
| `MAX_HISTORY_ENTRIES` | 100 | Query-history ring buffer | Oldest evicted |
| `MAX_HISTORY_PAGE` | 50 | History rows per response | 400 |

Two properties are deliberate:

- **Over-long input is rejected, not truncated.** Silently answering a question
  the operator did not finish asking is precisely the failure this surface must
  not have.
- **Truncation is reported, never silent.** Every response carries a
  `truncation` object, and the natural-language answer states the caveat in
  words. A capped tag count is rendered as `2000+`, not as the site's total.

On the timeout: `Promise.race` bounds the *response*, not the work — a promise
cannot be cancelled in JavaScript, so an in-flight query runs to completion.
That residual work is bounded independently, because every port read pushes an
explicit row cap down to the store as a SQL `LIMIT`. A timed-out query cannot
leave unbounded work behind it. The code says this plainly rather than claiming
cancellation it does not perform.

### 3. The engine reads real data, behind a narrow injectable port

`NLQueryDataPort` has four methods, each taking an explicit cap.
`ProcessDataPort` implements it over the three stores that exist on `main`:

- **Tag catalogue and history** — the `historian_data` table, via Drizzle.
  There is no dedicated tag table in `shared/schema.ts`; the tag id space is
  defined by what the historian recorded, the same projection
  `server/protocols/opcua-server/runtime.ts` uses for its UA address space.
- **Latest values** — `tagStreamServer.getLatestValues()`, the live stream the
  gateway scan loop and the field simulator already publish to. A live sample
  is preferred over the newest historian row because it is fresher, and each
  reading records which source it came from so the answer can cite provenance.
- **Active alarms** — `alarmCorrelationService.engine`, over alarms actually
  ingested through `/api/alarm-correlation`.

**No SQL is constructed from operator text.** Every query is a Drizzle
query-builder expression with bound parameters; the operator's string reaches a
parameter slot and never the statement. There is no `eval` and no dynamic
`RegExp` built from input.

**When data is unavailable, the engine says so.** Reads return
`PortResult<T>`, so `available: false` ("could not consult the store") stays
distinct from `available: true, value: null` ("consulted, nothing recorded").
Collapsing those would let an outage read to an operator as a quiet process.
The honest-refusal cases are:

- the historian is Postgres-only, and the SQLite development fallback has no
  `historian_data` table — reported, not faked;
- `status` reports the last recorded value and its age, and states that no
  equipment state model is configured, rather than inventing a
  running/stopped verdict;
- a comparison with one missing reading reports the gap; a null is never
  coerced to 0;
- an unresolved alarm scope reports the total active count and explicitly does
  **not** read as an all-clear.

### 4. No LLM backend ships — the interface is deleted

The previous attempt shipped an `LLMBackend` interface with `parseQuery` and
`formatAnswer`. It is **removed**, not re-homed behind a flag.

The decisive reason is `formatAnswer`. It allowed a language model to rewrite
an operator-facing process answer wholesale. A model doing that can emit a
number no sensor produced, and no amount of output validation catches a
plausible-looking wrong reading. On a SCADA surface that is the worst available
failure mode, and it is exactly what this repository's integrity rule forbids.

`parseQuery` is safer in principle but was still dead code by the review's own
finding: injected, wired by nothing, exercised only by fakes. It also buys no
extensibility that the module boundary does not already provide — `parseIntent`
is a pure `(query, nowMs) => QueryIntent` function, and anyone adding a
different parsing strategy replaces that one call. Shipping an unused interface
to advertise a seam that already exists is cost without benefit.

Issue #216 asks for a "pluggable LLM backend interface". That framing predates
the operator-safety review, and where the two conflict the safety constraint
wins. **No language model is imported, constructed, or called anywhere in this
feature; no API key is read; no network dependency is added.** The extension
point, if one is ever wanted, is `parser.ts`.

### 5. History is process-local, bounded, and says so

Query history is a bounded ring buffer of `MAX_HISTORY_ENTRIES` results held in
the API process. It is **not** persisted, and this is a decision rather than an
omission:

- **This surface performs no mutation, so there is nothing to audit durably.**
  ADR-0026's durability requirement covers "pending approvals and audit
  records". A read query creates neither. Control-plane audit lives in
  `audit_logs` and is untouched.
- **Persisting results would create a second source of truth for process
  values.** A `QueryResult` embeds the readings that answered it. Writing those
  to a new table would put a durable, unversioned, retention-policy-free copy
  of process data outside the historian — with the historian's values reachable
  by two paths that can disagree. For a SCADA system that is a worse outcome
  than losing a convenience list on restart.
- **Free-text operator questions are a data-retention surface** we should not
  create without a retention policy, and #216 does not define one.

The obligation that comes with this choice is disclosure, and it is met in
three places: `GET /nlquery/history` returns
`persistence: "process-local"` plus a `persistenceNote` stating the history is
"lost on restart and is not shared across replicas or persisted to the
database"; every query response carries `historyPersistence`; and the service
module documents it. No migration is added, so `migrations/meta/_journal.json`
is untouched.

## Consequences

- Read-only operators can query process data with a credential that grants no
  write capability anywhere in the system.
- A large site degrades honestly: answers arrive capped and labelled rather
  than slowly or not at all.
- The engine answers fewer questions than a fabricating one would, and says so
  when it cannot answer. That is the intended trade.
- Restarting the API loses recent query history. Accepted, disclosed, and
  reversible: if a durable history is later wanted, it is an additive table plus
  a migration, and the port boundary means the engine does not change.
- Anyone wanting model-assisted parsing must revisit this ADR rather than
  filling in a waiting interface.

## Compliance with ADR-0026

| ADR-0026 row | Status on this surface |
| --- | --- |
| Authentication | **Closed here.** Both routes fail closed for anonymous and unknown credentials; tested. |
| Authorization | **Closed here.** Least-privilege read scope, distinct from `write`, enforced at both the route and the gateway floor; both directions tested. |
| Authenticated identity | N/A — no actor is recorded, because nothing is mutated. |
| Durable approvals | N/A — no approvals, no mutations. History durability is addressed in §5. |
| Physical actuation | N/A — read-only surface. |
