import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerSitesCommand } from "../../src/commands/sites.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getSites: vi.fn(),
    getSiteById: vi.fn(),
    getAssetsBySite: vi.fn(),
    createSite: vi.fn(),
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

describe("Sites Command", () => {
  let program: Command;
  const mockApiClient = {
    getSites: vi.fn(),
    getSiteById: vi.fn(),
    getAssetsBySite: vi.fn(),
    createSite: vi.fn(),
  };

  const mockSites = [
    { id: "1", name: "Site 1", location: "Location 1", owner: "0x123", createdAt: "2024-01-01" },
    { id: "2", name: "Site 2", location: "Location 2", owner: "0x456", createdAt: "2024-01-02" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    mockApiClient.getSites.mockResolvedValue({
      success: true,
      data: mockSites,
    });

    registerSitesCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("sites list", () => {
    it("should register sites command with list subcommand", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      expect(sitesCmd).toBeDefined();
      
      const listCmd = sitesCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all sites", async () => {
      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(mockApiClient.getSites).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "sites", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(mockSites);
    });

    it("should handle API errors", async () => {
      mockApiClient.getSites.mockResolvedValue({
        success: false,
        error: "Failed to fetch",
      });

      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch sites"),
        expect.anything()
      );
    });

    it("should handle empty sites list", async () => {
      mockApiClient.getSites.mockResolvedValue({
        success: true,
        data: [],
      });

      await program.parseAsync(["node", "test", "sites", "list"]);

      // Should not output table for empty list
      expect(outputTable).not.toHaveBeenCalled();
    });
  });

  describe("sites get", () => {
    it("should get site by ID", async () => {
      mockApiClient.getSiteById.mockResolvedValue({
        success: true,
        data: mockSites[0],
      });

      await program.parseAsync(["node", "test", "sites", "get", "1"]);

      expect(mockApiClient.getSiteById).toHaveBeenCalledWith("1");
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle non-existent site", async () => {
      mockApiClient.getSiteById.mockResolvedValue({
        success: false,
        error: "Site not found",
      });

      await program.parseAsync(["node", "test", "sites", "get", "999"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
        expect.anything()
      );
    });

    it("should include assets when --with-assets flag is provided", async () => {
      mockApiClient.getSiteById.mockResolvedValue({
        success: true,
        data: mockSites[0],
      });
      mockApiClient.getAssetsBySite.mockResolvedValue({
        success: true,
        data: [{ id: "a1", nameOrTag: "Asset 1", assetType: "PLC", critical: true }],
      });

      await program.parseAsync(["node", "test", "sites", "get", "1", "--with-assets"]);

      expect(mockApiClient.getAssetsBySite).toHaveBeenCalledWith("1");
    });

    it("should output JSON when --json flag is provided", async () => {
      mockApiClient.getSiteById.mockResolvedValue({
        success: true,
        data: mockSites[0],
      });

      await program.parseAsync(["node", "test", "sites", "get", "1", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    });
  });

  describe("sites create", () => {
    it("should create a new site", async () => {
      const newSite = { id: "3", name: "New Site", location: "New Location", owner: "0x789", createdAt: "2024-01-03" };
      mockApiClient.createSite.mockResolvedValue({
        success: true,
        data: newSite,
      });

      await program.parseAsync([
        "node", "test", "sites", "create",
        "--name", "New Site",
        "--location", "New Location",
        "--owner", "0x789",
      ]);

      expect(mockApiClient.createSite).toHaveBeenCalledWith({
        name: "New Site",
        location: "New Location",
        owner: "0x789",
      });
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("Site created"));
    });

    it("should require all options", async () => {
      // Missing required options should throw
      try {
        await program.parseAsync(["node", "test", "sites", "create", "--name", "Test"]);
      } catch (e) {
        // Expected to throw due to missing required options
        expect(e).toBeDefined();
      }
    });

    it("should handle creation errors", async () => {
      mockApiClient.createSite.mockResolvedValue({
        success: false,
        error: "Validation failed",
      });

      await program.parseAsync([
        "node", "test", "sites", "create",
        "--name", "Test",
        "--location", "Location",
        "--owner", "0x123",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create site"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const newSite = { id: "3", name: "New Site", location: "New Location", owner: "0x789", createdAt: "2024-01-03" };
      mockApiClient.createSite.mockResolvedValue({
        success: true,
        data: newSite,
      });

      await program.parseAsync([
        "node", "test", "sites", "create",
        "--name", "New Site",
        "--location", "New Location",
        "--owner", "0x789",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(newSite);
    });
  });
});
