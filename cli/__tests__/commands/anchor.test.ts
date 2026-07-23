import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAnchorCommand } from "../../src/commands/anchor.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    createAnchor: vi.fn(),
    batchAnchor: vi.fn(),
    verifyAnchor: vi.fn(),
    getAnchorProof: vi.fn(),
    getAnchorStatus: vi.fn(),
    getTreeInfo: vi.fn(),
    getTreeRoot: vi.fn(),
    getPendingAnchors: vi.fn(),
    getBatchHistory: vi.fn(),
    auditAnchors: vi.fn(),
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
  outputInfo: vi.fn(),
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
} from "../../src/output.js";

describe("Anchor Command", () => {
  let program: Command;
  const mockApiClient = {
    createAnchor: vi.fn(),
    batchAnchor: vi.fn(),
    verifyAnchor: vi.fn(),
    getAnchorProof: vi.fn(),
    getAnchorStatus: vi.fn(),
    getTreeInfo: vi.fn(),
    getTreeRoot: vi.fn(),
    getPendingAnchors: vi.fn(),
    getBatchHistory: vi.fn(),
    auditAnchors: vi.fn(),
  };

  const mockAnchorStatus = {
    anchorId: "anchor-001",
    status: "ANCHORED",
    dataHash: "0xabc123def456",
    batchId: "batch-001",
    merkleRoot: "0xroot123",
    txHash: "0xtx789",
    blockNumber: 12345,
    createdAt: "2024-01-15T10:00:00Z",
    anchoredAt: "2024-01-15T10:05:00Z",
  };

  const mockProof = {
    anchorId: "anchor-001",
    dataHash: "0xabc123def456",
    merkleRoot: "0xroot123",
    leafIndex: 3,
    proof: ["0xsibling1", "0xsibling2", "0xsibling3"],
  };

  const mockTreeInfo = {
    root: "0xroot123",
    leafCount: 15,
    height: 4,
    lastUpdated: "2024-01-15T10:05:00Z",
  };

  const mockBatchHistory = [
    {
      batchId: "batch-001",
      eventCount: 10,
      merkleRoot: "0xroot123",
      txHash: "0xtx789",
      anchoredAt: "2024-01-15T10:05:00Z",
    },
    {
      batchId: "batch-002",
      eventCount: 8,
      merkleRoot: "0xroot456",
      txHash: "0xtx012",
      anchoredAt: "2024-01-15T11:05:00Z",
    },
  ];

  const mockAuditReport = {
    totalAnchors: 100,
    anchoredCount: 95,
    pendingCount: 3,
    failedCount: 2,
    batchCount: 10,
    avgEventsPerBatch: 10.0,
    issues: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default mock responses
    mockApiClient.createAnchor.mockResolvedValue({
      success: true,
      data: {
        anchorId: "anchor-new",
        dataHash: "0xnew123",
        status: "PENDING",
        batchId: null,
      },
    });

    mockApiClient.verifyAnchor.mockResolvedValue({
      success: true,
      data: {
        anchorId: "anchor-001",
        valid: true,
        dataHash: "0xabc123def456",
        merkleRoot: "0xroot123",
        blockNumber: 12345,
        txHash: "0xtx789",
      },
    });

    mockApiClient.getAnchorProof.mockResolvedValue({
      success: true,
      data: mockProof,
    });

    mockApiClient.getAnchorStatus.mockResolvedValue({
      success: true,
      data: mockAnchorStatus,
    });

    mockApiClient.getTreeInfo.mockResolvedValue({
      success: true,
      data: mockTreeInfo,
    });

    mockApiClient.getTreeRoot.mockResolvedValue({
      success: true,
      data: { root: "0xroot123" },
    });

    mockApiClient.getPendingAnchors.mockResolvedValue({
      success: true,
      data: {
        count: 3,
        events: [
          { id: "evt-1", eventType: "sensor", assetId: "asset-1", receivedAt: "2024-01-15T10:00:00Z" },
          { id: "evt-2", eventType: "maintenance", assetId: "asset-2", receivedAt: "2024-01-15T10:01:00Z" },
          { id: "evt-3", eventType: "sensor", assetId: "asset-1", receivedAt: "2024-01-15T10:02:00Z" },
        ],
      },
    });

    mockApiClient.getBatchHistory.mockResolvedValue({
      success: true,
      data: mockBatchHistory,
    });

    mockApiClient.auditAnchors.mockResolvedValue({
      success: true,
      data: mockAuditReport,
    });

    registerAnchorCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("anchor create", () => {
    it("should register anchor command with create subcommand", () => {
      const anchorCmd = program.commands.find((c) => c.name() === "anchor");
      expect(anchorCmd).toBeDefined();

      const createCmd = anchorCmd?.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
    });

    it("should create a new anchor with data hash", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
      ]);

      expect(mockApiClient.createAnchor).toHaveBeenCalledWith({
        dataHash: "0xabc123",
        metadata: undefined,
      });
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Anchor created")
      );
    });

    it("should create anchor with metadata", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
        "--metadata",
        '{"type":"sensor","location":"A1"}',
      ]);

      expect(mockApiClient.createAnchor).toHaveBeenCalledWith({
        dataHash: "0xabc123",
        metadata: { type: "sensor", location: "A1" },
      });
    });

    it("should handle invalid JSON metadata", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
        "--metadata",
        "invalid json",
      ]);

      expect(mockApiClient.createAnchor).not.toHaveBeenCalled();
      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorId: "anchor-new",
          dataHash: "0xnew123",
        })
      );
    });

    it("should handle API errors", async () => {
      mockApiClient.createAnchor.mockResolvedValue({
        success: false,
        error: "Failed to create anchor",
      });

      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create anchor"),
        expect.anything()
      );
    });
  });

  describe("anchor verify", () => {
    it("should verify an anchor", async () => {
      await program.parseAsync(["node", "test", "anchor", "verify", "anchor-001"]);

      expect(mockApiClient.verifyAnchor).toHaveBeenCalledWith("anchor-001");
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("valid")
      );
    });

    it("should show warning for invalid anchor", async () => {
      mockApiClient.verifyAnchor.mockResolvedValue({
        success: true,
        data: {
          anchorId: "anchor-001",
          valid: false,
          dataHash: "0xabc123",
        },
      });

      await program.parseAsync(["node", "test", "anchor", "verify", "anchor-001"]);

      expect(outputWarning).toHaveBeenCalledWith(
        expect.stringContaining("verification failed")
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "verify",
        "anchor-001",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorId: "anchor-001",
          valid: true,
        })
      );
    });

    it("should handle API errors", async () => {
      mockApiClient.verifyAnchor.mockResolvedValue({
        success: false,
        error: "Anchor not found",
      });

      await program.parseAsync(["node", "test", "anchor", "verify", "invalid-id"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to verify"),
        expect.anything()
      );
    });
  });

  describe("anchor proof", () => {
    it("should get Merkle proof for an anchor", async () => {
      await program.parseAsync(["node", "test", "anchor", "proof", "anchor-001"]);

      expect(mockApiClient.getAnchorProof).toHaveBeenCalledWith("anchor-001");
      expect(outputSection).toHaveBeenCalledWith("Merkle Proof");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "proof",
        "anchor-001",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(mockProof);
    });

    it("should handle API errors", async () => {
      mockApiClient.getAnchorProof.mockResolvedValue({
        success: false,
        error: "Proof not available",
      });

      await program.parseAsync(["node", "test", "anchor", "proof", "anchor-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to get proof"),
        expect.anything()
      );
    });
  });

  describe("anchor status", () => {
    it("should get anchor status", async () => {
      await program.parseAsync(["node", "test", "anchor", "status", "anchor-001"]);

      expect(mockApiClient.getAnchorStatus).toHaveBeenCalledWith("anchor-001");
      expect(outputSection).toHaveBeenCalledWith("Anchor Status");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "status",
        "anchor-001",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(mockAnchorStatus);
    });

    it("should handle not found errors", async () => {
      mockApiClient.getAnchorStatus.mockResolvedValue({
        success: false,
        error: "Anchor not found",
      });

      await program.parseAsync(["node", "test", "anchor", "status", "invalid-id"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Anchor not found"),
        expect.anything()
      );
    });
  });

  describe("anchor tree show", () => {
    it("should show tree structure", async () => {
      await program.parseAsync(["node", "test", "anchor", "tree", "show"]);

      expect(mockApiClient.getTreeInfo).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalledWith("Merkle Tree");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "tree",
        "show",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(mockTreeInfo);
    });

    it("should handle API errors", async () => {
      mockApiClient.getTreeInfo.mockResolvedValue({
        success: false,
        error: "Failed to fetch tree info",
      });

      await program.parseAsync(["node", "test", "anchor", "tree", "show"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch tree info"),
        expect.anything()
      );
    });
  });

  describe("anchor tree root", () => {
    it("should show current Merkle root", async () => {
      await program.parseAsync(["node", "test", "anchor", "tree", "root"]);

      expect(mockApiClient.getTreeRoot).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "tree",
        "root",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith({ root: "0xroot123" });
    });

    it("should handle empty tree", async () => {
      mockApiClient.getTreeRoot.mockResolvedValue({
        success: true,
        data: { root: null },
      });

      await program.parseAsync(["node", "test", "anchor", "tree", "root"]);

      // Should complete without error
      expect(mockApiClient.getTreeRoot).toHaveBeenCalled();
    });
  });

  describe("anchor tree pending", () => {
    it("should show pending events", async () => {
      await program.parseAsync(["node", "test", "anchor", "tree", "pending"]);

      expect(mockApiClient.getPendingAnchors).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalledWith(
        expect.stringContaining("Pending Events")
      );
      expect(outputTable).toHaveBeenCalled();
    });

    it("should handle no pending events", async () => {
      mockApiClient.getPendingAnchors.mockResolvedValue({
        success: true,
        data: { count: 0, events: [] },
      });

      await program.parseAsync(["node", "test", "anchor", "tree", "pending"]);

      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "tree",
        "pending",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ count: 3 })
      );
    });
  });

  describe("anchor tree history", () => {
    it("should show batch history", async () => {
      await program.parseAsync(["node", "test", "anchor", "tree", "history"]);

      expect(mockApiClient.getBatchHistory).toHaveBeenCalledWith(20);
      expect(outputSection).toHaveBeenCalledWith("Batch History");
      expect(outputTable).toHaveBeenCalled();
    });

    it("should respect --limit option", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "tree",
        "history",
        "--limit",
        "10",
      ]);

      expect(mockApiClient.getBatchHistory).toHaveBeenCalledWith(10);
    });

    it("should handle empty history", async () => {
      mockApiClient.getBatchHistory.mockResolvedValue({
        success: true,
        data: [],
      });

      await program.parseAsync(["node", "test", "anchor", "tree", "history"]);

      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "tree",
        "history",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(mockBatchHistory);
    });
  });

  describe("anchor export", () => {
    it("should export anchor data", async () => {
      await program.parseAsync(["node", "test", "anchor", "export", "anchor-001"]);

      expect(mockApiClient.getAnchorStatus).toHaveBeenCalledWith("anchor-001");
      expect(mockApiClient.getAnchorProof).toHaveBeenCalledWith("anchor-001");
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "export",
        "anchor-001",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          anchor: mockAnchorStatus,
          proof: mockProof,
        })
      );
    });

    it("should handle not found errors", async () => {
      mockApiClient.getAnchorStatus.mockResolvedValue({
        success: false,
        error: "Anchor not found",
      });

      await program.parseAsync(["node", "test", "anchor", "export", "invalid-id"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch anchor"),
        expect.anything()
      );
    });
  });

  describe("anchor audit", () => {
    it("should run audit without date range", async () => {
      await program.parseAsync(["node", "test", "anchor", "audit"]);

      expect(mockApiClient.auditAnchors).toHaveBeenCalledWith({
        from: undefined,
        to: undefined,
      });
      expect(outputSection).toHaveBeenCalledWith("Anchor Audit Report");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should run audit with date range", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "audit",
        "--from",
        "2024-01-01",
        "--to",
        "2024-01-31",
      ]);

      expect(mockApiClient.auditAnchors).toHaveBeenCalledWith({
        from: expect.any(String),
        to: expect.any(String),
      });
    });

    it("should handle invalid date format", async () => {
      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "audit",
        "--from",
        "invalid-date",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid from date"),
        expect.anything()
      );
    });

    it("should show issues when found", async () => {
      mockApiClient.auditAnchors.mockResolvedValue({
        success: true,
        data: {
          ...mockAuditReport,
          issues: ["Missing proof for anchor-005", "TX not confirmed for batch-003"],
        },
      });

      await program.parseAsync(["node", "test", "anchor", "audit"]);

      expect(outputSection).toHaveBeenCalledWith("Issues Found");
    });

    it("should show success message when no issues", async () => {
      await program.parseAsync(["node", "test", "anchor", "audit"]);

      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("No issues found")
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "anchor", "audit", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAuditReport);
    });

    it("should handle API errors", async () => {
      mockApiClient.auditAnchors.mockResolvedValue({
        success: false,
        error: "Audit failed",
      });

      await program.parseAsync(["node", "test", "anchor", "audit"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to run audit"),
        expect.anything()
      );
    });
  });

  describe("network errors", () => {
    it("should handle network errors on create", async () => {
      mockApiClient.createAnchor.mockRejectedValue(new Error("Network error"));

      await program.parseAsync([
        "node",
        "test",
        "anchor",
        "create",
        "--data",
        "0xabc123",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors on verify", async () => {
      mockApiClient.verifyAnchor.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "anchor", "verify", "anchor-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors on proof", async () => {
      mockApiClient.getAnchorProof.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "anchor", "proof", "anchor-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors on status", async () => {
      mockApiClient.getAnchorStatus.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "anchor", "status", "anchor-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors on tree show", async () => {
      mockApiClient.getTreeInfo.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "anchor", "tree", "show"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors on audit", async () => {
      mockApiClient.auditAnchors.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "anchor", "audit"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });
});
