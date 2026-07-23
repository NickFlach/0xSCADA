import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.sequential("blueprint SQLite persistence (#511)", () => {
  let database: typeof import("../storage");
  let seedBlueprintDatabase: typeof import("../blueprints/seed-database").seedBlueprintDatabase;

  beforeAll(async () => {
    process.env.FORCE_POSTGRES = "false";
    process.env.SQLITE_DATABASE_PATH = ":memory:";
    database = await import("../storage");
    ({ seedBlueprintDatabase } = await import("../blueprints/seed-database"));
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

  it("upserts imported instances by type and name without duplicates", async () => {
    const unitType = await database.storage.getUnitTypeByName("ProcessTank");
    const controlModuleType =
      await database.storage.getControlModuleTypeByName("MotorValve");
    expect(unitType).toBeDefined();
    expect(controlModuleType).toBeDefined();

    const firstUnit = await database.storage.upsertUnitInstance({
      name: "T-IDEMPOTENT",
      unitTypeId: unitType!.id,
      area: "Area A",
    });
    const secondUnit = await database.storage.upsertUnitInstance({
      name: "T-IDEMPOTENT",
      unitTypeId: unitType!.id,
      area: "Area B",
    });
    expect(secondUnit.id).toBe(firstUnit.id);
    const storedUnits = (await database.storage.getUnitInstancesByTypeId(unitType!.id))
      .filter((instance) => instance.name === "T-IDEMPOTENT");
    expect(storedUnits).toHaveLength(1);
    expect(storedUnits[0]).toEqual(expect.objectContaining({ area: "Area B" }));

    const firstModule = await database.storage.upsertControlModuleInstance({
      name: "XV-IDEMPOTENT",
      controlModuleTypeId: controlModuleType!.id,
      configuration: { failPosition: "closed" },
    });
    const secondModule = await database.storage.upsertControlModuleInstance({
      name: "XV-IDEMPOTENT",
      controlModuleTypeId: controlModuleType!.id,
      configuration: { failPosition: "open" },
    });
    expect(secondModule.id).toBe(firstModule.id);
    const storedModules = (await database.storage.getControlModuleInstancesByTypeId(
      controlModuleType!.id,
    )).filter((instance) => instance.name === "XV-IDEMPOTENT");
    expect(storedModules).toHaveLength(1);
    expect(storedModules[0]).toEqual(expect.objectContaining({
      configuration: { failPosition: "open" },
    }));
  });

  it("rolls back the entire import transaction when persistence fails", async () => {
    const marker = `rollback-${Date.now()}`;

    await expect(database.storage.transaction(async () => {
      await database.storage.upsertVendor({
        name: marker,
        displayName: "Must Roll Back",
        platforms: [],
        languages: [],
        configSchema: {},
        isActive: true,
      });
      throw new Error("simulated import failure");
    })).rejects.toThrow("simulated import failure");

    expect(await database.storage.getVendorByName(marker)).toBeUndefined();
  });

  it("does not roll back an unrelated write that arrives during a transaction", async () => {
    const transactionMarker = `transaction-${Date.now()}`;
    const unrelatedMarker = `unrelated-${Date.now()}`;
    let transactionStarted!: () => void;
    let releaseTransaction!: () => void;
    const started = new Promise<void>((resolve) => {
      transactionStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const transaction = database.storage.transaction(async () => {
      await database.storage.upsertVendor({
        name: transactionMarker,
        displayName: "Must Roll Back",
        platforms: [],
        languages: [],
        configSchema: {},
        isActive: true,
      });
      transactionStarted();
      await release;
      throw new Error("rollback isolated transaction");
    });

    await started;
    const unrelatedWrite = database.storage.upsertVendor({
      name: unrelatedMarker,
      displayName: "Must Survive",
      platforms: [],
      languages: [],
      configSchema: {},
      isActive: true,
    });
    releaseTransaction();

    await expect(transaction).rejects.toThrow("rollback isolated transaction");
    await unrelatedWrite;

    expect(await database.storage.getVendorByName(transactionMarker)).toBeUndefined();
    expect(await database.storage.getVendorByName(unrelatedMarker))
      .toMatchObject({ name: unrelatedMarker });
  });

  it("serializes raw Drizzle operations behind the transaction lock", async () => {
    let transactionStarted!: () => void;
    let releaseTransaction!: () => void;
    const started = new Promise<void>((resolve) => {
      transactionStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    let rawOperationEntered = false;

    const transaction = database.storage.transaction(async () => {
      transactionStarted();
      await release;
    });
    await started;

    const rawOperation = database.withLockedDatabase(async () => {
      rawOperationEntered = true;
      return "completed";
    });
    await Promise.resolve();
    expect(rawOperationEntered).toBe(false);

    releaseTransaction();
    await transaction;
    await expect(rawOperation).resolves.toBe("completed");
    expect(rawOperationEntered).toBe(true);
  });
});
