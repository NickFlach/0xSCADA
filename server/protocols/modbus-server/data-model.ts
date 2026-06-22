/**
 * Modbus data model — the four classic primary tables.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * Modbus exposes four logically-distinct address spaces:
 *   - Coils             (FC01 read, FC05/FC15 write) — 1-bit read/write
 *   - Discrete Inputs   (FC02 read)                   — 1-bit read-only
 *   - Holding Registers (FC03 read, FC06/FC16 write)  — 16-bit read/write
 *   - Input Registers   (FC04 read)                   — 16-bit read-only
 *
 * This module defines the `ModbusDataModel` interface that the function-code
 * handlers operate against, plus an `InMemoryDataModel` used for tests and as
 * the in-process backing for the tag-store bridge. Keeping the handlers behind
 * this interface is what lets the protocol logic be unit-tested with zero I/O.
 */

/** One of the four Modbus primary tables. */
export type RegisterArea =
  | "coil"
  | "discreteInput"
  | "holdingRegister"
  | "inputRegister";

/**
 * Reason a data-model access was rejected. Maps onto Modbus exception codes by
 * the handler layer (see `handlers.ts`):
 *   ILLEGAL_DATA_ADDRESS -> 0x02
 *   ILLEGAL_DATA_VALUE   -> 0x03 (e.g. write to a read-only entry, misalignment)
 *   SERVER_FAILURE       -> 0x04
 */
export type DataModelErrorKind =
  | "ILLEGAL_DATA_ADDRESS"
  | "ILLEGAL_DATA_VALUE"
  | "SERVER_FAILURE";

/** Thrown by data-model implementations to signal a typed failure. */
export class DataModelError extends Error {
  constructor(
    public readonly kind: DataModelErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DataModelError";
  }
}

/**
 * Backing store for Modbus addresses. Implementations decide whether an address
 * is mapped (throwing `ILLEGAL_DATA_ADDRESS` if not) and how reads/writes
 * propagate to the underlying tag store.
 *
 * Reads/writes are async because a real backing store (the live tag store /
 * Redis cache) is async; the in-memory implementation resolves synchronously.
 */
export interface ModbusDataModel {
  /** Read `quantity` coils starting at `address`. */
  readCoils(address: number, quantity: number): Promise<boolean[]>;
  /** Read `quantity` discrete inputs starting at `address`. */
  readDiscreteInputs(address: number, quantity: number): Promise<boolean[]>;
  /** Read `quantity` holding registers (16-bit) starting at `address`. */
  readHoldingRegisters(address: number, quantity: number): Promise<number[]>;
  /** Read `quantity` input registers (16-bit) starting at `address`. */
  readInputRegisters(address: number, quantity: number): Promise<number[]>;
  /** Write coils starting at `address`. */
  writeCoils(address: number, values: boolean[]): Promise<void>;
  /** Write holding registers (16-bit) starting at `address`. */
  writeHoldingRegisters(address: number, values: number[]): Promise<void>;
}

/**
 * Simple in-memory data model. Addresses are "mapped" if they fall inside the
 * configured size of each area; otherwise reads/writes throw
 * `ILLEGAL_DATA_ADDRESS`. This mirrors how a real PLC rejects out-of-range
 * accesses and is the default backing used by unit tests.
 */
export class InMemoryDataModel implements ModbusDataModel {
  private coils: boolean[];
  private discreteInputs: boolean[];
  private holdingRegisters: number[];
  private inputRegisters: number[];

  constructor(
    size: {
      coils?: number;
      discreteInputs?: number;
      holdingRegisters?: number;
      inputRegisters?: number;
    } = {},
  ) {
    this.coils = new Array<boolean>(size.coils ?? 0x10000).fill(false);
    this.discreteInputs = new Array<boolean>(
      size.discreteInputs ?? 0x10000,
    ).fill(false);
    this.holdingRegisters = new Array<number>(
      size.holdingRegisters ?? 0x10000,
    ).fill(0);
    this.inputRegisters = new Array<number>(size.inputRegisters ?? 0x10000).fill(
      0,
    );
  }

  private static assertRange(
    area: RegisterArea,
    backing: { length: number },
    address: number,
    quantity: number,
  ): void {
    if (address < 0 || quantity < 0 || address + quantity > backing.length) {
      throw new DataModelError(
        "ILLEGAL_DATA_ADDRESS",
        `${area} access [${address}, ${address + quantity}) out of range (size ${backing.length})`,
      );
    }
  }

  async readCoils(address: number, quantity: number): Promise<boolean[]> {
    InMemoryDataModel.assertRange("coil", this.coils, address, quantity);
    return this.coils.slice(address, address + quantity);
  }

  async readDiscreteInputs(
    address: number,
    quantity: number,
  ): Promise<boolean[]> {
    InMemoryDataModel.assertRange(
      "discreteInput",
      this.discreteInputs,
      address,
      quantity,
    );
    return this.discreteInputs.slice(address, address + quantity);
  }

  async readHoldingRegisters(
    address: number,
    quantity: number,
  ): Promise<number[]> {
    InMemoryDataModel.assertRange(
      "holdingRegister",
      this.holdingRegisters,
      address,
      quantity,
    );
    return this.holdingRegisters.slice(address, address + quantity);
  }

  async readInputRegisters(
    address: number,
    quantity: number,
  ): Promise<number[]> {
    InMemoryDataModel.assertRange(
      "inputRegister",
      this.inputRegisters,
      address,
      quantity,
    );
    return this.inputRegisters.slice(address, address + quantity);
  }

  async writeCoils(address: number, values: boolean[]): Promise<void> {
    InMemoryDataModel.assertRange("coil", this.coils, address, values.length);
    for (let i = 0; i < values.length; i++) {
      this.coils[address + i] = values[i];
    }
  }

  async writeHoldingRegisters(
    address: number,
    values: number[],
  ): Promise<void> {
    InMemoryDataModel.assertRange(
      "holdingRegister",
      this.holdingRegisters,
      address,
      values.length,
    );
    for (let i = 0; i < values.length; i++) {
      this.holdingRegisters[address + i] = values[i] & 0xffff;
    }
  }

  // ── Test/seed helpers (not part of the ModbusDataModel interface) ──────────

  /** Directly seed a discrete-input value (read-only over Modbus). */
  setDiscreteInput(address: number, value: boolean): void {
    this.discreteInputs[address] = value;
  }

  /** Directly seed an input-register value (read-only over Modbus). */
  setInputRegister(address: number, value: number): void {
    this.inputRegisters[address] = value & 0xffff;
  }
}
