/**
 * Modbus register map — configurable per-site tag <-> Modbus-address mapping.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * A site administrator declares which 0xSCADA tags are exposed at which Modbus
 * addresses, and in which area (coil / discrete input / holding register /
 * input register). Standard Modbus masters then poll those addresses. This
 * module owns:
 *   - the Zod schema for a register-map entry / a full map,
 *   - efficient address -> entry lookup for a contiguous read/write range,
 *   - encoding/decoding between a JS tag value and its 16-bit register
 *     representation according to the entry's `dataType`.
 *
 * The map itself is pure data and is fully unit-testable. Persistence lives in
 * `shared/schema.ts` (table `modbusRegisterMap`); see `tag-store-bridge.ts` for
 * how a loaded map is bound to the live tag store.
 */

import { z } from "zod";
import type { RegisterArea } from "./data-model";

/**
 * How a tag value is encoded into Modbus registers. Coils/discrete inputs are
 * always single-bit and ignore `dataType`.
 *
 *   - bool   : single coil / discrete input (1 bit)
 *   - uint16 : 1 register, unsigned
 *   - int16  : 1 register, signed (two's complement)
 *   - uint32 : 2 registers, unsigned
 *   - int32  : 2 registers, signed
 *   - float32: 2 registers, IEEE-754 single precision
 */
export const ModbusDataType = {
  BOOL: "bool",
  UINT16: "uint16",
  INT16: "int16",
  UINT32: "uint32",
  INT32: "int32",
  FLOAT32: "float32",
} as const;

export type ModbusDataType = (typeof ModbusDataType)[keyof typeof ModbusDataType];

/** Word order for multi-register (32-bit) values. */
export type WordOrder = "big" | "little";

/** Zod schema for a single register-map entry. */
export const registerMapEntrySchema = z.object({
  /** 0xSCADA tag identifier this entry exposes. */
  tagId: z.string().min(1),
  /** Which Modbus primary table this address lives in. */
  area: z.enum([
    "coil",
    "discreteInput",
    "holdingRegister",
    "inputRegister",
  ]) satisfies z.ZodType<RegisterArea>,
  /** Zero-based Modbus address (the on-the-wire address, not 4xxxx notation). */
  address: z.number().int().min(0).max(0xffff),
  /** Value encoding. Must be `bool` for coil/discreteInput areas. */
  dataType: z.enum(["bool", "uint16", "int16", "uint32", "int32", "float32"]),
  /** Optional linear scale applied on read (value * scale) and inverse on write. */
  scale: z.number().optional(),
  /** Word order for 32-bit types. Defaults to big-endian word order. */
  wordOrder: z.enum(["big", "little"]).optional(),
  /** If true, writes from a master are rejected (ILLEGAL_DATA_VALUE). */
  readOnly: z.boolean().optional(),
});

export type RegisterMapEntry = z.infer<typeof registerMapEntrySchema>;

/** Zod schema for a full per-site register map. */
export const registerMapSchema = z.object({
  siteId: z.string().min(1),
  /** Modbus unit id this map answers for (default 1). */
  unitId: z.number().int().min(0).max(255).default(1),
  entries: z.array(registerMapEntrySchema),
});

export type RegisterMapConfig = z.infer<typeof registerMapSchema>;

/** Number of 16-bit registers a data type occupies. */
export function registerWidth(dataType: ModbusDataType): number {
  switch (dataType) {
    case "bool":
      return 0; // bit area, not register-addressed
    case "uint16":
    case "int16":
      return 1;
    case "uint32":
    case "int32":
    case "float32":
      return 2;
  }
}

/** Areas that are bit-addressed rather than register-addressed. */
function isBitArea(area: RegisterArea): boolean {
  return area === "coil" || area === "discreteInput";
}

/**
 * Indexed, validated view over a register map. Provides O(1) lookup of the
 * entry owning a given (area, address) and range-coverage checks for a
 * contiguous read/write. Construct via `RegisterMap.fromConfig`.
 */
export class RegisterMap {
  /** key = `${area}:${address}` -> entry that *starts* there. */
  private readonly byStart = new Map<string, RegisterMapEntry>();
  /** key = `${area}:${address}` -> entry that *occupies* that address. */
  private readonly byOccupied = new Map<string, RegisterMapEntry>();

  readonly siteId: string;
  readonly unitId: number;
  readonly entries: RegisterMapEntry[];

  private constructor(config: RegisterMapConfig) {
    this.siteId = config.siteId;
    this.unitId = config.unitId;
    this.entries = config.entries;

    for (const entry of config.entries) {
      this.assertEntryConsistent(entry);
      const startKey = RegisterMap.key(entry.area, entry.address);
      if (this.byStart.has(startKey)) {
        throw new Error(
          `Duplicate Modbus entry at ${entry.area}:${entry.address}`,
        );
      }
      this.byStart.set(startKey, entry);

      const width = isBitArea(entry.area)
        ? 1
        : registerWidth(entry.dataType);
      for (let i = 0; i < width; i++) {
        const occKey = RegisterMap.key(entry.area, entry.address + i);
        if (this.byOccupied.has(occKey)) {
          throw new Error(
            `Overlapping Modbus entries at ${entry.area}:${entry.address + i}`,
          );
        }
        this.byOccupied.set(occKey, entry);
      }
    }
  }

  /** Validate raw config with Zod and build the indexed map. */
  static fromConfig(raw: unknown): RegisterMap {
    const config = registerMapSchema.parse(raw);
    return new RegisterMap(config);
  }

  private assertEntryConsistent(entry: RegisterMapEntry): void {
    if (isBitArea(entry.area) && entry.dataType !== "bool") {
      throw new Error(
        `Entry ${entry.area}:${entry.address} must use dataType "bool"`,
      );
    }
    if (!isBitArea(entry.area) && entry.dataType === "bool") {
      throw new Error(
        `Entry ${entry.area}:${entry.address} (register area) cannot use dataType "bool"`,
      );
    }
  }

  private static key(area: RegisterArea, address: number): string {
    return `${area}:${address}`;
  }

  /** The entry that starts exactly at (area, address), if any. */
  entryStartingAt(
    area: RegisterArea,
    address: number,
  ): RegisterMapEntry | undefined {
    return this.byStart.get(RegisterMap.key(area, address));
  }

  /** The entry occupying (area, address), if any (covers multi-register types). */
  entryOccupying(
    area: RegisterArea,
    address: number,
  ): RegisterMapEntry | undefined {
    return this.byOccupied.get(RegisterMap.key(area, address));
  }

  /** True if every address in [address, address+quantity) is mapped. */
  rangeIsFullyMapped(
    area: RegisterArea,
    address: number,
    quantity: number,
  ): boolean {
    for (let i = 0; i < quantity; i++) {
      if (!this.byOccupied.has(RegisterMap.key(area, address + i))) {
        return false;
      }
    }
    return true;
  }

  /** All entries for an area, sorted by address. */
  entriesForArea(area: RegisterArea): RegisterMapEntry[] {
    return this.entries
      .filter((e) => e.area === area)
      .sort((a, b) => a.address - b.address);
  }
}

// ── Value <-> register encoding ────────────────────────────────────────────

/**
 * Encode a JS numeric value into the register words it occupies, honouring the
 * entry's data type, scale, and word order. Returns one or two 16-bit words.
 */
export function encodeValueToRegisters(
  entry: RegisterMapEntry,
  value: number,
): number[] {
  const scaled = entry.scale ? value / entry.scale : value;
  const wordOrder: WordOrder = entry.wordOrder ?? "big";

  switch (entry.dataType) {
    case "uint16":
      return [Math.round(scaled) & 0xffff];
    case "int16": {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(clampInt(Math.round(scaled), -0x8000, 0x7fff), 0);
      return [buf.readUInt16BE(0)];
    }
    case "uint32": {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.round(scaled) >>> 0, 0);
      return splitWords(buf, wordOrder);
    }
    case "int32": {
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(clampInt(Math.round(scaled), -0x80000000, 0x7fffffff), 0);
      return splitWords(buf, wordOrder);
    }
    case "float32": {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(scaled, 0);
      return splitWords(buf, wordOrder);
    }
    case "bool":
      throw new Error("encodeValueToRegisters called on bool entry");
  }
}

/**
 * Decode the register words occupied by an entry back into a JS number,
 * honouring data type, scale, and word order.
 */
export function decodeRegistersToValue(
  entry: RegisterMapEntry,
  words: number[],
): number {
  const wordOrder: WordOrder = entry.wordOrder ?? "big";
  let raw: number;

  switch (entry.dataType) {
    case "uint16":
      raw = words[0] & 0xffff;
      break;
    case "int16": {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(words[0] & 0xffff, 0);
      raw = buf.readInt16BE(0);
      break;
    }
    case "uint32": {
      const buf = joinWords(words, wordOrder);
      raw = buf.readUInt32BE(0);
      break;
    }
    case "int32": {
      const buf = joinWords(words, wordOrder);
      raw = buf.readInt32BE(0);
      break;
    }
    case "float32": {
      const buf = joinWords(words, wordOrder);
      raw = buf.readFloatBE(0);
      break;
    }
    case "bool":
      throw new Error("decodeRegistersToValue called on bool entry");
  }

  return entry.scale ? raw * entry.scale : raw;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Split a 4-byte buffer into two 16-bit words in the given word order. */
function splitWords(buf: Buffer, wordOrder: WordOrder): number[] {
  const hi = buf.readUInt16BE(0);
  const lo = buf.readUInt16BE(2);
  return wordOrder === "big" ? [hi, lo] : [lo, hi];
}

/** Join two 16-bit words into a 4-byte buffer in the given word order. */
function joinWords(words: number[], wordOrder: WordOrder): Buffer {
  const buf = Buffer.alloc(4);
  const [hi, lo] = wordOrder === "big" ? [words[0], words[1]] : [words[1], words[0]];
  buf.writeUInt16BE((hi ?? 0) & 0xffff, 0);
  buf.writeUInt16BE((lo ?? 0) & 0xffff, 2);
  return buf;
}
