# Wave 2 — Build Set Design

**Date:** 2026-06-01
**Methodology:** Wave-dev — Build → Gate → Hunt → Fix (see `docs/QE-METHODOLOGY.md`)
**Scope:** New feature work. Companion to the 15 remediation/verification issues seeded as the `ripe` board (issues #440-#451 in 0xSCADA, #1-#3 in 0xSCADA-node).

## Framing

Wave-1 left the project rich in surface area but uneven in depth. The wave-1 devil's-advocate sweeps caught the load-bearing bugs (Kuramoto N-divisor, BFT threshold, vendor byte-level cluster). The fresh `ripe` board cleans those up.

Wave-2 ships **new** capability along three coherent themes, each as an independently-buildable sub-wave so parallel sub-agents can ship them without stepping on each other:

- **2a — Multi-node Coordination** (`wave:2a-multinode`) — turn `0xSCADA-node` from "anchor target" into "first-class operator surface."
- **2b — Real-time Control Plane** (`wave:2b-realtime`) — finish ADR-0021's "real-time" half so an industrial site could trust running it.
- **2c — Industrial Protocol Completion** (`wave:2c-protocols`) — close the OPC-UA / Modbus / DNP3 / IEC 61850 loops promised in #11, #48, #81, #82.

13 build issues total. Each carries `cycle:build`, its sub-wave label, an `area:*` label, and `severity:*` per the QE-METHODOLOGY.md severity matrix.

## Why this set, not exotic-arch progression

The most-recent active edge (issues #380-#391, PRs #426-#431) was exotic-arch — ADR-0023 ParadoxResolver, ADR-0024 Decoherence Scheduler, ADR-0025 Living Fano canvas. Wave-2 deliberately steps off that track to harden the substrate beneath it: an exotic governance layer doesn't matter if the control plane can't hit its tick budget, or if operators can't trust the validator set, or if a real industrial customer can't speak Sparkplug B.

Exotic-arch continuation is a candidate Wave-3 theme.

---

## Sub-wave 2a — Multi-node Coordination

**Premise:** `0xSCADA-node` is the canonical ledger but the TS side mostly ignores it as an inspection surface. 2a builds the operator-facing layer that exploits it.

**Build issues (4):**

1. **Validator Dashboard** — React surface pulling `oxscada` `:9090` RPC. Kuramoto phase coupling, attestation health per round, anchor batch throughput. Builds on the data layer from #442's monitor rewrite.
2. **Cross-Node State Queries** — `GET /api/nodes/:id/state/:key` proxying to a specific validator, with response-signature verification against that validator's pubkey. For divergence investigations.
3. **Anchor-Backend Switch UX** — Operator UI + `POST /api/admin/anchor-backend` flipping the runtime `ANCHOR_BACKEND` (introduced by #443) between `l2`/`node`/`both`. Includes dry-run simulation. Closes the dual-anchoring loop with a real switching tool.
4. **Slashing & Liveness Visualizer** — Per-validator attestation participation, missed-slot detector, liveness-fault timeline. "What if" simulator for proposed slashing rules.

**Wave shape:** build #1 first (data layer); #2-#4 build on it in parallel. Single Gate after build. Hunt sweep across all four (focus: signature verification correctness, RPC error handling). Fix as needed.

**Companion remediation already queued:** #442 (monitor RPC port), #443 (dual-anchoring decision).

---

## Sub-wave 2b — Real-time Control Plane

**Premise:** ADR-0021 promised a real-time control plane under cryptographic audit. The audit half shipped; the "real-time" half — PREEMPT_RT scheduling, deterministic blueprint execution, sub-millisecond control loops — was promised but underdeveloped. 2b finishes the surface so an industrial site could trust running it.

**Build issues (4):**

1. **Deterministic Blueprint Runtime** — Lock the blueprint execution path into a single hot loop with bounded allocation. Pre-allocate the I/O tag buffer at startup, replace dynamic `Map` lookups with indexed arrays, eliminate Promise micro-tasks inside the tick. Target: < 1 ms p99 tick under a 1000-tag blueprint. **Gate decision inside the issue:** if Node's event loop can't be tamed enough, swap for a Rust control-loop crate via N-API.
2. **Tick-Aware Scheduler** — Plug `SCHED_FIFO` priorities for the control thread under PREEMPT_RT; fall back gracefully on stock kernels with a warning surfaced in `/health`. Expose tick-jitter, missed-deadline, and WCET as Prometheus gauges.
3. **Watchdog & Safe-State Fallback** — Per-blueprint watchdog: tick over budget for N consecutive cycles → transition to pre-declared safe state (hold-last / force-zero / custom recipe). Anchor as CRITICAL severity. Operator UI surfaces "running in safe-state" prominently.
4. **Control-Loop Latency Telemetry** — End-to-end probe: synthetic tag flips on Validator A's blueprint, observes round-trip to anchor confirmation, reports latency budget broken down by stage (tick → batch → sign → anchor → confirm). Becomes the SLO instrument for the whole integrity-pipeline.

**Wave shape:** build #1 + #2 in parallel (both touch the scheduler/runtime layer). Gate before #3 (watchdog depends on a deterministic runtime). #4 builds alongside any of the others. Hunt: focus on jitter, GC pauses, NUMA effects. Fix as needed.

**Companion remediation queued:** #444 (ADR-0021 current-state checklist) — its findings may add follow-ups to this sub-wave.

---

## Sub-wave 2c — Industrial Protocol Completion

**Premise:** #11, #48, #81, #82 promised OPC-UA, Modbus, DNP3, IEC 61850. Wave-1 shipped scaffolding and bug fixes (#360-#365). The gateway surfaces a real industrial customer would notice on day one of an evaluation are still partial. 2c closes them.

**Build issues (5):**

1. **OPC-UA Server Mode** — Today 0xSCADA speaks OPC-UA as a client (reads from PLCs). Add server mode so other SCADA systems and historians can consume 0xSCADA tags/blueprints as a standard UA address space. Subscription support; security policies (Basic256Sha256). Unlocks "0xSCADA as edge gateway" deployments.
2. **Modbus TCP Server Mode** — Mirror of #1 for the lower-end market. Function codes 1-6 + 15 + 16. Standard Modbus master systems can poll 0xSCADA itself. Required for retrofit deployments where 0xSCADA aggregates field data and a legacy HMI reads from it.
3. **MQTT Sparkplug B Bridge** — Sparkplug B (Eclipse Tahu): proper `NBIRTH`/`DBIRTH`/`NDATA`/`DDATA` lifecycle, edge-node + device modeling, host application state. The operator-friendly surface for IIoT integrators on Ignition / Cirrus Link.
4. **DNP3 Outstation Mode** — Outstation lets DNP3 masters (legacy utility control rooms) poll 0xSCADA. Class 0/1/2/3 events, unsolicited responses, secure authentication v5. Required for utility consortium pilots.
5. **IEC 61850 GOOSE Subscriber** — Subscriber-only (publisher later). Receive GOOSE frames from IEDs, validate timing and quality bits, surface as tag updates. Pairs with 2b's control-loop telemetry to verify the < 4 ms GOOSE budget.

**Wave shape:** all five mostly independent; build in parallel. Gate per-protocol on a conformance test (each has standard test vectors). Hunt: byte-level edge cases — the #360-#365 cluster taught us this is where bugs hide. Fix as needed.

**Companion remediation queued:** #450 (vendor cluster re-verify) — its outcome may surface protocol-correctness issues that overlap.

---

## How Wave-2 ends

A Wave-2 is "done" when:

1. Every build issue has either a merged PR or is intentionally deferred (`status:deferred-wave-3`).
2. Each sub-wave has a `docs/reviews/wave-2{a,b,c}-devils-advocate.md` produced by the hunt phase.
3. Fix-squad PRs landed for every `severity:critical` and `severity:high` finding from those reviews.
4. The 15 ripe items from the pre-Wave-2 remediation set are closed or downgraded.

## Wave-3 candidates (not in scope)

- Exotic-arch progression (ADR-0023/24/25 Wave-2 work)
- OPC-UA + Modbus + IEC 61850 **publisher** modes (the inverse of 2c's subscriber/server modes)
- AI/ML Phase 11 (anomaly detection, recipe generation)
- Decentralized governance / consortium voting (ADR successor)

---

## Label index

- `wave:2a-multinode`, `wave:2b-realtime`, `wave:2c-protocols` (new for Wave-2)
- `cycle:build` (existing — Wave-2 build phase)
- `area:cross-repo-coherence` (2a), `area:integrity-pipeline` (2b), `area:vendor-adapters` (2c) (existing)
- `severity:critical|high|medium|low` (existing, per QE-METHODOLOGY.md)
- `ripe` is **not** applied here; `ripe` is reserved for the remediation backlog. Build issues go directly into their sub-wave queue.
