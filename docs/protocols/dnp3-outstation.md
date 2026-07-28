# DNP3 Outstation Mode

Issue #464 (wave 2c). Lets legacy utility control-room **masters** (e.g. SCADA
front-end processors running [opendnp3](https://github.com/dnp3/opendnp3)) poll
0xSCADA over DNP3 (IEEE 1815-2012) as if it were a conventional RTU/outstation.
Required for the utility-consortium pilots.

> **Status: working outstation for reads, events and controls, with a gated
> listener wired into server startup.** A master can run an integrity poll
> (Class 0), poll Class 1/2/3 and receive **real timestamped event objects**,
> confirm them, and issue **SELECT/OPERATE or DIRECT-OPERATE** controls that
> reach live tag state — provided controls are explicitly enabled (they are off
> by default; see [Controls](#controls-select--operate--direct-operate)). The
> listener is started by `server/index.ts` **only** when
> `DNP3_OUTSTATION_ENABLED=true`; with no new environment set, no socket is
> created and startup is unchanged — see
> [Enabling the listener](#enabling-the-listener). Some framing details remain
> explicit TODOs (see "Implemented vs TODO" below).
>
> **Reference-master interoperability is tested.** The automated conformance
> smoke builds the pinned OpenDNP3 3.1.2 reference master (commit
> `26b4c01e4839bbbda8866655e086471c4917ee53`) and verifies startup, the g80v1
> restart acknowledgement, all five static point families, Class 1/2/3 events,
> confirmed unsolicited responses, and SELECT/OPERATE reaching the tag sink.
> See [OpenDNP3 conformance smoke](#opendnp3-conformance-smoke).

## Module layout

```
server/protocols/dnp3-outstation/
  index.ts          outstation object + pure request handler + startDnp3Outstation() bootstrap
  server.ts         TCP listener: peer allowlist, connection cap, socket timeout,
                    bounded link-frame reassembly with 0x0564 resynchronisation
  config.ts         env -> Zod-validated deployment config; point-map file loader
  tag-store-bridge.ts  live tag poller (reads) + tag-store control sink (writes)
  session.ts        per-association application state (fragment queue / awaited CONFIRM)
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

| Layer              | Concern                                                                                | Status                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Data Link**      | start bytes, length, CONTROL, addresses                                                | header build/parse implemented                                                                                            |
|                    | CRC-DNP (poly 0x3D65)                                                                  | **fully implemented + tested** (verified against the canonical reset-link vector → CRC `0x21E9`)                          |
|                    | 16-octet block CRC interleave                                                          | implemented for build + extract                                                                                           |
|                    | TCP stream → frame reassembly, bounded, with resync                                    | **implemented + tested** (`server.ts`; see [Framing on a byte stream](#framing-on-a-byte-stream))                         |
|                    | secondary link-confirm / FCB state machine                                             | **TODO**                                                                                                                  |
| **Transport**      | FIR/FIN/SEQ segmentation + reassembly                                                  | **fully implemented + tested**                                                                                            |
| **Application**    | request header parse (FIR/FIN/CON/UNS/SEQ + func)                                      | implemented                                                                                                               |
|                    | object-header scan (qualifiers 0x00/0x01/0x06/0x07/0x08)                               | implemented                                                                                                               |
|                    | prefixed-index qualifiers (0x17/0x28) length decode                                    | **implemented + tested** (for objects of known fixed size, which covers all control objects)                              |
|                    | free-format qualifier 0x5B (count8 + size16LE + body)                                  | **implemented + tested** for g120v1/v2                                                                                    |
|                    | response header + correctly ordered IIN1/IIN2 wire octets                              | **fully implemented + tested against OpenDNP3**                                                                           |
|                    | Class 0 static read (BI/AI/Counter/BO/AO + flags)                                      | **fully implemented + tested**, split into fragment-sized object blocks, non-contiguous indices and 16-bit ranges handled |
|                    | Class 1/2/3 event read                                                                 | **fully implemented + tested** — g2v1/v2/v3, g11v1/v2, g22v1/v5, g32v1/v3/v5/v7, g42, with g51v1 CTO for relative time    |
|                    | multi-fragment responses (FIR/FIN/CON + per-fragment CONFIRM)                          | **implemented + tested**                                                                                                  |
|                    | SELECT/OPERATE/DIRECT-OPERATE (g12v1, g41v1..v4)                                       | **implemented + tested**, fail-closed and off by default                                                                  |
|                    | WRITE g80v1 (clear DEVICE_RESTART IIN)                                                 | **implemented + tested against OpenDNP3**                                                                                 |
|                    | per-variation read selection (master asks for a variation, not a class)                | **TODO**                                                                                                                  |
| **Secure Auth v5** | AUTH_RESPONSE g120v1 → AUTH_REQUEST g120v2 challenge/reply, exact Table A-3 HMAC input | **implemented + tested**                                                                                                  |
|                    | dispatch of the ASDU once its reply verifies                                           | **implemented + tested**                                                                                                  |
|                    | in-band session-key establishment/wrap (g120v4/v5/v6), aggressive mode, key-change     | **TODO**; deploy with the already-established Control Direction Session Key                                               |

## Point mapping

Each 0xSCADA tag is mapped to a DNP3 point in one of the five static groups.
Indices are 0-based and contiguous **per group**.

| DNP3 group | Type                 | Direction  | Default variation                 |
| ---------- | -------------------- | ---------- | --------------------------------- |
| 1          | Binary Input         | read       | v2 (with flags)                   |
| 30         | Analog Input         | read       | v5 (float, w/ flag) or v1 (int32) |
| 20         | Counter              | read       | v1 (32-bit, w/ flag)              |
| 10         | Binary Output Status | read/write | v2 (with flags)                   |
| 40         | Analog Output Status | read/write | v3 (float) or v1 (int32)          |

Status flags are derived from 0xSCADA point quality:

| Quality     | DNP3 flags                        |
| ----------- | --------------------------------- |
| `good`      | `ONLINE` (+ binary `STATE` bit 7) |
| `uncertain` | `ONLINE` + `LOCAL_FORCED`         |
| `bad`       | `COMM_LOST` (ONLINE cleared)      |

```ts
import { createDnp3Outstation } from "@server/protocols/dnp3-outstation";

const outstation = createDnp3Outstation({
  port: 20000,
  localAddress: 10,
  unsolicitedEnabled: true,
  pointMap: {
    points: [
      { tagId: "pump.run", type: "binaryInput", index: 0, eventClass: 1 },
      {
        tagId: "tank.level",
        type: "analogInput",
        index: 0,
        eventClass: 2,
        encoding: "float32",
        deadband: 0.5,
      },
      { tagId: "flow.total", type: "counter", index: 0, eventClass: 0 },
    ],
  },
});

// Provision the already-established SAv5 Control Direction Session Key.
outstation.setControlDirectionKey(
  1,
  Buffer.from(process.env.DNP3_SAV5_CONTROL_KEY!, "hex"),
);

await outstation.start();

// Feed live values in from the tag layer:
outstation.updateTag("tank.level", {
  value: 12.4,
  quality: "good",
  timestamp: Date.now(),
});
```

> Embedding the class directly gets the same fail-closed transport defaults as
> the startup path: `host` is `127.0.0.1`, the peer allowlist is loopback-only,
> `maxConnections` is 1, `socketTimeoutMs` is 60 s and `maxRxBufferBytes` is 8192. Pass `allowedPeers` explicitly to serve anything else; a wildcard rule
> makes `start()` throw.

> **INTEGRATION (#464):** `updateTag` is the seam where the 0xSCADA tag/event
> pipeline feeds the outstation. A deployment started through
> `startDnp3Outstation()` gets that seam driven for it by
> `Dnp3TagStorePoller` (see
> [Reads and writes against the tag store](#reads-and-writes-against-the-tag-store));
> embedding the class directly leaves `updateTag` for the embedder to call.

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

| Point type             | Group | No time | Absolute time | Relative time    |
| ---------------------- | ----- | ------- | ------------- | ---------------- |
| Binary Input           | 2     | v1      | v2            | v3 (+ g51v1 CTO) |
| Binary Output          | 11    | v1      | v2            | —                |
| Counter                | 22    | v1      | v5            | —                |
| Analog Input (int32)   | 32    | v1      | v3            | —                |
| Analog Input (float32) | 32    | v5      | v7            | —                |
| Analog Output          | 42    | v1 / v5 | v3 / v7       | —                |

The numeric width is **not** configurable: it follows the point's own
`encoding`, so an event never truncates a value the static read reports at full
precision. The time representation is chosen per event type with
`eventVariations` (default: absolute time everywhere):

```ts
createDnp3Outstation({
  eventVariations: {
    binary: "absolute-time",
    counter: "absolute-time",
    analog: "absolute-time",
  },
});
```

Absolute timestamps are the 6-octet little-endian DNP3 Time (48-bit ms since the
Unix epoch). Relative-time binary events (`g2v3`) are only legal after a Common
Time Of Occurrence object, so a `g51v1` CTO is emitted immediately before each
relative run and a fresh CTO is started whenever the 16-bit offset would
overflow. Group 11 (Binary Output Event) has no relative-time variation in IEEE
1815 — only `v1` and `v2` — so a `relative-time` policy degrades to `g11v2` for
binary _output_ events while binary _inputs_ still use `g2v3`.

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
  pointMap: {
    points: [{ tagId: "valve.cmd", type: "binaryOutput", index: 0 }],
  },
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

| Situation                                                          | CommandStatus        |
| ------------------------------------------------------------------ | -------------------- |
| Control executed                                                   | `SUCCESS` (0)        |
| Armed selection expired (matching objects)                         | `TIMEOUT` (1)        |
| No arm, wrong objects, or wrong sequence number                    | `NO_SELECT` (2)      |
| Malformed object body                                              | `FORMAT_ERROR` (3)   |
| Controls disabled / no sink / unmapped point / unsupported op type | `NOT_SUPPORTED` (4)  |
| Pulse still running on that output                                 | `ALREADY_ACTIVE` (5) |
| Sink threw, or refused without a status                            | `HARDWARE_ERROR` (6) |

A CROB `count` of 0 is a spec-defined no-op: the outstation answers `SUCCESS`
and does **not** call the sink. The deprecated queue bit and the clear bit are
refused with `NOT_SUPPORTED` rather than being silently ignored.

## Enabling the listener

`server/index.ts` calls `startDnp3Outstation()` inside its `httpServer.listen`
callback, next to `startModbusServer()`. **It returns immediately, having created
no socket and no timer, unless `DNP3_OUTSTATION_ENABLED=true`.** A deployment
that sets none of the variables below behaves exactly as it did before.

### What DNP3 authenticates — and what it does not

DNP3 over TCP **does not authenticate the TCP peer at all**, and it does not
authenticate reads. Anything that can open the socket can read every mapped
point. Secure Authentication v5 authenticates **critical function codes only**
(SELECT, OPERATE, DIRECT_OPERATE, WRITE, restarts, (en|dis)able-unsolicited) and
only when the current Control Direction Session Key is provisioned for the user.
There is no confidentiality
anywhere in this implementation. The compensations therefore live at the
deployment boundary, and every one of them is off by default.

### Environment variables

| Variable                                         | Default     | Meaning                                                                                                                                        |
| ------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DNP3_OUTSTATION_ENABLED`                        | _(unset)_   | Must be exactly `true` to create a listener.                                                                                                   |
| `DNP3_OUTSTATION_SITE_ID`                        | —           | **Required.** Site whose tags back the point map.                                                                                              |
| `DNP3_OUTSTATION_POINT_MAP_FILE`                 | —           | **Required.** Path to the JSON point map (`{ "points": [...] }`, validated with Zod).                                                          |
| `DNP3_OUTSTATION_BIND_HOST`                      | `127.0.0.1` | Bind address. Anything non-loopback additionally requires the allowlist below.                                                                 |
| `DNP3_OUTSTATION_PORT`                           | `20000`     | Bind port (the registered DNP3 port).                                                                                                          |
| `DNP3_OUTSTATION_ALLOWED_PEERS`                  | loopback    | Comma-separated IPs/CIDRs, enforced at accept time. `/0` wildcards are refused.                                                                |
| `DNP3_OUTSTATION_LINK_ADDRESS`                   | `10`        | This outstation's DNP3 link address.                                                                                                           |
| `DNP3_OUTSTATION_MAX_CONNECTIONS`                | `1`         | Hard cap on simultaneous master associations. Must remain 1 when SAv5 is provisioned because session keys are association-scoped.              |
| `DNP3_OUTSTATION_SOCKET_TIMEOUT_MS`              | `60000`     | Idle socket timeout (`0` disables).                                                                                                            |
| `DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES`            | `8192`      | Per-connection receive bound; must be ≥ 292 (one maximum link frame).                                                                          |
| `DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES`             | `1048576`   | Per-connection bound on unread response bytes; see [Bounding a peer that stops reading](#bounding-a-peer-that-stops-reading).                  |
| `DNP3_OUTSTATION_POLL_INTERVAL_MS`               | `1000`      | How often mapped tags are re-read from the tag store.                                                                                          |
| `DNP3_OUTSTATION_UNSOLICITED_ENABLED`            | `false`     | Enable unsolicited responses at startup.                                                                                                       |
| `DNP3_OUTSTATION_ALLOW_CONTROLS`                 | `false`     | **Separate opt-in** before SELECT/OPERATE/DIRECT-OPERATE execute.                                                                              |
| `DNP3_OUTSTATION_SELECT_TIMEOUT_MS`              | `5000`      | How long a SELECT stays armed.                                                                                                                 |
| `DNP3_OUTSTATION_SAV5_CONTROL_KEY`               | _(unset)_   | Hex-encoded active SAv5 Control Direction Session Key (≥ 16 octets). Provisioning it turns on standard challenge/reply for critical functions. |
| `DNP3_OUTSTATION_SAV5_USER`                      | `1`         | SAv5 user number the key belongs to.                                                                                                           |
| `DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS` | `false`     | Required to run controls with **no** SAv5 Control Direction Session Key.                                                                       |

Configuration is validated with Zod and **fails closed**: an invalid value throws
`Dnp3OutstationConfigError`, the failure is logged, and no socket is bound. It is
never downgraded to defaults.

### Network-policy expectations

- The default bind is `127.0.0.1`. Moving it is a deliberate act, and the loader
  **refuses to start** a non-loopback listener that does not name its masters in
  `DNP3_OUTSTATION_ALLOWED_PEERS`.
- The allowlist is checked at accept time, before a protocol byte is read, and a
  wildcard (`0.0.0.0/0`, `::/0`) is rejected outright — it is not an allowlist.
- Keep the listener on a segmented control network. The allowlist is IP-based and
  offers no defence against a peer that can spoof or occupy an allowed address.
- Master associations are capped (default 1) and idle sockets are closed.

### What an unauthenticated peer can actuate

- **With `DNP3_OUTSTATION_ALLOW_CONTROLS` unset (the default):** nothing. Every
  SELECT/OPERATE/DIRECT-OPERATE is echoed with CommandStatus `NOT_SUPPORTED` (4).
  An allowlisted peer can still **read** every mapped point.
- **With it set:** exactly the `binaryOutput`/`analogOutput` points that the
  point map marks `"writable": true`. Mapping a point makes its status readable;
  only `writable` makes it controllable. The boot log names them:

  ```
  DNP3 Outstation Mode has CONTROLS ENABLED: 1 of 4 mapped points are writable
  by a master (binaryOutput:0→valve.cmd). SAv5 is NOT provisioned, so these
  commands carry no authentication at all — the peer allowlist and network
  segmentation are the only controls in front of these tags.
  ```

- Enabling controls **requires** either `DNP3_OUTSTATION_SAV5_CONTROL_KEY` or an
  explicit `DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS=true`. There is no
  configuration in which plant outputs become writable by accident.

### Reads and writes against the tag store

`tag-store-bridge.ts` supplies both directions:

- **Reads.** `Dnp3TagStorePoller` re-reads every mapped tag every
  `DNP3_OUTSTATION_POLL_INTERVAL_MS` and calls `updateTag()` for the ones whose
  value or quality changed, so Class 0 reflects live values and Class 1/2/3
  carry real changes. The initial snapshot taken at startup is the outstation's
  starting state, so the events it would produce are discarded rather than
  reported to a master as boot-time changes.
- **Writes.** `createTagStoreControlSink()` is installed **only** when controls
  are enabled. It refuses any point not marked `writable`.

### Framing on a byte stream

DNP3 over TCP is a byte stream, so `Dnp3LinkFrameReader` recovers frames itself.
It never trusts a LENGTH octet it has not CRC-validated: it scans to the next
`0x05 0x64`, waits for the whole 10-octet header block, verifies the header CRC,
rejects a structurally impossible LENGTH (< 5), and only then waits for exactly
that many octets. A failed header CRC resynchronises on the next candidate start
pattern. The retained buffer is bounded by `DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES`;
a peer that exceeds it without completing a frame has its connection closed.

The bound is applied to the whole incoming chunk before it is buffered, so a
single TCP read larger than `DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES` closes the
connection **even if every octet of it is a valid frame** (at the default that is
roughly 480 pipelined requests in one segment). That is deliberate — it fails
closed — but it is a real limit on how hard a master may pipeline.

### Bounding a peer that stops reading

The receive bound does not bound outstation memory on its own. A Class 0 READ is
17 octets on the wire and asks for the **entire static database**, so a peer can
buy several hundred full responses inside one bounded read and then simply never
drain its socket; the responses would otherwise queue in the process indefinitely.
Two defences engage, in order:

1. when the kernel stops accepting a response write, the outstation **pauses
   reading** that connection until it drains, so no further responses are
   generated;
2. if the unflushed queue still passes `DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES`, the
   connection is dropped, exactly as an oversized receive buffer is.

`server.test.ts` asserts this against a real socket that is connected, pipelining
Class 0 reads, and never reading a single response octet.

## Known limitations

- **One master association.** Application-confirm state is per connection, but
  the event buffer is shared, so with two masters connected at once the first
  CONFIRM drains events for both. DNP3 outstations conventionally serve a single
  master. The default connection cap of 2 does not change that — raise it only
  if you understand the consequence.
- **A control's `SUCCESS` means "accepted for writing", not "written".** The
  `Dnp3ControlSink` contract is synchronous (DNP3 needs a CommandStatus in the
  OPERATE response) while the tag store is asynchronous, so the sink answers for
  the enqueue onto an in-process, strictly ordered queue. That queue is **not**
  durable: if the process dies between the response and the store write, the
  master will have been told SUCCESS for a write that did not land. A later
  failure is logged (`control write to … failed AFTER the master was told
SUCCESS`) but cannot be un-reported.
- **Event resolution is the poll interval.** The tag cache exposes no change
  feed, so the bridge polls. A change that comes and goes inside one interval is
  never observed, and event timestamps are the store's sample timestamps as seen
  at poll time.
- **The per-point `deadband` is not applied by the poller.** It is accepted and
  validated in the point map, but the production data source forwards any change,
  however small.
- Unconfirmed events are re-sent on the next Class poll, but there is no
  independent retry timer.
- The secondary link-confirm / frame-count-bit (FCB) state machine is not
  implemented.
- The point map is read once at startup from
  `DNP3_OUTSTATION_POINT_MAP_FILE`; there is no reload path.
- **The idle timeout does not evict a peer that keeps talking.**
  `DNP3_OUTSTATION_SOCKET_TIMEOUT_MS` is an _inactivity_ timer, so an allowlisted
  peer that dribbles one octet every few seconds holds its slot indefinitely.
  With the default cap of 1, one such peer can keep a legitimate master out.
  The allowlist is the control for this; the timeout is not.
- A truncated frame costs the frame that follows it. The header CRC fixes the
  frame length, so a frame that is cut short consumes the head of the next one,
  which then fails its block CRC and is dropped. The reader resynchronises and
  the frame after that is served normally — this is inherent to length-prefixed
  framing, not a recoverable case.
- TCP only; DNP3 serial is a separate task.

## Secure Authentication v5

Critical function codes (SELECT, OPERATE, DIRECT_OPERATE, WRITE, restarts,
(en|dis)able-unsolicited) are challenged before execution **when the current
Control Direction Session Key is provisioned for the user** (open mode
otherwise, for pilots without keys):

```
master                                   outstation
  |  --- OPERATE (critical ASDU) ------->  |
  |  <-- 0x83 g120v1/0x5B Challenge ------ |   issueChallenge(), USR=0
  |  --- 0x20 g120v2/0x5B Reply -------->  |   reply supplies USR
  |  <----- result / control executed ---- |   verifyReply() -> dispatch
```

The MAC follows IEEE 1815 Table A-3 exactly:
`HMAC(controlDirectionSessionKey, completeChallengeApplicationFragment ‖ criticalASDU)`,
truncated per the negotiated algorithm. Supported algorithm identifiers are 2
(SHA-1/10), 3 (SHA-256/8), 4 (SHA-256/16, default), and 5 (SHA-1/8).
Verification is constant-time (`crypto.timingSafeEqual`). Challenges are bound
to one DNP association, single-use, and expire after `challengeTimeoutMs`.
While waiting for a reply, a second critical ASDU is discarded rather than
replacing the queued one. Malformed/trailing g120v2 data, function 0x21,
wrong-user, CSQ, MAC, and expiry paths all fail closed in tests.

> No new dependency: HMAC uses Node's built-in `crypto`.

**Scope of SAv5, stated plainly.** It authenticates the listed _critical function
codes_ and nothing else. READs are not authenticated. The TCP peer is not
authenticated. Nothing is encrypted. This implementation performs standard
challenge/reply but does not perform in-band session-key establishment or
g120v6 key wrap; provision the already-established active Control Direction
Session Key out of band on both peers. It therefore enforces a single
authenticated association (`DNP3_OUTSTATION_MAX_CONNECTIONS=1`). When no key is
provisioned the outstation runs in open mode and there is **no authentication at
all** — which is why `DNP3_OUTSTATION_ALLOW_CONTROLS=true` refuses to start
without either a key or an explicit
`DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS=true`. Set the key with
`DNP3_OUTSTATION_SAV5_CONTROL_KEY` (hex, ≥ 16 octets) and
`DNP3_OUTSTATION_SAV5_USER`.

## OpenDNP3 conformance smoke

Run the Linux conformance harness from the repository root:

```bash
bash scripts/run-dnp3-opendnp3-smoke.sh
```

The harness clones the final OpenDNP3 3.1.2 source at an immutable commit,
builds its official `master-demo`, starts
`test/conformance/dnp3/outstation-fixture.ts`, and fails unless the reference
master proves all of the following:

- startup Disable-Unsolicited → Clear-Restart-IIN → integrity sequence completes
  without error IIN bits;
- Class 0 contains Binary Input, Analog Input, Counter, Binary Output Status,
  and Analog Output Status values with parseable flags;
- Class 1/2/3 polls contain timestamped binary, analog, and counter events;
- OpenDNP3 receives and confirms an unsolicited response;
- OpenDNP3 SELECT/OPERATE reports `State: SUCCESS Status: SUCCESS`; and
- the command actually reaches the 0xSCADA control sink.

`.github/workflows/dnp3-opendnp3-conformance.yml` runs the same harness whenever
the protocol, fixture, harness, or workflow changes. It was also run directly
against this implementation on 2026-07-28; that run exposed and led to the fix
for reversed IIN1/IIN2 octets and then passed end to end.

OpenDNP3 3.1.2 does not participate in this module's SAv5 test exchange. The
HMAC challenge → verified reply → authorised-ASDU execution path remains covered
by the deterministic `secure-auth.test.ts` and live-dispatch tests, including
tampering, replay, wrong-user, wrong-key, and expiry rejection.

### Protocol unit and live-socket suite

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

Added for the listener/wiring work:

- `frame-reader.test.ts` — link-frame recovery from a byte stream: a frame split
  at **every** offset, one byte per segment, several frames per segment, garbage
  before a start pattern, a false `0x0564` whose header CRC fails, a
  CRC-consistent but structurally impossible LENGTH, and the buffer bound.
- `server.test.ts` — the listener over **real loopback sockets**: loopback bind
  by default, wildcard allowlist refused, a disallowed peer dropped at accept
  time, the connection cap, the idle timeout, pathological segmentation on the
  wire, a bad user-data CRC dropped without wedging the connection, the receive
  bound closing a connection, a Class 0 poll returning live values, Class 1/2/3
  event polls, controls refused with `NOT_SUPPORTED` until opted in and then
  executed only for `writable` points, and shutdown releasing the port.
- `config.test.ts` — every gate in the environment contract, including the
  refusal to run controls without an authentication decision.
- `tag-store-bridge.test.ts` — the poller's change detection and error
  tolerance, and everything the control sink refuses.
- `bootstrap.test.ts` — `startDnp3Outstation()` end to end: nothing at all when
  the flag is absent, a refusal (and no bound port) for every invalid
  configuration, and a real master reading live tag values off the socket.

## References

- IEEE 1815-2012 — DNP3 specification
- IEC 62351-5 — Secure Authentication
- opendnp3: https://github.com/dnp3/opendnp3
