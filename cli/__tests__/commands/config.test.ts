import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerConfigCommand } from "../../src/commands/config.js";

// Mock config module
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(() => ({
    apiUrl: "http://localhost:5000",
    timeout: 30000,
    colorOutput: true,
    jsonOutput: false,
  })),
  saveConfig: vi.fn(),
  getConfigPath: vi.fn(() => "/path/to/config.json"),
  getAllConfigPaths: vi.fn(() => [
    "/cwd/0xscada.config.json",
    "/home/.0xscada.config.json",
  ]),
}));

vi.mock("../../src/output.js", () => ({
  setOutputOptions: vi.fn(),
  output: vi.fn(),
  outputSection: vi.fn(),
  outputKeyValue: vi.fn(),
  outputError: vi.fn(),
  outputSuccess: vi.fn(),
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

import { loadConfig, saveConfig, getConfigPath, getAllConfigPaths } from "../../src/config.js";
import { output, outputError, outputSuccess, outputSection, outputKeyValue } from "../../src/output.js";

describe("Config Command", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerConfigCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("config show", () => {
    it("should register config command with show subcommand", () => {
      const configCmd = program.commands.find((c) => c.name() === "config");
      expect(configCmd).toBeDefined();
      
      const showCmd = configCmd?.commands.find((c) => c.name() === "show");
      expect(showCmd).toBeDefined();
    });

    it("should display current configuration", async () => {
      await program.parseAsync(["node", "test", "config", "show"]);

      expect(loadConfig).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "config", "show", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.any(Object),
          configFile: expect.any(String),
          searchPaths: expect.any(Array),
        })
      );
    });
  });

  describe("config set", () => {
    it("should set apiUrl", async () => {
      await program.parseAsync(["node", "test", "config", "set", "apiUrl", "http://new:8080"]);

      expect(saveConfig).toHaveBeenCalledWith({ apiUrl: "http://new:8080" });
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should set timeout as number", async () => {
      await program.parseAsync(["node", "test", "config", "set", "timeout", "5000"]);

      expect(saveConfig).toHaveBeenCalledWith({ timeout: 5000 });
    });

    it("should set colorOutput as boolean", async () => {
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "false"]);

      expect(saveConfig).toHaveBeenCalledWith({ colorOutput: false });
    });

    it("should set jsonOutput as boolean", async () => {
      await program.parseAsync(["node", "test", "config", "set", "jsonOutput", "true"]);

      expect(saveConfig).toHaveBeenCalledWith({ jsonOutput: true });
    });

    it("should reject invalid key", async () => {
      await program.parseAsync(["node", "test", "config", "set", "invalidKey", "value"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid configuration key"),
        expect.anything()
      );
      expect(saveConfig).not.toHaveBeenCalled();
    });

    it("should reject invalid timeout value", async () => {
      await program.parseAsync(["node", "test", "config", "set", "timeout", "invalid"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid value"),
        expect.anything()
      );
      expect(saveConfig).not.toHaveBeenCalled();
    });

    it("should reject zero timeout", async () => {
      await program.parseAsync(["node", "test", "config", "set", "timeout", "0"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid value"),
        expect.anything()
      );
    });

    it("should reject invalid URL for apiUrl", async () => {
      await program.parseAsync(["node", "test", "config", "set", "apiUrl", "not-a-url"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid"),
        expect.anything()
      );
    });

    it("should reject invalid boolean value", async () => {
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "maybe"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid value"),
        expect.anything()
      );
    });

    it("should accept various boolean formats", async () => {
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "yes"]);
      expect(saveConfig).toHaveBeenCalledWith({ colorOutput: true });

      vi.clearAllMocks();
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "1"]);
      expect(saveConfig).toHaveBeenCalledWith({ colorOutput: true });

      vi.clearAllMocks();
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "no"]);
      expect(saveConfig).toHaveBeenCalledWith({ colorOutput: false });

      vi.clearAllMocks();
      await program.parseAsync(["node", "test", "config", "set", "colorOutput", "0"]);
      expect(saveConfig).toHaveBeenCalledWith({ colorOutput: false });
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "config", "set", "apiUrl", "http://new:8080", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          key: "apiUrl",
          value: "http://new:8080",
        })
      );
    });
  });

  describe("config get", () => {
    it("should get specific config value", async () => {
      await program.parseAsync(["node", "test", "config", "get", "apiUrl"]);

      expect(loadConfig).toHaveBeenCalled();
    });

    it("should reject invalid key", async () => {
      await program.parseAsync(["node", "test", "config", "get", "invalidKey"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid configuration key"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "config", "get", "timeout", "--json"]);

      expect(output).toHaveBeenCalledWith({ timeout: 30000 });
    });
  });

  describe("config keys", () => {
    it("should list all valid keys", async () => {
      await program.parseAsync(["node", "test", "config", "keys"]);

      expect(outputSection).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "config", "keys", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "apiUrl" }),
          expect.objectContaining({ key: "timeout" }),
          expect.objectContaining({ key: "colorOutput" }),
          expect.objectContaining({ key: "jsonOutput" }),
        ])
      );
    });
  });

  describe("config paths", () => {
    it("should show config file paths", async () => {
      await program.parseAsync(["node", "test", "config", "paths"]);

      expect(getAllConfigPaths).toHaveBeenCalled();
      expect(getConfigPath).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "config", "paths", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          searchPaths: expect.any(Array),
          activeFile: expect.any(String),
        })
      );
    });
  });
});
