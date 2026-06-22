# IEC 61850 GOOSE Subscriber

> Status: **subscriber-only** (the GOOSE *publisher* is a later wave).
> Tier: scaffold-core. The decode + validation core is fully implemented and
> unit-tested; the live raw-socket capture path is behind capability detection
> with a documented native-binding integration gap.
>
> Issue: [#465](https://github.com/) — *Build IEC 61850 GOOSE Subscriber*.

## What this is

GOOSE (Generic Object Oriented Substation Event, IEC 61850-8-1) is the
multicast, Layer-2 publish/subscribe mechanism substation IEDs use for fast
(sub-4 ms) peer-to-peer messaging — trips, interlocks, position indications.
There is **no IP/UDP**: GOOSE rides directly on Ethernet with EtherType
`0x88B8` and a (usually multicast) destination MAC.

This module (`server/protocols/iec61850-goose/`) **subscribes** to GOOSE
traffic: it captures frames on an interface, decodes the ASN.1 BER PDU,
validates timing and quality against a per-control-block subscription, and
surfaces decoded dataset values as tag updates with `origin = "goose"`.

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

| File | Responsibility | Status |
|------|----------------|--------|
| `types.ts` | Shared types: `GoosePdu`, `GooseFrame`, `GooseDataValue`, `GooseQuality`, `GooseTagUpdate` | complete |
| `frame-parser.ts` | ASN.1 BER decoder + Ethernet/802.1Q header parse + `allData` decode | **complete & unit-tested** |
| `subscription.ts` | Per-subscription config (Zod) + validation state machine | **complete & unit-tested** |
| `metrics.ts` | Prometheus metrics on the shared registry | complete |
| `index.ts` | `GooseSubscriber` service: capability detection, frame intake, tag-update emission | core complete; live capture deferred |
| `__tests__/` | `frame-parser.test.ts`, `subscription.test.ts`, `fixtures.ts` (synthetic frame builders) | complete |

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
   `receiveTime + timeAllowedToLive`; a watchdog flags a stale/lost link when
   the next retransmission does not arrive in time.
8. **stNum / sqNum monotonicity** (IEC 61850-8-1 §18) — `stNum` increments on a
   dataset change and must not regress; within the same `stNum`, `sqNum`
   strictly increases per retransmission. 32-bit wraparound is tolerated.

Accepted frames yield one `GooseTagUpdate` per dataset member, with
`origin: "goose"`, the originating `gocbRef`, the `stNum`, a `simulated` flag,
and a coarse `good`/`bad`/`uncertain` quality derived from the IEC 61850-7-3
Quality bits.

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

The `goose_round_trip_us` histogram (publisher `t` → local receive) is paired
with wave-2b control-loop latency telemetry to validate the **sub-4 ms** budget
— buckets are centred at 4000 µs.

## Capability detection (raw socket)

A raw Layer-2 capture socket (`AF_PACKET` / `SOCK_RAW`) requires **all** of:

- **Linux** (AF_PACKET is Linux-only),
- **`CAP_NET_RAW`** (run as root, or `setcap cap_net_raw+ep $(command -v node)`),
- a **native L2 capture binding** (Node has no built-in AF_PACKET).

`detectRawSocketCapability()` checks the first two and reports the third as the
remaining gap. On the dev box (Windows) and in CI the subscriber starts in the
**`disabled`** state and never throws — the pure decode/validation core stays
fully usable for pcap replay and tests.

### Enabling live capture (TODO #465)

1. Add an approved native capture dependency (e.g. `cap`, `pcap`, or a custom
   AF_PACKET addon) to `package.json`.
2. In `GooseSubscriber.startCapture()`:
   - open `AF_PACKET/SOCK_RAW` bound to the configured interface,
   - install a BPF filter for EtherType `0x88B8` (including the 802.1Q form),
   - for each captured frame call `this.handleFrame(buf, Date.now())`.
3. Relax `detectRawSocketCapability()` to return `available: true` when the
   binding is present and the host is Linux with `CAP_NET_RAW`.

## Usage

```ts
import { GooseSubscriber } from "@server/protocols/iec61850-goose";

const subscriber = new GooseSubscriber({
  iface: process.env.GOOSE_IFACE ?? "eth0",
  subscriptions: [
    {
      gocbRef: "IED1LD0/LLN0$GO$gcb01",
      appId: 0x3001,
      expectedSrcMac: "00:11:22:33:44:55",
      dataset: [
        { tagName: "IED1/GGIO1.Ind1.stVal", type: "boolean" },
        { tagName: "IED1/GGIO1.Ind1.q", type: "quality", isQuality: true },
        { tagName: "IED1/MMXU1.A.mag.f", type: "float" },
      ],
    },
  ],
  onTagUpdate: (u) => tagStreamServer.broadcastTagUpdate(u), // INTEGRATION (#206)
});

subscriber.start(); // "disabled" on non-capable hosts, "running" on Linux+binding
```

For testing / pcap replay, feed raw frame bytes directly:

```ts
const updates = subscriber.handleFrame(rawFrameBuffer);
```

## Verification

- **Unit tests** (`vitest`): `frame-parser.test.ts` decodes synthetic frames
  (boolean / int / uint / float / quality / visible-string members, VLAN-tagged
  frames, malformed inputs); `subscription.test.ts` covers shape validation,
  stNum/sqNum monotonicity, TTL staleness, quality-bit propagation, simulated
  handling, MAC/confRev/ndsCom rejection, and the subscriber service’s
  capability gating + tag-update emission.
- **pcap replay** (manual, when a capture binding is available): replay a
  captured GOOSE pcap, assert the expected dataset decodes and that quality-bit
  / `stNum` changes surface as tag updates within the latency budget.
