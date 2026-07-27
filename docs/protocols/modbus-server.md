# Modbus TCP Server Mode

> Issue #462 — Mirror of OPC-UA Server Mode for the lower-end market. Legacy
> HMIs and integrators can read (and, with explicit opt-in, write) 0xSCADA tags
> via standard Modbus TCP.

## Overview

The Modbus TCP server (`server/protocols/modbus-server/`) lets any standard
Modbus master (pymodbus, ModScan, legacy HMIs, SCADA integrators) poll 0xSCADA
tags. The Modbus TCP wire protocol (MBAP header + PDU) is implemented **from
scratch** — it is small, well specified, and avoids a heavy runtime dependency,
which keeps the protocol logic fully unit-testable.

```
Modbus master ──TCP──▶ ModbusTcpServer ──▶ handlers ──▶ TagStoreDataModel
   (pymodbus)          (server.ts)        (handlers.ts)   (tag-store-bridge.ts)
                            │                                     │
                     peer allowlist                               ▼
                     + connection cap                      live tag store
                     (peer-filter.ts)                     (tagCache / Redis)
```

## Security model — read this before enabling it

**Modbus TCP has no authentication.** The protocol carries no credential, no
handshake, and no integrity protection. Any peer that can complete a TCP
connection to the listener is, as far as the protocol is concerned, a fully
privileged master. Nothing in this implementation can change that, and nothing
in it pretends to.

What 0xSCADA does instead is refuse to be exposed by accident. Every control
below is off or closed by default, and each has to be opened deliberately:

| Control | Default | How it opens |
|---------|---------|--------------|
| The listener exists at all | **off** | `MODBUS_SERVER_ENABLED=true` |
| Bind address | **`127.0.0.1`** | `MODBUS_SERVER_BIND_HOST=<addr>` |
| Peer allowlist (accept time) | **loopback only** | `MODBUS_SERVER_ALLOWED_PEERS=<ip/cidr,…>` — *mandatory* once the bind address is not loopback |
| Simultaneous masters | **4** | `MODBUS_SERVER_MAX_CONNECTIONS=<n>` |
| Write function codes served | **refused (0x01)** | `MODBUS_SERVER_ALLOW_WRITES=true` |
| A given address is writable | **not writable** | `modbus_register_map.writable = true` for that row |

Additional hard rules, enforced in code:

- A wildcard allowlist (`0.0.0.0/0`, `::/0`) is **rejected** — an allowlist that
  admits everyone is not an allowlist, and the protocol cannot authenticate the
  peers it would admit.
- A non-loopback bind with no `MODBUS_SERVER_ALLOWED_PEERS` is **rejected**.
- Any invalid value fails closed with a `ModbusServerConfigError`; the process
  logs it and binds **no** socket. Configuration is never silently defaulted
  into something more permissive.
- Peers outside the allowlist and connections past the cap are logged and
  destroyed at accept time, before a single protocol byte is read.

Enabling writes on a routable interface still means an unauthenticated peer on
the allowlisted subnet can actuate every address marked `writable`. Keep the
listener on a segmented control network; the allowlist is a blast-radius
control, not an authentication mechanism.

## Module layout

| File | Responsibility |
|------|----------------|
| `codec.ts` | MBAP header + PDU encode/decode, bit/register packing. Pure, no I/O. |
| `data-model.ts` | `ModbusDataModel` interface + `InMemoryDataModel`. The four primary tables. |
| `register-map.ts` | Per-site tag ⇄ address mapping, Zod schema, lookups, value⇄register codec. |
| `register-map-store.ts` | Loads a site's map from `modbus_register_map`. Fails closed. |
| `handlers.ts` | Pure request → response processing for all 8 FCs + exception mapping. |
| `tag-store-bridge.ts` | Binds a `RegisterMap` to the live tag store; writes propagate back. |
| `peer-filter.ts` | IP/CIDR allowlist parsing + matching (IPv4, IPv6, IPv4-mapped). Pure. |
| `config.ts` | Zod-validated deployment configuration from the environment. |
| `server.ts` | `net.Server` listener, admission control, TCP frame reassembly. |
| `index.ts` | Public exports, `createModbusServerForSite()`, `startModbusServer()`. |

## Supported function codes

| FC | Name | Direction |
|----|------|-----------|
| `0x01` | Read Coils | read R/W bits |
| `0x02` | Read Discrete Inputs | read RO bits |
| `0x03` | Read Holding Registers | read R/W 16-bit |
| `0x04` | Read Input Registers | read RO 16-bit |
| `0x05` | Write Single Coil | write 1 bit |
| `0x06` | Write Single Register | write 1 register |
| `0x0F` | Write Multiple Coils | write N bits |
| `0x10` | Write Multiple Registers | write N registers |

## Exception responses

| Code | Name | When |
|------|------|------|
| `0x01` | Illegal Function | function code not in the supported set, **or any write FC on a listener started without `MODBUS_SERVER_ALLOW_WRITES=true`** |
| `0x02` | Illegal Data Address | the requested address/range is not mapped |
| `0x03` | Illegal Data Value | quantity/byte-count out of spec range; write to an address not marked `writable`; misaligned or truncated multi-register write |
| `0x04` | Server Device Failure | the data model / tag store raised an unexpected error |

A multi-address write is validated in full before any tag is touched: if one
address in the range is not writable, the whole request is rejected and nothing
is mutated.

## Register map (per-site configuration)

Each site declares which tags are exposed at which Modbus addresses. The runtime
schema lives in `register-map.ts`; the persisted table is `modbus_register_map`
(`shared/schema.ts`, migration `0007_modbus_register_map.sql`).

```sql
INSERT INTO modbus_register_map
  (site_id, unit_id, area, address, tag_id, data_type, scale, word_order, writable)
VALUES
  ('site-1', 1, 'coil',            0, 'pump-01.run',   'bool',    NULL, NULL, true),
  ('site-1', 1, 'discreteInput',   0, 'alarm.active',  'bool',    NULL, NULL, false),
  ('site-1', 1, 'holdingRegister', 0, 'tank.level',    'uint16',  NULL, NULL, false),
  ('site-1', 1, 'holdingRegister', 1, 'flow.rate',     'float32', 1,    NULL, false),
  ('site-1', 1, 'inputRegister',   5, 'device.serial', 'uint16',  NULL, NULL, false);
```

### Entry fields

- `tagId` — the 0xSCADA tag exposed at this address.
- `area` — `coil` | `discreteInput` | `holdingRegister` | `inputRegister`.
- `address` — zero-based on-the-wire address (NOT 4xxxx notation).
- `dataType` — `bool` (bit areas) | `uint16` | `int16` | `uint32` | `int32` | `float32`.
- `scale` — optional linear scale: read value = raw × scale; write raw = value ÷ scale.
- `wordOrder` — `big` (default) | `little` for 32-bit types.
- `writable` — **defaults to false.** Exposing a tag for polling never implies a
  master may actuate it. A write to a non-writable address is rejected with
  Illegal Data Value even on a listener that has writes enabled.

32-bit types occupy two consecutive registers; the map rejects overlapping or
duplicate addresses at construction time.

### Backend requirement

`loadModbusRegisterMap()` reads the `modbus_register_map` table over Drizzle and
therefore **requires the PostgreSQL backend**. The SQLite development fallback
in `server/storage.ts` does not carry this table (its Drizzle shim resolves
every select to `[]`), so the loader refuses with a clear error instead of
opening a listener backed by an empty map. An empty result set from Postgres is
likewise refused: a socket that answers nothing is pure attack surface.

## Configuration / environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MODBUS_SERVER_ENABLED` | `false` | Must be exactly `true` to start a listener. |
| `MODBUS_SERVER_SITE_ID` | *(required)* | Site whose register map is served. |
| `MODBUS_SERVER_UNIT_ID` | `1` | Modbus unit id whose rows are served. |
| `MODBUS_SERVER_BIND_HOST` | `127.0.0.1` | Bind address. Non-loopback forces an allowlist. |
| `MODBUS_SERVER_PORT` | `502` | Bind port (use a high port for unprivileged runs). |
| `MODBUS_SERVER_ALLOWED_PEERS` | loopback (`127.0.0.0/8`, `::1/128`) | Comma-separated IPs/CIDRs allowed to connect. No `/0`. |
| `MODBUS_SERVER_MAX_CONNECTIONS` | `4` | Simultaneous master connections. |
| `MODBUS_SERVER_ALLOW_WRITES` | `false` | Must be exactly `true` to serve FC05/06/15/16. |
| `MODBUS_SERVER_SOCKET_TIMEOUT_MS` | `60000` | Idle socket timeout (`0` disables). |

> Binding to port 502 requires elevated privileges on most operating systems.
> For local development/conformance testing, set `MODBUS_SERVER_PORT=1502`.

### Example: read-only, loopback (the safe starting point)

```bash
MODBUS_SERVER_ENABLED=true \
MODBUS_SERVER_SITE_ID=site-1 \
MODBUS_SERVER_PORT=1502 \
npm run start
```

### Example: exposed to a named control subnet, writes enabled

```bash
MODBUS_SERVER_ENABLED=true \
MODBUS_SERVER_SITE_ID=site-1 \
MODBUS_SERVER_BIND_HOST=10.4.0.10 \
MODBUS_SERVER_PORT=502 \
MODBUS_SERVER_ALLOWED_PEERS=10.4.7.0/24,10.4.9.15 \
MODBUS_SERVER_MAX_CONNECTIONS=8 \
MODBUS_SERVER_ALLOW_WRITES=true \
npm run start
```

Both the write opt-in and the non-loopback bind are logged at `warn` on
startup, together with how many mapped addresses are writable, so an operator
can see from the boot log alone what was exposed.

## Server bootstrap / wiring

`server/index.ts` calls `startModbusServer()` after the HTTP server is
listening, next to the Sparkplug B bridge:

```ts
try {
  const { startModbusServer } = await import("./protocols/modbus-server");
  await startModbusServer();
} catch (err) {
  logError(err, "Modbus TCP Server Mode not started (failed closed)");
}
```

`startModbusServer()` returns `null` — having done nothing — unless
`MODBUS_SERVER_ENABLED=true`. When enabled it validates the environment, loads
the site's register map, and binds the listener. A configuration or register-map
failure throws; `server/index.ts` logs it and the process continues **without a
Modbus listener**. There is no fallback path that binds a permissive socket.

## Conformance smoke test (pymodbus)

A runnable pymodbus client lives at
`server/protocols/modbus-server/__tests__/pymodbus_smoke.py`. It exercises coil
+ register read/write ranges and asserts values round-trip.

```bash
# 1. Start a loopback server with writes enabled, on a high port
MODBUS_SERVER_ENABLED=true MODBUS_SERVER_SITE_ID=site-1 \
MODBUS_SERVER_PORT=1502 MODBUS_SERVER_ALLOW_WRITES=true npm run dev

# 2. In another shell, run the conformance client
pip install pymodbus
python server/protocols/modbus-server/__tests__/pymodbus_smoke.py --port 1502
```

Its write checks require both `MODBUS_SERVER_ALLOW_WRITES=true` and a register
map whose `--coil` / `--hreg` addresses are marked `writable`; otherwise they
fail by design (0x01 and 0x03 respectively).

> NOTE: This smoke test requires a running server, a PostgreSQL-backed register
> map, and Python's `pymodbus`, so it is **not** part of the Node/vitest suite
> and was **not** executed in the isolated build worktree. The TypeScript
> request/response path it exercises *is* covered end-to-end by the vitest
> tests below, including over real TCP sockets.

## Tests

`server/protocols/modbus-server/__tests__/`:
- `codec.test.ts` — MBAP/PDU encode/decode round-trips, partial/coalesced frames.
- `handlers.test.ts` — each of the 8 function codes + every exception code.
- `register-map.test.ts` — lookups, range coverage, value⇄register encoding, scale, word order.
- `register-map-store.test.ts` — loader fails closed on empty/invalid rows, read errors, and a backend without the table.
- `tag-store-bridge.test.ts` — reads observe live values; writes propagate; write scoping and all-or-nothing multi-address writes.
- `peer-filter.test.ts` — IPv4/IPv6/IPv4-mapped parsing, CIDR matching, wildcard rejection, fail-closed defaults.
- `config.test.ts` — enable flag, loopback default, mandatory allowlist when exposed, every invalid-config rejection.
- `server.test.ts` — real loopback TCP: framing, reassembly, exception frames, write refusal.
- `bootstrap.test.ts` — real TCP through `startModbusServer()`: disabled by default, refuses invalid config, binds loopback, drops disallowed peers, caps connections, refuses writes with 0x01, and lands writes only on `writable` addresses once opted in.
