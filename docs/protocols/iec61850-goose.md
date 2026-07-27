# IEC 61850 GOOSE Subscriber

> Status: **subscriber-only** (the GOOSE *publisher* is a later wave).
>
> **Live Layer-2 capture is provided**, opt-in via `GOOSE_CAPTURE=live`, by
> spawning a libpcap capture tool (`dumpcap`/`tcpdump`) that streams pcap on
> stdout. No native addon and no new npm dependency. It requires a
> Linux/BSD/macOS host, that tool installed, and `CAP_NET_RAW`.
> **It has not been run against a real IED or a real substation bus here** —
> see [What is *not* verified](#what-is-not-verified).
>
> Offline **pcap replay** is also provided and fully works, and any other frame
> source can be injected as a backend.
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

| Backend | `GOOSE_CAPTURE` | Delivers frames? |
|---------|-----------------|------------------|
| `NullGooseCaptureBackend` (**default**) | `none` | **no** — reports why, in `start()` and in a log line |
| `GoosePcapReplayBackend` | `pcap` | **yes** — replays a captured `.pcap` offline |
| `GooseLiveCaptureBackend` | `live` | **yes** — real frames off a real interface, via `dumpcap`/`tcpdump` |
| your own implementation | — | inject it as `options.backend` |

Consequences you should plan around:

- **Capture is opt-in.** With none of the `GOOSE_*` capture variables set, the
  service constructs the null backend, `start()` resolves to **`"unavailable"`**
  and it says why. It does not throw, it never claims to be running, and it
  never starts a capture process. The decode/validation core is still fully
  usable via `handleFrame()`.
- Live capture has hard host requirements — a supported OS, a capture tool, and
  `CAP_NET_RAW`; see [Live capture](#live-capture-goose_capturelive).
  `availability()` names what your host is missing before anything is spawned,
  and `open()` reports what only the kernel can tell you.
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
| `pcap-stream.ts` | `PcapStreamDecoder` — incremental pcap decode for a live byte stream |
| `pcap-backend.ts` | `GoosePcapReplayBackend` — replays a capture with recorded timing |
| `live-backend.ts` | `GooseLiveCaptureBackend` — live capture via a spawned libpcap tool |
| `config.ts` | `GOOSE_*` environment configuration (Zod-validated) |
| `metrics.ts` | Prometheus metrics on the shared registry |
| `index.ts` | `GooseSubscriber` service + `startGooseSubscriber()` startup wiring |
| `__tests__/` | Frame/PDU, subscription, pcap codec, pcap stream, live capture, end-to-end replay and config tests |

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
provides it.

- **The pcap backend supplies the capture's own recorded timestamps**, so TTL
  countdown and round-trip latency are evaluated in the trace's time base —
  replaying a two-year-old capture reports the latencies that existed when it
  was recorded, not the age of the file.
- **The live backend supplies the kernel's capture timestamp** for each frame,
  taken from the pcap record, and `Date.now()` for `clockNowMs()`. Both come
  from the same host clock. The kernel timestamp is used rather than "when Node
  got round to it" because the capture tool's buffering, the pipe and Node's
  event loop are all comparable to the sub-4 ms budget `goose_round_trip_us`
  measures; using `Date.now()` at the point of decode would fold our own
  latency into the metric. So on the live backend **`goose_round_trip_us` is
  publisher `t` → kernel capture time**, and does not include the time to get
  the frame into Node. If the recorded timestamps disagree with the local clock
  by more than five minutes they are discarded in favour of the wall clock
  (otherwise every subscription would look permanently TTL-expired); that is
  counted and logged once.

## Live capture (`GOOSE_CAPTURE=live`)

`GooseLiveCaptureBackend` captures real EtherType 0x88B8 frames off a real
interface. It does so by spawning a libpcap capture tool that writes a classic
pcap stream to stdout, and decoding that stream incrementally:

```
dumpcap -i eth0 -P -q -s 65535 -w - -f 'ether proto 0x88b8 or (vlan and ether proto 0x88b8)'
tcpdump -i eth0 -U -n -s 65535 -w - 'ether proto 0x88b8 or (vlan and ether proto 0x88b8)'
```

Be precise about where the raw socket lives: **libpcap opens it inside the
capture tool** (`AF_PACKET`/`SOCK_RAW` on Linux, BPF devices on the BSDs), binds
it to the configured interface, and attaches the EtherType filter as a kernel
BPF program. Node never holds the socket; it reads the resulting pcap stream
over a pipe. That is why there is no native addon, no `node-gyp` and no new npm
dependency — and why the privilege requirement lands on the tool rather than on
the Node process. The pcap decoding on this side is the same code the offline
replay backend uses.

The tool is spawned with an **argv array and no shell**, so an interface name or
filter containing shell metacharacters is one opaque argument.

`-P` (dumpcap) is mandatory — modern dumpcap defaults to pcapNG, which this
decoder does not read. `-U` (tcpdump) is mandatory — without packet-buffered
output tcpdump holds frames in a 4 KiB stdio buffer.

### Requirements

All of these must hold, or capture will not start:

1. **A Linux/BSD/macOS host.** Windows is reported as unavailable: capture there
   goes through Npcap with a different privilege model and different packaging,
   and none of it is implemented or tested here.
2. **`dumpcap` or `tcpdump` installed** and on `PATH` (or pointed at by
   `GOOSE_CAPTURE_TOOL_PATH`). `dumpcap` is preferred: it is the small,
   privilege-separated capture binary Wireshark ships for exactly this purpose.
3. **`CAP_NET_RAW`.** Opening a capture handle is privileged. Grant it once to
   the capture tool rather than running the whole Node process as root:

   ```bash
   # Debian/Ubuntu: the packaged way — puts dumpcap in the `wireshark` group
   sudo dpkg-reconfigure wireshark-common     # answer "yes"
   sudo usermod -aG wireshark "$SERVICE_USER" # then re-login the service

   # or grant the capability directly
   sudo setcap cap_net_raw,cap_net_admin+eip "$(command -v dumpcap)"
   getcap "$(command -v dumpcap)"             # verify
   ```

   Under systemd, `AmbientCapabilities=CAP_NET_RAW` on the unit works too.
4. **The NIC must actually see the GOOSE traffic.** GOOSE is Layer-2 multicast:
   it is not routed and does not cross a VLAN boundary. The interface must be on
   the station/process bus, in the GOOSE VLAN (or on a mirror/SPAN port carrying
   it), and must not be a `-i any` pseudo-interface — that yields
   `LINKTYPE_LINUX_SLL`, which has no Ethernet header, and the backend refuses
   it explicitly.

### VLAN tagging — why the filter is what it is

`ether proto 0x88b8` on its own is **wrong** for a substation bus. It compiles
to a comparison at Ethernet offset 12, and on an 802.1Q-tagged frame offset 12
holds the tag's TPID (0x8100) — the real EtherType has moved to offset 16. Since
GOOSE is normally published on a dedicated priority-tagged VLAN, that filter
silently drops exactly the traffic you subscribed to.

libpcap's `vlan` keyword fixes it, with one sharp edge: it is not an ordinary
predicate. Per `pcap-filter(7)`, the first `vlan` in an expression re-bases every
offset *after* it by 4 bytes. So the terms are not interchangeable:

```
ether proto 0x88b8                 → offset 12 → untagged GOOSE
or (vlan and ether proto 0x88b8)   → `vlan` matches the tag and shifts the base,
                                     so this test reads offset 16 → tagged GOOSE
```

Putting the VLAN term first would leave the untagged test reading a shifted
offset. Exactly **one** tag is unwrapped, matching what `readFrameEtherType()`
and the frame parser decode; a QinQ (0x88A8/0x9100) outer tag is not handled by
either, so the filter does not pretend to.

Whatever the filter does, every delivered frame is re-checked with the same
`isGooseFrame()` helper the offline backend uses, so a mis-set
`GOOSE_CAPTURE_FILTER` cannot feed non-GOOSE traffic into the BER decoder.

### Startup, failure and shutdown

- `availability()` never throws and never guesses. It reports the unsupported
  platform, or that no capture tool is installed, or the exact command it would
  run. It explicitly does **not** claim your process holds `CAP_NET_RAW` — only
  the kernel can answer that, and it does so when the tool starts.
- `open()` resolves only once the pcap **global header** has been decoded.
  libpcap emits it when the capture handle is open, so `start()` reporting
  `"running"` means capture genuinely started rather than "we launched
  something". If the tool exits first, the rejection carries its exit status and
  its stderr; a permission failure is recognised and answered with the `setcap`
  remedy above, and a bad interface name is called out as such. A tool that
  emits nothing at all is abandoned after `startupTimeoutMs` (default 5 s).
- Nothing is ever fabricated. If capture cannot start there are no frames, no
  synthetic values, and the subscriber reports `"error"` or `"unavailable"`.
- `close()` kills the child (SIGTERM, then SIGKILL after a grace period), waits
  for it to be reaped, and is safe to call twice or when `open()` was never
  called. A `process.on("exit")` hook covers a shutdown that forgets to call it.
  Neither can survive a `SIGKILL` of the server, so run under a supervisor that
  kills the whole control group (systemd's default `KillMode=control-group`) if
  an orphaned `dumpcap` would be a problem for you.
- Frames snapped by the snapshot length (`incl_len < orig_len`) are **dropped**
  and counted, not decoded — a cut-off APDU would otherwise yield a partial
  dataset.
- The stream decoder is bounded: an over-large record header is rejected before
  its body is buffered, and the undecodable residue between chunks is capped.
  A framing error stops the capture rather than being silently ignored, because
  pcap has no resynchronisation marker.

```bash
GOOSE_SUBSCRIPTIONS_FILE=/etc/0xscada/goose-subscriptions.json \
GOOSE_CAPTURE=live \
GOOSE_IFACE=eth0 \
npm run start
```

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

## Injecting your own capture backend

If the spawned-tool approach does not suit your deployment, implement
`GooseCaptureBackend` against whatever binding you are willing to deploy (`cap`,
`pcap`, a custom AF_PACKET addon, a userspace DPDK shim…) and pass it to the
subscriber. Nothing else changes.

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
control-block map cannot be guessed — and capture is **off** unless a source is
selected. With none of these variables set, the service behaves exactly as it
did before live capture existed.

| Variable | Meaning |
|----------|---------|
| `GOOSE_SUBSCRIPTIONS_FILE` | Path to a JSON array of subscription configs. **Required to enable the service.** |
| `GOOSE_CAPTURE` | `none` \| `pcap` \| `live`. Defaults to `pcap` when `GOOSE_PCAP_FILE` is set, else `none`. `live` is never chosen implicitly. |
| `GOOSE_PCAP_FILE` | Path to a classic `.pcap` to replay. |
| `GOOSE_PCAP_REALTIME` | `false`/`0` to drain the capture with no delay. Default honours recorded timing. |
| `GOOSE_IFACE` | Interface to capture on. Default `eth0`. Used by the live backend; named in the "capture unavailable" explanation otherwise. |
| `GOOSE_CAPTURE_TOOL` | `auto` (default) \| `dumpcap` \| `tcpdump`. |
| `GOOSE_CAPTURE_TOOL_PATH` | Absolute path to that tool, bypassing the `PATH` search. Requires an explicit `GOOSE_CAPTURE_TOOL`, because the two tools take different arguments. |
| `GOOSE_CAPTURE_SNAPLEN` | Snapshot length, 68–262144. Default 65535. |
| `GOOSE_CAPTURE_FILTER` | BPF filter override (advanced). The EtherType 0x88B8 check is applied to every delivered frame regardless. |

`server/index.ts` calls `startGooseSubscriber()` at boot. Startup outcomes:

- no `GOOSE_SUBSCRIPTIONS_FILE` → one info line, service stays off;
- subscriptions but no capture source → `"unavailable"` plus a warning naming
  exactly what is missing;
- subscriptions + `GOOSE_PCAP_FILE` → `"running"`, frames replayed;
- subscriptions + `GOOSE_CAPTURE=live` → `"running"` once the capture tool has
  opened its handle; `"unavailable"` if the host cannot capture at all (wrong
  platform, no tool installed); `"error"`, with the tool's stderr and a remedy,
  if it could have but did not (no `CAP_NET_RAW`, no such interface).

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
- `pcap-stream.test.ts` — the incremental decoder, checked against `parsePcap()`
  for **every** single split point of a multi-packet capture, every pair of
  split points of a small one, and a byte-at-a-time feed; plus the byte-order ×
  resolution matrix, snaplen truncation flagging, both bounds, and failing
  closed after a framing error.
- `live-backend.test.ts` — the live path, driven by a fake capture command
  (`process.execPath -e …`) that emits a known pcap byte stream on stdout. This
  exercises the real spawn → stdout stream → incremental decode → EtherType
  filter → frame handler → subscriber path, including pathological chunk sizes,
  genuinely separate pipe chunks, both byte orders and the ns magic, truncated-
  frame rejection, non-GOOSE filtering, the record bound, spawn `ENOENT`,
  non-zero exit with the tool's stderr surfaced, the permission-denied remedy,
  the startup timeout, `close()` reaping the child, double-close, reopen, and an
  end-to-end run producing tag updates and moving the Prometheus counters.
- `pcap-replay.test.ts` — the issue's Verification section, executable: replay
  the committed capture, assert the expected dataset decodes, that the
  quality-bit change surfaces as a tag update, that mean round-trip stays inside
  the 4 ms budget, that the stale re-injected frame is rejected, and that the
  received/rejected counters and round-trip histogram move by exactly the
  expected amounts.
- `config.test.ts` — environment parsing, backend selection, and the startup
  outcomes. Includes the guarantee that an unconfigured environment selects no
  capture at all.

### What is *not* verified

Everything below is written from the tools' and the standard's documented
behaviour. None of it has been observed here, and nothing in this repository
claims otherwise:

- **No frame has ever been captured from a real IED or a real substation bus.**
  No such hardware is available to this repository. The end-to-end live tests
  use a fake capture command emitting a known pcap stream; the code on this side
  of the pipe is real, the bus is not.
- The `dumpcap`/`tcpdump` argument vectors and the BPF filter have not been run
  against a real libpcap in CI — CI has no capture privileges and no GOOSE
  traffic. If a tool rejects the filter or an argument, it exits and its stderr
  is surfaced verbatim; that path *is* tested.
- Timing under real load — GOOSE retransmission storms, a saturated process bus,
  the latency the pipe adds under pressure — is unmeasured. The sub-4 ms figure
  the histogram reports is publisher `t` → kernel capture time, which excludes
  the pipe.
- The committed replay capture is **synthetic**: hand-encoded by the test
  fixtures, not sniffed from a relay.

Before trusting this on a live bus, capture a trace with Wireshark first, replay
it through `GOOSE_PCAP_FILE`, and confirm the decode and the subscription map
against the IED's SCL.
