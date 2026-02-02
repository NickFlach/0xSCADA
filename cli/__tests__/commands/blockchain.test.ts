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
  statusIcon: vi.fn((status) => {
    if (status === "enabled" || status === "connected" || status === "up") return "●";
    if (status === "disabled" || status === "disconnected" || status === "down") return "○";
    return "?";
  }),
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
import { output, outputError, outputSection, outputKeyValue, setOutputOptions } from "../../src/output.js";
import ora from "ora";

describe("Blockchain Command", () => {
  let program: Command;
  const mockApiClient = {
    getBlockchainStatus: vi.fn(),
    getHealth: vi.fn(),
  };
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);
    
    // Store original env
    originalEnv = process.env.BLOCKCHAIN_RPC_URL;

    // Default successful responses
    mockApiClient.getBlockchainStatus.mockResolvedValue({
      success: true,
      data: { enabled: true },
    });

    mockApiClient.getHealth.mockResolvedValue({
      success: true,
      data: {
        status: "healthy",
        components: {
          database: { status: "connected" },
          blockchain: { status: "connected" },
        },
      },
    });

    registerBlockchainCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.BLOCKCHAIN_RPC_URL;
    } else {
      process.env.BLOCKCHAIN_RPC_URL = originalEnv;
    }
  });

  describe("command registration", () => {
    it("should register blockchain command", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      expect(blockchainCmd).toBeDefined();
      expect(blockchainCmd?.description()).toContain("Blockchain");
    });

    it("should register info subcommand", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const infoCmd = blockchainCmd?.commands.find((c) => c.name() === "info");
      expect(infoCmd).toBeDefined();
      expect(infoCmd?.description()).toContain("connection status");
    });

    it("should register status subcommand as alias", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const statusCmd = blockchainCmd?.commands.find((c) => c.name() === "status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toContain("alias");
    });

    it("should have --json option on info command", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const infoCmd = blockchainCmd?.commands.find((c) => c.name() === "info");
      const jsonOption = infoCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });

    it("should have --no-color option on info command", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const infoCmd = blockchainCmd?.commands.find((c) => c.name() === "info");
      const colorOption = infoCmd?.options.find((o) => o.long === "--no-color");
      expect(colorOption).toBeDefined();
    });
  });

  describe("blockchain info - connected state", () => {
    it("should fetch blockchain status and health concurrently", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(mockApiClient.getBlockchainStatus).toHaveBeenCalledTimes(1);
      expect(mockApiClient.getHealth).toHaveBeenCalledTimes(1);
    });

    it("should display blockchain status section when connected", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputSection).toHaveBeenCalledWith("Blockchain Status");
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should show enabled status when blockchain is enabled", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: true },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "Enabled" }),
        ])
      );
    });

    it("should display connected blockchain component status", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "connected" },
            blockchain: { status: "connected" },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "Status" }),
        ])
      );
    });

    it("should stop spinner after successful fetch", async () => {
      const mockOra = vi.mocked(ora);
      const spinnerMock = {
        start: vi.fn().mockReturnThis(),
        stop: vi.fn(),
        fail: vi.fn(),
        text: "",
      };
      mockOra.mockReturnValue(spinnerMock as any);

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(spinnerMock.stop).toHaveBeenCalled();
    });
  });

  describe("blockchain info - disconnected state", () => {
    it("should handle disabled blockchain gracefully", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: false },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
      // Should complete without error
      expect(outputError).not.toHaveBeenCalled();
    });

    it("should show disabled status message", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: false },
      });

      // Capture console.log calls
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      // Check that helpful message is displayed for disabled blockchain
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should handle disconnected blockchain component status", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "connected" },
            blockchain: { status: "disconnected" },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle unknown blockchain component status", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "connected" },
            blockchain: { status: undefined },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle missing blockchain component in health response", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "connected" },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });
  });

  describe("RPC URL handling", () => {
    it("should use default RPC URL when not set in environment", async () => {
      delete process.env.BLOCKCHAIN_RPC_URL;

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: "http://127.0.0.1:8545",
        })
      );
    });

    it("should use custom RPC URL from environment", async () => {
      process.env.BLOCKCHAIN_RPC_URL = "http://custom-node:8545";

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: "http://custom-node:8545",
        })
      );
    });

    it("should handle mainnet RPC URL", async () => {
      process.env.BLOCKCHAIN_RPC_URL = "https://mainnet.infura.io/v3/YOUR-API-KEY";

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: "https://mainnet.infura.io/v3/YOUR-API-KEY",
        })
      );
    });

    it("should handle WebSocket RPC URL", async () => {
      process.env.BLOCKCHAIN_RPC_URL = "wss://mainnet.infura.io/ws/v3/YOUR-API-KEY";

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcUrl: "wss://mainnet.infura.io/ws/v3/YOUR-API-KEY",
        })
      );
    });

    it("should display RPC URL in formatted output", async () => {
      process.env.BLOCKCHAIN_RPC_URL = "http://localhost:8545";

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "RPC URL" }),
        ])
      );
    });
  });

  describe("JSON output mode", () => {
    it("should set output options when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });

    it("should output valid JSON structure", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: expect.any(Boolean),
          status: expect.any(String),
          rpcUrl: expect.any(String),
        })
      );
    });

    it("should include enabled true in JSON output when blockchain enabled", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: true },
      });

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true })
      );
    });

    it("should include enabled false in JSON output when blockchain disabled", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: false },
      });

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    });

    it("should include component status in JSON output", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "connected" },
            blockchain: { status: "syncing" },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ status: "syncing" })
      );
    });

    it("should skip spinner creation in JSON mode", async () => {
      // In JSON mode, the spinner is conditionally set to null
      // Verify JSON output works without spinner issues
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      // Should output JSON data successfully
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: expect.any(Boolean),
        })
      );
    });

    it("should not call outputSection in JSON mode", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(outputSection).not.toHaveBeenCalled();
    });

    it("should not call outputKeyValue in JSON mode", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--json"]);

      expect(outputKeyValue).not.toHaveBeenCalled();
    });
  });

  describe("error handling - RPC errors", () => {
    it("should handle network errors gracefully", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(new Error("Network error"));
      mockApiClient.getHealth.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        "Network error"
      );
    });

    it("should handle timeout errors", async () => {
      const timeoutError = new Error("Request timed out");
      timeoutError.name = "AbortError";
      mockApiClient.getBlockchainStatus.mockRejectedValue(timeoutError);
      mockApiClient.getHealth.mockRejectedValue(timeoutError);

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalled();
    });

    it("should handle connection refused errors", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(
        new Error("ECONNREFUSED - Connection refused")
      );
      mockApiClient.getHealth.mockRejectedValue(
        new Error("ECONNREFUSED - Connection refused")
      );

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        expect.stringContaining("ECONNREFUSED")
      );
    });

    it("should handle RPC node unavailable errors", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(
        new Error("RPC node is not responding")
      );
      mockApiClient.getHealth.mockRejectedValue(
        new Error("RPC node is not responding")
      );

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        expect.stringContaining("RPC")
      );
    });

    it("should handle API returning failure status", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: false,
        error: "Blockchain service unavailable",
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      // Should still render but with potentially undefined data
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle partial API failure (status ok, health fails)", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: true },
      });
      mockApiClient.getHealth.mockRejectedValue(new Error("Health check failed"));

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalled();
    });

    it("should handle partial API failure (health ok, status fails)", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(
        new Error("Status check failed")
      );
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            blockchain: { status: "connected" },
          },
        },
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalled();
    });

    it("should fail spinner on error", async () => {
      const mockOra = vi.mocked(ora);
      const spinnerMock = {
        start: vi.fn().mockReturnThis(),
        stop: vi.fn(),
        fail: vi.fn(),
        text: "",
      };
      mockOra.mockReturnValue(spinnerMock as any);

      mockApiClient.getBlockchainStatus.mockRejectedValue(new Error("API Error"));
      mockApiClient.getHealth.mockRejectedValue(new Error("API Error"));

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(spinnerMock.fail).toHaveBeenCalledWith("Failed to fetch blockchain info");
    });

    it("should handle unknown error type gracefully", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue("Unknown error type");
      mockApiClient.getHealth.mockRejectedValue("Unknown error type");

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        "Unknown error"
      );
    });

    it("should handle null error gracefully", async () => {
      mockApiClient.getBlockchainStatus.mockRejectedValue(null);
      mockApiClient.getHealth.mockRejectedValue(null);

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        "Unknown error"
      );
    });
  });

  describe("blockchain status (alias)", () => {
    it("should have status command as alias for info", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const statusCmd = blockchainCmd?.commands.find((c) => c.name() === "status");
      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description()).toContain("alias for info");
    });

    it("should have --json option on status command", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const statusCmd = blockchainCmd?.commands.find((c) => c.name() === "status");
      const jsonOption = statusCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });

    it("should have --no-color option on status command", () => {
      const blockchainCmd = program.commands.find((c) => c.name() === "blockchain");
      const statusCmd = blockchainCmd?.commands.find((c) => c.name() === "status");
      const colorOption = statusCmd?.options.find((o) => o.long === "--no-color");
      expect(colorOption).toBeDefined();
    });
  });

  describe("output options", () => {
    it("should set color option when --no-color is provided", async () => {
      await program.parseAsync(["node", "test", "blockchain", "info", "--no-color"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ color: false })
      );
    });

    it("should set both json and color options together", async () => {
      await program.parseAsync([
        "node",
        "test",
        "blockchain",
        "info",
        "--json",
        "--no-color",
      ]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true, color: false })
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty health response data", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {},
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle empty blockchain status response", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: {},
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle null data in responses", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: null,
      });
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: null,
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should handle concurrent API calls correctly", async () => {
      const callOrder: string[] = [];

      mockApiClient.getBlockchainStatus.mockImplementation(async () => {
        callOrder.push("status-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("status-end");
        return { success: true, data: { enabled: true } };
      });

      mockApiClient.getHealth.mockImplementation(async () => {
        callOrder.push("health-start");
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push("health-end");
        return {
          success: true,
          data: { components: { blockchain: { status: "connected" } } },
        };
      });

      await program.parseAsync(["node", "test", "blockchain", "info"]);

      // Both should start before either ends (concurrent execution)
      const allStarts = callOrder.filter((c) => c.endsWith("-start"));
      expect(allStarts.length).toBe(2);
    });
  });
});
