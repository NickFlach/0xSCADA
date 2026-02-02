import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerDevCommand } from "../../src/commands/dev.js";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    seedDatabase: vi.fn(),
    getHealth: vi.fn(),
    getBlockchainStatus: vi.fn(),
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
  outputSection: vi.fn(),
  outputKeyValue: vi.fn(),
  outputError: vi.fn(),
  outputSuccess: vi.fn(),
  outputWarning: vi.fn(),
  outputInfo: vi.fn(),
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

import { spawn } from "child_process";
import { getApiClient } from "../../src/api.js";
import { output, outputError, outputSuccess, outputWarning, outputSection, outputKeyValue } from "../../src/output.js";

describe("Dev Command", () => {
  let program: Command;
  const mockApiClient = {
    seedDatabase: vi.fn(),
    getHealth: vi.fn(),
    getBlockchainStatus: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default mock responses
    mockApiClient.getHealth.mockResolvedValue({
      success: true,
      data: {
        components: {
          database: { status: "up", latencyMs: 5 },
          blockchain: { status: "up" },
        },
      },
    });

    mockApiClient.getBlockchainStatus.mockResolvedValue({
      success: true,
      data: { enabled: true },
    });

    registerDevCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("dev start", () => {
    it("should register dev command with start subcommand", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      expect(devCmd).toBeDefined();
      
      const startCmd = devCmd?.commands.find((c) => c.name() === "start");
      expect(startCmd).toBeDefined();
    });

    it("should have --no-blockchain option", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      const startCmd = devCmd?.commands.find((c) => c.name() === "start");
      const option = startCmd?.options.find((o) => o.long === "--no-blockchain");
      expect(option).toBeDefined();
    });

    it("should have --port option", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      const startCmd = devCmd?.commands.find((c) => c.name() === "start");
      const option = startCmd?.options.find((o) => o.long === "--port");
      expect(option).toBeDefined();
    });

    it("should spawn npm run dev", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      expect(spawn).toHaveBeenCalledWith(
        "npm",
        ["run", "dev"],
        expect.objectContaining({
          stdio: "inherit",
          shell: true,
        })
      );
    });

    it("should set PORT environment variable", async () => {
      await program.parseAsync(["node", "test", "dev", "start", "--port", "3000"]);

      expect(spawn).toHaveBeenCalledWith(
        "npm",
        ["run", "dev"],
        expect.objectContaining({
          env: expect.objectContaining({
            PORT: "3000",
          }),
        })
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "dev", "start", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.any(String),
          port: expect.any(String),
        })
      );
    });
  });

  describe("dev seed", () => {
    it("should seed the database", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { success: true, message: "Database seeded" },
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      // seedDatabase is called with undefined when --force is not provided
      expect(mockApiClient.seedDatabase).toHaveBeenCalled();
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should force seed with --force flag", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { success: true, message: "Database re-seeded" },
      });

      await program.parseAsync(["node", "test", "dev", "seed", "--force"]);

      expect(mockApiClient.seedDatabase).toHaveBeenCalledWith(true);
    });

    it("should warn when already seeded", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { skipped: true, message: "Database already seeded" },
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputWarning).toHaveBeenCalled();
    });

    it("should handle seed errors", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: false,
        error: "Seed failed",
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to seed database"),
        expect.anything()
      );
    });

    it("should output JSON when --json flag is provided", async () => {
      const seedResult = { success: true, message: "Database seeded" };
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: seedResult,
      });

      await program.parseAsync(["node", "test", "dev", "seed", "--json"]);

      expect(output).toHaveBeenCalledWith(seedResult);
    });
  });

  describe("dev check", () => {
    it("should check environment prerequisites", async () => {
      await program.parseAsync(["node", "test", "dev", "check"]);

      expect(mockApiClient.getHealth).toHaveBeenCalled();
      expect(mockApiClient.getBlockchainStatus).toHaveBeenCalled();
    });

    it("should check Node.js version", async () => {
      await program.parseAsync(["node", "test", "dev", "check"]);

      // Should complete without error for Node 18+
      expect(outputSection).toHaveBeenCalled();
    });

    it("should handle server not running", async () => {
      mockApiClient.getHealth.mockRejectedValue(new Error("Connection refused"));
      mockApiClient.getBlockchainStatus.mockRejectedValue(new Error("Connection refused"));

      await program.parseAsync(["node", "test", "dev", "check"]);

      // Should still complete with warnings
      expect(outputSection).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.any(Array),
        })
      );
    });

    it("should check for required environment variables", async () => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string }> };
      const dbCheck = outputCall.checks.find((c) => c.name === "DATABASE_URL");
      expect(dbCheck?.status).toBe("error");

      process.env.DATABASE_URL = originalEnv;
    });

    it("should show optional environment variables as warnings", async () => {
      const originalEnv = process.env.BLOCKCHAIN_RPC_URL;
      delete process.env.BLOCKCHAIN_RPC_URL;

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string }> };
      const bcCheck = outputCall.checks.find((c) => c.name === "BLOCKCHAIN_RPC_URL");
      expect(bcCheck?.status).toBe("warning");

      process.env.BLOCKCHAIN_RPC_URL = originalEnv;
    });
  });
});
