# [13.5] Port the natural-language process query engine onto current main

## Summary

ADR-0013 [13.5] was implemented upstream as
[NickFlach/0xSCADA#501](https://github.com/NickFlach/0xSCADA/pull/501) but not
ported here — `POST /api/intelligence/nlquery` is still the placeholder that
echoes the query back. Port the real engine following the rebase-and-harden
pattern of #547/#576/#551.

## Context

- Reference implementation: upstream PR #501 (branch `feat/216-nl-query`)
- Mock endpoints to replace: `server/routes/intelligence.ts` (`/nlquery`,
  `/nlquery/history`)
- Live tag data: `server/websocket/tag-stream.ts` (the `onTagUpdate` hook
  already exists on current main)

## What done looks like

- [ ] `server/services/nlquery/` exists: ordered intent grammar (specific
      intents before the `read_tag` catch-all), token-scoring tag resolver
      (numeric tokens must match exactly; ambiguity returns candidates, never a
      guess), and an engine where every intent has a real execution path
- [ ] Comparisons report missing data explicitly — a null reading is never
      coerced to 0
- [ ] Pluggable `LLMBackend` contract (async `parseQuery`/`formatAnswer`,
      `null` = decline): output validated before use, errors emitted as
      `backend-error` events with regex fallback — no LLM dependency ships
- [ ] `/api/intelligence/nlquery` + `/nlquery/history` serve real results
      (same response shape as the mock, extended with
      `answer`/`intent`/`success`), backed by an in-memory rolling tag store
      fed from the tag stream
- [ ] Service registered in the barrel and initialized at startup

## Prove it

```bash
npx tsc --noEmit
npx vitest run server/services/nlquery --project node
npm test
# Manual smoke (dev server running with the simulator):
curl -s -X POST localhost:5000/api/intelligence/nlquery \
  -H 'content-type: application/json' \
  -d '{"query":"What tags are available?"}'   # answer lists live simulator tags
```

## Size

Medium-large (complete upstream reference exists).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
