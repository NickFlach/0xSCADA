import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerBlockchainCommand } from "../../src/commands/blockchain.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getBlockchainStatus: vi.fn(),
    getHealth: vi.fn(),
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
  statusIcon: vi.fn((status) => status === "enabled" ? "●" : "○"),
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
import { output, outputError, outputSection, outputKeyValue } from "../../src/output.js";

describe("Blockchain Command", () => {
  let program: Command;
  const mockApiClient = {
    getBlockchainStatus: vi.fn(),
    getHealth: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    mockApiClient.getBlockchainStatus.mockResolvedValue({
      success: true,
      data: { enabled: true },
    });

    mockApiClient.getHealth.mockResolvedValue({
      success: true,
      data: {
        components: {
          database: { status: "up" },
          blockchain: { status: "up" },
        },
      },
    });

    registerBlockchainCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("blockchain info", () => {
    it("should register blockchain command with info subcommand", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      expect(blockchainCmd).toBeDefined();
      
      const infoCmd = blockchainCmd?.commands.find((c) => c.name() === "info");
      expect(infoCmd).toBeDefined();
    });

    it("should fetch blockchain status and health", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(mockApiClient.getBlockchainStatus).toHaveBeenCalled();
      expect(mockApiClient.getHealth).toHaveBeenCalled();
    });

    it("should display blockchain info sections", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          status: "up",
        })
      );
    });

    it("should handle disabled blockchain", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: false },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle API errors", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(new Error("Network error"));
      mockApiClient.getHealth.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalled();
    });

    it("should use RPC URL from environment", async () => {
      const originalEnv = process.env.BLOCKCHAIN_RPC_URL;
      process.env.BLOCKCHAIN_RPC_URL = "http://custom:8545";

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: "http://custom:8545",
        })
      );

      process.env.BLOCKCHAIN_RPC_URL = originalEnv;
    });
  });

  describe("blockchain status", () => {
    it("should have status as alias for info", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const statusCmd = blockchainCmd?.commands.find((c) => c.name() === "status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toContain("alias");
    });

    // Note: The status command internally calls info which requires special handling
    // Testing the registration is sufficient here
  });
});
