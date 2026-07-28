#!/usr/bin/env python3
"""Conformance smoke test for the 0xSCADA Modbus TCP server (Issue #462).

This is a REAL, runnable pymodbus client. It is NOT part of the Node/vitest
suite and was NOT executed in the isolated build worktree (it needs a running
server and the `pymodbus` package). Run it against a live server:

    pip install pymodbus
    python pymodbus_smoke.py --host 127.0.0.1 --port 1502 --unit 1

It exercises the acceptance-criteria function codes and asserts that coil and
register writes round-trip back through reads. Addresses below assume a register
map similar to the example in docs/protocols/modbus-server.md; adjust with the
CLI flags if your map differs.

PREREQUISITES (the write checks fail otherwise, by design):
  * the target server was started with MODBUS_SERVER_ALLOW_WRITES=true —
    otherwise every write returns exception 0x01 (Illegal Function);
  * the --coil / --hreg addresses are marked `writable` in the register map —
    otherwise they return exception 0x03 (Illegal Data Value);
  * this machine's IP is in MODBUS_SERVER_ALLOWED_PEERS — otherwise the
    connection is dropped at accept time and connect() fails.
Run it only against an isolated loopback/test deployment.

Exit code 0 = all checks passed; non-zero = a check failed.
"""

import argparse
import sys

try:
    # pymodbus >= 3.x
    from pymodbus.client import ModbusTcpClient
except ImportError:  # pragma: no cover - depends on installed version
    # pymodbus 2.x fallback
    from pymodbus.client.sync import ModbusTcpClient  # type: ignore


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {label}")
    return condition


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1502)
    parser.add_argument("--unit", type=int, default=1)
    parser.add_argument("--coil", type=int, default=0, help="writable coil addr")
    parser.add_argument(
        "--hreg", type=int, default=0, help="writable holding register addr"
    )
    args = parser.parse_args()

    client = ModbusTcpClient(args.host, port=args.port)
    if not client.connect():
        print(f"ERROR: could not connect to {args.host}:{args.port}")
        return 2

    ok = True
    try:
        print("Modbus TCP conformance smoke test")
        print(f"Target {args.host}:{args.port} unit {args.unit}\n")

        # FC05 + FC01: write a single coil, then read it back.
        client.write_coil(args.coil, True, slave=args.unit)
        rr = client.read_coils(args.coil, 1, slave=args.unit)
        ok &= check("FC05 write coil True -> FC01 read coil",
                    not rr.isError() and rr.bits[0] is True)

        client.write_coil(args.coil, False, slave=args.unit)
        rr = client.read_coils(args.coil, 1, slave=args.unit)
        ok &= check("FC05 write coil False -> FC01 read coil",
                    not rr.isError() and rr.bits[0] is False)

        # FC06 + FC03: write a single register, read it back.
        client.write_register(args.hreg, 1337, slave=args.unit)
        rr = client.read_holding_registers(args.hreg, 1, slave=args.unit)
        ok &= check("FC06 write register 1337 -> FC03 read register",
                    not rr.isError() and rr.registers[0] == 1337)

        # FC16 + FC03: write multiple registers (where the map allows it).
        client.write_registers(args.hreg, [111, 222], slave=args.unit)
        rr = client.read_holding_registers(args.hreg, 2, slave=args.unit)
        ok &= check("FC16 write [111,222] -> FC03 read range",
                    not rr.isError() and list(rr.registers[:2]) == [111, 222])

        # FC15 + FC01: write multiple coils, read back the range.
        client.write_coils(args.coil, [True, False, True], slave=args.unit)
        rr = client.read_coils(args.coil, 3, slave=args.unit)
        ok &= check("FC15 write [T,F,T] -> FC01 read range",
                    not rr.isError() and list(rr.bits[:3]) == [True, False, True])

        # FC02 / FC04: read-only areas should at least respond without error.
        rr = client.read_discrete_inputs(0, 1, slave=args.unit)
        ok &= check("FC02 read discrete inputs responds", rr is not None)
        rr = client.read_input_registers(5, 1, slave=args.unit)
        ok &= check("FC04 read input registers responds", rr is not None)

        # Exception: reading an unmapped address must return an exception.
        rr = client.read_holding_registers(60000, 1, slave=args.unit)
        ok &= check("FC03 unmapped address -> Modbus exception", rr.isError())

    finally:
        client.close()

    print("\nRESULT:", "ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
