# DNP3 Outstation Mode

Issue #464 (wave 2c). Lets legacy utility control-room **masters** (e.g. SCADA
front-end processors running [opendnp3](https://github.com/dnp3/opendnp3)) poll
0xSCADA over DNP3 (IEEE 1815-2012) as if it were a conventional RTU/outstation.
Required for the utility-consortium pilots.

> **Status: working outstation for reads, events and controls.** A master can
> run an integrity poll (Class 0), poll Class 1/2/3 and receive **real
> timestamped event objects**, confirm them, and issue **SELECT/OPERATE or
> DIRECT-OPERATE** controls that reach live tag state — provided controls are
> explicitly enabled (they are off by default; see
> [Controls](#controls-select--operate--direct-operate)). Some framing details
> remain explicit TODOs (see "Implemented vs TODO" below), and the outstation is
> **not started by server startup** — see
> [Not wired into startup](#not-wired-into-server-startup).

## Module layout

```
server/protocols/dnp3-outstation/
  index.ts          TCP outstation server (default port 20000) + pure request handler
  app-objects.ts    DNP3 object groups/variations, status-flag (quality) octets, IIN, encoders, DNP3 time
  point-map.ts      tag -> DNP3 point mapping for all 5 static groups (+ flags, scaling, deadband)
  event-buffer.ts   Class 0/1/2/3 event buffering, overflow, unsolicited-trigger evaluation
  event-objects.ts  event object serialisation: g2/g11/g22/g32/g42 (+ g51 CTO), qualifiers 0x17/0x28
  controls.ts       g12v1 CROB + g41v1..v4 analog output: codecs and the select-before-operate machine
  secure-auth.ts    Secure Authentication v5 — HMAC challenge/response state machine
  link-layer.ts     DNP3 data-link framing + CRC-DNP (poly 0x3D65)
  transport.ts      transport function segmentation / reassembly (FIR/FIN/SEQ)
  app-layer.ts      APDU parse (incl. index-prefixed qualifiers) + object-header assembly + Class-0 reader
  __tests__/        unit tests for every core above, incl. golden byte vectors
```

## DNP3 layer model — Implemented vs TODO

DNP3 is a four-layer stack. Here is exactly what is real today.

| Layer | Concern | Status |
|-------|---------|--------|
| **Data Link** | start bytes, length, CONTROL, addresses | header build/parse implemented |
| | CRC-DNP (poly 0x3D65) | **fully implemented + tested** (verified against the canonical reset-link vector → CRC `0x21E9`) |
| | 16-octet block CRC interleave | implemented for build + extract |
| | secondary link-confirm / FCB state machine | **TODO** |
| **Transport** | FIR/FIN/SEQ segmentation + reassembly | **fully implemented + tested** |
| **Application** | request header parse (FIR/FIN/CON/UNS/SEQ + func) | implemented |
| | object-header scan (qualifiers 0x00/0x01/0x06/0x07/0x08) | implemented |
| | prefixed-index qualifiers (0x17/0x28) length decode | **implemented + tested** (for objects of known fixed size, which covers all control objects) |
| | free-format qualifier 0x5B (group-120 objects) | **TODO** — SAv5 objects use the simple count-1 header this module also emits |
| | response header + IIN | **fully implemented + tested** |
| | Class 0 static read (BI/AI/Counter/BO/AO + flags) | **fully implemented + tested**, split into fragment-sized object blocks, non-contiguous indices and 16-bit ranges handled |
| | Class 1/2/3 event read | **fully implemented + tested** — g2v1/v2/v3, g11v1/v2, g22v1/v5, g32v1/v3/v5/v7, g42, with g51v1 CTO for relative time |
| | multi-fragment responses (FIR/FIN/CON + per-fragment CONFIRM) | **implemented + tested** |
| | SELECT/OPERATE/DIRECT-OPERATE (g12v1, g41v1..v4) | **implemented + tested**, fail-closed and off by default |
| | WRITE g80v1 (clear DEVICE_RESTART IIN) | **TODO** |
| | per-variation read selection (master asks for a variation, not a class) | **TODO** |
| **Secure Auth v5** | HMAC over critical ASDU (challenge/response) | **fully implemented + tested** |
| | dispatch of the ASDU once its reply verifies | **implemented + tested** |
| | session-key wrap (g120v6), aggressive mode, key-change | **TODO** (Update Key used directly today) |

## Point mapping

Each 0xSCADA tag is mapped to a DNP3 point in one of the five static groups.
Indices are 0-based and contiguous **per group**.

| DNP3 group | Type | Direction | Default variation |
|-----------|------|-----------|-------------------|
| 1  | Binary Input | read | v2 (with flags) |
| 30 | Analog Input | read | v5 (float, w/ flag) or v1 (int32) |
| 20 | Counter | read | v1 (32-bit, w/ flag) |
| 10 | Binary Output Status | read/write | v2 (with flags) |
| 40 | Analog Output Status | read/write | v3 (float) or v1 (int32) |

Status flags are derived from 0xSCADA point quality:

| Quality | DNP3 flags |
|---------|-----------|
| `good` | `ONLINE` (+ binary `STATE` bit 7) |
| `uncertain` | `ONLINE` + `LOCAL_FORCED` |
| `bad` | `COMM_LOST` (ONLINE cleared) |

```ts
import { createDnp3Outstation } from '@server/protocols/dnp3-outstation';

const outstation = createDnp3Outstation({
  port: 20000,
  localAddress: 10,
  unsolicitedEnabled: true,
  pointMap: {
    points: [
      { tagId: 'pump.run',  type: 'binaryInput', index: 0, eventClass: 1 },
      { tagId: 'tank.level', type: 'analogInput', index: 0, eventClass: 2, encoding: 'float32', deadband: 0.5 },
      { tagId: 'flow.total', type: 'counter',     index: 0, eventClass: 0 },
    ],
  },
});

// Provision a Secure Authentication v5 Update Key for user 1 (>= 16 bytes).
outstation.setUpdateKey(1, Buffer.from(process.env.DNP3_SAV5_KEY!, 'hex'));

await outstation.start();

// Feed live values in from the tag layer:
outstation.updateTag('tank.level', { value: 12.4, quality: 'good', timestamp: Date.now() });
```

> **INTEGRATION (#464):** `updateTag` is the seam where the 0xSCADA tag/event
> pipeline feeds the outstation. A sibling issue owns the bridge that subscribes
> to tag changes and calls `updateTag`; this module defines the minimal
> `PointSample` contract for that seam.

## Event classes & unsolicited responses

- **Class 0** = all current static values (returned for a Class-0 poll).
- **Class 1/2/3** = timestamped change events, queued per class. Each point
  declares its `eventClass`; `0` means static-only (no events).
- Buffering is configurable per class (`maxEvents`, `unsolicitedThreshold`).
  On overflow the **oldest** event is dropped and the `EVENT_BUFFER_OVERFLOW`
  IIN bit is raised until the master confirms.
- **Unsolicited responses** fire when either (a) a class reaches its configured
  count threshold, or (b) the oldest un-reported event exceeds
  `unsolicitedMaxDelayMs`. Disabled until the master sends `ENABLE_UNSOLICITED`
  (or `unsolicitedEnabled: true` at construction). The decision logic is pure
  and unit-tested (`event-buffer.test.ts`).

### Event object encoding

Events are serialised by `event-objects.ts` into index-prefixed object headers —
qualifier `0x17` (1-octet index prefix + 1-octet count) while every index in the
run is ≤ 255, otherwise `0x28` (2-octet prefix + 2-octet count). Consecutive
events sharing a group/variation share one header; a change of group starts a
new one, so chronological order is preserved across headers.

| Point type | Group | No time | Absolute time | Relative time |
|-----------|-------|---------|---------------|---------------|
| Binary Input | 2 | v1 | v2 | v3 (+ g51v1 CTO) |
| Binary Output | 11 | v1 | v2 | — |
| Counter | 22 | v1 | v5 | — |
| Analog Input (int32) | 32 | v1 | v3 | — |
| Analog Input (float32) | 32 | v5 | v7 | — |
| Analog Output | 42 | v1 / v5 | v3 / v7 | — |

The numeric width is **not** configurable: it follows the point's own
`encoding`, so an event never truncates a value the static read reports at full
precision. The time representation is chosen per event type with
`eventVariations` (default: absolute time everywhere):

```ts
createDnp3Outstation({
  eventVariations: { binary: 'absolute-time', counter: 'absolute-time', analog: 'absolute-time' },
});
```

Absolute timestamps are the 6-octet little-endian DNP3 Time (48-bit ms since the
Unix epoch). Relative-time binary events (`g2v3`) are only legal after a Common
Time Of Occurrence object, so a `g51v1` CTO is emitted immediately before each
relative run and a fresh CTO is started whenever the 16-bit offset would
overflow. Group 11 (Binary Output Event) has no relative-time variation in IEEE
1815 — only `v1` and `v2` — so a `relative-time` policy degrades to `g11v2` for
binary *output* events while binary *inputs* still use `g2v3`.

### Fragmentation and confirmation

Responses respect `maxTxFragmentSize` (default 2048, the IEEE 1815 maximum).
Static object blocks are emitted first, then events; when they do not fit, the
response is split. Non-final fragments and any fragment carrying events set the
`CON` bit, and the outstation holds the remaining fragments until the master's
application `CONFIRM` arrives.

**Events are removed from the buffer only on CONFIRM**, never on send. A
reported-but-unconfirmed event stays buffered, stops driving the unsolicited
trigger (so a master that never confirms cannot cause an unsolicited storm), and
is re-sent on the next Class poll.

## Controls (SELECT / OPERATE / DIRECT-OPERATE)

Supported command objects: **g12v1** Control Relay Output Block (→
`binaryOutput` points) and **g41v1..v4** Analog Output Block (→ `analogOutput`
points, 32/16-bit integer and single/double float).

> ### The write path is fail-closed and OFF by default
>
> A DNP3 control is the highest-privilege operation this codebase exposes. Two
> independent things must **both** be true before an octet reaches tag state:
>
> 1. `controls.enabled` is explicitly `true` (default `false`), **and**
> 2. a control sink has been installed with `setControlSink()`.
>
> If either is missing the outstation is read-only and echoes every control
> object with CommandStatus `NOT_SUPPORTED` (4). It never silently accepts, and
> never reports `SUCCESS` for something it did not perform.

```ts
const outstation = createDnp3Outstation({
  controls: { enabled: true, selectTimeoutMs: 5000 },
  pointMap: { points: [{ tagId: 'valve.cmd', type: 'binaryOutput', index: 0 }] },
});

// The sink is the seam to the tag store. It is synchronous because DNP3 needs a
// CommandStatus in the response: a sink talking to slow hardware must enqueue
// the write and answer for the enqueue.
outstation.setControlSink((command) => {
  // `command.tagId` was resolved through the point map — e.g. 'valve.cmd'.
  // `yourTagWriter` stands in for whatever the deployment uses; this module
  // deliberately ships no default sink, so there is nothing to write through
  // until one is supplied.
  return yourTagWriter.enqueue(command.tagId, command.value)
    ? { ok: true }
    : { ok: false, status: DNP3_COMMAND_STATUS.HARDWARE_ERROR };
});
```

The outstation deliberately does **not** update its own Binary/Analog Output
Status points when a control succeeds. Doing so would report a state it has not
observed. The real value must come back through `updateTag()` from the tag
layer, exactly like any other measurement.

### Select-before-operate

A `SELECT` validates and arms a specific point+value set for
`selectTimeoutMs`; it never touches the process. The following `OPERATE` must
reproduce the armed objects exactly **and** carry an application sequence number
one greater than the SELECT's (IEEE 1815 §4.4.2.1). The arm is single-use: it is
consumed whatever the outcome, so a rejected OPERATE cannot be replayed.

| Situation | CommandStatus |
|-----------|---------------|
| Control executed | `SUCCESS` (0) |
| Armed selection expired (matching objects) | `TIMEOUT` (1) |
| No arm, wrong objects, or wrong sequence number | `NO_SELECT` (2) |
| Malformed object body | `FORMAT_ERROR` (3) |
| Controls disabled / no sink / unmapped point / unsupported op type | `NOT_SUPPORTED` (4) |
| Pulse still running on that output | `ALREADY_ACTIVE` (5) |
| Sink threw, or refused without a status | `HARDWARE_ERROR` (6) |

A CROB `count` of 0 is a spec-defined no-op: the outstation answers `SUCCESS`
and does **not** call the sink. The deprecated queue bit and the clear bit are
refused with `NOT_SUPPORTED` rather than being silently ignored.

## Not wired into server startup

`createDnp3Outstation()` does not listen; only an explicit `start()` does, and
nothing in `server/` calls it. Exposing the outstation on a network interface is
deliberately a separate change: it needs its own network-policy review because
any master that can reach the port can drive the control path. Until then this
module is a library that a deployment must opt into.

## Known limitations

- **One master association.** Application-confirm state is per connection, but
  the event buffer is shared, so with two masters connected at once the first
  CONFIRM drains events for both. DNP3 outstations conventionally serve a single
  master.
- Unconfirmed events are re-sent on the next Class poll, but there is no
  independent retry timer.
- The secondary link-confirm / frame-count-bit (FCB) state machine is not
  implemented.
- `WRITE g80v1` (the master clearing `DEVICE_RESTART`) is not handled, so that
  IIN bit stays set for the lifetime of the process.
- TCP only; DNP3 serial is a separate task.

## Secure Authentication v5

Critical function codes (SELECT, OPERATE, DIRECT_OPERATE, WRITE, restarts,
(en|dis)able-unsolicited) are challenged before execution **when an Update Key
is provisioned for the user** (open mode otherwise, for pilots without keys):

```
master                                   outstation
  |  --- OPERATE (critical ASDU) ------->  |
  |  <---- g120v1 Challenge (CSQ, nonce) - |   issueChallenge()
  |  --- g120v2 Reply (HMAC over ASDU) ->  |
  |  <----- result / control executed ---- |   verifyReply() -> dispatch
```

The MAC is `HMAC(key, CSQ‖userNumber‖algorithm‖reason‖nonce‖criticalASDU)`,
truncated per the negotiated algorithm. Supported: HMAC-SHA-256 (8/16/32 octet
truncations) and HMAC-SHA-1 (4-octet, legacy). Verification is constant-time
(`crypto.timingSafeEqual`). Challenges are single-use (nonce consumed on any
reply) and expire after `challengeTimeoutMs`. Implemented and tested in
`secure-auth.ts` / `secure-auth.test.ts`, including impostor-key,
tampered-ASDU, CSQ-mismatch, and expiry rejection paths.

> No new dependency: HMAC uses Node's built-in `crypto`.

## Conformance smoke test (opendnp3) — CANNOT run in CI here

The acceptance criterion calls for a smoke test against an open-source DNP3
master. **This cannot run in this environment** (no opendnp3 toolchain, no
Docker network namespace for a real master, and node_modules is absent in the
worktree). The procedure below is documented so it can be run on a host with
opendnp3 available; do not treat it as executed.

### Procedure

1. Build/obtain opendnp3 and its `master-gprs-demo` (or use `pydnp3`).
2. Start the outstation:
   ```ts
   const os = createDnp3Outstation({ port: 20000, localAddress: 10, unsolicitedEnabled: true, pointMap: {...} });
   await os.start();
   ```
3. Point the master at `127.0.0.1:20000`, master link address 1, outstation
   link address 10.
4. **Integrity poll (Class 0):** master issues `READ g60v1` → expect a RESPONSE
   (func 0x81) carrying g1/g30/g20/g10/g40 static objects with flags.
5. **Event poll (Class 1/2/3):** push a tag change via `updateTag`, then have
   the master `READ g60v2/v3/v4` → expect timestamped g2/g22/g32 objects and the
   matching class-event IIN bit, cleared after the master's CONFIRM.
6. **Unsolicited:** enable unsolicited on the master, breach a class threshold,
   confirm the master receives a func-0x82 fragment.
7. **Secure auth:** provision a matching Update Key on both ends, send an
   OPERATE, confirm the g120v1 challenge / g120v2 reply handshake succeeds.
8. **Controls:** with `controls.enabled` and a sink installed, SELECT then
   OPERATE a CROB and confirm the echoed status octet is 0 (SUCCESS); repeat
   with controls disabled and confirm it is 4 (NOT_SUPPORTED).

### Local equivalent (no opendnp3)

The protocol logic is covered by `npm run test:unit`:

```bash
npx vitest run server/protocols/dnp3-outstation
```

These verify CRC against the canonical DNP3 vector, link frame round-trips,
transport segmentation, Class 0/1/2/3 buffering + unsolicited triggers, point
serialisation with flags, and the full SAv5 HMAC challenge/response including
adversarial rejection paths.

Added for the event/control work, with **golden byte vectors derived by hand
from IEEE 1815** and annotated octet by octet:

- `event-objects.test.ts` — exact octets for g2v1/v2/v3 (incl. the g51v1 CTO and
  16-bit offset roll), g22v1/v5, g32v1/v3/v7, qualifier 0x17 vs 0x28, and the
  byte-budget cut-off.
- `class-read.test.ts` — full response fragments for empty, populated and
  mixed-class polls; the three-fragment split with FIR/FIN/CON and sequence
  numbering; and the rule that events leave the buffer only on CONFIRM.
- `controls.test.ts` — decode of real master CROB/analog-output requests, the
  select→operate happy path, and the rejection paths (no select, select
  timeout, mismatched operate, wrong sequence number, controls disabled, no
  sink, unmapped point, truncated object).
- `outstation.test.ts` — fail-closed defaults, the SAv5 challenge→verify→execute
  round trip, and a **live localhost TCP round trip** in which a real master
  frame produces real g2v2 event octets on the wire.

## References

- IEEE 1815-2012 — DNP3 specification
- IEC 62351-5 — Secure Authentication
- opendnp3: https://github.com/dnp3/opendnp3
