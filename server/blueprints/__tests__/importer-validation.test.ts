import { describe, expect, it } from "vitest";

import { validateInstanceBindings } from "../importer";
import type {
  ParsedCMInstances,
  ParsedUnitInstances,
  ParsedUnitType,
} from "../types";

const unitTypes: ParsedUnitType[] = [
  { name: "Tank", variables: [] },
  { name: "Reactor", variables: [] },
];

function cmReference(unitInstance: string): ParsedCMInstances[] {
  return [{
    cmTypeName: "Valve",
    instances: [{
      name: "XV-1",
      unitInstance,
      configuration: {},
    }],
  }];
}

describe("validateInstanceBindings", () => {
  it("rejects a missing CM to Unit instance reference", () => {
    expect(validateInstanceBindings(unitTypes, [], cmReference("U-404")))
      .toEqual([expect.stringMatching(/unknown Unit instance: U-404/)]);
  });

  it("rejects a name that is ambiguous across Unit types", () => {
    const instances: ParsedUnitInstances[] = [
      {
        unitTypeName: "Tank",
        instances: [{ name: "U-1", unitType: "Tank" }],
      },
      {
        unitTypeName: "Reactor",
        instances: [{ name: "U-1", unitType: "Reactor" }],
      },
    ];

    expect(validateInstanceBindings(unitTypes, instances, cmReference("U-1")))
      .toEqual([expect.stringMatching(/ambiguous Unit instance U-1/)]);
  });

  it("accepts one unambiguous matching identity", () => {
    const instances: ParsedUnitInstances[] = [{
      unitTypeName: "Tank",
      instances: [{ name: "U-1", unitType: "Tank" }],
    }];

    expect(validateInstanceBindings(unitTypes, instances, cmReference("U-1")))
      .toEqual([]);
  });
});
