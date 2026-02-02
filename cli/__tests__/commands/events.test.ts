import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerEventsCommand } from "../../src/commands/events.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getEvents: vi.fn(),
    createEvent: vi.fn(),
    getBatchStats: vi.fn(),
    triggerBatchAnchor: vi.fn(),
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
  formatDate: vi.fn((d) => d),
  truncate: vi.fn((s) => s),
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
import { output, outputTable, outputError, outputSuccess, outputWarning, outputSection, outputKeyValue } from "../../src/output.js";

describe("Events Command", () => {
  let program: Command;
  const mockApiClient = {
    getEvents: vi.fn(),
    createEvent: vi.fn(),
    getBatchStats: vi.fn(),
    triggerBatchAnchor: vi.fn(),
  };

  const mockEvents = {
    data: [
      { id: "e1", assetId: "a1", eventType: "config_change", payloadHash: "0xabc", timestamp: "2024-01-01", recordedBy: "0x123", txHash: "0xdef", details: "" },
      { id: "e2", assetId: "a1", eventType: "alarm", payloadHash: "0x123", timestamp: "2024-01-02", recordedBy: "0x123", txHash: null, details: "" },
    ],
    total: 2,
    page: 1,
    limit: 20,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    mockApiClient.getEvents.mockResolvedValue({
      success: true,
      data: mockEvents,
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

    it("should list events with pagination", async () => {
      await program.parseAsync(["node", "test", "events", "list"]);

      expect(mockApiClient.getEvents).toHaveBeenCalledWith(1, 20);
      expect(outputTable).toHaveBeenCalled();
    });

    it("should accept custom page and limit", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--page", "2", "--limit", "50"]);

      expect(mockApiClient.getEvents).toHaveBeenCalledWith(2, 50);
    });

    it("should filter by event type", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--type", "alarm"]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
    });

    it("should filter by asset ID", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--asset", "a1"]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
    });

    it("should filter anchored events", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--anchored"]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
    });

    it("should filter pending events", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--pending"]);

      expect(mockApiClient.getEvents).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "events", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.any(Array),
          pagination: expect.any(Object),
        })
      );
    });

    it("should handle API errors", async () => {
      mockApiClient.getEvents.mockResolvedValue({
        success: false,
        error: "Failed to fetch",
      });

      await program.parseAsync(["node", "test", "events", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch events"),
        expect.anything()
      );
    });
  });

  describe("events anchor", () => {
    it("should trigger batch anchoring", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { pendingEvents: 10 },
      });
      mockApiClient.triggerBatchAnchor.mockResolvedValue({
        success: true,
        data: { success: true, message: "Batch anchored", batchId: "b1", txHash: "0xabc", eventCount: 10 },
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(mockApiClient.triggerBatchAnchor).toHaveBeenCalled();
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should warn when no pending events", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { pendingEvents: 0 },
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(outputWarning).toHaveBeenCalledWith(expect.stringContaining("No pending events"));
      expect(mockApiClient.triggerBatchAnchor).not.toHaveBeenCalled();
    });

    it("should handle anchor errors", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { pendingEvents: 5 },
      });
      mockApiClient.triggerBatchAnchor.mockResolvedValue({
        success: false,
        error: "Blockchain unavailable",
      });

      await program.parseAsync(["node", "test", "events", "anchor"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to trigger batch anchoring"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: { pendingEvents: 10 },
      });
      mockApiClient.triggerBatchAnchor.mockResolvedValue({
        success: true,
        data: { success: true, message: "Batch anchored" },
      });

      await program.parseAsync(["node", "test", "events", "anchor", "--json"]);

      expect(output).toHaveBeenCalled();
    });
  });

  describe("events stats", () => {
    it("should show batch statistics", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: {
          pendingEvents: 10,
          totalBatchesAnchored: 5,
          totalEventsAnchored: 100,
          lastBatchTime: "2024-01-01T00:00:00Z",
          averageEventsPerBatch: 20,
          estimatedGasSavings: 85.5,
        },
      });

      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(mockApiClient.getBatchStats).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle stats errors", async () => {
      mockApiClient.getBatchStats.mockResolvedValue({
        success: false,
        error: "Not available",
      });

      await program.parseAsync(["node", "test", "events", "stats"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch batch stats"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const stats = {
        pendingEvents: 10,
        totalBatchesAnchored: 5,
        totalEventsAnchored: 100,
        lastBatchTime: "2024-01-01T00:00:00Z",
        averageEventsPerBatch: 20,
        estimatedGasSavings: 85.5,
      };
      mockApiClient.getBatchStats.mockResolvedValue({
        success: true,
        data: stats,
      });

      await program.parseAsync(["node", "test", "events", "stats", "--json"]);

      expect(output).toHaveBeenCalledWith(stats);
    });
  });

  describe("events create", () => {
    it("should create a new event", async () => {
      const newEvent = { id: "e3", assetId: "a1", eventType: "alarm", payloadHash: "0x456", timestamp: "2024-01-03", recordedBy: "0x123", txHash: null, details: "" };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node", "test", "events", "create",
        "--asset", "a1",
        "--type", "alarm",
        "--payload", '{"value": 100}',
      ]);

      expect(mockApiClient.createEvent).toHaveBeenCalledWith({
        assetId: "a1",
        eventType: "alarm",
        payload: { value: 100 },
        details: undefined,
        recordedBy: undefined,
      });
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("Event created"));
    });

    it("should handle invalid JSON payload", async () => {
      await program.parseAsync([
        "node", "test", "events", "create",
        "--asset", "a1",
        "--type", "alarm",
        "--payload", "{ invalid json }",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON payload"),
        expect.anything()
      );
      expect(mockApiClient.createEvent).not.toHaveBeenCalled();
    });

    it("should accept optional details and recordedBy", async () => {
      const newEvent = { id: "e3", assetId: "a1", eventType: "alarm", payloadHash: "0x456", timestamp: "2024-01-03", recordedBy: "0x789", txHash: null, details: "Test details" };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node", "test", "events", "create",
        "--asset", "a1",
        "--type", "alarm",
        "--payload", '{"value": 100}',
        "--details", "Test details",
        "--recorded-by", "0x789",
      ]);

      expect(mockApiClient.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: "Test details",
          recordedBy: "0x789",
        })
      );
    });

    it("should handle creation errors", async () => {
      mockApiClient.createEvent.mockResolvedValue({
        success: false,
        error: "Validation failed",
      });

      await program.parseAsync([
        "node", "test", "events", "create",
        "--asset", "a1",
        "--type", "alarm",
        "--payload", '{"value": 100}',
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create event"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const newEvent = { id: "e3", assetId: "a1", eventType: "alarm", payloadHash: "0x456", timestamp: "2024-01-03", recordedBy: "0x123", txHash: null, details: "" };
      mockApiClient.createEvent.mockResolvedValue({
        success: true,
        data: newEvent,
      });

      await program.parseAsync([
        "node", "test", "events", "create",
        "--asset", "a1",
        "--type", "alarm",
        "--payload", '{"value": 100}',
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newEvent);
    });
  });
});
