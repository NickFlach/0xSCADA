import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerDevCommand } from "../../src/commands/dev.js";
import type { ChildProcess } from "child_process";
import type { EventEmitter } from "events";

// Create mock spawn with event handlers that we can control
const createMockSpawn = () => {
  const eventHandlers: Record<string, Function[]> = {};
  const mockProcess = {
    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers[event]) {
        eventHandlers[event] = [];
      }
      eventHandlers[event].push(handler);
      return mockProcess;
    }),
    kill: vi.fn(),
    _emit: (event: string, ...args: unknown[]) => {
      if (eventHandlers[event]) {
        eventHandlers[event].forEach(handler => handler(...args));
      }
    },
    _eventHandlers: eventHandlers,
  };
  return mockProcess;
};

let mockSpawnProcess = createMockSpawn();

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(() => mockSpawnProcess),
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

import { spawn } from "child_process";
import { getApiClient } from "../../src/api.js";
import { output, outputError, outputSuccess, outputWarning, outputSection, outputKeyValue, outputInfo, setOutputOptions } from "../../src/output.js";

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
    
    // Reset the mock spawn process for each test
    mockSpawnProcess = createMockSpawn();
    vi.mocked(spawn).mockReturnValue(mockSpawnProcess as any);
    
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

    it("should output JSON with blockchain flag status", async () => {
      await program.parseAsync(["node", "test", "dev", "start", "--json", "--no-blockchain"]);

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          blockchain: false,
        })
      );
    });

    it("should register error handler for spawn failure", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      // Verify error handler is registered
      expect(mockSpawnProcess.on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("should register close handler for process exit", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      // Verify close handler is registered
      expect(mockSpawnProcess.on).toHaveBeenCalledWith("close", expect.any(Function));
    });

    it("should display section header when not in JSON mode", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      expect(outputSection).toHaveBeenCalledWith("Starting Development Environment");
    });

    it("should display key-value pairs when not in JSON mode", async () => {
      await program.parseAsync(["node", "test", "dev", "start", "--port", "4000"]);

      expect(outputKeyValue).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ key: "Server Port", value: "4000" }),
        ])
      );
    });

    it("should show info message about starting server when not in JSON mode", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      expect(outputInfo).toHaveBeenCalledWith("Starting server with npm run dev...");
    });

    it("should use default port 5000", async () => {
      await program.parseAsync(["node", "test", "dev", "start"]);

      expect(spawn).toHaveBeenCalledWith(
        "npm",
        ["run", "dev"],
        expect.objectContaining({
          env: expect.objectContaining({
            PORT: "5000",
          }),
        })
      );
    });

    it("should set output options correctly", async () => {
      await program.parseAsync(["node", "test", "dev", "start", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
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

    it("should handle network connection errors", async () => {
      mockApiClient.seedDatabase.mockRejectedValue(new Error("ECONNREFUSED"));

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        "ECONNREFUSED"
      );
    });

    it("should handle unknown errors gracefully", async () => {
      mockApiClient.seedDatabase.mockRejectedValue("Non-error rejection");

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputError).toHaveBeenCalledWith(
        "Failed to connect to server",
        "Unknown error"
      );
    });

    it("should set output options for JSON mode", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { success: true },
      });

      await program.parseAsync(["node", "test", "dev", "seed", "--json"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true })
      );
    });

    it("should set output options for color mode", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { success: true },
      });

      await program.parseAsync(["node", "test", "dev", "seed", "--no-color"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ color: false })
      );
    });

    it("should show default message when seed data has no message", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: {},
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputSuccess).toHaveBeenCalledWith("Database seeded successfully");
    });

    it("should show custom message from seed response", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { message: "Custom seed complete" },
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputSuccess).toHaveBeenCalledWith("Custom seed complete");
    });

    it("should show default warning message when skipped but no message", async () => {
      mockApiClient.seedDatabase.mockResolvedValue({
        success: true,
        data: { skipped: true },
      });

      await program.parseAsync(["node", "test", "dev", "seed"]);

      expect(outputWarning).toHaveBeenCalledWith("Database already seeded");
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

    it("should show DATABASE_URL as ok when set", async () => {
      const originalEnv = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string }> };
      const dbCheck = outputCall.checks.find((c) => c.name === "DATABASE_URL");
      expect(dbCheck?.status).toBe("ok");

      if (originalEnv) {
        process.env.DATABASE_URL = originalEnv;
      } else {
        delete process.env.DATABASE_URL;
      }
    });

    it("should detect database connection failure", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "down" },
            blockchain: { status: "up" },
          },
        },
      });

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string }> };
      const dbCheck = outputCall.checks.find((c) => c.name === "Database");
      expect(dbCheck?.status).toBe("error");
    });

    it("should detect blockchain disabled", async () => {
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: true,
        data: { enabled: false },
      });

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string; message: string }> };
      const bcCheck = outputCall.checks.find((c) => c.name === "Blockchain");
      expect(bcCheck?.status).toBe("warning");
      expect(bcCheck?.message).toContain("Disabled");
    });

    it("should detect server not responding (health returns unsuccessful)", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: false,
        error: "Server error",
      });
      mockApiClient.getBlockchainStatus.mockResolvedValue({
        success: false,
        error: "Server error",
      });

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string; message: string }> };
      const serverCheck = outputCall.checks.find((c) => c.name === "Server");
      expect(serverCheck?.status).toBe("warning");
      expect(serverCheck?.message).toBe("Not responding");
    });

    it("should show success message when all checks pass", async () => {
      const originalDbUrl = process.env.DATABASE_URL;
      const originalRpcUrl = process.env.BLOCKCHAIN_RPC_URL;
      const originalKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
      
      // Set all env vars to get all checks to pass
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";
      process.env.BLOCKCHAIN_RPC_URL = "http://localhost:8545";
      process.env.BLOCKCHAIN_PRIVATE_KEY = "0x123";

      await program.parseAsync(["node", "test", "dev", "check"]);

      expect(outputSuccess).toHaveBeenCalledWith("All checks passed");

      // Restore original env
      if (originalDbUrl) {
        process.env.DATABASE_URL = originalDbUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
      if (originalRpcUrl) {
        process.env.BLOCKCHAIN_RPC_URL = originalRpcUrl;
      } else {
        delete process.env.BLOCKCHAIN_RPC_URL;
      }
      if (originalKey) {
        process.env.BLOCKCHAIN_PRIVATE_KEY = originalKey;
      } else {
        delete process.env.BLOCKCHAIN_PRIVATE_KEY;
      }
    });

    it("should show error message when required checks fail", async () => {
      const originalEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      await program.parseAsync(["node", "test", "dev", "check"]);

      expect(outputError).toHaveBeenCalledWith("Some required checks failed");

      process.env.DATABASE_URL = originalEnv;
    });

    it("should show warning message when only optional checks fail", async () => {
      const originalDbUrl = process.env.DATABASE_URL;
      const originalBcUrl = process.env.BLOCKCHAIN_RPC_URL;
      
      process.env.DATABASE_URL = "postgresql://localhost:5432/test";
      delete process.env.BLOCKCHAIN_RPC_URL;

      await program.parseAsync(["node", "test", "dev", "check"]);

      expect(outputWarning).toHaveBeenCalledWith("All required checks passed with warnings");

      if (originalDbUrl) {
        process.env.DATABASE_URL = originalDbUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
      if (originalBcUrl) {
        process.env.BLOCKCHAIN_RPC_URL = originalBcUrl;
      }
    });

    it("should set output options correctly", async () => {
      await program.parseAsync(["node", "test", "dev", "check", "--json", "--no-color"]);

      expect(setOutputOptions).toHaveBeenCalledWith(
        expect.objectContaining({ json: true, color: false })
      );
    });

    it("should check BLOCKCHAIN_PRIVATE_KEY optional env var", async () => {
      const originalEnv = process.env.BLOCKCHAIN_PRIVATE_KEY;
      delete process.env.BLOCKCHAIN_PRIVATE_KEY;

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string; message: string }> };
      const keyCheck = outputCall.checks.find((c) => c.name === "BLOCKCHAIN_PRIVATE_KEY");
      expect(keyCheck?.status).toBe("warning");
      expect(keyCheck?.message).toContain("optional");

      process.env.BLOCKCHAIN_PRIVATE_KEY = originalEnv;
    });

    it("should show ok when optional env vars are set", async () => {
      const originalRpcUrl = process.env.BLOCKCHAIN_RPC_URL;
      const originalKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
      
      process.env.BLOCKCHAIN_RPC_URL = "http://localhost:8545";
      process.env.BLOCKCHAIN_PRIVATE_KEY = "0x123";

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string }> };
      const rpcCheck = outputCall.checks.find((c) => c.name === "BLOCKCHAIN_RPC_URL");
      const keyCheck = outputCall.checks.find((c) => c.name === "BLOCKCHAIN_PRIVATE_KEY");
      
      expect(rpcCheck?.status).toBe("ok");
      expect(keyCheck?.status).toBe("ok");

      if (originalRpcUrl) {
        process.env.BLOCKCHAIN_RPC_URL = originalRpcUrl;
      } else {
        delete process.env.BLOCKCHAIN_RPC_URL;
      }
      if (originalKey) {
        process.env.BLOCKCHAIN_PRIVATE_KEY = originalKey;
      } else {
        delete process.env.BLOCKCHAIN_PRIVATE_KEY;
      }
    });

    it("should detect Node.js version check passes for Node 18+", async () => {
      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; status: string; message: string }> };
      const nodeCheck = outputCall.checks.find((c) => c.name === "Node.js");
      expect(nodeCheck?.status).toBe("ok");
      expect(nodeCheck?.message).toContain(process.version);
    });

    it("should include database latency in message when connected", async () => {
      mockApiClient.getHealth.mockResolvedValue({
        success: true,
        data: {
          components: {
            database: { status: "up", latencyMs: 12 },
            blockchain: { status: "up" },
          },
        },
      });

      await program.parseAsync(["node", "test", "dev", "check", "--json"]);

      const outputCall = vi.mocked(output).mock.calls[0][0] as { checks: Array<{ name: string; message: string }> };
      const dbCheck = outputCall.checks.find((c) => c.name === "Database");
      expect(dbCheck?.message).toContain("12ms");
    });
  });

  describe("command registration", () => {
    it("should register dev command with description", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      expect(devCmd).toBeDefined();
      expect(devCmd?.description()).toContain("Development");
    });

    it("should have seed subcommand with force option", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      const seedCmd = devCmd?.commands.find((c) => c.name() === "seed");
      expect(seedCmd).toBeDefined();
      
      const forceOption = seedCmd?.options.find((o) => o.long === "--force");
      expect(forceOption).toBeDefined();
    });

    it("should have check subcommand", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      const checkCmd = devCmd?.commands.find((c) => c.name() === "check");
      expect(checkCmd).toBeDefined();
    });

    it("should have --json option on all subcommands", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      
      const startCmd = devCmd?.commands.find((c) => c.name() === "start");
      const seedCmd = devCmd?.commands.find((c) => c.name() === "seed");
      const checkCmd = devCmd?.commands.find((c) => c.name() === "check");
      
      expect(startCmd?.options.find((o) => o.long === "--json")).toBeDefined();
      expect(seedCmd?.options.find((o) => o.long === "--json")).toBeDefined();
      expect(checkCmd?.options.find((o) => o.long === "--json")).toBeDefined();
    });

    it("should have --no-color option on all subcommands", () => {
      const devCmd = program.commands.find((c) => c.name() === "dev");
      
      const startCmd = devCmd?.commands.find((c) => c.name() === "start");
      const seedCmd = devCmd?.commands.find((c) => c.name() === "seed");
      const checkCmd = devCmd?.commands.find((c) => c.name() === "check");
      
      expect(startCmd?.options.find((o) => o.long === "--no-color")).toBeDefined();
      expect(seedCmd?.options.find((o) => o.long === "--no-color")).toBeDefined();
      expect(checkCmd?.options.find((o) => o.long === "--no-color")).toBeDefined();
    });
  });
});
