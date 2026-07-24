# MQTT Sparkplug B Bridge

> Issue #463 — [wave:2c] Build MQTT Sparkplug B Bridge.
> Status: **scaffold-core** — lifecycle state machine, topic grammar and payload
> mapping are implemented and unit-tested; protobuf encode/decode and the MQTT
> transport delegate to optional packages (`sparkplug-payload`, `mqtt`) that are
> declared in `package.json` but are **not installed in this worktree**, so
> end-to-end broker conformance must be run centrally (see *Conformance* below).

## Overview

The Sparkplug B bridge (`server/protocols/sparkplug-b/`) exposes 0xSCADA as a
Sparkplug B **edge node** so integrators on Ignition / Cirrus Link / any
Sparkplug-aware MQTT host can discover our sites and tags using the industry
standard MQTT modeling layer (Eclipse Tahu / Sparkplug B v3.0.0).

```
server/protocols/sparkplug-b/
  index.ts       # MQTT broker client (connect + LWT) → drives the lifecycle
  lifecycle.ts   # PURE edge-node lifecycle state machine (NBIRTH/NDATA/… )
  topic.ts       # PURE topic builder/parser (spBv1.0/group/type/edge[/device])
  payload.ts     # Sparkplug B protobuf codec + pure metric mapping
  types.ts       # Zod config loader + metric/payload types
  __tests__/     # unit tests for the pure logic + transport wiring
```

## Topic namespace

Sparkplug B topics follow `namespace/group_id/message_type/edge_node_id[/device_id]`:

| Message  | Topic                                                   | Scope  |
|----------|---------------------------------------------------------|--------|
| NBIRTH   | `spBv1.0/<group>/NBIRTH/<edge>`                         | node   |
| NDEATH   | `spBv1.0/<group>/NDEATH/<edge>` (MQTT Will)             | node   |
| NDATA    | `spBv1.0/<group>/NDATA/<edge>`                          | node   |
| NCMD     | `spBv1.0/<group>/NCMD/<edge>`                           | node   |
| DBIRTH   | `spBv1.0/<group>/DBIRTH/<edge>/<device>`                | device |
| DDATA    | `spBv1.0/<group>/DDATA/<edge>/<device>`                 | device |
| DDEATH   | `spBv1.0/<group>/DDEATH/<edge>/<device>`                | device |
| DCMD     | `spBv1.0/<group>/DCMD/<edge>/<device>`                  | device |
| STATE    | `spBv1.0/STATE/<host_application_id>`                   | host   |

The builders reject MQTT wildcards (`+`, `#`) and `/` inside any identifier.

## Lifecycle (state machine)

The state machine (`lifecycle.ts`) is pure — it returns the ordered messages to
publish and performs no I/O — so it is fully unit-testable.

1. **`beginSession()`** — increments `bdSeq` (mod 256) and resets `seq` to 0.
   Call this immediately before connecting so the Will/NDEATH carries the
   correct `bdSeq` (Sparkplug §6.4).
2. **MQTT Will** — `buildWillTopic()` + `buildWillPayload(bdSeq)` produce the
   retained-false NDEATH the broker publishes if we drop.
3. **`onConnect()`** — emits **NBIRTH** with `seq = 0`, the `bdSeq` metric, the
   `Node Control/Rebirth` control point, and the full node metric definitions.
4. **`birthDevice(def)`** — emits **DBIRTH** with the device's full metric set on
   its first publish; subsequent **DDATA** carry deltas; **DDEATH** on offline.
5. **`onHostState(online)`** — applies a received host-application STATE. When
   the *primary* host is OFFLINE the node quiesces DATA publishing (§10); it
   resumes when the host returns ONLINE.
6. **`seq`** increments by one (mod 256) on every published message after the
   BIRTH and is reset to 0 on rebirth.

## Sequence & birth/death sequence rules

- `seq` is `0` on **every** BIRTH (NBIRTH and DBIRTH share the node `seq` space)
  and increments mod 256 for each subsequent message.
- `bdSeq` increments once per connect session. The NDEATH delivered by the Will
  carries the **same** `bdSeq` as the NBIRTH for that session, letting the host
  correlate births and deaths and detect stale sessions.
- A host `Node Control/Rebirth = true` command triggers a fresh NBIRTH
  *in the same MQTT session*: `seq` restarts at 0 but `bdSeq` is **unchanged**,
  so the NDEATH Will registered at connect still correlates with the new birth
  (§6.4 / §7.6). A new `bdSeq` only occurs on an actual reconnect.

## Configuration

Environment variables (validated with Zod in `types.ts`). The bridge stays
disabled unless `SPARKPLUG_BROKER_URL` is set.

| Variable                     | Default            | Meaning                              |
|------------------------------|--------------------|--------------------------------------|
| `SPARKPLUG_BROKER_URL`       | `mqtt://localhost:1883` | Broker URL (`mqtt://` / `mqtts://`) — also the enable switch |
| `SPARKPLUG_USERNAME`         | —                  | MQTT username                        |
| `SPARKPLUG_PASSWORD`         | —                  | MQTT password                        |
| `SPARKPLUG_CLIENT_ID`        | `<group>-<edge>`   | MQTT client id                       |
| `SPARKPLUG_GROUP_ID`         | `0xSCADA`          | Sparkplug group id                   |
| `SPARKPLUG_EDGE_NODE_ID`     | `edge-node`        | This edge node's id                  |
| `SPARKPLUG_PRIMARY_HOST_ID`  | —                  | Primary host id for STATE gating     |
| `SPARKPLUG_KEEPALIVE_SEC`    | `30`               | MQTT keepalive (s)                   |
| `SPARKPLUG_RECONNECT_MS`     | `5000`             | Reconnect period (ms)                |

## Usage

```typescript
import { getSparkplugBridge } from "@server/protocols/sparkplug-b";

const bridge = getSparkplugBridge();
bridge.setNodeMetrics([
  { name: "Node/Firmware", dataType: SparkplugDataType.String, value: "1.0.0" },
]);
bridge.start(); // connects, sets LWT, publishes NBIRTH on connect

// On a site coming online (first publish):
bridge.birthSite({
  deviceId: "pump-42",
  metrics: [{ name: "FlowRate", dataType: SparkplugDataType.Double, value: 0 }],
});

// On tag updates:
bridge.publishSiteData("pump-42", [
  { name: "FlowRate", dataType: SparkplugDataType.Double, value: 12.5 },
]);

// On a site going offline:
bridge.deathSite("pump-42");
```

## Dependencies (NOT installed in the worktree)

Two packages are declared in `package.json` but `npm install` is intentionally
not run in the issue worktree:

- **`sparkplug-payload`** — the reference protobuf codec generated from Eclipse
  Tahu's `sparkplug_b.proto`. `payload.ts` loads it lazily; `isCodecAvailable()`
  reports whether it is present, and `setCodec()` allows dependency injection in
  tests. If it is missing at runtime the bridge logs a clear error and stays
  disabled (no fake encoding).
- **`mqtt`** — the MQTT client. `index.ts` loads it lazily through an injectable
  `MqttConnectFn` (the tests inject a fake client and codec, so the wiring is
  covered without a broker).

## Testing

Pure-logic unit tests (run with `npx vitest run server/protocols/sparkplug-b`):

- `topic.test.ts` — topic builders/parsers, wildcard rejection, round-trips.
- `payload.test.ts` — data-type mapping, metric/payload mapping, encode/decode
  via an injected fake codec.
- `lifecycle.test.ts` — NBIRTH/DBIRTH/DDATA/DDEATH transitions, `seq`/`bdSeq`
  rules and rollover, host-STATE DATA gating.
- `bridge.test.ts` — transport wiring (LWT, NBIRTH-on-connect, STATE
  subscription/gating, Rebirth) against an injected fake MQTT client.

## Conformance (cannot run in this environment)

The acceptance criterion *"Tahu test harness passes for our edge node"* requires
a live MQTT broker and the Eclipse Tahu compatibility/host application, which are
**not available in the worktree** (no broker, deps not installed). The procedure
to run it centrally / in CI:

1. `npm install` (pulls `mqtt` + `sparkplug-payload`).
2. Start an MQTT broker, e.g. `docker run -p 1883:1883 eclipse-mosquitto`.
3. Set `SPARKPLUG_BROKER_URL=mqtt://localhost:1883` and start the server so the
   bridge publishes NBIRTH/DBIRTH.
4. Run the Eclipse Tahu **compatibility test** / a Sparkplug host (e.g.
   Cirrus Link MQTT Engine in Ignition, or the Tahu `python` host application)
   pointed at the same broker and verify:
   - the edge node appears with its metric definitions (NBIRTH);
   - devices appear under it (DBIRTH) and update (DDATA);
   - a forced disconnect produces NDEATH with the matching `bdSeq`;
   - issuing `Node Control/Rebirth` triggers a fresh NBIRTH at `seq = 0`.
5. Confirm an Ignition broker dashboard shows our edge node + devices populated.

This document records the procedure in lieu of executing it here, per the issue's
integrity rules (no fabricated conformance runs).
