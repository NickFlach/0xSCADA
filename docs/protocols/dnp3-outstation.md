# DNP3 Outstation Mode

Issue #464 (wave 2c). Lets legacy utility control-room **masters** (e.g. SCADA
front-end processors running [opendnp3](https://github.com/dnp3/opendnp3)) poll
0xSCADA over DNP3 (IEEE 1815-2012) as if it were a conventional RTU/outstation.
Required for the utility-consortium pilots.

> **Status: scaffold-core (substantial-but-partial).** The protocol's testable
> cores — point mapping, status flags, Class 0/1/2/3 event buffering, the
> unsolicited trigger, Secure Authentication v5 HMAC, link CRC, and transport
> segmentation — are **fully implemented and unit-tested**. The full
> link/transport/application framing on a live socket is wired but several
> framing details are explicit TODOs (see "Implemented vs TODO" below). This is
> intentional for the tier: the network glue is hardware/conformance-gated and
> verified centrally, not faked here.

## Module layout

```
server/protocols/dnp3-outstation/
  index.ts          TCP outstation server (default port 20000) + pure request handler
  app-objects.ts    DNP3 object groups/variations, status-flag (quality) octets, IIN, encoders
  point-map.ts      tag -> DNP3 point mapping for all 5 static groups (+ flags, scaling, deadband)
  event-buffer.ts   Class 0/1/2/3 event buffering, overflow, unsolicited-trigger evaluation
  secure-auth.ts    Secure Authentication v5 — HMAC challenge/response state machine
  link-layer.ts     DNP3 data-link framing + CRC-DNP (poly 0x3D65)
  transport.ts      transport function segmentation / reassembly (FIR/FIN/SEQ)
  app-layer.ts      APDU parse + response/object-header assembly + Class-0 reader
  __tests__/        unit tests for every core above
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
| | prefixed-index qualifiers (0x17/0x28) length decode | **TODO** |
| | response header + IIN | **fully implemented + tested** |
| | Class 0 static read (BI/AI/Counter/BO/AO + flags) | **fully implemented + tested** |
| | Class 1/2/3 event read | buffer + IIN/report-state implemented; per-variation **timestamped event object encoder is a TODO** (g2v2 / g22v1 / g32v1) |
| | SELECT/OPERATE CROB execution + arm/disarm timing | **TODO** |
| | WRITE g80v1 (clear DEVICE_RESTART IIN) | **TODO** |
| **Secure Auth v5** | HMAC over critical ASDU (challenge/response) | **fully implemented + tested** |
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
   the master `READ g60v2/v3/v4`. (Per-variation timestamped event objects are
   the TODO above; the IIN class-event bits + buffer drain are verifiable now.)
6. **Unsolicited:** enable unsolicited on the master, breach a class threshold,
   confirm the master receives a func-0x82 fragment.
7. **Secure auth:** provision a matching Update Key on both ends, send an
   OPERATE, confirm the g120v1 challenge / g120v2 reply handshake succeeds.

### Local equivalent (no opendnp3)

The pure cores are exhaustively covered by `npm run test:unit`:

```bash
npx vitest run server/protocols/dnp3-outstation
```

These verify CRC against the canonical DNP3 vector, link frame round-trips,
transport segmentation, Class 0/1/2/3 buffering + unsolicited triggers, point
serialisation with flags, and the full SAv5 HMAC challenge/response including
adversarial rejection paths.

## References

- IEEE 1815-2012 — DNP3 specification
- IEC 62351-5 — Secure Authentication
- opendnp3: https://github.com/dnp3/opendnp3
