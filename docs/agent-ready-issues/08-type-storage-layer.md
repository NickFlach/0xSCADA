# Type the storage layer: eliminate every `(storage as any)` cast

## Summary

Routes reach the storage layer through untyped casts — currently **38
occurrences** of `(storage as any)` across `server/routes/assets.ts` (3),
`server/routes/blueprints.ts` (18), `server/routes/codegen.ts` (5), and
`server/routes/vendors.ts` (12). Each cast hides whether the method actually
exists on `storage`; missing methods surface as runtime 500s instead of
compile errors. This directly violates the repo's "no `any`" rule.

## Context

- `server/storage.ts` — the exported `storage` object (~line 599+); some
  accessors already exist (e.g. `getControlModuleTypes`)
- Call sites: `grep -rn "storage as any" server/routes/`

## What done looks like

- [ ] `server/storage.ts` exports a typed interface (e.g. `Storage`) that the
      `storage` object satisfies, covering every method the routes call
- [ ] Methods that exist get real signatures. Methods the routes call that do
      NOT exist get one of: a real Drizzle implementation (preferred where the
      table exists in `shared/schema.ts`), or an explicit typed
      implementation that returns a clear `501`-style error object — never a
      silent `undefined` call through `any`
- [ ] `grep -rn "storage as any" server/` returns nothing
- [ ] No route that worked before regresses: existing route tests pass, and
      each newly-typed 501 path has a test asserting the explicit error (not
      a crash)
- [ ] Zero new `any` anywhere (gate rule)

## Prove it

```bash
npx tsc --noEmit
grep -rn "storage as any" server/ | wc -l    # must print 0
npx vitest run server/routes/__tests__ --project node
npm test
```

## Size

Medium (mechanical but wide; the type surface is discoverable from the call
sites).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
