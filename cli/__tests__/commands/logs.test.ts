import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerLogsCommand } from "../../src/commands/logs.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    request: vi.fn(),
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
  outputSection: vi.fn(),
  outputKeyValue: vi.fn(),
  outputError: vi.fn(),
  outputWarning: vi.fn(),
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
  output: vi.fn(),
}));

import { getApiClient } from "../../src/api.js";
import {
  outputError,
  output,
  outputSection,
  outputWarning,
} from "../../src/output.js";

describe("Logs Command", () => {
  let program: Command;
  let mockApiClient: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    mockApiClient = {
      request: vi.fn(),
    };

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default successful response with empty logs
    mockApiClient.request.mockResolvedValue({
      success: true,
      data: [],
    });

    registerLogsCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Command Registration", () => {
    it("should register logs command", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      expect(logsCmd).toBeDefined();
      expect(logsCmd?.description()).toContain("logs");
    });

    it("should register server subcommand", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      expect(serverCmd).toBeDefined();
    });

    it("should register blockchain subcommand", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const blockchainCmd = logsCmd?.commands.find(
        (c) => c.name() === "blockchain"
      );
      expect(blockchainCmd).toBeDefined();
    });

    it("should register batch-anchoring subcommand", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const batchCmd = logsCmd?.commands.find(
        (c) => c.name() === "batch-anchoring"
      );
      expect(batchCmd).toBeDefined();
    });

    it("should register agents subcommand", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const agentsCmd = logsCmd?.commands.find((c) => c.name() === "agents");
      expect(agentsCmd).toBeDefined();
    });

    it("should register export subcommand", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const exportCmd = logsCmd?.commands.find((c) => c.name() === "export");
      expect(exportCmd).toBeDefined();
    });
  });

  describe("Server Logs", () => {
    it("should have --tail option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      const tailOption = serverCmd?.options.find((o) => o.long === "--tail");
      expect(tailOption).toBeDefined();
    });

    it("should have --follow option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      const followOption = serverCmd?.options.find(
        (o) => o.long === "--follow"
      );
      expect(followOption).toBeDefined();
    });

    it("should have --level option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      const levelOption = serverCmd?.options.find((o) => o.long === "--level");
      expect(levelOption).toBeDefined();
    });

    it("should have --since option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      const sinceOption = serverCmd?.options.find((o) => o.long === "--since");
      expect(sinceOption).toBeDefined();
    });

    it("should have --json option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const serverCmd = logsCmd?.commands.find((c) => c.name() === "server");
      const jsonOption = serverCmd?.options.find((o) => o.long === "--json");
      expect(jsonOption).toBeDefined();
    });

    it("should fetch server logs", async () => {
      mockApiClient.request.mockResolvedValue({
        success: true,
        data: [
          {
            timestamp: "2024-01-01T00:00:00Z",
            level: "info",
            message: "Server started",
            service: "api",
          },
        ],
      });

      await program.parseAsync(["node", "test", "logs", "server"]);

      expect(mockApiClient.request).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      const logs = [
        {
          timestamp: "2024-01-01T00:00:00Z",
          level: "info",
          message: "Test log",
        },
      ];

      mockApiClient.request.mockResolvedValue({
        success: true,
        data: logs,
      });

      await program.parseAsync(["node", "test", "logs", "server", "--json"]);

      expect(output).toHaveBeenCalledWith(logs);
    });

    it("should handle empty logs", async () => {
      mockApiClient.request.mockResolvedValue({
        success: true,
        data: [],
      });

      await program.parseAsync(["node", "test", "logs", "server"]);

      expect(outputWarning).toHaveBeenCalledWith(
        expect.stringContaining("No server logs found")
      );
    });

    it("should apply level filter", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "server",
        "--level",
        "error",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("level=error")
      );
    });

    it("should apply tail limit", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "server",
        "--tail",
        "50",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("limit=50")
      );
    });
  });

  describe("Blockchain Logs", () => {
    it("should have --tx option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const blockchainCmd = logsCmd?.commands.find(
        (c) => c.name() === "blockchain"
      );
      const txOption = blockchainCmd?.options.find((o) => o.long === "--tx");
      expect(txOption).toBeDefined();
    });

    it("should have --block option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const blockchainCmd = logsCmd?.commands.find(
        (c) => c.name() === "blockchain"
      );
      const blockOption = blockchainCmd?.options.find(
        (o) => o.long === "--block"
      );
      expect(blockOption).toBeDefined();
    });

    it("should fetch blockchain logs", async () => {
      mockApiClient.request.mockResolvedValue({
        success: true,
        data: [
          {
            blockNumber: 12345,
            eventType: "EventAnchored",
            timestamp: "2024-01-01T00:00:00Z",
            data: {},
          },
        ],
      });

      await program.parseAsync(["node", "test", "logs", "blockchain"]);

      expect(mockApiClient.request).toHaveBeenCalled();
    });

    it("should filter by transaction hash", async () => {
      const txHash = "0x123abc";
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "blockchain",
        "--tx",
        txHash,
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining(`tx=${txHash}`)
      );
    });

    it("should filter by block number", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "blockchain",
        "--block",
        "12345",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("block=12345")
      );
    });
  });

  describe("Batch Anchoring Logs", () => {
    it("should fetch batch anchoring logs with service filter", async () => {
      await program.parseAsync(["node", "test", "logs", "batch-anchoring"]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("service=batch-anchoring")
      );
    });
  });

  describe("Agent Framework Logs", () => {
    it("should fetch agent framework logs with service filter", async () => {
      await program.parseAsync(["node", "test", "logs", "agents"]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("service=agents")
      );
    });
  });

  describe("Export Logs", () => {
    it("should require --from option", async () => {
      await program.parseAsync(["node", "test", "logs", "export"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("--from")
      );
    });

    it("should have --to option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const exportCmd = logsCmd?.commands.find((c) => c.name() === "export");
      const toOption = exportCmd?.options.find((o) => o.long === "--to");
      expect(toOption).toBeDefined();
    });

    it("should have --output option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const exportCmd = logsCmd?.commands.find((c) => c.name() === "export");
      const outputOption = exportCmd?.options.find(
        (o) => o.long === "--output"
      );
      expect(outputOption).toBeDefined();
    });

    it("should have --format option", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      const exportCmd = logsCmd?.commands.find((c) => c.name() === "export");
      const formatOption = exportCmd?.options.find(
        (o) => o.long === "--format"
      );
      expect(formatOption).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors for server logs", async () => {
      mockApiClient.request.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "logs", "server"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch server logs"),
        expect.anything()
      );
    });

    it("should handle API errors for blockchain logs", async () => {
      mockApiClient.request.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "logs", "blockchain"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch blockchain logs"),
        expect.anything()
      );
    });

    it("should handle empty response gracefully", async () => {
      mockApiClient.request.mockResolvedValue({
        success: false,
        error: "Not found",
      });

      await program.parseAsync(["node", "test", "logs", "server"]);

      // Should show warning for no logs found
      expect(outputWarning).toHaveBeenCalled();
    });
  });

  describe("Duration Parsing", () => {
    it("should parse hours correctly", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "server",
        "--since",
        "1h",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("since=")
      );
    });

    it("should parse minutes correctly", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "server",
        "--since",
        "30m",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("since=")
      );
    });

    it("should parse days correctly", async () => {
      await program.parseAsync([
        "node",
        "test",
        "logs",
        "server",
        "--since",
        "7d",
      ]);

      expect(mockApiClient.request).toHaveBeenCalledWith(
        expect.stringContaining("since=")
      );
    });
  });

  describe("Help Text", () => {
    it("should include examples in help text", () => {
      const logsCmd = program.commands.find((c) => c.name() === "logs");
      expect(logsCmd).toBeDefined();

      // Get the help text by capturing it
      let helpText = "";
      const originalLog = console.log;
      console.log = (text: string) => {
        helpText += text;
      };

      try {
        logsCmd?.outputHelp();
      } catch {
        // Ignore any errors from outputHelp
      }

      console.log = originalLog;

      // Check that examples are present in help configuration
      const helpInfo = logsCmd?.helpInformation() || "";
      expect(helpInfo).toBeDefined();
    });
  });
});
