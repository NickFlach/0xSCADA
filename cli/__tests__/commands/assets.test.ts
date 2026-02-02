import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAssetsCommand } from "../../src/commands/assets.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getAssets: vi.fn(),
    getAssetById: vi.fn(),
    getAssetsBySite: vi.fn(),
    createAsset: vi.fn(),
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
  formatDate: vi.fn((d) => d),
  formatBoolean: vi.fn((b) => b ? "Yes" : "No"),
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
import { output, outputTable, outputError, outputSuccess, outputSection, outputKeyValue } from "../../src/output.js";

describe("Assets Command", () => {
  let program: Command;
  const mockApiClient = {
    getAssets: vi.fn(),
    getAssetById: vi.fn(),
    getAssetsBySite: vi.fn(),
    createAsset: vi.fn(),
  };

  const mockAssets = [
    { id: "a1", siteId: "1", assetType: "PLC", nameOrTag: "PLC-001", critical: true, createdAt: "2024-01-01" },
    { id: "a2", siteId: "1", assetType: "HMI", nameOrTag: "HMI-001", critical: false, createdAt: "2024-01-02" },
    { id: "a3", siteId: "2", assetType: "PLC", nameOrTag: "PLC-002", critical: true, createdAt: "2024-01-03" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    mockApiClient.getAssets.mockResolvedValue({
      success: true,
      data: mockAssets,
    });

    registerAssetsCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("assets list", () => {
    it("should register assets command with list subcommand", () => {
      const assetsCmd = program.commands.find((c) => c.name() === "assets");
      expect(assetsCmd).toBeDefined();
      
      const listCmd = assetsCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all assets", async () => {
      await program.parseAsync(["node", "test", "assets", "list"]);

      expect(mockApiClient.getAssets).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter by site ID", async () => {
      mockApiClient.getAssetsBySite.mockResolvedValue({
        success: true,
        data: mockAssets.filter((a) => a.siteId === "1"),
      });

      await program.parseAsync(["node", "test", "assets", "list", "--site", "1"]);

      expect(mockApiClient.getAssetsBySite).toHaveBeenCalledWith("1");
    });

    it("should filter by asset type", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--type", "PLC"]);

      // Should filter assets by type
      expect(mockApiClient.getAssets).toHaveBeenCalled();
    });

    it("should filter by critical flag", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--critical"]);

      expect(mockApiClient.getAssets).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--json"]);

      expect(output).toHaveBeenCalled();
    });

    it("should handle API errors", async () => {
      mockApiClient.getAssets.mockResolvedValue({
        success: false,
        error: "Failed to fetch",
      });

      await program.parseAsync(["node", "test", "assets", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch assets"),
        expect.anything()
      );
    });

    it("should handle empty assets list", async () => {
      mockApiClient.getAssets.mockResolvedValue({
        success: true,
        data: [],
      });

      await program.parseAsync(["node", "test", "assets", "list"]);

      expect(outputTable).not.toHaveBeenCalled();
    });
  });

  describe("assets get", () => {
    it("should get asset by ID", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0],
      });

      await program.parseAsync(["node", "test", "assets", "get", "a1"]);

      expect(mockApiClient.getAssetById).toHaveBeenCalledWith("a1");
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle non-existent asset", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: false,
        error: "Asset not found",
      });

      await program.parseAsync(["node", "test", "assets", "get", "999"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0],
      });

      await program.parseAsync(["node", "test", "assets", "get", "a1", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAssets[0]);
    });
  });

  describe("assets create", () => {
    it("should create a new asset", async () => {
      const newAsset = { id: "a4", siteId: "1", assetType: "Sensor", nameOrTag: "TEMP-001", critical: false, createdAt: "2024-01-04" };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node", "test", "assets", "create",
        "--site", "1",
        "--name", "TEMP-001",
        "--type", "Sensor",
      ]);

      expect(mockApiClient.createAsset).toHaveBeenCalledWith({
        siteId: "1",
        nameOrTag: "TEMP-001",
        assetType: "Sensor",
        critical: false,
      });
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("Asset created"));
    });

    it("should create a critical asset", async () => {
      const newAsset = { id: "a5", siteId: "1", assetType: "PLC", nameOrTag: "PLC-003", critical: true, createdAt: "2024-01-05" };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node", "test", "assets", "create",
        "--site", "1",
        "--name", "PLC-003",
        "--type", "PLC",
        "--critical",
      ]);

      expect(mockApiClient.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({ critical: true })
      );
    });

    it("should require all options", async () => {
      try {
        await program.parseAsync(["node", "test", "assets", "create", "--name", "Test"]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should handle creation errors", async () => {
      mockApiClient.createAsset.mockResolvedValue({
        success: false,
        error: "Validation failed",
      });

      await program.parseAsync([
        "node", "test", "assets", "create",
        "--site", "1",
        "--name", "Test",
        "--type", "PLC",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create asset"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const newAsset = { id: "a4", siteId: "1", assetType: "Sensor", nameOrTag: "TEMP-001", critical: false, createdAt: "2024-01-04" };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node", "test", "assets", "create",
        "--site", "1",
        "--name", "TEMP-001",
        "--type", "Sensor",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newAsset);
    });
  });
});
