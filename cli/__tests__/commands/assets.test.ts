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
  formatBoolean: vi.fn((b) => (b ? "Yes" : "No")),
  isStructuredOutput: vi.fn(() => false),
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
  outputSection,
  outputKeyValue,
} from "../../src/output.js";

describe("Assets Command", () => {
  let program: Command;
  const mockApiClient = {
    getAssets: vi.fn(),
    getAssetById: vi.fn(),
    getAssetsBySite: vi.fn(),
    createAsset: vi.fn(),
  };

  const mockAssets = [
    {
      id: "asset-1",
      nameOrTag: "PLC-001",
      assetType: "PLC",
      siteId: "site-1",
      critical: true,
      createdAt: "2024-01-01",
    },
    {
      id: "asset-2",
      nameOrTag: "HMI-001",
      assetType: "HMI",
      siteId: "site-1",
      critical: false,
      createdAt: "2024-01-02",
    },
    {
      id: "asset-3",
      nameOrTag: "Sensor-001",
      assetType: "Sensor",
      siteId: "site-2",
      critical: true,
      createdAt: "2024-01-03",
    },
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

    it("should handle empty assets list", async () => {
      mockApiClient.getAssets.mockResolvedValue({
        success: true,
        data: [],
      });

      await program.parseAsync(["node", "test", "assets", "list"]);

      // Should not output table for empty list
      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should filter assets by site when --site flag is provided", async () => {
      mockApiClient.getAssetsBySite.mockResolvedValue({
        success: true,
        data: mockAssets.filter((a) => a.siteId === "site-1"),
      });

      await program.parseAsync(["node", "test", "assets", "list", "--site", "site-1"]);

      expect(mockApiClient.getAssetsBySite).toHaveBeenCalledWith("site-1");
      expect(mockApiClient.getAssets).not.toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter assets by type when --type flag is provided", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--type", "PLC"]);

      expect(mockApiClient.getAssets).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
      // Verify the table was called with filtered data
      const tableCall = vi.mocked(outputTable).mock.calls[0];
      expect(tableCall[1]).toHaveLength(1);
      expect(tableCall[1][0][2]).toBe("PLC"); // Check asset type column
    });

    it("should filter to show only critical assets when --critical flag is provided", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--critical"]);

      expect(mockApiClient.getAssets).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
      // Verify only critical assets are shown
      const tableCall = vi.mocked(outputTable).mock.calls[0];
      expect(tableCall[1]).toHaveLength(2); // asset-1 and asset-3 are critical
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAssets);
      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should handle API errors gracefully", async () => {
      mockApiClient.getAssets.mockResolvedValue({
        success: false,
        error: "Failed to fetch assets",
      });

      await program.parseAsync(["node", "test", "assets", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch assets"),
        expect.anything()
      );
    });

    it("should handle network errors gracefully", async () => {
      mockApiClient.getAssets.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "assets", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect to server"),
        expect.stringContaining("Network error")
      );
    });
  });

  describe("assets get", () => {
    it("should register assets get subcommand", () => {
      const assetsCmd = program.commands.find((c) => c.name() === "assets");
      const getCmd = assetsCmd?.commands.find((c) => c.name() === "get");
      expect(getCmd).toBeDefined();
    });

    it("should get asset by ID when asset exists", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0],
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-1"]);

      expect(mockApiClient.getAssetById).toHaveBeenCalledWith("asset-1");
      expect(outputSection).toHaveBeenCalledWith("Asset Details");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle non-existent asset", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: false,
        error: "Asset not found",
      });

      await program.parseAsync(["node", "test", "assets", "get", "non-existent"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Asset not found"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0],
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-1", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAssets[0]);
      expect(outputSection).not.toHaveBeenCalled();
      expect(outputKeyValue).not.toHaveBeenCalled();
    });

    it("should display critical status correctly", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0], // critical: true
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-1"]);

      const keyValueCall = vi.mocked(outputKeyValue).mock.calls[0][0];
      const criticalEntry = keyValueCall.find((kv: any) => kv.key === "Critical");
      expect(criticalEntry).toBeDefined();
      expect(criticalEntry.value).toBe("Yes");
    });

    it("should handle network errors gracefully", async () => {
      mockApiClient.getAssetById.mockRejectedValue(new Error("Connection refused"));

      await program.parseAsync(["node", "test", "assets", "get", "asset-1"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect to server"),
        expect.stringContaining("Connection refused")
      );
    });
  });

  describe("assets create", () => {
    it("should register assets create subcommand", () => {
      const assetsCmd = program.commands.find((c) => c.name() === "assets");
      const createCmd = assetsCmd?.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
    });

    it("should create a new asset successfully", async () => {
      const newAsset = {
        id: "asset-new",
        nameOrTag: "New-PLC",
        assetType: "PLC",
        siteId: "site-1",
        critical: false,
        createdAt: "2024-01-15",
      };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "New-PLC",
        "--type",
        "PLC",
      ]);

      expect(mockApiClient.createAsset).toHaveBeenCalledWith({
        siteId: "site-1",
        nameOrTag: "New-PLC",
        assetType: "PLC",
        critical: false,
      });
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("Asset created"));
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should create a critical asset when --critical flag is provided", async () => {
      const newAsset = {
        id: "asset-critical",
        nameOrTag: "Critical-Sensor",
        assetType: "Sensor",
        siteId: "site-2",
        critical: true,
        createdAt: "2024-01-15",
      };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-2",
        "--name",
        "Critical-Sensor",
        "--type",
        "Sensor",
        "--critical",
      ]);

      expect(mockApiClient.createAsset).toHaveBeenCalledWith({
        siteId: "site-2",
        nameOrTag: "Critical-Sensor",
        assetType: "Sensor",
        critical: true,
      });
    });

    it("should require all required options", async () => {
      // Missing --site should throw
      try {
        await program.parseAsync([
          "node",
          "test",
          "assets",
          "create",
          "--name",
          "Test",
          "--type",
          "PLC",
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should require --name option", async () => {
      try {
        await program.parseAsync([
          "node",
          "test",
          "assets",
          "create",
          "--site",
          "site-1",
          "--type",
          "PLC",
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should require --type option", async () => {
      try {
        await program.parseAsync([
          "node",
          "test",
          "assets",
          "create",
          "--site",
          "site-1",
          "--name",
          "Test",
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should handle validation errors from API", async () => {
      mockApiClient.createAsset.mockResolvedValue({
        success: false,
        error: "Invalid asset type",
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "Test",
        "--type",
        "InvalidType",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create asset"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const newAsset = {
        id: "asset-new",
        nameOrTag: "New-PLC",
        assetType: "PLC",
        siteId: "site-1",
        critical: false,
        createdAt: "2024-01-15",
      };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "New-PLC",
        "--type",
        "PLC",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newAsset);
      expect(outputSuccess).not.toHaveBeenCalled();
    });

    it("should handle network errors gracefully", async () => {
      mockApiClient.createAsset.mockRejectedValue(new Error("Server unavailable"));

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "Test",
        "--type",
        "PLC",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect to server"),
        expect.stringContaining("Server unavailable")
      );
    });
  });

  describe("critical asset flag handling", () => {
    it("should correctly identify critical assets in list", async () => {
      await program.parseAsync(["node", "test", "assets", "list"]);

      const tableCall = vi.mocked(outputTable).mock.calls[0];
      const rows = tableCall[1];
      
      // asset-1 is critical (index 0)
      expect(rows[0][4]).toBe("Yes");
      // asset-2 is not critical (index 1)
      expect(rows[1][4]).toBe("No");
      // asset-3 is critical (index 2)
      expect(rows[2][4]).toBe("Yes");
    });

    it("should correctly display critical status in get command", async () => {
      // Test with critical asset
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0], // critical: true
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-1"]);

      let keyValueCall = vi.mocked(outputKeyValue).mock.calls[0][0];
      let criticalEntry = keyValueCall.find((kv: any) => kv.key === "Critical");
      expect(criticalEntry.value).toBe("Yes");

      vi.clearAllMocks();

      // Test with non-critical asset
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[1], // critical: false
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-2"]);

      keyValueCall = vi.mocked(outputKeyValue).mock.calls[0][0];
      criticalEntry = keyValueCall.find((kv: any) => kv.key === "Critical");
      expect(criticalEntry.value).toBe("No");
    });

    it("should default critical to false when creating asset without --critical flag", async () => {
      const newAsset = {
        id: "asset-new",
        nameOrTag: "Non-Critical",
        assetType: "PLC",
        siteId: "site-1",
        critical: false,
        createdAt: "2024-01-15",
      };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "Non-Critical",
        "--type",
        "PLC",
      ]);

      expect(mockApiClient.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({ critical: false })
      );
    });
  });

  describe("JSON output mode", () => {
    it("should output raw JSON array for list command", async () => {
      await program.parseAsync(["node", "test", "assets", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAssets);
      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should output raw JSON object for get command", async () => {
      mockApiClient.getAssetById.mockResolvedValue({
        success: true,
        data: mockAssets[0],
      });

      await program.parseAsync(["node", "test", "assets", "get", "asset-1", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAssets[0]);
      expect(outputSection).not.toHaveBeenCalled();
    });

    it("should output raw JSON object for create command", async () => {
      const newAsset = {
        id: "asset-new",
        nameOrTag: "New-Asset",
        assetType: "HMI",
        siteId: "site-1",
        critical: false,
        createdAt: "2024-01-15",
      };
      mockApiClient.createAsset.mockResolvedValue({
        success: true,
        data: newAsset,
      });

      await program.parseAsync([
        "node",
        "test",
        "assets",
        "create",
        "--site",
        "site-1",
        "--name",
        "New-Asset",
        "--type",
        "HMI",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newAsset);
      expect(outputSuccess).not.toHaveBeenCalled();
    });

    it("should still output errors even in JSON mode when API fails", async () => {
      mockApiClient.getAssets.mockResolvedValue({
        success: false,
        error: "API Error",
      });

      await program.parseAsync(["node", "test", "assets", "list", "--json"]);

      expect(outputError).toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    });
  });
});
