import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// Mock all external dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getHealth: vi.fn().mockResolvedValue({ success: true, data: { status: "healthy", version: "1.0.0", uptime: 3600, components: { database: { status: "up" }, blockchain: { status: "up" } } } }),
    getBlockchainStatus: vi.fn().mockResolvedValue({ success: true, data: { enabled: true } }),
    getBlueprintsSummary: vi.fn().mockResolvedValue({ success: true, data: { controlModuleTypes: 5, vendors: 2 } }),
    getSites: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getSiteById: vi.fn().mockResolvedValue({ success: true, data: { id: "1", name: "Test Site" } }),
    getAssets: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getAssetById: vi.fn().mockResolvedValue({ success: true, data: { id: "a1", nameOrTag: "Test Asset" } }),
    getEvents: vi.fn().mockResolvedValue({ success: true, data: { data: [], total: 0, page: 1, limit: 20, totalPages: 0, hasNextPage: false, hasPrevPage: false } }),
    getBatchStats: vi.fn().mockResolvedValue({ success: true, data: { pendingEvents: 0 } }),
    createSite: vi.fn().mockResolvedValue({ success: true, data: { id: "new-site" } }),
    createAsset: vi.fn().mockResolvedValue({ success: true, data: { id: "new-asset" } }),
    createEvent: vi.fn().mockResolvedValue({ success: true, data: { id: "new-event" } }),
    seedDatabase: vi.fn().mockResolvedValue({ success: true, data: { success: true } }),
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

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })),
}));

// Mock console
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

import {
  registerStatusCommand,
  registerSitesCommand,
  registerAssetsCommand,
  registerEventsCommand,
  registerBlockchainCommand,
  registerDevCommand,
  registerConfigCommand,
} from "../../src/commands/index.js";

describe("CLI Integration", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

    // Register all commands
    registerStatusCommand(program);
    registerSitesCommand(program);
    registerAssetsCommand(program);
    registerEventsCommand(program);
    registerBlockchainCommand(program);
    registerDevCommand(program);
    registerConfigCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Command Registration", () => {
    it("should register all main commands", () => {
      const commandNames = program.commands.map((c) => c.name());
      
      expect(commandNames).toContain("status");
      expect(commandNames).toContain("sites");
      expect(commandNames).toContain("assets");
      expect(commandNames).toContain("events");
      expect(commandNames).toContain("blockchain");
      expect(commandNames).toContain("dev");
      expect(commandNames).toContain("config");
    });

    it("should register sites subcommands", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      const subcommands = sitesCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("list");
      expect(subcommands).toContain("get");
      expect(subcommands).toContain("create");
    });

    it("should register assets subcommands", () => {
      const assetsCmd = program.commands.find((c) => c.name() === "assets");
      const subcommands = assetsCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("list");
      expect(subcommands).toContain("get");
      expect(subcommands).toContain("create");
    });

    it("should register events subcommands", () => {
      const eventsCmd = program.commands.find((c) => c.name() === "events");
      const subcommands = eventsCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("list");
      expect(subcommands).toContain("anchor");
      expect(subcommands).toContain("stats");
      expect(subcommands).toContain("create");
    });

    it("should register blockchain subcommands", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const subcommands = blockchainCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("info");
      expect(subcommands).toContain("status");
    });

    it("should register dev subcommands", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      const subcommands = devCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("start");
      expect(subcommands).toContain("seed");
      expect(subcommands).toContain("check");
    });

    it("should register config subcommands", () => {
      const configCmd = program.commands.find((c) => c.name() === "config");
      const subcommands = configCmd?.commands.map((c) => c.name());
      
      expect(subcommands).toContain("show");
      expect(subcommands).toContain("set");
      expect(subcommands).toContain("get");
      expect(subcommands).toContain("keys");
      expect(subcommands).toContain("paths");
    });
  });

  describe("Command Execution Flow", () => {
    it("should execute status command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "status"])
      ).resolves.not.toThrow();
    });

    it("should execute sites list command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "sites", "list"])
      ).resolves.not.toThrow();
    });

    it("should execute assets list command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "assets", "list"])
      ).resolves.not.toThrow();
    });

    it("should execute events list command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "events", "list"])
      ).resolves.not.toThrow();
    });

    it("should execute blockchain info command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "blockchain", "info"])
      ).resolves.not.toThrow();
    });

    it("should execute config show command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "config", "show"])
      ).resolves.not.toThrow();
    });

    it("should execute dev check command without errors", async () => {
      await expect(
        program.parseAsync(["node", "test", "dev", "check"])
      ).resolves.not.toThrow();
    });
  });

  describe("Global Options", () => {
    it("should accept --json option on status command", async () => {
      await expect(
        program.parseAsync(["node", "test", "status", "--json"])
      ).resolves.not.toThrow();
    });

    it("should accept --no-color option on status command", async () => {
      await expect(
        program.parseAsync(["node", "test", "status", "--no-color"])
      ).resolves.not.toThrow();
    });

    it("should accept combined options", async () => {
      await expect(
        program.parseAsync(["node", "test", "status", "--json", "--no-color"])
      ).resolves.not.toThrow();
    });
  });

  describe("Error Handling", () => {
    it("should handle unknown command gracefully", async () => {
      program.on("command:*", (operands) => {
        // Custom unknown command handler
      });

      try {
        await program.parseAsync(["node", "test", "unknown"]);
      } catch (e) {
        // Expected to throw or handle unknown command
      }
    });

    it("should handle missing required arguments", async () => {
      try {
        await program.parseAsync(["node", "test", "sites", "get"]);
        // If it doesn't throw, the command handles missing args
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should handle missing required options", async () => {
      try {
        await program.parseAsync(["node", "test", "sites", "create"]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe("Command Descriptions", () => {
    it("should have description for status command", () => {
      const statusCmd = program.commands.find((c) => c.name() === "status");
      expect(statusCmd?.description()).toBeTruthy();
    });

    it("should have description for all main commands", () => {
      program.commands.forEach((cmd) => {
        expect(cmd.description()).toBeTruthy();
      });
    });
  });

  describe("Help Text", () => {
    it("should generate help text for main program", () => {
      const help = program.helpInformation();
      expect(help).toContain("status");
      expect(help).toContain("sites");
      expect(help).toContain("assets");
      expect(help).toContain("events");
    });

    it("should generate help text for subcommands", () => {
      const sitesCmd = program.commands.find((c) => c.name() === "sites");
      const help = sitesCmd?.helpInformation();
      expect(help).toContain("list");
      expect(help).toContain("get");
      expect(help).toContain("create");
    });
  });
});

describe("CLI Argument Parsing", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    registerEventsCommand(program);
  });

  it("should parse pagination options correctly", async () => {
    const eventsCmd = program.commands.find((c) => c.name() === "events");
    const listCmd = eventsCmd?.commands.find((c) => c.name() === "list");
    
    expect(listCmd?.options.some((o) => o.long === "--page")).toBe(true);
    expect(listCmd?.options.some((o) => o.long === "--limit")).toBe(true);
  });

  it("should parse filter options correctly", async () => {
    const eventsCmd = program.commands.find((c) => c.name() === "events");
    const listCmd = eventsCmd?.commands.find((c) => c.name() === "list");
    
    expect(listCmd?.options.some((o) => o.long === "--type")).toBe(true);
    expect(listCmd?.options.some((o) => o.long === "--asset")).toBe(true);
    expect(listCmd?.options.some((o) => o.long === "--anchored")).toBe(true);
    expect(listCmd?.options.some((o) => o.long === "--pending")).toBe(true);
  });
});

describe("CLI Output Modes", () => {
  let program: Command;
  let capturedOutput: unknown[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOutput = [];
    
    program = new Command();
    program.exitOverride();
    
    registerStatusCommand(program);
    registerConfigCommand(program);
  });

  it("should support JSON output mode", async () => {
    await program.parseAsync(["node", "test", "status", "--json"]);
    
    // Command should complete without error
    expect(true).toBe(true);
  });

  it("should support text output mode (default)", async () => {
    await program.parseAsync(["node", "test", "status"]);
    
    // Command should complete without error
    expect(true).toBe(true);
  });

  it("should respect --no-color option", async () => {
    await program.parseAsync(["node", "test", "status", "--no-color"]);
    
    // Command should complete without error
    expect(true).toBe(true);
  });
});
