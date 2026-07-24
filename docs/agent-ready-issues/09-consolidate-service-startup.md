# Consolidate service startup: make initializeServices() real (or remove it)

## Summary

`server/services/index.ts` exports `initializeServices()` and
`getServicesHealthStatus()` — and nothing calls them. Actual service startup
is scattered: `server/routes.ts` contains at least three ad-hoc
`void <service>.initialize()` calls, each with a comment explaining that
"services/initializeServices() has no callers at startup" (routes.ts ~lines
114, 136, 140). Every new service PR has had to rediscover this trap. Pick
one startup path and make it the only one.

## Context

- Dead machinery: `server/services/index.ts` (`initializeServices`,
  `getServicesHealthStatus`, `serviceRegistry`)
- Ad-hoc wiring: `grep -n "has no callers at startup" server/routes.ts`
- Boot sequence: `server/index.ts` (see also the startup-singletons work in
  #544); liveness registration: `server/health/index.ts`

## What done looks like

- [ ] One documented startup path. Recommended: `server/index.ts` (or the
      startup-singletons module) calls `initializeServices()` once during
      boot, and the ad-hoc `void x.initialize()` calls plus their workaround
      comments are removed from `registerRoutes`
- [ ] Every service currently initialized ad-hoc is in the
      `initializeServices()` list (verify none are silently dropped)
- [ ] Order-sensitive wiring that must happen in `registerRoutes` (e.g.
      `tagStreamServer.onTagUpdate(...)` hooks that need the HTTP server)
      stays there — but plain `initialize()` calls move
- [ ] `getServicesHealthStatus()` is either wired into `server/health/` or
      deleted — no half-alive machinery remains
- [ ] A startup test boots the service layer and asserts each registered
      service reports `healthy: true` from its `healthCheck()`
- [ ] `grep -rn "has no callers at startup" server/` returns nothing

## Prove it

```bash
npx tsc --noEmit
grep -rn "has no callers at startup" server/ | wc -l   # must print 0
npx vitest run server/services/__tests__/startup.test.ts   # new suite (name yours accordingly)
npm test
```

## Size

Small-medium (wiring + one test; the risk is missing a service, which the
startup test catches).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
