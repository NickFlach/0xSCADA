/**
 * Register-map tests (#462): lookups + value <-> register encoding.
 */
import { describe, it, expect } from "vitest";
import {
  RegisterMap,
  decodeRegistersToValue,
  encodeValueToRegisters,
  registerWidth,
  type RegisterMapEntry,
} from "../register-map";

const baseConfig = {
  siteId: "site-1",
  unitId: 1,
  entries: [
    { tagId: "pump.run", area: "coil", address: 0, dataType: "bool" },
    {
      tagId: "valve.open",
      area: "discreteInput",
      address: 0,
      dataType: "bool",
    },
    {
      tagId: "tank.level",
      area: "holdingRegister",
      address: 0,
      dataType: "uint16",
    },
    {
      tagId: "flow.rate",
      area: "holdingRegister",
      address: 1,
      dataType: "float32",
    }, // occupies 1 and 2
    {
      tagId: "motor.temp",
      area: "inputRegister",
      address: 10,
      dataType: "int16",
    },
  ],
};

describe("RegisterMap.fromConfig", () => {
  it("validates and indexes entries", () => {
    const map = RegisterMap.fromConfig(baseConfig);
    expect(map.siteId).toBe("site-1");
    expect(map.unitId).toBe(1);
    expect(map.entriesForArea("holdingRegister").map((e) => e.tagId)).toEqual([
      "tank.level",
      "flow.rate",
    ]);
  });

  it("looks up the entry starting at an address", () => {
    const map = RegisterMap.fromConfig(baseConfig);
    expect(map.entryStartingAt("coil", 0)?.tagId).toBe("pump.run");
    expect(map.entryStartingAt("coil", 1)).toBeUndefined();
  });

  it("resolves the entry occupying a secondary register of a 32-bit value", () => {
    const map = RegisterMap.fromConfig(baseConfig);
    // flow.rate is float32 at hr1 -> occupies hr1 and hr2
    expect(map.entryOccupying("holdingRegister", 1)?.tagId).toBe("flow.rate");
    expect(map.entryOccupying("holdingRegister", 2)?.tagId).toBe("flow.rate");
    expect(map.entryOccupying("holdingRegister", 3)).toBeUndefined();
  });

  it("reports range coverage correctly", () => {
    const map = RegisterMap.fromConfig(baseConfig);
    expect(map.rangeIsFullyMapped("holdingRegister", 0, 3)).toBe(true); // hr0,1,2
    expect(map.rangeIsFullyMapped("holdingRegister", 0, 4)).toBe(false); // hr3 unmapped
  });

  it("rejects a bit area entry with a non-bool dataType", () => {
    expect(() =>
      RegisterMap.fromConfig({
        siteId: "s",
        entries: [
          { tagId: "x", area: "coil", address: 0, dataType: "uint16" },
        ],
      }),
    ).toThrow(/must use dataType "bool"/);
  });

  it("rejects a register area entry using bool", () => {
    expect(() =>
      RegisterMap.fromConfig({
        siteId: "s",
        entries: [
          { tagId: "x", area: "holdingRegister", address: 0, dataType: "bool" },
        ],
      }),
    ).toThrow(/cannot use dataType "bool"/);
  });

  it("rejects duplicate addresses", () => {
    expect(() =>
      RegisterMap.fromConfig({
        siteId: "s",
        entries: [
          { tagId: "a", area: "coil", address: 0, dataType: "bool" },
          { tagId: "b", area: "coil", address: 0, dataType: "bool" },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it("rejects overlapping multi-register entries", () => {
    expect(() =>
      RegisterMap.fromConfig({
        siteId: "s",
        entries: [
          {
            tagId: "a",
            area: "holdingRegister",
            address: 0,
            dataType: "uint32",
          }, // hr0,1
          {
            tagId: "b",
            area: "holdingRegister",
            address: 1,
            dataType: "uint16",
          }, // collides at hr1
        ],
      }),
    ).toThrow(/Overlapping/);
  });

  it("defaults unitId to 1 when omitted", () => {
    const map = RegisterMap.fromConfig({ siteId: "s", entries: [] });
    expect(map.unitId).toBe(1);
  });
});

describe("registerWidth", () => {
  it("returns the correct word counts", () => {
    expect(registerWidth("uint16")).toBe(1);
    expect(registerWidth("int16")).toBe(1);
    expect(registerWidth("uint32")).toBe(2);
    expect(registerWidth("int32")).toBe(2);
    expect(registerWidth("float32")).toBe(2);
    expect(registerWidth("bool")).toBe(0);
  });
});

describe("value <-> register codec", () => {
  function entry(over: Partial<RegisterMapEntry>): RegisterMapEntry {
    return {
      tagId: "t",
      area: "holdingRegister",
      address: 0,
      dataType: "uint16",
      ...over,
    } as RegisterMapEntry;
  }

  it("round-trips uint16", () => {
    const e = entry({ dataType: "uint16" });
    const words = encodeValueToRegisters(e, 0x1234);
    expect(words).toEqual([0x1234]);
    expect(decodeRegistersToValue(e, words)).toBe(0x1234);
  });

  it("round-trips negative int16", () => {
    const e = entry({ dataType: "int16" });
    const words = encodeValueToRegisters(e, -5);
    expect(decodeRegistersToValue(e, words)).toBe(-5);
  });

  it("round-trips uint32 big word order", () => {
    const e = entry({ dataType: "uint32" });
    const words = encodeValueToRegisters(e, 0x12345678);
    expect(words).toEqual([0x1234, 0x5678]);
    expect(decodeRegistersToValue(e, words)).toBe(0x12345678);
  });

  it("honours little word order for uint32", () => {
    const e = entry({ dataType: "uint32", wordOrder: "little" });
    const words = encodeValueToRegisters(e, 0x12345678);
    expect(words).toEqual([0x5678, 0x1234]);
    expect(decodeRegistersToValue(e, words)).toBe(0x12345678);
  });

  it("round-trips float32 within tolerance", () => {
    const e = entry({ dataType: "float32" });
    const words = encodeValueToRegisters(e, 3.14159);
    expect(decodeRegistersToValue(e, words)).toBeCloseTo(3.14159, 4);
  });

  it("applies scale on encode and decode", () => {
    // scale 0.1: tag value 23.5 -> raw 235 -> back to 23.5
    const e = entry({ dataType: "uint16", scale: 0.1 });
    const words = encodeValueToRegisters(e, 23.5);
    expect(words).toEqual([235]);
    expect(decodeRegistersToValue(e, words)).toBeCloseTo(23.5, 5);
  });
});
