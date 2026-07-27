# IEC 61850 GOOSE Subscriber

> Status: **subscriber-only** (the GOOSE *publisher* is a later wave).
>
> **Live Layer-2 capture is NOT provided by this repository.** GOOSE rides
> directly on Ethernet and Node has no way to receive those frames without a
> native addon; none is shipped. What *is* provided and fully works is offline
> **pcap replay**, plus an injection point for a live backend you supply.
>
> Issue: [#465](https://github.com/NickFlach/0xSCADA/issues/465) — *Build IEC
> 61850 GOOSE Subscriber*.

## What this is

GOOSE (Generic Object Oriented Substation Event, IEC 61850-8-1) is the
multicast, Layer-2 publish/subscribe mechanism substation IEDs use for fast
(sub-4 ms) peer-to-peer messaging — trips, interlocks, position indications.
There is **no IP/UDP**: GOOSE rides directly on Ethernet with EtherType
`0x88B8` and a (usually multicast) destination MAC.

This module (`server/protocols/iec61850-goose/`) **subscribes** to GOOSE
traffic: it consumes raw frames from a capture backend, decodes the ASN.1 BER
PDU, validates timing and quality against a per-control-block subscription, and
surfaces decoded dataset values as tag updates with `origin = "goose"`.

## Read this first: what can and cannot capture frames

The subscriber does **not** own capture. It consumes frames from an injected
`GooseCaptureBackend`, which is the only environment-dependent part:

| Backend | Ships here? | Delivers frames? |
|---------|-------------|------------------|
| `NullGooseCaptureBackend` (**default**) | yes | **no** — reports why, in `start()` and in a log line |
| `GoosePcapReplayBackend` | yes | **yes** — replays a captured `.pcap` offline |
| live AF_PACKET / native addon | **no** | you implement and inject it |

Consequences you should plan around:

- With the default backend, `start()` resolves to **`"unavailable"`**. It does
  not throw, and it never claims to be running. The decode/validation core is
  still fully usable via `handleFrame()`.
- A raw Layer-2 capture socket (`AF_PACKET` / `SOCK_RAW`) requires **all** of:
  Linux (AF_PACKET is Linux-only), `CAP_NET_RAW` (root, or
  `setcap cap_net_raw+ep $(command -v node)`), **and** a native L2 capture
  binding. `detectRawSocketCapability()` reports which of these your host is
  missing so the log line is host-specific rather than a generic "disabled".
- No native capture dependency is added to `package.json`, and nothing in this
  module pretends one exists.

## Frame layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Dest MAC (6) │ Src MAC (6) │ [802.1Q VLAN tag (4, optional)]             │
│ EtherType 0x88B8 (2)                                                     │
│ APPID (2) │ Length (2) │ Reserved1 (2) │ Reserved2 (2)   ← GOOSE header  │
│ APDU: IECGoosePdu  (ASN.1 BER, [APPLICATION 1] tag 0x61)                 │
└────────────────────────────────────────────────────────────────────────┘
```

The `IECGoosePdu` (IEC 61850-8-1 Annex A) carries: `gocbRef`,
`timeAllowedToLive`, `datSet`, `goID`, `t` (UTCTime), `stNum`, `sqNum`,
`simulation`/test, `confRev`, `ndsCom`, `numDatSetEntries`, and `allData`
(a `SEQUENCE OF Data` CHOICE).

## Module layout

| File | Responsibility |
|------|----------------|
| `types.ts` | Shared types: `GoosePdu`, `GooseFrame`, `GooseDataValue`, `GooseQuality`, `GooseTagUpdate` |
| `frame-parser.ts` | ASN.1 BER decoder + Ethernet/802.1Q header parse + `allData` decode |
| `subscription.ts` | Per-subscription config (Zod) + validation state machine |
| `capture-backend.ts` | The `GooseCaptureBackend` seam, EtherType filter, null backend, raw-socket capability probe |
| `pcap.ts` | Classic libpcap reader/writer (both byte orders, µs and ns magics) |
| `pcap-backend.ts` | `GoosePcapReplayBackend` — replays a capture with recorded timing |
| `config.ts` | `GOOSE_*` environment configuration (Zod-validated) |
| `metrics.ts` | Prometheus metrics on the shared registry |
| `index.ts` | `GooseSubscriber` service + `startGooseSubscriber()` startup wiring |
| `__tests__/` | Frame/PDU, subscription, pcap codec, end-to-end replay and config tests |

## Validation performed

Each frame matched to a subscription (`gocbRef` + `appId`) is checked:

1. **MAC** — optional `expectedDestMac` / `expectedSrcMac`.
2. **APPID** — must equal the configured `appId`.
3. **needsCommissioning** (`ndsCom`) — rejected.
4. **confRev** — rejected if it differs from `expectedConfRev` (when set).
5. **simulation/test bit** — handled per `simulationPolicy`
   (`reject` | `accept` | `accept-flagged`, default `accept-flagged`).
6. **Dataset shape** — entry count and per-member types must match the config
   (Quality may decode as either `quality` or a generic `bitstring`).
7. **timeAllowedToLive (TTL)** — each accepted frame arms an expiry at
   `receiveTime + timeAllowedToLive`. `sweepStaleSubscriptions()` (driven by a
   watchdog interval while running, and callable directly) flags a stale/lost
   link when the next retransmission does not arrive in time.
8. **stNum / sqNum monotonicity** (IEC 61850-8-1 §18) — `stNum` increments on a
   dataset change and must not regress; within the same `stNum`, `sqNum`
   strictly increases per retransmission. 32-bit wraparound is tolerated.

Accepted frames yield one `GooseTagUpdate` per dataset member, with
`origin: "goose"`, the originating `gocbRef`, the `stNum`, a `simulated` flag,
and a coarse `good`/`bad`/`uncertain` quality derived from the IEC 61850-7-3
Quality bits. `startGooseSubscriber()` feeds those updates to
`tagStreamServer.broadcastTagUpdate()`, so they reach the existing websocket
tag stream.

### Time base

Validation always uses the receive timestamp the backend supplies with the
frame, and the TTL watchdog uses `backend.clockNowMs?.()` when the backend
provides it. A live backend supplies wall-clock times. **The pcap backend
supplies the capture's own recorded timestamps**, so TTL countdown and
round-trip latency are evaluated in the trace's time base — replaying a
two-year-old capture reports the latencies that existed when it was recorded,
not the age of the file.

## pcap replay (fully supported)

`pcap.ts` reads the classic libpcap format: 24-byte global header plus
16-byte-per-packet records, accepting all four magic-number variants
(`0xa1b2c3d4` / `0xa1b23c4d`, big- and little-endian). pcapng (`.pcapng`) is
**not** supported and is rejected with a message telling you to re-save as
pcap. The link type must be `LINKTYPE_ETHERNET` (1).

The backend filters to EtherType `0x88B8`, transparently stepping over a single
802.1Q tag — the same test a BPF filter would apply. QinQ outer tags are not
unwrapped, matching what the frame parser can decode.

```ts
import { GooseSubscriber, GoosePcapReplayBackend } from "@server/protocols/iec61850-goose";

const backend = new GoosePcapReplayBackend({
  path: "captures/bay1-trip.pcap",
  realtime: true, // honour recorded inter-frame gaps; false = drain immediately
  speed: 1,       // realtime multiplier
});

const subscriber = new GooseSubscriber({
  backend,
  subscriptions: [/* … */],
  onTagUpdate: (u) => console.log(u),
});

await subscriber.start();      // "running"
await backend.completion();    // resolves with replay stats at end of trace
await subscriber.stop();
```

### Test capture

`__tests__/fixtures/goose-replay.pcap` is a committed 9-packet capture: eight
GOOSE frames on two control blocks plus one ARP frame that must be filtered
out. It is **synthetic** — hand-encoded by the test fixture builders, not
sniffed from a real IED, because no relay is available to this repository. It
is regenerated (and its bytes are asserted in the test suite) from source:

```bash
npx tsx server/protocols/iec61850-goose/__tests__/generate-replay-pcap.ts
```

The scenario deliberately exercises a state change, a retransmission, a quality
degradation to `invalid`, a stale frame re-injected on the bus (stNum
regression), the simulation bit, an 802.1Q-tagged frame and a foreign control
block.

## Injecting a live capture backend

Implement `GooseCaptureBackend` against whatever binding you are willing to
deploy (`cap`, `pcap`, a custom AF_PACKET addon, a userspace DPDK shim…) and
pass it to the subscriber. Nothing else changes.

```ts
import type {
  GooseCaptureAvailability,
  GooseCaptureBackend,
  GooseFrameHandler,
} from "@server/protocols/iec61850-goose";

class AfPacketBackend implements GooseCaptureBackend {
  readonly name = "af-packet";
  constructor(private readonly iface: string) {}

  availability(): GooseCaptureAvailability {
    // Return { available: false, reason } when the binding or CAP_NET_RAW is
    // missing — the subscriber will report "unavailable" instead of "running".
    return { available: true, reason: `AF_PACKET on ${this.iface}` };
  }

  async open(onFrame: GooseFrameHandler): Promise<void> {
    // 1. open AF_PACKET/SOCK_RAW bound to this.iface
    // 2. install a BPF filter for EtherType 0x88B8 (incl. the 802.1Q form)
    // 3. for each captured frame: onFrame(buffer, Date.now())
  }

  async close(): Promise<void> {
    /* close the handle */
  }

  // Optional: omit to let the subscriber use its own wall clock.
  clockNowMs(): number {
    return Date.now();
  }
}

const subscriber = new GooseSubscriber({
  backend: new AfPacketBackend("eth0"),
  subscriptions,
});
```

Contract for a backend:

- `availability()` must be honest. Returning `{ available: true }` when frames
  cannot arrive makes the subscriber report `"running"` when it is not.
- `open()` delivers **complete Ethernet frames starting at the destination
  MAC**, already filtered to EtherType `0x88B8` (use the exported
  `isGooseFrame()` helper).
- The `receivedAtMs` argument and `clockNowMs()` must share one time base.
- `close()` must be safe to call when never opened.

## Configuration

The subscriber is **off** unless subscriptions are configured — a substation's
control-block map cannot be guessed.

| Variable | Meaning |
|----------|---------|
| `GOOSE_SUBSCRIPTIONS_FILE` | Path to a JSON array of subscription configs. **Required to enable the service.** |
| `GOOSE_PCAP_FILE` | Path to a classic `.pcap` to replay. When set, the pcap backend is used. |
| `GOOSE_PCAP_REALTIME` | `false`/`0` to drain the capture with no delay. Default honours recorded timing. |
| `GOOSE_IFACE` | Interface a live backend *would* bind. Used only in the "capture unavailable" explanation. |

`server/index.ts` calls `startGooseSubscriber()` at boot. Startup outcomes:

- no `GOOSE_SUBSCRIPTIONS_FILE` → one info line, service stays off;
- subscriptions but no capture source → `"unavailable"` plus a warning naming
  exactly what is missing;
- subscriptions + `GOOSE_PCAP_FILE` → `"running"`, frames replayed.

Example `goose-subscriptions.json`:

```json
[
  {
    "gocbRef": "IED1LD0/LLN0$GO$gcb01",
    "appId": 12289,
    "expectedSrcMac": "00:11:22:33:44:55",
    "expectedConfRev": 1,
    "simulationPolicy": "accept-flagged",
    "dataset": [
      { "tagName": "IED1/XCBR1.Pos.stVal", "type": "boolean" },
      { "tagName": "IED1/XCBR1.Pos.q", "type": "quality", "isQuality": true },
      { "tagName": "IED1/MMXU1.A.phsA.cVal.mag.f", "type": "float" }
    ]
  }
]
```

## Metrics

Registered on the shared 0xSCADA Prometheus registry (prefix `scada_`), exposed
on the existing `/metrics` endpoint:

| Metric | Type | Labels |
|--------|------|--------|
| `scada_goose_frames_received_total` | counter | `app_id` |
| `scada_goose_frames_rejected_total` | counter | `reason` |
| `scada_goose_round_trip_us` | histogram | `gocb_ref` |
| `scada_goose_last_st_num` | gauge | `gocb_ref` |
| `scada_goose_subscriptions_active` | gauge | — |

`reason` is a fixed enum (`parse_error`, `no_subscription`, `mac_mismatch`,
`app_id_mismatch`, `dataset_shape`, `stnum_regression`, `sqnum_regression`,
`ttl_expired`, `conf_rev_mismatch`, `simulation`, `nds_com`) to bound label
cardinality.

The `goose_round_trip_us` histogram (publisher `t` → receive timestamp) is
paired with wave-2b control-loop latency telemetry to validate the **sub-4 ms**
budget — buckets are centred at 4000 µs. Frames filtered out by the backend's
EtherType test are never counted as received or rejected: they are not GOOSE.

## Verification

Run `npx vitest run server/protocols/iec61850-goose`.

- `frame-parser.test.ts` — BER/PDU decode of synthetic frames (boolean, int,
  uint, float, quality, visible-string members; VLAN-tagged frames; malformed
  inputs).
- `subscription.test.ts` — dataset-shape validation, stNum/sqNum monotonicity,
  TTL staleness, quality-bit propagation, simulated handling, MAC/confRev/
  ndsCom rejection, plus subscriber state transitions across an injected
  backend (`running`/`error`) and the default backend (`unavailable`).
- `pcap.test.ts` — global-header parse against a hand-assembled little-endian
  capture, the full byte-order × timestamp-resolution matrix, truncation and
  pcapng errors, and the EtherType filter.
- `pcap-replay.test.ts` — the issue's Verification section, executable: replay
  the committed capture, assert the expected dataset decodes, that the
  quality-bit change surfaces as a tag update, that mean round-trip stays inside
  the 4 ms budget, that the stale re-injected frame is rejected, and that the
  received/rejected counters and round-trip histogram move by exactly the
  expected amounts.
- `config.test.ts` — environment parsing and the three startup outcomes.

Not verified here, because it cannot be: live multicast capture. There is no
test, and no code, that receives a frame from a real substation bus.
