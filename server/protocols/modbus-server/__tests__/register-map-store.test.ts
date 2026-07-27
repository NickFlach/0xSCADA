/**
 * Register-map loader tests (#462).
 *
 * The loader is the last gate before a socket is bound, so every failure path
 * has to be terminal: no rows, an invalid row, a read error, or a backend that
 * does not carry the table must all raise rather than yield a map that would
 * open a listener serving nothing (or, worse, serving defaults).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDatabaseType = vi.fn<[], string>();
const withLockedDatabase = vi.fn();

vi.mock("../../../storage", () => ({
  getDatabaseType: () => getDatabaseType(),
  withLockedDatabase: (operation: unknown) => withLockedDatabase(operation),
}));

import { loadModbusRegisterMap, RegisterMapLoadError } from "../register-map-store";

/** Stand-in for the Drizzle chain the loader drives. */
function rowsResolvingTo(rows: unknown[]): void {
  withLockedDatabase.mockImplementation(
    async (operation: (db: unknown) => Promise<unknown>) =>
      operation({
        select: () => ({ from: () => ({ where: async () => rows }) }),
      }),
  );
}

const row = (over: Record<string, unknown> = {}) => ({
  unitId: 1,
  area: "holdingRegister",
  address: 0,
  tagId: "tank.level",
  dataType: "uint16",
  scale: null,
  wordOrder: null,
  writable: false,
  ...over,
});

describe("loadModbusRegisterMap", () => {
  beforeEach(() => {
    getDatabaseType.mockReturnValue("postgres");
    withLockedDatabase.mockReset();
  });

  it("builds a validated map from the persisted rows", async () => {
    rowsResolvingTo([
      row(),
      row({ address: 1, tagId: "pump.speed", writable: true }),
    ]);

    const map = await loadModbusRegisterMap("site-1", 1);
    expect(map.siteId).toBe("site-1");
    expect(map.entries).toHaveLength(2);
    expect(map.entryStartingAt("holdingRegister", 0)?.writable).toBe(false);
    expect(map.entryStartingAt("holdingRegister", 1)?.writable).toBe(true);
  });

  it("carries scale and word order through, mapping NULL to undefined", async () => {
    rowsResolvingTo([
      row({ dataType: "float32", scale: 0.1, wordOrder: "little" }),
    ]);

    const entry = (await loadModbusRegisterMap("site-1", 1)).entries[0];
    expect(entry.scale).toBe(0.1);
    expect(entry.wordOrder).toBe("little");
  });

  it("refuses an empty register map rather than opening an empty listener", async () => {
    rowsResolvingTo([]);
    await expect(loadModbusRegisterMap("site-1", 1)).rejects.toBeInstanceOf(
      RegisterMapLoadError,
    );
    await expect(loadModbusRegisterMap("site-1", 1)).rejects.toThrow(
      /empty register map/,
    );
  });

  it("refuses a row the runtime schema rejects", async () => {
    rowsResolvingTo([row({ area: "notAnArea" })]);
    await expect(loadModbusRegisterMap("site-1", 1)).rejects.toBeInstanceOf(
      RegisterMapLoadError,
    );
  });

  it("refuses a backend that does not carry the table", async () => {
    getDatabaseType.mockReturnValue("sqlite");
    await expect(loadModbusRegisterMap("site-1", 1)).rejects.toThrow(
      /requires the PostgreSQL backend/,
    );
    expect(withLockedDatabase).not.toHaveBeenCalled();
  });

  it("wraps a read failure instead of swallowing it", async () => {
    withLockedDatabase.mockRejectedValue(new Error("connection terminated"));
    await expect(loadModbusRegisterMap("site-1", 1)).rejects.toThrow(
      /connection terminated/,
    );
  });
});
