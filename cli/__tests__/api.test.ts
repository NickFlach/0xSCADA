import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, getApiClient } from "../src/api.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("ApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    delete process.env.OXSCADA_API_URL;
    delete process.env.OXSCADA_TIMEOUT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create client with default config", () => {
      const client = new ApiClient();
      expect(client).toBeDefined();
    });

    it("should allow config overrides", () => {
      const client = new ApiClient({ apiUrl: "http://custom:8080" });
      expect(client).toBeDefined();
    });
  });

  describe("getHealth", () => {
    it("should fetch health status successfully", async () => {
      const mockHealth = {
        status: "healthy",
        timestamp: "2024-01-01T00:00:00Z",
        version: "1.0.0",
        uptime: 3600,
        components: {
          database: { status: "up", latencyMs: 5 },
          blockchain: { status: "up" },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockHealth,
      });

      const client = new ApiClient();
      const result = await client.getHealth();

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockHealth);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/health",
        expect.objectContaining({
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("should handle server errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Internal server error" }),
      });

      const client = new ApiClient();
      const result = await client.getHealth();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Internal server error");
      expect(result.statusCode).toBe(500);
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network unreachable"));

      const client = new ApiClient();
      const result = await client.getHealth();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network unreachable");
    });

    it("should handle timeout errors", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      const client = new ApiClient({ timeout: 100 });
      const result = await client.getHealth();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Request timed out");
    });
  });

  describe("getBlockchainStatus", () => {
    it("should fetch blockchain status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enabled: true }),
      });

      const client = new ApiClient();
      const result = await client.getBlockchainStatus();

      expect(result.success).toBe(true);
      expect(result.data?.enabled).toBe(true);
    });
  });

  describe("Sites API", () => {
    const mockSites = [
      { id: "1", name: "Site 1", location: "Location 1", owner: "0x123", createdAt: "2024-01-01" },
      { id: "2", name: "Site 2", location: "Location 2", owner: "0x456", createdAt: "2024-01-02" },
    ];

    it("should fetch all sites", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSites,
      });

      const client = new ApiClient();
      const result = await client.getSites();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    it("should get site by ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSites,
      });

      const client = new ApiClient();
      const result = await client.getSiteById("1");

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe("Site 1");
    });

    it("should return error for non-existent site ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSites,
      });

      const client = new ApiClient();
      const result = await client.getSiteById("999");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should create a site", async () => {
      const newSite = { id: "3", name: "New Site", location: "New Location", owner: "0x789", createdAt: "2024-01-03" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => newSite,
      });

      const client = new ApiClient();
      const result = await client.createSite({
        name: "New Site",
        location: "New Location",
        owner: "0x789",
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe("3");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/sites",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        })
      );
    });
  });

  describe("Assets API", () => {
    const mockAssets = [
      { id: "a1", siteId: "1", assetType: "PLC", nameOrTag: "PLC-001", critical: true, createdAt: "2024-01-01" },
      { id: "a2", siteId: "1", assetType: "HMI", nameOrTag: "HMI-001", critical: false, createdAt: "2024-01-02" },
    ];

    it("should fetch all assets", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAssets,
      });

      const client = new ApiClient();
      const result = await client.getAssets();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    it("should get asset by ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAssets,
      });

      const client = new ApiClient();
      const result = await client.getAssetById("a1");

      expect(result.success).toBe(true);
      expect(result.data?.nameOrTag).toBe("PLC-001");
    });

    it("should fetch assets by site", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAssets,
      });

      const client = new ApiClient();
      const result = await client.getAssetsBySite("1");

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/assets/site/1",
        expect.anything()
      );
    });

    it("should create an asset", async () => {
      const newAsset = { id: "a3", siteId: "1", assetType: "Sensor", nameOrTag: "TEMP-001", critical: false, createdAt: "2024-01-03" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => newAsset,
      });

      const client = new ApiClient();
      const result = await client.createAsset({
        siteId: "1",
        assetType: "Sensor",
        nameOrTag: "TEMP-001",
        critical: false,
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe("a3");
    });
  });

  describe("Events API", () => {
    const mockEvents = {
      data: [
        { id: "e1", assetId: "a1", eventType: "config_change", payloadHash: "0xabc", timestamp: "2024-01-01", recordedBy: "0x123", txHash: null, details: "" },
      ],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
    };

    it("should fetch paginated events", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEvents,
      });

      const client = new ApiClient();
      const result = await client.getEvents(1, 50);

      expect(result.success).toBe(true);
      expect(result.data?.data).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/events?page=1&limit=50",
        expect.anything()
      );
    });

    it("should create an event", async () => {
      const newEvent = { id: "e2", assetId: "a1", eventType: "alarm", payloadHash: "0xdef", timestamp: "2024-01-02", recordedBy: "0x123", txHash: null, details: "Test" };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => newEvent,
      });

      const client = new ApiClient();
      const result = await client.createEvent({
        assetId: "a1",
        eventType: "alarm",
        payload: { value: 100 },
        details: "Test",
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe("e2");
    });
  });

  describe("Batch API", () => {
    it("should fetch batch stats", async () => {
      const mockStats = {
        pendingEvents: 10,
        totalBatchesAnchored: 5,
        totalEventsAnchored: 100,
        lastBatchTime: "2024-01-01T00:00:00Z",
        averageEventsPerBatch: 20,
        estimatedGasSavings: 85.5,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockStats,
      });

      const client = new ApiClient();
      const result = await client.getBatchStats();

      expect(result.success).toBe(true);
      expect(result.data?.pendingEvents).toBe(10);
    });

    it("should trigger batch anchor", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: "Batch anchored", batchId: "b1", txHash: "0xabc", eventCount: 10 }),
      });

      const client = new ApiClient();
      const result = await client.triggerBatchAnchor();

      expect(result.success).toBe(true);
      expect(result.data?.batchId).toBe("b1");
    });
  });

  describe("Blueprints API", () => {
    it("should fetch blueprints summary", async () => {
      const mockSummary = {
        controlModuleTypes: 5,
        controlModuleInstances: 20,
        unitTypes: 3,
        unitInstances: 10,
        phaseTypes: 8,
        phaseInstances: 40,
        vendors: 2,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSummary,
      });

      const client = new ApiClient();
      const result = await client.getBlueprintsSummary();

      expect(result.success).toBe(true);
      expect(result.data?.vendors).toBe(2);
    });

    it("should seed database", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: "Database seeded" }),
      });

      const client = new ApiClient();
      const result = await client.seedDatabase();

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/blueprints/seed",
        expect.anything()
      );
    });

    it("should force seed database", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: "Database re-seeded" }),
      });

      const client = new ApiClient();
      const result = await client.seedDatabase(true);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:5000/api/blueprints/seed?force=true",
        expect.anything()
      );
    });
  });

  describe("Vendors API", () => {
    it("should fetch vendors", async () => {
      const mockVendors = [
        { id: "v1", name: "vendor1", displayName: "Vendor 1" },
        { id: "v2", name: "vendor2", displayName: "Vendor 2" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockVendors,
      });

      const client = new ApiClient();
      const result = await client.getVendors();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });
  });

  describe("Controllers API", () => {
    it("should fetch controllers", async () => {
      const mockControllers = [
        { id: "c1", name: "Controller 1", vendorId: "v1", siteId: "1", ipAddress: "192.168.1.1" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockControllers,
      });

      const client = new ApiClient();
      const result = await client.getControllers();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });
  });

  describe("getApiClient singleton", () => {
    it("should return singleton instance", () => {
      const client1 = getApiClient();
      const client2 = getApiClient();
      expect(client1).toBe(client2);
    });

    it("should create new instance with config", () => {
      const client1 = getApiClient();
      const client2 = getApiClient({ apiUrl: "http://new:8080" });
      // Config should create new instance
      expect(client2).toBeDefined();
    });
  });
});
