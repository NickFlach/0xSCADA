import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerShellCommand, getAvailableCommands, getCompletions, parseCommandLine } from "../../src/commands/shell.js";

// Mock readline module
vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    prompt: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    setPrompt: vi.fn(),
    write: vi.fn(),
  })),
  emitKeypressEvents: vi.fn(),
}));

// Mock chalk
vi.mock("chalk", () => ({
  default: {
    bold: Object.assign((t: string) => t, {
      cyan: (t: string) => t,
      green: (t: string) => t,
      white: (t: string) => t,
    }),
    cyan: (t: string) => t,
    green: (t: string) => t,
    yellow: (t: string) => t,
    red: (t: string) => t,
    dim: (t: string) => t,
    white: (t: string) => t,
  },
}));

// Mock config
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    colorOutput: true,
    jsonOutput: false,
    apiUrl: "http://localhost:5000",
  })),
}));

describe("Shell Command", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerShellCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerShellCommand", () => {
    it("should register shell command", () => {
      const shellCmd = program.commands.find((c) => c.name() === "shell");
      expect(shellCmd).toBeDefined();
    });

    it("should have correct description", () => {
      const shellCmd = program.commands.find((c) => c.name() === "shell");
      expect(shellCmd?.description()).toContain("interactive");
    });
  });

  describe("getAvailableCommands", () => {
    it("should return array of available commands", () => {
      const commands = getAvailableCommands();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
    });

    it("should include core commands", () => {
      const commands = getAvailableCommands();
      expect(commands).toContain("status");
      expect(commands).toContain("sites");
      expect(commands).toContain("assets");
      expect(commands).toContain("events");
      expect(commands).toContain("blockchain");
    });

    it("should include shell-specific commands", () => {
      const commands = getAvailableCommands();
      expect(commands).toContain("help");
      expect(commands).toContain("exit");
      expect(commands).toContain("quit");
      expect(commands).toContain("clear");
      expect(commands).toContain("history");
    });

    it("should include subcommands", () => {
      const commands = getAvailableCommands();
      expect(commands).toContain("sites list");
      expect(commands).toContain("sites get");
      expect(commands).toContain("assets list");
      expect(commands).toContain("events list");
      expect(commands).toContain("blockchain info");
    });
  });

  describe("getCompletions", () => {
    it("should return top-level commands for empty input", () => {
      const completions = getCompletions("");
      expect(completions).toContain("status");
      expect(completions).toContain("sites");
      expect(completions).toContain("help");
      // Should not include subcommands for empty input
      expect(completions).not.toContain("sites list");
    });

    it("should filter commands based on partial input", () => {
      const completions = getCompletions("si");
      expect(completions).toContain("sites");
      expect(completions).toContain("sites list");
      expect(completions).toContain("sites get");
      expect(completions).not.toContain("status");
      expect(completions).not.toContain("assets");
    });

    it("should be case-insensitive", () => {
      const completions = getCompletions("SI");
      expect(completions).toContain("sites");
      expect(completions).toContain("sites list");
    });

    it("should complete subcommands", () => {
      const completions = getCompletions("sites l");
      expect(completions).toContain("sites list");
    });

    it("should return exact match when input matches a command", () => {
      const completions = getCompletions("status");
      expect(completions).toContain("status");
    });

    it("should handle trailing spaces", () => {
      const completions = getCompletions("sites ");
      // Commands starting with "sites " should be included
      expect(completions.some((c) => c.startsWith("sites "))).toBe(true);
    });
  });

  describe("parseCommandLine", () => {
    it("should parse simple commands", () => {
      const args = parseCommandLine("status");
      expect(args).toEqual(["status"]);
    });

    it("should parse commands with arguments", () => {
      const args = parseCommandLine("sites get site-123");
      expect(args).toEqual(["sites", "get", "site-123"]);
    });

    it("should handle multiple spaces", () => {
      const args = parseCommandLine("sites   list");
      expect(args).toEqual(["sites", "list"]);
    });

    it("should handle quoted strings with spaces", () => {
      const args = parseCommandLine('sites create --name "My Site"');
      expect(args).toEqual(["sites", "create", "--name", "My Site"]);
    });

    it("should handle single quoted strings", () => {
      const args = parseCommandLine("sites create --name 'My Site'");
      expect(args).toEqual(["sites", "create", "--name", "My Site"]);
    });

    it("should handle mixed quotes", () => {
      const args = parseCommandLine('config set key "value with \'nested\' quotes"');
      expect(args).toEqual(["config", "set", "key", "value with 'nested' quotes"]);
    });

    it("should handle options with values", () => {
      const args = parseCommandLine("events list --limit 10");
      expect(args).toEqual(["events", "list", "--limit", "10"]);
    });

    it("should handle equals-style options", () => {
      const args = parseCommandLine("events list --limit=10");
      expect(args).toEqual(["events", "list", "--limit=10"]);
    });

    it("should handle empty input", () => {
      const args = parseCommandLine("");
      expect(args).toEqual([]);
    });

    it("should handle whitespace-only input", () => {
      const args = parseCommandLine("   ");
      expect(args).toEqual([]);
    });

    it("should preserve flags", () => {
      const args = parseCommandLine("status --json --no-color");
      expect(args).toEqual(["status", "--json", "--no-color"]);
    });
  });

  describe("shell integration", () => {
    it("should not interfere with other commands", () => {
      // Add another command
      program.command("other").description("Other command");

      const commands = program.commands.map((c) => c.name());
      expect(commands).toContain("shell");
      expect(commands).toContain("other");
    });

    it("shell command should not have subcommands", () => {
      const shellCmd = program.commands.find((c) => c.name() === "shell");
      expect(shellCmd?.commands.length).toBe(0);
    });
  });
});

describe("Shell Command History", () => {
  it("should track command history", async () => {
    // Import fresh to get clean history
    const { history } = await import("../../src/commands/shell.js");

    // History should be an array
    expect(Array.isArray(history)).toBe(true);
  });
});

describe("Shell Context", () => {
  it("should have context object", async () => {
    const { context } = await import("../../src/commands/shell.js");

    // Context should be an object
    expect(typeof context).toBe("object");
  });
});
