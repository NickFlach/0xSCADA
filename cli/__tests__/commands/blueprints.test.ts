import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerBlueprintsCommand } from "../../src/commands/blueprints.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getCMTypes: vi.fn(),
    getCMTypeByName: vi.fn(),
    createCMType: vi.fn(),
    getUnitTypes: vi.fn(),
    createUnitType: vi.fn(),
    getPhaseTypes: vi.fn(),
    createPhaseType: vi.fn(),
    importBlueprints: vi.fn(),
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
  formatDate: vi.fn((date) => date),
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

vi.mock("fs", () => {
  // Share the SAME spy instances between the default export (used by the
  // source via `import fs from "fs"`) and the named exports (targeted by the
  // tests via `await import("fs")`), so a per-test override affects both.
  const existsSync = vi.fn(() => true);
  const readFileSync = vi.fn(() => '{"name": "test"}');
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  return {
    default: { existsSync, readFileSync, writeFileSync, mkdirSync },
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn((content) => JSON.parse(content)),
    dump: vi.fn((obj) => JSON.stringify(obj)),
  },
  load: vi.fn((content) => JSON.parse(content)),
  dump: vi.fn((obj) => JSON.stringify(obj)),
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
const mockCMTypes = [
  {
    id: "cm-001",
    name: "Valve_AO",
    inputs: [{ name: "CMD", dataType: "BOOL" }],
    outputs: [{ name: "STS", dataType: "BOOL" }],
    inOuts: [],
    sourcePackage: "test.yaml",
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "cm-002",
    name: "Motor_VFD",
    inputs: [{ name: "Start", dataType: "BOOL" }],
    outputs: [{ name: "Running", dataType: "BOOL" }],
    inOuts: [],
    sourcePackage: "test.yaml",
    createdAt: "2024-01-02T00:00:00Z",
  },
];

const mockUnitTypes = [
  {
    id: "unit-001",
    name: "Reactor",
    description: "Chemical reactor unit",
    variables: [],
    createdAt: "2024-01-01T00:00:00Z",
  },
];

const mockPhaseTypes = [
  {
    id: "phase-001",
    name: "Charge",
    description: "Charge phase for reactor",
    linkedModules: ["Valve_AO"],
    inputs: [],
    outputs: [],
    inOuts: [],
    internalValues: [],
    sequences: {},
    createdAt: "2024-01-01T00:00:00Z",
  },
];

describe("Blueprints Command", () => {
  let program: Command;
  const mockApiClient = {
    getCMTypes: vi.fn(),
    getCMTypeByName: vi.fn(),
    createCMType: vi.fn(),
    getUnitTypes: vi.fn(),
    createUnitType: vi.fn(),
    getPhaseTypes: vi.fn(),
    createPhaseType: vi.fn(),
    importBlueprints: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default successful responses
    mockApiClient.getCMTypes.mockResolvedValue({
      success: true,
      data: mockCMTypes,
    });

    mockApiClient.getCMTypeByName.mockResolvedValue({
      success: true,
      data: mockCMTypes[0],
    });

    mockApiClient.createCMType.mockResolvedValue({
      success: true,
      data: mockCMTypes[0],
    });

    mockApiClient.getUnitTypes.mockResolvedValue({
      success: true,
      data: mockUnitTypes,
    });

    mockApiClient.createUnitType.mockResolvedValue({
      success: true,
      data: mockUnitTypes[0],
    });

    mockApiClient.getPhaseTypes.mockResolvedValue({
      success: true,
      data: mockPhaseTypes,
    });

    mockApiClient.createPhaseType.mockResolvedValue({
      success: true,
      data: mockPhaseTypes[0],
    });

    mockApiClient.importBlueprints.mockResolvedValue({
      success: true,
      data: {
        success: true,
        imported: {
          cmTypes: 2,
          cmInstances: 5,
          unitTypes: 1,
          unitInstances: 2,
          phaseTypes: 1,
        },
        warnings: [],
      },
    });

    registerBlueprintsCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Command Registration", () => {
    it("should register blueprints command with subcommands", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      expect(blueprintsCmd).toBeDefined();
      expect(blueprintsCmd?.description()).toContain("blueprint");
    });

    it("should have list subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const listCmd = blueprintsCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should have show subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const showCmd = blueprintsCmd?.commands.find((c) => c.name() === "show");
      expect(showCmd).toBeDefined();
    });

    it("should have create subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const createCmd = blueprintsCmd?.commands.find((c) => c.name() === "create");
      expect(createCmd).toBeDefined();
    });

    it("should have import subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const importCmd = blueprintsCmd?.commands.find((c) => c.name() === "import");
      expect(importCmd).toBeDefined();
    });

    it("should have export subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const exportCmd = blueprintsCmd?.commands.find((c) => c.name() === "export");
      expect(exportCmd).toBeDefined();
    });

    it("should have export-all subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const exportAllCmd = blueprintsCmd?.commands.find((c) => c.name() === "export-all");
      expect(exportAllCmd).toBeDefined();
    });

    it("should have validate subcommand", () => {
      const blueprintsCmd = program.commands.find((c) => c.name() === "blueprints");
      const validateCmd = blueprintsCmd?.commands.find((c) => c.name() === "validate");
      expect(validateCmd).toBeDefined();
    });
  });

  describe("blueprints list", () => {
    it("should fetch and display all blueprint types by default", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list"]);

      expect(mockApiClient.getCMTypes).toHaveBeenCalled();
      expect(mockApiClient.getUnitTypes).toHaveBeenCalled();
      expect(mockApiClient.getPhaseTypes).toHaveBeenCalled();
    });

    it("should filter by cm-types when specified", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--type", "cm-types"]);

      expect(mockApiClient.getCMTypes).toHaveBeenCalled();
      expect(mockApiClient.getUnitTypes).not.toHaveBeenCalled();
      expect(mockApiClient.getPhaseTypes).not.toHaveBeenCalled();
    });

    it("should filter by unit-types when specified", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--type", "unit-types"]);

      expect(mockApiClient.getCMTypes).not.toHaveBeenCalled();
      expect(mockApiClient.getUnitTypes).toHaveBeenCalled();
      expect(mockApiClient.getPhaseTypes).not.toHaveBeenCalled();
    });

    it("should filter by phase-types when specified", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--type", "phase-types"]);

      expect(mockApiClient.getCMTypes).not.toHaveBeenCalled();
      expect(mockApiClient.getUnitTypes).not.toHaveBeenCalled();
      expect(mockApiClient.getPhaseTypes).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
      expect(output).toHaveBeenCalled();
    });

    it("should handle empty results", async () => {
      mockApiClient.getCMTypes.mockResolvedValue({ success: true, data: [] });
      mockApiClient.getUnitTypes.mockResolvedValue({ success: true, data: [] });
      mockApiClient.getPhaseTypes.mockResolvedValue({ success: true, data: [] });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "blueprints", "list"]);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should handle API error", async () => {
      mockApiClient.getCMTypes.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "blueprints", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });

  describe("blueprints show <id>", () => {
    it("should fetch and display blueprint details", async () => {
      await program.parseAsync(["node", "test", "blueprints", "show", "Valve_AO"]);

      expect(mockApiClient.getCMTypeByName).toHaveBeenCalledWith("Valve_AO");
    });

    it("should search all types when type not specified", async () => {
      mockApiClient.getCMTypeByName.mockResolvedValue({ success: false, error: "Not found" });

      await program.parseAsync(["node", "test", "blueprints", "show", "some-id"]);

      expect(mockApiClient.getCMTypeByName).toHaveBeenCalled();
      expect(mockApiClient.getUnitTypes).toHaveBeenCalled();
    });

    it("should handle blueprint not found", async () => {
      mockApiClient.getCMTypeByName.mockResolvedValue({ success: false, error: "Not found" });
      mockApiClient.getUnitTypes.mockResolvedValue({ success: true, data: [] });
      mockApiClient.getPhaseTypes.mockResolvedValue({ success: true, data: [] });

      await program.parseAsync(["node", "test", "blueprints", "show", "nonexistent"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Blueprint not found"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "blueprints", "show", "Valve_AO", "--json"]);

      expect(output).toHaveBeenCalledWith(mockCMTypes[0]);
    });
  });

  describe("blueprints validate", () => {
    it("should validate a blueprint file", async () => {
      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "validate",
        "--file",
        "test.json",
      ]);

      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("valid"));
    });

    it("should report validation errors", async () => {
      const fs = await import("fs");
      vi.mocked(fs.readFileSync).mockReturnValue("{}");

      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "validate",
        "--file",
        "invalid.json",
      ]);

      expect(outputError).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "validate",
        "--file",
        "test.json",
        "--json",
      ]);

      expect(output).toHaveBeenCalled();
    });
  });

  describe("blueprints import", () => {
    it("should import blueprints from a package file", async () => {
      const fs = await import("fs");
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          cmTypePackage: "...",
          designSpec: "...",
        })
      );

      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "import",
        "--file",
        "package.json",
      ]);

      expect(mockApiClient.importBlueprints).toHaveBeenCalled();
      expect(outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining("imported successfully")
      );
    });

    it("should handle import errors", async () => {
      mockApiClient.importBlueprints.mockResolvedValue({
        success: false,
        error: "Import failed",
        data: {
          errors: ["Invalid structure"],
          warnings: [],
        },
      });

      const fs = await import("fs");
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          cmTypePackage: "...",
          designSpec: "...",
        })
      );

      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "import",
        "--file",
        "package.json",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Import failed"),
        expect.anything()
      );
    });

    it("should validate package structure", async () => {
      const fs = await import("fs");
      vi.mocked(fs.readFileSync).mockReturnValue("{}");

      await program.parseAsync([
        "node",
        "test",
        "blueprints",
        "import",
        "--file",
        "invalid-package.json",
      ]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid package structure"),
        expect.anything()
      );
    });
  });

  describe("Output Options", () => {
    it("should pass json option to setOutputOptions for list", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });

    it("should pass color option to setOutputOptions for list", async () => {
      await program.parseAsync(["node", "test", "blueprints", "list", "--no-color"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ color: false })
      );
    });
  });
});
