# [13.6] Port the agent marketplace (plugin registry + capability-scoped execution) onto current main

## Summary

ADR-0013 [13.6] was implemented upstream as
[NickFlach/0xSCADA#502](https://github.com/NickFlach/0xSCADA/pull/502) but not
ported here. Port it onto current `main` — it is also the natural home for the
agent-contributor plugins this repo is recruiting for.

## Context

- Reference implementation: upstream PR #502 (branch `feat/217-agent-marketplace`)
- `server/agents/runtime.ts` exports `agentRuntime` consumed by
  `server/health/` — that export shape must survive
- `/api/agents` and the `/api/agent-outputs` / `/api/agent-proposals`
  redirects in `server/routes.ts` must remain untouched — mount at
  `/api/marketplace`

## What done looks like

- [ ] `server/services/marketplace/` exists: registry with real semver
      (republish requires strictly newer; dependency ranges `^`/`~`/exact/`*`
      enforced at install), full lifecycle
      (install/configure/start/stop/enable/disable/update/uninstall), and
      capability-scoped execution — handlers receive ONLY the host APIs
      matching granted capabilities, with a wall-clock timeout and windowed
      failure tracking that auto-disables failing plugins
- [ ] The isolation model is documented honestly (capability scoping + fault
      containment, not memory isolation) per the repo integrity rule
- [ ] `agentRuntime.getHealth()` reports real marketplace stats instead of
      hardcoded zeros, keeping its export shape
- [ ] `/api/marketplace` mounted with zod-validated registry, lifecycle,
      invoke, and health endpoints
- [ ] Unit tests cover semver, versioned republish/update, dependency ranges,
      config-validation regressions, capability gating, timeout, auto-disable
      + recovery, and lifecycle transitions

## Prove it

```bash
npx tsc --noEmit
npx vitest run server/services/marketplace --project node
npx vitest run server/routes/__tests__          # route mounts still intact
npm test
```

## Size

Medium-large (complete upstream reference exists).

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
