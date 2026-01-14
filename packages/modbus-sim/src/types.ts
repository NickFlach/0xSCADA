/**
 * Modbus Simulator Types
 *
 * VS-1.1 - Vertical Slice: Modbus TCP Simulator
 */

// =============================================================================
// REGISTER TYPES
// =============================================================================

export type RegisterType =
  | "coil"            // 0xxxx - Discrete outputs (read/write)
  | "discreteInput"   // 1xxxx - Discrete inputs (read-only)
  | "inputRegister"   // 3xxxx - Analog inputs (read-only)
  | "holdingRegister"; // 4xxxx - Analog outputs (read/write)

// =============================================================================
// TAG BINDING
// =============================================================================

export interface TagBinding {
  /** Tag name (e.g., "TK-101.Level") */
  tag: string;
  /** Modbus register type */
  registerType: RegisterType;
  /** Register address (0-based) */
  address: number;
  /** Optional scaling factor */
  scale?: number;
  /** Optional offset */
  offset?: number;
}

// =============================================================================
// SIMULATOR CONFIG
// =============================================================================

export interface ModbusSimConfig {
  /** TCP port to listen on (default: 502) */
  port: number;
  /** Unit ID (default: 1) */
  unitId: number;
  /** Number of coils (default: 1000) */
  coilCount: number;
  /** Number of discrete inputs (default: 1000) */
  discreteInputCount: number;
  /** Number of input registers (default: 1000) */
  inputRegisterCount: number;
  /** Number of holding registers (default: 1000) */
  holdingRegisterCount: number;
}

// =============================================================================
// SIMULATOR EVENTS
// =============================================================================

export interface ReadEvent {
  type: "read";
  registerType: RegisterType;
  address: number;
  quantity: number;
  timestamp: Date;
}

export interface WriteEvent {
  type: "write";
  registerType: RegisterType;
  address: number;
  values: number[] | boolean[];
  timestamp: Date;
}

export type ModbusEvent = ReadEvent | WriteEvent;

export type EventCallback = (event: ModbusEvent) => void;

// =============================================================================
// PROCESS MODEL INTERFACE
// =============================================================================

export interface ProcessVariable {
  /** Variable name */
  name: string;
  /** Current value */
  value: number;
  /** Engineering unit */
  unit: string;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
}

export interface TankModel {
  /** Tank identifier */
  id: string;
  /** Current level (0-100%) */
  level: ProcessVariable;
  /** Current temperature */
  temperature: ProcessVariable;
  /** Inflow rate (L/s) */
  inflow: number;
  /** Outflow rate (L/s) */
  outflow: number;
  /** Tank capacity (L) */
  capacity: number;
}
