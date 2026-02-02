import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerStatusCommand } from "../../src/commands/status.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getHealth: vi.fn(),
    getBlockchainStatus: vi.fn(),
    getBlueprintsSummary: vi.fn(),
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
  statusIcon: vi.fn((status) => status === "up" ? "●" : "○"),
  formatUptime: vi.fn((s) => `${s}s`),
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
import { outputError, output, outputSection, outputKeyValue } from "../../src/output.js";

describe("Status Command", () => {
  let program: Command;
  const mockApiClient = {
    getHealth: vi.fn(),
    getBlockchainStatus: vi.fn(),
    getBlueprintsSummary: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    
    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default successful responses
    mockApiClient.getHealth.mockResolvedValue({
      success: true,
      data: {
        status: "healthy",
        timestamp: "2024-01-01T00:00:00Z",
        version: "1.0.0",
        uptime: 3600,
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

    mockApiClient.getBlueprintsSummary.mockResolvedValue({
      success: true,
      data: {
        controlModuleTypes: 5,
        controlModuleInstances: 20,
        unitTypes: 3,
        unitInstances: 10,
        phaseTypes: 8,
        phaseInstances: 40,
        vendors: 2,
      },
    });

    registerStatusCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should register status command", () => {
    const statusCmd = program.commands.find((c) => c.name() === "status");
    expect(statusCmd).toBeDefined();
    expect(statusCmd?.description()).toContain("health");
  });

  it("should have --json option", () => {
    const statusCmd = program.commands.find((c) => c.name() === "status");
    const jsonOption = statusCmd?.options.find((o) => o.long === "--json");
    expect(jsonOption).toBeDefined();
  });

  it("should have --no-color option", () => {
    const statusCmd = program.commands.find((c) => c.name() === "status");
    const colorOption = statusCmd?.options.find((o) => o.long === "--no-color");
    expect(colorOption).toBeDefined();
  });

  it("should fetch health, blockchain, and blueprints status", async () => {
    await program.parseAsync(["node", "test", "status"]);

    expect(mockApiClient.getHealth).toHaveBeenCalled();
    expect(mockApiClient.getBlockchainStatus).toHaveBeenCalled();
    expect(mockApiClient.getBlueprintsSummary).toHaveBeenCalled();
  });

  it("should output sections for each status area", async () => {
    await program.parseAsync(["node", "test", "status"]);

    expect(outputSection).toHaveBeenCalled();
    expect(outputKeyValue).toHaveBeenCalled();
  });

  it("should output JSON when --json flag is provided", async () => {
    await program.parseAsync(["node", "test", "status", "--json"]);

    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        health: expect.anything(),
        blockchain: expect.anything(),
        blueprints: expect.anything(),
      })
    );
  });

  it("should handle health check failure", async () => {
    mockApiClient.getHealth.mockResolvedValue({
      success: false,
      error: "Connection refused",
    });

    await program.parseAsync(["node", "test", "status"]);

    expect(outputError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch health"),
      expect.anything()
    );
  });

  it("should handle network errors gracefully", async () => {
    mockApiClient.getHealth.mockRejectedValue(new Error("Network error"));
    mockApiClient.getBlockchainStatus.mockRejectedValue(new Error("Network error"));
    mockApiClient.getBlueprintsSummary.mockRejectedValue(new Error("Network error"));

    await program.parseAsync(["node", "test", "status"]);

    expect(outputError).toHaveBeenCalled();
  });

  it("should display blockchain status when enabled", async () => {
    await program.parseAsync(["node", "test", "status"]);

    expect(outputKeyValue).toHaveBeenCalled();
  });

  it("should display blockchain status when disabled", async () => {
    mockApiClient.getBlockchainStatus.mockResolvedValue({
      success: true,
      data: { enabled: false },
    });

    await program.parseAsync(["node", "test", "status"]);

    expect(outputKeyValue).toHaveBeenCalled();
  });

  it("should handle blueprints fetch failure gracefully", async () => {
    mockApiClient.getBlueprintsSummary.mockResolvedValue({
      success: false,
      error: "Not available",
    });

    await program.parseAsync(["node", "test", "status"]);

    // Should still complete without crashing
    expect(outputSection).toHaveBeenCalled();
  });
});
