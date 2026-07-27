/**
 * Shared Modbus protocol constants — the single source of truth for Modbus
 * function codes and exception codes across 0xSCADA.
 *
 * Historically these constants were defined twice:
 *   - `server/services/vendors/modbus-utils.ts` (`MODBUS_FC`, `MODBUS_EXCEPTION`)
 *     for the client-side vendor adapters (issue #370).
 *   - `server/protocols/modbus-server/codec.ts` (`FunctionCode`, `ExceptionCode`)
 *     for the Modbus TCP server (issue #462).
 *
 * Both now re-export from this module so the numeric values can never drift
 * apart. Those modules keep their original export names (and the legacy
 * "slave" naming on the vendor side) for backwards compatibility — see the
 * re-exports there.
 *
 * Values follow the "MODBUS Application Protocol Specification V1.1b3".
 */

/**
 * Standard (public-function) Modbus function codes.
 *
 * The Modbus-server codec supports the first eight; the vendor adapters use the
 * full set. Vendor-proprietary codes (e.g. Schneider extensions) live with
 * their adapter, not here.
 */
export const MODBUS_FUNCTION_CODES = {
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
} as const;

/** A standard Modbus function code value. */
export type ModbusFunctionCode =
  (typeof MODBUS_FUNCTION_CODES)[keyof typeof MODBUS_FUNCTION_CODES];

/**
 * Modbus exception codes (returned with the function-code high bit set).
 *
 * Codes 0x04 and 0x06 are named "server" here per the current spec; the vendor
 * adapters historically call them "slave" and re-export them under those legacy
 * names. Both names map to the same numeric values.
 */
export const MODBUS_EXCEPTION_CODES = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
  ACKNOWLEDGE: 0x05,
  SERVER_DEVICE_BUSY: 0x06,
  MEMORY_PARITY_ERROR: 0x08,
  GATEWAY_PATH_UNAVAILABLE: 0x0a,
  GATEWAY_TARGET_FAILED: 0x0b,
} as const;

/** A Modbus exception code value. */
export type ModbusExceptionCode =
  (typeof MODBUS_EXCEPTION_CODES)[keyof typeof MODBUS_EXCEPTION_CODES];
