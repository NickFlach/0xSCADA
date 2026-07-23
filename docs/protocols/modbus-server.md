# Modbus TCP Server Mode

> Issue #462 — Mirror of OPC-UA Server Mode for the lower-end market. Legacy
> HMIs and integrators can read/write 0xSCADA tags via standard Modbus TCP.

## Overview

The Modbus TCP server (`server/protocols/modbus-server/`) lets any standard
Modbus master (pymodbus, ModScan, legacy HMIs, SCADA integrators) poll 0xSCADA
tags. The Modbus TCP wire protocol (MBAP header + PDU) is implemented **from
scratch** — it is small, well specified, and avoids a heavy runtime dependency,
which keeps the protocol logic fully unit-testable.

```
Modbus master ──TCP──▶ ModbusTcpServer ──▶ handlers ──▶ TagStoreDataModel
   (pymodbus)          (server.ts)        (handlers.ts)   (tag-store-bridge.ts)
                                                                │
                                                                ▼
                                                         live tag store
                                                       (tagCache / Redis)
```

## Module layout

| File | Responsibility |
|------|----------------|
| `codec.ts` | MBAP header + PDU encode/decode, bit/register packing. Pure, no I/O. |
| `data-model.ts` | `ModbusDataModel` interface + `InMemoryDataModel`. The four primary tables. |
| `register-map.ts` | Per-site tag ⇄ address mapping, Zod schema, lookups, value⇄register codec. |
| `handlers.ts` | Pure request → response processing for all 8 FCs + exception mapping. |
| `tag-store-bridge.ts` | Binds a `RegisterMap` to the live tag store; writes propagate back. |
| `server.ts` | `net.Server` listener, TCP frame reassembly. Transport only. |
| `index.ts` | Public exports + `createModbusServerForSite()` factory. |

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
| `0x01` | Illegal Function | function code not in the supported set |
| `0x02` | Illegal Data Address | the requested address/range is not mapped |
| `0x03` | Illegal Data Value | quantity/byte-count out of spec range; write to a read-only tag; misaligned multi-register write |
| `0x04` | Server Device Failure | the data model / tag store raised an unexpected error |

## Register map (per-site configuration)

Each site declares which tags are exposed at which Modbus addresses. The
runtime schema lives in `register-map.ts`; the persisted table is
`modbus_register_map` in `shared/schema.ts`.

```ts
import { createModbusServerForSite } from "@server/protocols/modbus-server";

const server = createModbusServerForSite({
  siteId: "site-1",
  unitId: 1,
  entries: [
    { tagId: "pump-01.run",   area: "coil",            address: 0,  dataType: "bool" },
    { tagId: "alarm.active",  area: "discreteInput",   address: 0,  dataType: "bool" },
    { tagId: "tank.level",    area: "holdingRegister", address: 0,  dataType: "uint16" },
    { tagId: "flow.rate",     area: "holdingRegister", address: 1,  dataType: "float32", scale: 1 },
    { tagId: "device.serial", area: "inputRegister",   address: 5,  dataType: "uint16", readOnly: true },
  ],
});
await server.start(); // listens on MODBUS_SERVER_PORT or 502
```

### Entry fields

- `tagId` — the 0xSCADA tag exposed at this address.
- `area` — `coil` | `discreteInput` | `holdingRegister` | `inputRegister`.
- `address` — zero-based on-the-wire address (NOT 4xxxx notation).
- `dataType` — `bool` (bit areas) | `uint16` | `int16` | `uint32` | `int32` | `float32`.
- `scale` — optional linear scale: read value = raw × scale; write raw = value ÷ scale.
- `wordOrder` — `big` (default) | `little` for 32-bit types.
- `readOnly` — if true, master writes are rejected with Illegal Data Value.

32-bit types occupy two consecutive registers; the map rejects overlapping or
duplicate addresses at construction time.

## Configuration / environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MODBUS_SERVER_ENABLED` | `false` | gate that should guard bootstrap wiring |
| `MODBUS_SERVER_PORT` | `502` | bind port (use a high port for unprivileged runs) |

> Binding to port 502 requires elevated privileges on most operating systems.
> For local development/conformance testing, set `MODBUS_SERVER_PORT=1502`.

### Write safety

Network writes (FC05, FC06, FC15, FC16) are disabled by default. A caller must
construct the server with `{ allowWrites: true }` to expose them. This is only a
fail-closed capability gate; Modbus TCP itself does not authenticate clients,
so enabling writes still requires an explicit deployment-level network and
authorization policy. No such policy is invented by this protocol library.

## Conformance smoke test (pymodbus)

A runnable pymodbus client lives at
`server/protocols/modbus-server/__tests__/pymodbus_smoke.py`. It exercises coil
+ register read/write ranges and asserts values round-trip. Because that smoke
test performs writes, its test-only server must be constructed with
`{ allowWrites: true }` on an isolated loopback/test network.

```bash
# 1. Start the server on a high port (example bootstrap; see "wiring" below)
MODBUS_SERVER_PORT=1502 MODBUS_SERVER_ENABLED=true npm run dev

# 2. In another shell, run the conformance client
pip install pymodbus
python server/protocols/modbus-server/__tests__/pymodbus_smoke.py --port 1502
```

> NOTE: This smoke test requires a running server and Python's `pymodbus`, so it
> is **not** part of the Node/vitest suite and was **not** executed in the
> isolated build worktree (no running server, no Python deps). The TypeScript
> request/response path it exercises *is* covered end-to-end by the vitest tests
> in `__tests__/` (codec round-trips, every FC handler, every exception, and
> writes propagating into the tag store).

## Server bootstrap / wiring (deferred — INTEGRATION #462)

Loading the persisted register map and starting the server during application
bootstrap is intentionally left as a follow-up so this module stays
self-contained and unit-testable. The intended wiring in `server/index.ts`:

```ts
if (process.env.MODBUS_SERVER_ENABLED === "true") {
  // loadModbusRegisterMap() reads the modbus_register_map rows for a site via
  // server/storage.ts and shapes them into a RegisterMapConfig.
  const map = await loadModbusRegisterMap(siteId);
  const server = createModbusServerForSite(map);
  await server.start();
}
```

Two pieces remain before this can ship:
1. A storage accessor over the `modbus_register_map` table in `server/storage.ts`.
2. A product decision on which site(s) expose Modbus and on which port/unit id.

## Tests

`server/protocols/modbus-server/__tests__/`:
- `codec.test.ts` — MBAP/PDU encode/decode round-trips, partial/coalesced frames.
- `handlers.test.ts` — each of the 8 function codes + every exception code.
- `register-map.test.ts` — lookups, range coverage, value⇄register encoding, scale, word order.
- `tag-store-bridge.test.ts` — reads observe live values; writes propagate to the store; end-to-end through the handler layer.
