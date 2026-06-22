/**
 * Tag-store bridge — binds a per-site register map to the live tag store so
 * Modbus reads observe live tag values and Modbus writes propagate back.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * This is the integration seam between the protocol layer (which only knows the
 * `ModbusDataModel` interface) and 0xSCADA's live tag store. To keep the bridge
 * unit-testable without Redis, the underlying store is abstracted behind the
 * minimal `TagStorePort`. `createTagStorePort()` adapts the real `tagCache`
 * (server/services/cache/tag-cache.ts) to that port.
 */

import {
  DataModelError,
  type ModbusDataModel,
  type RegisterArea,
} from "./data-model";
import {
  decodeRegistersToValue,
  encodeValueToRegisters,
  registerWidth,
  type RegisterMap,
  type RegisterMapEntry,
} from "./register-map";

/**
 * Minimal async key/value port over the live tag store. Values are the raw JS
 * tag values (number | boolean). Implementations may be Redis-backed or
 * in-memory. Reads return `undefined` for an unknown tag.
 */
export interface TagStorePort {
  read(tagId: string): Promise<number | boolean | undefined>;
  write(tagId: string, value: number | boolean): Promise<void>;
}

/** Simple in-memory `TagStorePort` for tests and offline/dev usage. */
export class InMemoryTagStore implements TagStorePort {
  private values = new Map<string, number | boolean>();

  async read(tagId: string): Promise<number | boolean | undefined> {
    return this.values.get(tagId);
  }

  async write(tagId: string, value: number | boolean): Promise<void> {
    this.values.set(tagId, value);
  }

  /** Test helper to seed a value directly. */
  seed(tagId: string, value: number | boolean): void {
    this.values.set(tagId, value);
  }

  /** Test helper to read back the current value. */
  peek(tagId: string): number | boolean | undefined {
    return this.values.get(tagId);
  }
}

/**
 * A `ModbusDataModel` whose addresses are resolved through a `RegisterMap` and
 * whose reads/writes hit a `TagStorePort`. Unmapped addresses raise
 * `ILLEGAL_DATA_ADDRESS`; writes to read-only entries raise a dedicated error
 * that the handler maps to `ILLEGAL_DATA_VALUE`.
 */
export class TagStoreDataModel implements ModbusDataModel {
  constructor(
    private readonly map: RegisterMap,
    private readonly store: TagStorePort,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async readCoils(address: number, quantity: number): Promise<boolean[]> {
    return this.readBitArea("coil", address, quantity);
  }

  async readDiscreteInputs(
    address: number,
    quantity: number,
  ): Promise<boolean[]> {
    return this.readBitArea("discreteInput", address, quantity);
  }

  async readHoldingRegisters(
    address: number,
    quantity: number,
  ): Promise<number[]> {
    return this.readRegisterArea("holdingRegister", address, quantity);
  }

  async readInputRegisters(
    address: number,
    quantity: number,
  ): Promise<number[]> {
    return this.readRegisterArea("inputRegister", address, quantity);
  }

  private async readBitArea(
    area: RegisterArea,
    address: number,
    quantity: number,
  ): Promise<boolean[]> {
    if (!this.map.rangeIsFullyMapped(area, address, quantity)) {
      throw new DataModelError(
        "ILLEGAL_DATA_ADDRESS",
        `${area} read [${address}, ${address + quantity}) contains unmapped address`,
      );
    }
    const bits: boolean[] = [];
    for (let i = 0; i < quantity; i++) {
      const entry = this.map.entryStartingAt(area, address + i)!;
      const value = await this.store.read(entry.tagId);
      bits.push(toBool(value));
    }
    return bits;
  }

  private async readRegisterArea(
    area: RegisterArea,
    address: number,
    quantity: number,
  ): Promise<number[]> {
    if (!this.map.rangeIsFullyMapped(area, address, quantity)) {
      throw new DataModelError(
        "ILLEGAL_DATA_ADDRESS",
        `${area} read [${address}, ${address + quantity}) contains unmapped address`,
      );
    }

    // Cache decoded words per entry so multi-register entries are only read
    // from the store once even when the request spans several of their words.
    const wordCache = new Map<string, number[]>();
    const out: number[] = [];

    for (let i = 0; i < quantity; i++) {
      const addr = address + i;
      const entry = this.map.entryOccupying(area, addr)!;
      const words = await this.resolveEntryWords(entry, wordCache);
      const offset = addr - entry.address;
      out.push(words[offset] ?? 0);
    }
    return out;
  }

  private async resolveEntryWords(
    entry: RegisterMapEntry,
    cache: Map<string, number[]>,
  ): Promise<number[]> {
    const cacheKey = `${entry.area}:${entry.address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const raw = await this.store.read(entry.tagId);
    const numeric = toNumber(raw);
    const words = encodeValueToRegisters(entry, numeric);
    cache.set(cacheKey, words);
    return words;
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  async writeCoils(address: number, values: boolean[]): Promise<void> {
    if (!this.map.rangeIsFullyMapped("coil", address, values.length)) {
      throw new DataModelError(
        "ILLEGAL_DATA_ADDRESS",
        `coil write [${address}, ${address + values.length}) contains unmapped address`,
      );
    }
    for (let i = 0; i < values.length; i++) {
      const entry = this.map.entryStartingAt("coil", address + i)!;
      this.assertWritable(entry);
      await this.store.write(entry.tagId, values[i]);
    }
  }

  async writeHoldingRegisters(
    address: number,
    values: number[],
  ): Promise<void> {
    if (
      !this.map.rangeIsFullyMapped("holdingRegister", address, values.length)
    ) {
      throw new DataModelError(
        "ILLEGAL_DATA_ADDRESS",
        `holdingRegister write [${address}, ${address + values.length}) contains unmapped address`,
      );
    }

    // Group incoming words by the entry they belong to, then decode + write
    // each entry exactly once (so a 32-bit value is written atomically). A
    // partial write that does not cover all words of a multi-register entry is
    // rejected as an illegal data value.
    const start = address;
    let i = 0;
    while (i < values.length) {
      const addr = start + i;
      const entry = this.map.entryOccupying("holdingRegister", addr)!;
      if (addr !== entry.address) {
        // Write started mid-entry — not aligned to the value boundary.
        throw new DataModelError(
          "ILLEGAL_DATA_VALUE",
          `holdingRegister write not aligned to entry boundary at ${addr}`,
        );
      }
      const width = registerWidth(entry.dataType);
      if (i + width > values.length) {
        throw new DataModelError(
          "ILLEGAL_DATA_VALUE",
          `holdingRegister write truncates multi-register entry at ${addr}`,
        );
      }
      this.assertWritable(entry);
      const words = values.slice(i, i + width);
      const decoded = decodeRegistersToValue(entry, words);
      await this.store.write(entry.tagId, decoded);
      i += width;
    }
  }

  private assertWritable(entry: RegisterMapEntry): void {
    if (entry.readOnly) {
      throw new DataModelError(
        "ILLEGAL_DATA_VALUE",
        `tag ${entry.tagId} is read-only`,
      );
    }
  }
}

function toBool(value: number | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

function toNumber(value: number | boolean | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

// ── Real tag-store adapter ──────────────────────────────────────────────────

/**
 * Adapt the live `tagCache` (server/services/cache/tag-cache.ts) to a
 * `TagStorePort` for a given site. Reads pull the latest cached `TagValue`;
 * writes publish a new `TagValue` with GOOD quality and current timestamp.
 *
 * The import is dynamic so this module (and the pure protocol layer that
 * depends on it transitively) can be unit-tested without pulling in the Redis
 * cache stack.
 */
export function createTagStorePort(siteId: string): TagStorePort {
  return {
    async read(tagId: string): Promise<number | boolean | undefined> {
      const { tagCache } = await import("../../services/cache/tag-cache.js");
      const tag = await tagCache.getTagValue(siteId, tagId);
      if (!tag) return undefined;
      if (typeof tag.value === "string") {
        const n = Number(tag.value);
        return Number.isFinite(n) ? n : undefined;
      }
      return tag.value;
    },
    async write(tagId: string, value: number | boolean): Promise<void> {
      const { tagCache } = await import("../../services/cache/tag-cache.js");
      await tagCache.setTagValue(siteId, {
        tagId,
        value,
        quality: "GOOD",
        timestamp: new Date(),
      });
    },
  };
}
