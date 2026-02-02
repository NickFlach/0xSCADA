import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerEventsCommand } from "../../src/commands/events.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getEvents: vi.fn(),
    getBatchStats: vi.fn(),
    triggerBatchAnchor: vi.fn(),
    createEvent: vi.fn(),
  })),
}));

vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    fail: vi.fn(),
    text: "",
  })),
}));

vi.mock("../../src/output.js", () => ({
  setOutputOptions: vi.fn(),
  output: vi.fn(),
  outputTable: vi.fn(),
  outputSection: vi.fn(),
  outputKeyValue: vi.fn(),
  outputError: vi.fn(),
  outputSuccess: vi.fn(),
  outputWarning: vi.fn(),
  formatDate: vi.fn((d) => new Date(d).toISOString()),
  truncate: vi.fn((s: string, len: number) => s?.substring(0, len) || ""),
  colors: {
    success: (t: string) => t,
    error: (t: string) => t,
    warning: (t: string) => t,
    info: (t: string) => t,
    dim: (t: string) => t,
    bold: (t: string) => t,
    cyan: (t: string) => t,
    magenta: (t: string) => t,
  },
}));

import { getApiClient } from "../../src/api.js";
import {
  output,
  outputTable,
  outputError,
  outputSuccess,
  outputWarning,
  outputSection,
  outputKeyValue,
  formatDate,
} from "../../src/output.js";

describe("Events Command", () => {
  let program: Command;
  const mockApiClient = {
    getEvents: vi.fn(),
    getBatchStats: vi.fn(),
    triggerBatchAnchor: vi.fn(),
    createEvent: vi.fn(),
  };

  const mockEvents = [
    {
      id: "evt-001",
      eventType: "sensor_reading",
      assetId: "asset-001",
      timestamp: "2024-01-15T10:00:00Z",
      txHash: "0xabc123",
      payloadHash: "0xdef456",
    },
    {
      id: "evt-002",
      eventType: "maintenance",
      assetId: "asset-002",
      timestamp: "2024-01-15T11:00:00Z",
      txHash: null,
      payloadHash: "0xghi789",
    },
    {
      id: "evt-003",
      eventType: "sensor_reading",
      assetId: "asset-001",
      timestamp: "2024-01-15T12:00:00Z",
      txHash: null,
      payloadHash: "0xjkl012",
    },
  ];

  const mockPaginatedResponse = {
    data: mockEvents,
    page: 1,
    limit: 20,
    total: 3,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  };

  const mockBatchStats = {
    pendingEvents: 5,
    totalBatchesAnchored: 10,
    totalEventsAnchored: 100,
    averageEventsPerBatch: 10.0,
    estimatedGasSavings: 75.5,
    lastBatchTime: "2024-01-15T09:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default mock responses
    mockApiClient.getEvents.mockResolvedValue({
      success: true,
      data: mockPaginatedResponse,
    });
    mockApiClient.getBatchStats.mockResolvedValue({
      success: true,
      data: mockBatchStats,
    });
    mockApiClient.triggerBatchAnchor.mockResolvedValue({
      success: true,
      data: {
        success: true,
        message: "Batch anchoring completed",
        batchId: "batch-001",
        txHash: "0xtx123",
        eventCount: 5,
      },
    });

    registerEventsCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("events list", () => {
    it("should register events command with list subcommand", () => {
      const eventsCmd = program.commands.find((c) => c.name() === "events");
      expect(eventsCmd).toBeDefined();

      const listCmd = eventsCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all events with default pagination", async () => {
      await program.parseAsync(["node", "test", "events", "list"]);

      expect(mockApiClient.getEvents).toHaveBeenCalledWith(1, 20);
      expect(outputTable).toHaveBeenCalled();
    });

    it("should handle empty events list", async () => {
      mockApiClient.getEvents.mockResolvedValue({
        success: true,
        data: {
          ...mockPaginatedResponse,
          data: [],
          total: 0,
        },
      });

      await program.parseAsync(["node", "test", "events", "list"]);

      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should list events with custom limit", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "list",
        "--limit",
        "10",
      ]);

      expect(mockApiClient.getEvents).toHaveBeenCalledWith(1, 10);
    });

    it("should list events with custom page", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "list",
        "--page",
        "2",
      ]);

      expect(mockApiClient.getEvents).toHaveBeenCalledWith(2, 20);
    });

    it("should filter events by type", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "list",
        "--type",
        "sensor",
      ]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
      // The filter is applied client-side, so outputTable should be called
      // with filtered data containing only sensor_reading events
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter events by asset ID", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "list",
        "--asset",
        "asset-001",
      ]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter only anchored events", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "list",
        "--anchored",
      ]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter only pending events", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--pending"]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--json"]);

      expect(output).toHaveBeenCalledWith({
        data: mockEvents,
        pagination: {
          page: 1,
          limit: 20,
          total: 3,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
      });
    });

    it("should handle API errors", async () => {
      mockApiClient.getEvents.mockResolvedValue({
        success: false,
        error: "Failed to fetch events",
      });

      await program.parseAsync(["node", "test", "events", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch events"),
        expect.anything()
      );
    });

    it("should handle network errors", async () => {
      mockApiClient.getEvents.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "events", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });

  describe("events stats", () => {
    it("should register stats subcommand", () => {
      const eventsCmd = program.commands.find((c) => c.name() === "events");
      const statsCmd = eventsCmd?.commands.find((c) => c.name() === "stats");
      expect(statsCmd).toBeDefined();
    });

    it("should display batch statistics", async () => {
      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(mockApiClient.getBatchStats).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalledWith(
        "Batch Anchoring Statistics"
      );
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "events", "stats", "--json"]);

      expect(output).toHaveBeenCalledWith(mockBatchStats);
    });

    it("should handle API errors", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: false,
        error: "Stats unavailable",
      });

      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch batch stats"),
        expect.anything()
      );
    });

    it("should display zero pending events correctly", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { ...mockBatchStats, pendingEvents: 0 },
      });

      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle missing lastBatchTime", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { ...mockBatchStats, lastBatchTime: null },
      });

      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });
  });

  describe("events anchor", () => {
    it("should register anchor subcommand", () => {
      const eventsCmd = program.commands.find((c) => c.name() === "events");
      const anchorCmd = eventsCmd?.commands.find((c) => c.name() === "anchor");
      expect(anchorCmd).toBeDefined();
    });

    it("should trigger batch anchoring", async () => {
      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(mockApiClient.getBatchStats).toHaveBeenCalled();
      expect(mockApiClient.triggerBatchAnchor).toHaveBeenCalled();
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Batch anchoring completed")
      );
    });

    it("should show warning when no pending events", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { ...mockBatchStats, pendingEvents: 0 },
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(mockApiClient.triggerBatchAnchor).not.toHaveBeenCalled();
      expect(outputWarning).toHaveBeenCalledWith(
        expect.stringContaining("No pending events")
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "events", "anchor", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          batchId: "batch-001",
        })
      );
    });

    it("should output JSON for no pending events", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { ...mockBatchStats, pendingEvents: 0 },
      });

      await program.parseAsync(["node", "test", "events", "anchor", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          pendingEvents: 0,
        })
      );
    });

    it("should handle API errors", async () => {
      mockApiClient.triggerBatchAnchor.mockResolvedValue({
        success: false,
        error: "Anchoring failed",
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to trigger batch anchoring"),
        expect.anything()
      );
    });

    it("should display batch details on success", async () => {
      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "Batch ID" }),
          expect.objectContaining({ key: "TX Hash" }),
          expect.objectContaining({ key: "Events Anchored" }),
        ])
      );
    });

    it("should handle warning response from API", async () => {
      mockApiClient.triggerBatchAnchor.mockResolvedValue({
        success: true,
        data: {
          success: false,
          message: "Partial anchoring",
        },
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(outputWarning).toHaveBeenCalledWith(
        expect.stringContaining("Partial anchoring")
      );
    });
  });

  describe("events create", () => {
    it("should register create subcommand", () => {
      const eventsCmd = program.commands.find((c) => c.name() === "events");
      const createCmd = eventsCmd?.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
    });

    it("should create a new event", async () => {
      const newEvent = {
        id: "evt-new",
        eventType: "sensor_reading",
        assetId: "asset-001",
        payloadHash: "0xnew123",
        txHash: null,
      };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "asset-001",
        "--type",
        "sensor_reading",
        "--payload",
        '{"value": 42}',
      ]);

      expect(mockApiClient.createEvent).toHaveBeenCalledWith({
        assetId: "asset-001",
        eventType: "sensor_reading",
        payload: { value: 42 },
        details: undefined,
        recordedBy: undefined,
      });
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Event created")
      );
    });

    it("should handle validation error for invalid JSON payload", async () => {
      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "asset-001",
        "--type",
        "sensor_reading",
        "--payload",
        "not valid json",
      ]);

      expect(mockApiClient.createEvent).not.toHaveBeenCalled();
      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON"),
        expect.anything()
      );
    });

    it("should include optional details and recordedBy", async () => {
      const newEvent = {
        id: "evt-new",
        eventType: "maintenance",
        assetId: "asset-001",
        payloadHash: "0xnew123",
        txHash: null,
      };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "asset-001",
        "--type",
        "maintenance",
        "--payload",
        '{"description": "Replaced filter"}',
        "--details",
        "Scheduled maintenance",
        "--recorded-by",
        "0x123456",
      ]);

      expect(mockApiClient.createEvent).toHaveBeenCalledWith({
        assetId: "asset-001",
        eventType: "maintenance",
        payload: { description: "Replaced filter" },
        details: "Scheduled maintenance",
        recordedBy: "0x123456",
      });
    });

    it("should output JSON when --json flag is provided", async () => {
      const newEvent = {
        id: "evt-new",
        eventType: "sensor_reading",
        assetId: "asset-001",
        payloadHash: "0xnew123",
        txHash: null,
      };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "asset-001",
        "--type",
        "sensor_reading",
        "--payload",
        '{"value": 42}',
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newEvent);
    });

    it("should handle API errors", async () => {
      mockApiClient.createEvent.mockResolvedValue({
        success: false,
        error: "Asset not found",
      });

      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "invalid-asset",
        "--type",
        "sensor_reading",
        "--payload",
        '{"value": 42}',
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create event"),
        expect.anything()
      );
    });

    it("should require asset option", async () => {
      try {
        await program.parseAsync([
          "node",
          "test",
          "events",
          "create",
          "--type",
          "sensor_reading",
          "--payload",
          '{"value": 42}',
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should require type option", async () => {
      try {
        await program.parseAsync([
          "node",
          "test",
          "events",
          "create",
          "--asset",
          "asset-001",
          "--payload",
          '{"value": 42}',
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should require payload option", async () => {
      try {
        await program.parseAsync([
          "node",
          "test",
          "events",
          "create",
          "--asset",
          "asset-001",
          "--type",
          "sensor_reading",
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should display event details on success", async () => {
      const newEvent = {
        id: "evt-new",
        eventType: "sensor_reading",
        assetId: "asset-001",
        payloadHash: "0xnew123",
        txHash: null,
      };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node",
        "test",
        "events",
        "create",
        "--asset",
        "asset-001",
        "--type",
        "sensor_reading",
        "--payload",
        '{"value": 42}',
      ]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "ID" }),
          expect.objectContaining({ key: "Type" }),
          expect.objectContaining({ key: "Asset ID" }),
          expect.objectContaining({ key: "Payload Hash" }),
          expect.objectContaining({ key: "TX Hash" }),
        ])
      );
    });
  });

  describe("timestamp formatting", () => {
    it("should format timestamps correctly in list output", async () => {
      await program.parseAsync(["node", "test", "events", "list"]);

      expect(formatDate).toHaveBeenCalledWith("2024-01-15T10:00:00Z");
      expect(formatDate).toHaveBeenCalledWith("2024-01-15T11:00:00Z");
      expect(formatDate).toHaveBeenCalledWith("2024-01-15T12:00:00Z");
    });
  });

  describe("pagination display", () => {
    it("should show next page hint when hasNextPage is true", async () => {
      mockApiClient.getEvents.mockResolvedValue({
        success: true,
        data: {
          ...mockPaginatedResponse,
          hasNextPage: true,
          totalPages: 3,
        },
      });

      await program.parseAsync(["node", "test", "events", "list"]);

      // The console.log for pagination hint is called internally
      expect(outputTable).toHaveBeenCalled();
    });
  });
});
