import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.sequential("blueprint SQLite persistence (#511)", () => {
  let database: typeof import("../storage");
  let seedBlueprintDatabase: typeof import("../blueprints").seedBlueprintDatabase;

  beforeAll(async () => {
    process.env.FORCE_POSTGRES = "false";
    process.env.SQLITE_DATABASE_PATH = ":memory:";
    database = await import("../storage");
    ({ seedBlueprintDatabase } = await import("../blueprints"));
    await database.initializeDatabase();
  });

  afterAll(async () => {
    await database.closeDatabase();
    delete process.env.SQLITE_DATABASE_PATH;
  });

  it("round-trips blueprint types and instances", async () => {
    const vendor = await database.storage.upsertVendor({
      name: "test-vendor",
      displayName: "Test Vendor",
      platforms: ["Test Bench"],
      languages: ["ST"],
      configSchema: { family: "test" },
      isActive: true,
    });

    const controlModuleType = await database.storage.upsertControlModuleType({
      name: "MotorValve",
      vendorId: vendor.id,
      inputs: [{ name: "OpenCmd", dataType: "Bool" }],
      outputs: [{ name: "Opened", dataType: "Bool" }],
      inOuts: [],
    });
    await database.storage.createControlModuleInstance({
      name: "XV-101",
      controlModuleTypeId: controlModuleType.id,
      configuration: { failPosition: "closed" },
    });

    const unitType = await database.storage.upsertUnitType({
      name: "ProcessTank",
      variables: [{ name: "Level", dataType: "Real" }],
    });
    const unitInstance = await database.storage.createUnitInstance({
      name: "T-101",
      unitTypeId: unitType.id,
    });

    const phaseType = await database.storage.upsertPhaseType({
      name: "Fill",
      linkedModules: [{ name: "Inlet", type: "MotorValve" }],
      inputs: [],
      outputs: [],
      inOuts: [],
      internalValues: [],
      hmiParameters: [],
      recipeParameters: [],
      reportParameters: [],
      sequences: {},
    });
    await database.storage.createPhaseInstance({
      name: "Fill-101",
      phaseTypeId: phaseType.id,
      unitInstanceId: unitInstance.id,
    });

    expect(await database.storage.getControlModuleTypeByName("MotorValve"))
      .toMatchObject({ id: controlModuleType.id, name: "MotorValve" });
    expect(await database.storage.getControlModuleInstancesByTypeId(controlModuleType.id))
      .toEqual([expect.objectContaining({ name: "XV-101" })]);
    expect(await database.storage.getUnitInstancesByTypeId(unitType.id))
      .toEqual([expect.objectContaining({ name: "T-101" })]);
    expect(await database.storage.getPhaseTypes())
      .toEqual([expect.objectContaining({ name: "Fill" })]);
    expect(await database.storage.getPhaseInstances())
      .toEqual([expect.objectContaining({ name: "Fill-101" })]);
  });

  it("seeds vendors and mappings idempotently", async () => {
    const first = await seedBlueprintDatabase();
    const second = await seedBlueprintDatabase();

    expect(second).toEqual(first);
    expect((await database.storage.getVendors()).filter((vendor) =>
      vendor.name !== "test-vendor",
    )).toHaveLength(5);

    const siemens = await database.storage.getVendorByName("siemens");
    expect(siemens).toBeDefined();
    expect(await database.storage.getDataTypeMappingsByVendor(siemens!.id))
      .toHaveLength(12);
  });
});
