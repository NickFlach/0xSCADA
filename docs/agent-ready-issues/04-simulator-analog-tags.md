# Simulator: emit continuous analog process tags (real numeric time series)

## Summary

The field simulator only emits discrete random events every ~10s, and
non-numeric payloads are broadcast as JSON-stringified blobs
(`server/simulator.ts` — see the `JSON.stringify(payload)` fallback in the tag
broadcast). The analytics services shipped on this repo — predictive
maintenance (`/api/predictive`), the digital twin (`/api/twin`), and SPC —
consume numeric time series and currently have almost nothing realistic to
chew on in dev. Add continuous analog channels.

## Context

- `server/simulator.ts` — `FieldSimulator`, asset list, `generateEvent()`,
  `tagStreamServer.broadcastTagUpdate(...)`
- Consumers: `server/services/predictive`, `server/services/twin`,
  `server/services/spc`
- Tag naming convention: `${asset.nameOrTag}.${CHANNEL}` (e.g.
  `TR-MAIN-01.TEMPERATURE`)

## What done looks like

- [ ] Each simulated asset broadcasts 1–3 analog channels (e.g. TRANSFORMER:
      `TEMPERATURE`, `LOAD_PERCENT`; BREAKER: `CURRENT`) on a steady cadence
      (default 2s, configurable via `SIMULATOR_ANALOG_INTERVAL_MS`)
- [ ] Values are plausible process signals: baseline + slow drift + bounded
      noise (e.g. sine + seeded noise) — always finite numbers, never
      stringified JSON, `quality: "good"`
- [ ] The generator is a pure, exported function driven by a seeded RNG so
      tests are deterministic (no `Math.random` in the signal path)
- [ ] Existing discrete event behavior is unchanged; analog emission respects
      `SIMULATOR_ENABLED`
- [ ] Unit tests: determinism for a fixed seed, bounds (values stay within
      the configured band), cadence wiring, and that broadcast values are
      numeric

## Prove it

```bash
npx tsc --noEmit
npx vitest run server/__tests__/simulator-analog.test.ts   # new suite (name yours accordingly)
npm test
# Manual smoke: npm run dev, then watch /ws/tags — numeric TEMPERATURE/CURRENT
# updates every ~2s alongside the existing discrete events.
```

## Size

Small-medium.

---
Review process: Build → Gate → Hunt → Fix (see CONTRIBUTING.md).
Your PR description must include `City-Agent: <agent-name>` and `Closes #<this issue>`.
