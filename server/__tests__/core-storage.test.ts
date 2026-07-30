/**
 * Core asset-registry storage accessors (#9).
 *
 * The site / asset / event-anchor / maintenance routes reached the storage
 * layer through an untyped cast and called ten methods that were never
 * implemented, so every one of those endpoints answered 500 with a "not a
 * function" TypeError. Typing the facade turned that into a compile error;
 * these tests prove the implementations behind the new signatures actually
 * round-trip, rather than merely satisfying the interface.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.sequential("core asset-registry SQLite persistence (#9)", () => {
  let database: typeof import("../storage");

  beforeAll(async () => {
    process.env.FORCE_POSTGRES = "false";
    process.env.SQLITE_DATABASE_PATH = ":memory:";
    database = await import("../storage");
    await database.initializeDatabase();
    // Importing the storage module pulls in the full schema surface; on a
    // loaded machine that exceeds vitest's default 10s hook budget.
  }, 60_000);

  afterAll(async () => {
    await database.closeDatabase();
    delete process.env.SQLITE_DATABASE_PATH;
  });

  it("round-trips sites, preserving JSON metadata", async () => {
    const created = await database.storage.createSite({
      id: "site-alpha",
      name: "Alpha Plant",
      location: "Rotterdam",
      owner: "0xOwner",
      metadata: { region: "EMEA", lines: 3 },
    });

    expect(created.id).toBe("site-alpha");
    expect(created.name).toBe("Alpha Plant");
    // Decoded back out of TEXT storage, not left as a JSON string.
    expect(created.metadata).toEqual({ region: "EMEA", lines: 3 });
    expect(created.createdAt).toBeInstanceOf(Date);

    const sites = await database.storage.getSites();
    expect(sites.map((site) => site.id)).toContain("site-alpha");
  });

  it("round-trips assets and filters them by site", async () => {
    await database.storage.createSite({ id: "site-beta", name: "Beta Plant" });

    const critical = await database.storage.createAsset({
      id: "asset-alpha-1",
      siteId: "site-alpha",
      assetType: "PUMP",
      nameOrTag: "P-101",
      critical: true,
    });
    await database.storage.createAsset({
      id: "asset-beta-1",
      siteId: "site-beta",
      assetType: "VALVE",
      nameOrTag: "XV-201",
      critical: false,
    });

    // `critical` survives the INTEGER round-trip as a real boolean.
    expect(critical.critical).toBe(true);

    const all = await database.storage.getAssets();
    expect(all.map((asset) => asset.id).sort()).toEqual(["asset-alpha-1", "asset-beta-1"]);

    const alphaOnly = await database.storage.getAssetsBySiteId("site-alpha");
    expect(alphaOnly.map((asset) => asset.id)).toEqual(["asset-alpha-1"]);

    const none = await database.storage.getAssetsBySiteId("site-does-not-exist");
    expect(none).toEqual([]);
  });

  it("paginates event anchors newest-first and reports the unfiltered total", async () => {
    for (const [index, suffix] of ["a", "b", "c"].entries()) {
      await database.storage.createEventAnchor({
        id: `event-${suffix}`,
        assetId: "asset-alpha-1",
        eventType: "READING",
        payloadHash: `0xhash-${suffix}`,
        // Ascending timestamps, so newest-first ordering is c, b, a.
        timestamp: new Date(Date.UTC(2026, 0, 1 + index)),
        recordedBy: "0xGateway_System",
      });
    }

    const firstPage = await database.storage.getEventAnchorsPaginated(1, 2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.data.map((event) => event.id)).toEqual(["event-c", "event-b"]);
    expect(firstPage.data[0].timestamp).toBeInstanceOf(Date);

    const secondPage = await database.storage.getEventAnchorsPaginated(2, 2);
    // The total describes the whole table, not the page.
    expect(secondPage.total).toBe(3);
    expect(secondPage.data.map((event) => event.id)).toEqual(["event-a"]);

    const pastTheEnd = await database.storage.getEventAnchorsPaginated(9, 2);
    expect(pastTheEnd.data).toEqual([]);
    expect(pastTheEnd.total).toBe(3);
  });

  it("records a transaction hash against an existing event anchor", async () => {
    const updated = await database.storage.updateEventTxHash("event-a", "0xdeadbeef");
    expect(updated.txHash).toBe("0xdeadbeef");

    const { data } = await database.storage.getEventAnchorsPaginated(1, 10);
    expect(data.find((event) => event.id === "event-a")?.txHash).toBe("0xdeadbeef");
    // Only the addressed row is touched.
    expect(data.find((event) => event.id === "event-b")?.txHash).toBeNull();
  });

  it("round-trips maintenance records newest-first", async () => {
    await database.storage.createMaintenanceRecord({
      id: "maint-old",
      assetId: "asset-alpha-1",
      workOrderId: "WO-1",
      maintenanceType: "INSPECTION",
      performedBy: "tech-1",
      performedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    const recent = await database.storage.createMaintenanceRecord({
      id: "maint-new",
      assetId: "asset-alpha-1",
      workOrderId: "WO-2",
      maintenanceType: "REPAIR",
      performedBy: "tech-2",
      performedAt: new Date(Date.UTC(2026, 0, 5)),
      nextDueAt: new Date(Date.UTC(2026, 6, 5)),
    });

    expect(recent.performedAt).toBeInstanceOf(Date);
    expect(recent.nextDueAt).toBeInstanceOf(Date);

    const records = await database.storage.getMaintenanceRecords();
    expect(records.map((record) => record.id)).toEqual(["maint-new", "maint-old"]);
    // The POST /api/maintenance handler anchors these three fields; they must
    // survive the round-trip or the anchor is written from undefined values.
    expect(records[0].workOrderId).toBe("WO-2");
    expect(records[0].maintenanceType).toBe("REPAIR");
    expect(records[0].assetId).toBe("asset-alpha-1");
  });

  it("reports a real numeric probe latency from healthCheck", async () => {
    const health = await database.storage.healthCheck();
    expect(health.connected).toBe(true);
    // `/api/health` publishes `components.database.latencyMs`. Read through
    // the old untyped cast it was silently `undefined`; it is now measured.
    expect(typeof health.latencyMs).toBe("number");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("exposes every storage method the route layer calls", async () => {
    // Compile-time absence is caught by the `Storage` interface, but the
    // interface can only protect call sites that are typechecked. This is the
    // runtime half of the same gate: the exact method names the routes in
    // server/routes.ts and server/routes/*.ts invoke.
    const methodsCalledByRoutes = [
      "healthCheck",
      "getSites", "createSite",
      "getAssets", "getAssetsBySiteId", "createAsset",
      "getEventAnchorsPaginated", "createEventAnchor", "updateEventTxHash",
      "getMaintenanceRecords", "createMaintenanceRecord",
      "getControlModuleTypes", "getControlModuleTypeByName", "createControlModuleType",
      "getControlModuleInstances",
      "getUnitTypes", "createUnitType", "getUnitInstances",
      "getPhaseTypes", "createPhaseType", "getPhaseInstances",
      "getDesignSpecifications",
      "getVendors", "getVendorById", "createVendor",
      "getTemplatePackages", "getTemplatePackagesByVendor", "createTemplatePackage",
      "getDataTypeMappingsByVendor", "createDataTypeMapping",
      "getControllers", "getControllersByVendor", "getControllersBySite", "createController",
      "getGeneratedCode", "getGeneratedCodeBySource", "createGeneratedCode",
      "updateGeneratedCodeTxHash",
    ] as const;

    const missing = methodsCalledByRoutes.filter(
      (method) => typeof database.storage[method] !== "function",
    );
    expect(missing).toEqual([]);
  });
});
