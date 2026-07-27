/**
 * Load a site's Modbus register map from the `modbus_register_map` table.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * This is the seam between the persisted configuration (migration
 * `0007_modbus_register_map.sql`, table declared in `shared/schema.ts`) and the
 * in-memory `RegisterMap` the protocol layer serves. The storage module is
 * imported dynamically so the pure protocol layer — and its unit tests — never
 * pull in the pg/sqlite driver stack.
 *
 * Every failure mode here is fail-closed: the loader throws and the caller does
 * not start a listener. An empty map in particular is treated as an error
 * rather than as "a listener that answers nothing", because a socket that
 * exists but serves no data is pure attack surface.
 */

import { and, eq, type SQL } from "drizzle-orm";
import { modbusRegisterMap } from "@shared/schema";
import { RegisterMap } from "./register-map";

/** Raised when a usable register map cannot be loaded. */
export class RegisterMapLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegisterMapLoadError";
  }
}

/**
 * The narrow slice of the Drizzle handle this loader uses. `withLockedDatabase`
 * hands back the repository's shared, loosely-typed connection; declaring the
 * shape we need keeps this module free of `any`.
 */
interface RegisterMapQueryHandle {
  select(): {
    from(table: typeof modbusRegisterMap): {
      where(condition: SQL | undefined): Promise<ModbusRegisterMapRecord[]>;
    };
  };
}

/** One persisted register-map row, as selected. */
interface ModbusRegisterMapRecord {
  unitId: number;
  area: string;
  address: number;
  tagId: string;
  dataType: string;
  scale: number | null;
  wordOrder: string | null;
  writable: boolean;
}

/**
 * Read the register map for `siteId` / `unitId` and build the validated runtime
 * map the protocol layer serves.
 *
 * `RegisterMap.fromConfig` owns the Zod schema, so a row with a bogus `area` or
 * `dataType` surfaces as one consistent validation error regardless of whether
 * the map came from the database or from a caller.
 *
 * @throws {RegisterMapLoadError} when the map cannot be read, is empty, or does
 *   not validate.
 */
export async function loadModbusRegisterMap(
  siteId: string,
  unitId: number,
): Promise<RegisterMap> {
  const { getDatabaseType, withLockedDatabase } = await import("../../storage");

  if (getDatabaseType() !== "postgres") {
    // The SQLite development fallback does not carry the modbus_register_map
    // table, and its Drizzle shim resolves every select to []. Starting a
    // listener from that would silently expose an empty map instead of the
    // operator's configuration, so refuse instead of pretending.
    throw new RegisterMapLoadError(
      "Modbus TCP Server Mode requires the PostgreSQL backend: the " +
        "modbus_register_map table is created by migration " +
        "0007_modbus_register_map.sql and is not present in the SQLite " +
        "development fallback.",
    );
  }

  let rows: ModbusRegisterMapRecord[];
  try {
    rows = await withLockedDatabase((database: RegisterMapQueryHandle) =>
      database
        .select()
        .from(modbusRegisterMap)
        .where(
          and(
            eq(modbusRegisterMap.siteId, siteId),
            eq(modbusRegisterMap.unitId, unitId),
          ),
        ),
    );
  } catch (err) {
    throw new RegisterMapLoadError(
      `Failed to read modbus_register_map for site "${siteId}" unit ${unitId}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  if (rows.length === 0) {
    throw new RegisterMapLoadError(
      `No modbus_register_map rows for site "${siteId}" unit ${unitId}. ` +
        "Refusing to open a Modbus listener with an empty register map.",
    );
  }

  const raw: unknown = {
    siteId,
    unitId,
    entries: rows.map((row) => ({
      tagId: row.tagId,
      area: row.area,
      address: row.address,
      dataType: row.dataType,
      scale: row.scale ?? undefined,
      wordOrder: row.wordOrder ?? undefined,
      writable: row.writable,
    })),
  };

  try {
    return RegisterMap.fromConfig(raw);
  } catch (err) {
    throw new RegisterMapLoadError(
      `modbus_register_map rows for site "${siteId}" unit ${unitId} are not a ` +
        `valid register map: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
