/**
 * Tests for the shared Modbus constants (consolidation of issues #370 + #462).
 *
 * Two responsibilities:
 *   1. Pin the canonical numeric values to the Modbus spec.
 *   2. Act as a drift guard: assert the vendor-side re-exports (`MODBUS_FC` /
 *      `MODBUS_EXCEPTION`) and the Modbus-server codec re-exports
 *      (`FunctionCode` / `ExceptionCode`) all resolve to the same values as the
 *      shared source of truth. If anyone re-introduces a parallel definition
 *      with a different value, this fails.
 */
import { describe, it, expect } from "vitest";
import {
  MODBUS_EXCEPTION_CODES,
  MODBUS_FUNCTION_CODES,
} from "../modbus-constants";
import {
  MODBUS_EXCEPTION,
  MODBUS_FC,
} from "../../../server/services/vendors/modbus-utils";
import {
  ExceptionCode,
  FunctionCode,
} from "../../../server/protocols/modbus-server/codec";

describe("MODBUS_FUNCTION_CODES (canonical)", () => {
  it("matches the Modbus spec values", () => {
    expect(MODBUS_FUNCTION_CODES).toEqual({
      READ_COILS: 0x01,
      READ_DISCRETE_INPUTS: 0x02,
      READ_HOLDING_REGISTERS: 0x03,
      READ_INPUT_REGISTERS: 0x04,
      WRITE_SINGLE_COIL: 0x05,
      WRITE_SINGLE_REGISTER: 0x06,
      READ_EXCEPTION_STATUS: 0x07,
      DIAGNOSTICS: 0x08,
      WRITE_MULTIPLE_COILS: 0x0f,
      WRITE_MULTIPLE_REGISTERS: 0x10,
      READ_DEVICE_IDENTIFICATION: 0x2b,
    });
  });
});

describe("MODBUS_EXCEPTION_CODES (canonical)", () => {
  it("matches the Modbus spec values", () => {
    expect(MODBUS_EXCEPTION_CODES).toEqual({
      ILLEGAL_FUNCTION: 0x01,
      ILLEGAL_DATA_ADDRESS: 0x02,
      ILLEGAL_DATA_VALUE: 0x03,
      SERVER_DEVICE_FAILURE: 0x04,
      ACKNOWLEDGE: 0x05,
      SERVER_DEVICE_BUSY: 0x06,
      MEMORY_PARITY_ERROR: 0x08,
      GATEWAY_PATH_UNAVAILABLE: 0x0a,
      GATEWAY_TARGET_FAILED: 0x0b,
    });
  });
});

describe("vendor MODBUS_FC re-export stays in sync with the canonical source", () => {
  it("is an exact alias of MODBUS_FUNCTION_CODES", () => {
    // Same values, same keys — the vendor side adds nothing of its own here.
    expect(MODBUS_FC).toEqual(MODBUS_FUNCTION_CODES);
  });
});

describe("vendor MODBUS_EXCEPTION re-export stays in sync with the canonical source", () => {
  it("keeps the legacy slave names but the canonical values", () => {
    // The two renamed keys map to the modern "server" canonical values...
    expect(MODBUS_EXCEPTION.SLAVE_DEVICE_FAILURE).toBe(
      MODBUS_EXCEPTION_CODES.SERVER_DEVICE_FAILURE,
    );
    expect(MODBUS_EXCEPTION.SLAVE_DEVICE_BUSY).toBe(
      MODBUS_EXCEPTION_CODES.SERVER_DEVICE_BUSY,
    );
    // ...and every shared (non-renamed) key carries the canonical value.
    for (const key of [
      "ILLEGAL_FUNCTION",
      "ILLEGAL_DATA_ADDRESS",
      "ILLEGAL_DATA_VALUE",
      "ACKNOWLEDGE",
      "MEMORY_PARITY_ERROR",
      "GATEWAY_PATH_UNAVAILABLE",
      "GATEWAY_TARGET_FAILED",
    ] as const) {
      expect(MODBUS_EXCEPTION[key]).toBe(MODBUS_EXCEPTION_CODES[key]);
    }
  });
});

describe("Modbus-server codec re-export stays in sync with the canonical source", () => {
  it("FunctionCode is the supported subset of MODBUS_FUNCTION_CODES", () => {
    for (const [key, value] of Object.entries(FunctionCode)) {
      expect(value).toBe(
        MODBUS_FUNCTION_CODES[key as keyof typeof MODBUS_FUNCTION_CODES],
      );
      // ...and equal to the vendor-side constant of the same name.
      expect(value).toBe(MODBUS_FC[key as keyof typeof MODBUS_FC]);
    }
  });

  it("ExceptionCode is the subset of MODBUS_EXCEPTION_CODES the server returns", () => {
    for (const [key, value] of Object.entries(ExceptionCode)) {
      expect(value).toBe(
        MODBUS_EXCEPTION_CODES[key as keyof typeof MODBUS_EXCEPTION_CODES],
      );
    }
    // The renamed exception (server vs slave) must agree across both modules.
    expect(ExceptionCode.SERVER_DEVICE_FAILURE).toBe(
      MODBUS_EXCEPTION.SLAVE_DEVICE_FAILURE,
    );
  });
});
