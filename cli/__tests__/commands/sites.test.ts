import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerSitesCommand } from "../../src/commands/sites.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getSites: vi.fn(),
    getSiteById: vi.fn(),
    createSite: vi.fn(),
    getAssetsBySite: vi.fn(),
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
  formatDate: vi.fn((date) => date),
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
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  setOutputOptions,
} from "../../src/output.js";

// Mock data
const mockSites = [
  {
    id: "site-001",
    name: "Plant Alpha",
    location: "Houston, TX",
    owner: "0x1234567890abcdef",
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "site-002",
    name: "Refinery Beta",
    location: "Denver, CO",
    owner: "0xabcdef1234567890",
    createdAt: "2024-01-15T00:00:00Z",
  },
];

const mockAssets = [
  {
    id: "asset-001",
    siteId: "site-001",
    assetType: "pump",
    nameOrTag: "P-101",
    critical: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "asset-002",
    siteId: "site-001",
    assetType: "valve",
    nameOrTag: "V-201",
    critical: false,
    createdAt: "2024-01-02T00:00:00Z",
  },
];

describe("Sites Command", () => {
  let program: Command;
  const mockApiClient = {
    getSites: vi.fn(),
    getSiteById: vi.fn(),
    createSite: vi.fn(),
    getAssetsBySite: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default successful responses
    mockApiClient.getSites.mockResolvedValue({
      success: true,
      data: mockSites,
    });

    mockApiClient.getSiteById.mockResolvedValue({
      success: true,
      data: mockSites[0],
    });

    mockApiClient.createSite.mockResolvedValue({
      success: true,
      data: mockSites[0],
    });

    mockApiClient.getAssetsBySite.mockResolvedValue({
      success: true,
      data: mockAssets,
    });

    registerSitesCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Command Registration", () => {
    it("should register sites command with subcommands", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      expect(sitesCmd).toBeDefined();
      expect(sitesCmd?.description()).toContain("site");
    });

    it("should have list subcommand", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      const listCmd = sitesCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should have get subcommand", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      const getCmd = sitesCmd?.commands.find((c) => c.name() === "get");
      expect(getCmd).toBeDefined();
    });

    it("should have create subcommand", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      const createCmd = sitesCmd?.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
    });
  });

  describe("sites list", () => {
    it("should fetch and display sites", async () => {
      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(mockApiClient.getSites).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should display table with correct columns", async () => {
      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(outputTable).toHaveBeenCalledWith(
        ["ID", "Name", "Location", "Owner", "Created"],
        expect.any(Array)
      );
    });

    it("should handle empty sites list", async () => {
      mockApiClient.getSites.mockResolvedValue({
        success: true,
        data: [],
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No sites registered")
      );
      expect(outputTable).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "sites", "list", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
      expect(output).toHaveBeenCalledWith(mockSites);
      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should handle API error", async () => {
      mockApiClient.getSites.mockResolvedValue({
        success: false,
        error: "Database connection failed",
      });

      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch sites"),
        expect.anything()
      );
    });

    it("should handle network error", async () => {
      mockApiClient.getSites.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should display total count after table", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Total: 2 sites")
      );

      consoleSpy.mockRestore();
    });
  });

  describe("sites get <id>", () => {
    it("should fetch and display site details", async () => {
      await program.parseAsync(["node", "test", "sites", "get", "site-001"]);

      expect(mockApiClient.getSiteById).toHaveBeenCalledWith("site-001");
      expect(outputSection).toHaveBeenCalledWith("Site Details");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should display site properties", async () => {
      await program.parseAsync(["node", "test", "sites", "get", "site-001"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "ID", value: "site-001" }),
          expect.objectContaining({ key: "Name", value: "Plant Alpha" }),
          expect.objectContaining({ key: "Location", value: "Houston, TX" }),
          expect.objectContaining({ key: "Owner", value: "0x1234567890abcdef" }),
        ])
      );
    });

    it("should handle site not found", async () => {
      mockApiClient.getSiteById.mockResolvedValue({
        success: false,
        error: "Site with ID 'nonexistent' not found",
      });

      await program.parseAsync(["node", "test", "sites", "get", "nonexistent"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Site not found"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "site-001",
          name: "Plant Alpha",
        })
      );
      expect(outputSection).not.toHaveBeenCalled();
    });

    it("should include assets when --with-assets flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--with-assets",
      ]);

      expect(mockApiClient.getAssetsBySite).toHaveBeenCalledWith("site-001");
      expect(outputSection).toHaveBeenCalledWith("Assets");
      expect(outputTable).toHaveBeenCalled();
    });

    it("should handle empty assets list with --with-assets", async () => {
      mockApiClient.getAssetsBySite.mockResolvedValue({
        success: true,
        data: [],
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--with-assets",
      ]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No assets registered")
      );

      consoleSpy.mockRestore();
    });

    it("should include assets in JSON output when --with-assets and --json", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--with-assets",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "site-001",
          assets: mockAssets,
        })
      );
    });

    it("should handle network error", async () => {
      mockApiClient.getSiteById.mockRejectedValue(new Error("Connection refused"));

      await program.parseAsync(["node", "test", "sites", "get", "site-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });

  describe("sites create", () => {
    it("should create site with required options", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "New Plant",
        "--location",
        "Chicago, IL",
        "--owner",
        "0xnewowner",
      ]);

      expect(mockApiClient.createSite).toHaveBeenCalledWith({
        name: "New Plant",
        location: "Chicago, IL",
        owner: "0xnewowner",
      });
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Site created")
      );
    });

    it("should display created site details", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "New Plant",
        "--location",
        "Chicago, IL",
        "--owner",
        "0xnewowner",
      ]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "ID" }),
          expect.objectContaining({ key: "Name" }),
          expect.objectContaining({ key: "Location" }),
          expect.objectContaining({ key: "Owner" }),
        ])
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "New Plant",
        "--location",
        "Chicago, IL",
        "--owner",
        "0xnewowner",
        "--json",
      ]);

      expect(output).toHaveBeenCalledWith(mockSites[0]);
      expect(outputSuccess).not.toHaveBeenCalled();
    });

    it("should handle validation error from API", async () => {
      mockApiClient.createSite.mockResolvedValue({
        success: false,
        error: "Site name already exists",
      });

      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "Duplicate",
        "--location",
        "Somewhere",
        "--owner",
        "0xowner",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create site"),
        expect.anything()
      );
    });

    it("should require --name option", async () => {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "sites",
          "create",
          "--location",
          "Chicago",
          "--owner",
          "0xowner",
        ])
      ).rejects.toThrow();
    });

    it("should require --location option", async () => {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "sites",
          "create",
          "--name",
          "Test",
          "--owner",
          "0xowner",
        ])
      ).rejects.toThrow();
    });

    it("should require --owner option", async () => {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "sites",
          "create",
          "--name",
          "Test",
          "--location",
          "Chicago",
        ])
      ).rejects.toThrow();
    });

    it("should handle network error", async () => {
      mockApiClient.createSite.mockRejectedValue(new Error("Network error"));

      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "New Plant",
        "--location",
        "Chicago, IL",
        "--owner",
        "0xnewowner",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });

  describe("Output Options", () => {
    it("should pass json option to setOutputOptions for list", async () => {
      await program.parseAsync(["node", "test", "sites", "list", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });

    it("should pass color option to setOutputOptions for list", async () => {
      await program.parseAsync(["node", "test", "sites", "list", "--no-color"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ color: false })
      );
    });

    it("should pass json option to setOutputOptions for get", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--json",
      ]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });

    it("should pass json option to setOutputOptions for create", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "create",
        "--name",
        "Test",
        "--location",
        "Test",
        "--owner",
        "0x",
        "--json",
      ]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });
  });

  describe("Table Formatting", () => {
    it("should format sites data correctly for table", async () => {
      await program.parseAsync(["node", "test", "sites", "list"]);

      expect(outputTable).toHaveBeenCalledWith(
        ["ID", "Name", "Location", "Owner", "Created"],
        [
          ["site-001", "Plant Alpha", "Houston, TX", "0x1234567890abcdef", "2024-01-01T00:00:00Z"],
          ["site-002", "Refinery Beta", "Denver, CO", "0xabcdef1234567890", "2024-01-15T00:00:00Z"],
        ]
      );
    });

    it("should format assets table correctly for --with-assets", async () => {
      await program.parseAsync([
        "node",
        "test",
        "sites",
        "get",
        "site-001",
        "--with-assets",
      ]);

      expect(outputTable).toHaveBeenCalledWith(
        ["ID", "Name/Tag", "Type", "Critical"],
        [
          ["asset-001", "P-101", "pump", "Yes"],
          ["asset-002", "V-201", "valve", "No"],
        ]
      );
    });
  });
});
