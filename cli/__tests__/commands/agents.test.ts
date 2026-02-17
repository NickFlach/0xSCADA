import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerAgentsCommand } from "../../src/commands/agents.js";

// Mock dependencies
vi.mock("../../src/api.js", () => ({
  getApiClient: vi.fn(() => ({
    getAgents: vi.fn(),
    getAgentById: vi.fn(),
    getAgentState: vi.fn(),
    getAgentOutputs: vi.fn(),
    getAgentLogs: vi.fn(),
    startAgent: vi.fn(),
    stopAgent: vi.fn(),
    setAgentConfig: vi.fn(),
    getProposals: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
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
  outputInfo: vi.fn(),
  formatDate: vi.fn((d) => new Date(d).toISOString()),
  truncate: vi.fn((s: string, len: number) => s?.substring(0, len) || ""),
  formatBoolean: vi.fn((v) => (v ? "Yes" : "No")),
  statusIcon: vi.fn((s) => (s === "ACTIVE" ? "[OK]" : "[X]")),
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
import {
  output,
  outputTable,
  outputError,
  outputSuccess,
  outputWarning,
  outputSection,
  outputKeyValue,
  outputInfo,
} from "../../src/output.js";

describe("Agents Command", () => {
  let program: Command;
  const mockApiClient = {
    getAgents: vi.fn(),
    getAgentById: vi.fn(),
    getAgentState: vi.fn(),
    getAgentOutputs: vi.fn(),
    getAgentLogs: vi.fn(),
    startAgent: vi.fn(),
    stopAgent: vi.fn(),
    setAgentConfig: vi.fn(),
    getProposals: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
  };

  const mockAgents = [
    {
      id: "agent-ops-001",
      name: "ops-agent",
      displayName: "Operations Agent",
      agentType: "OPS",
      status: "ACTIVE",
      capabilities: ["READ_EVENTS", "SUMMARIZE", "ANALYZE_ANOMALIES"],
      scope: {
        allSites: true,
        siteIds: [],
        allEventTypes: true,
        eventTypes: [],
      },
      publicKey: "0xpubkey123",
      version: "1.0.0",
      createdAt: "2024-01-15T10:00:00Z",
      lastActiveAt: "2024-01-15T15:30:00Z",
      errorCount: 0,
    },
    {
      id: "agent-cc-001",
      name: "change-control-agent",
      displayName: "Change Control Agent",
      agentType: "CHANGE_CONTROL",
      status: "INACTIVE",
      capabilities: ["READ_BLUEPRINTS", "GENERATE_CODE", "PROPOSE_CHANGES"],
      scope: {
        allSites: false,
        siteIds: ["site-001"],
        allEventTypes: false,
        eventTypes: ["BLUEPRINT_CHANGE"],
      },
      publicKey: "0xpubkey456",
      version: "1.0.0",
      createdAt: "2024-01-15T09:00:00Z",
      lastActiveAt: null,
      errorCount: 0,
    },
    {
      id: "agent-comp-001",
      name: "compliance-agent",
      displayName: "Compliance Agent",
      agentType: "COMPLIANCE",
      status: "ERROR",
      capabilities: ["VERIFY_ANCHORS", "VERIFY_COMPLIANCE", "GENERATE_REPORTS"],
      scope: {
        allSites: true,
        siteIds: [],
        allEventTypes: true,
        eventTypes: [],
      },
      publicKey: "0xpubkey789",
      version: "1.0.0",
      createdAt: "2024-01-15T08:00:00Z",
      lastActiveAt: "2024-01-15T14:00:00Z",
      errorCount: 3,
      lastError: "Connection timeout",
    },
  ];

  const mockProposals = [
    {
      id: "prop-001",
      agentId: "agent-cc-001",
      proposalType: "BLUEPRINT_CHANGE",
      title: "Update valve control logic",
      description: "Modify the valve control module to improve response time",
      action: { moduleId: "cm-valve-001", changes: {} },
      reasoning: "Performance analysis suggests 20% improvement possible",
      confidence: 85,
      supportingEventIds: ["evt-001", "evt-002"],
      riskLevel: "MEDIUM",
      riskFactors: ["Affects production system"],
      hash: "0xhash123",
      signature: "0xsig123",
      status: "PENDING_APPROVAL",
      requiredApprovals: 2,
      approvals: [
        {
          userId: "user-001",
          userName: "John Doe",
          decision: "APPROVE",
          comment: "Looks good",
          signature: "0xsig456",
          decidedAt: "2024-01-15T12:00:00Z",
        },
      ],
      createdAt: "2024-01-15T11:00:00Z",
      expiresAt: "2024-01-16T11:00:00Z",
    },
    {
      id: "prop-002",
      agentId: "agent-ops-001",
      proposalType: "MAINTENANCE",
      title: "Schedule preventive maintenance",
      description: "Recommend maintenance for pump P-101",
      action: { assetId: "pump-101", maintenanceType: "preventive" },
      reasoning: "Operating hours exceeded threshold",
      confidence: 92,
      supportingEventIds: ["evt-003"],
      riskLevel: "LOW",
      riskFactors: [],
      hash: "0xhash456",
      signature: "0xsig789",
      status: "APPROVED",
      requiredApprovals: 1,
      approvals: [
        {
          userId: "user-002",
          userName: "Jane Smith",
          decision: "APPROVE",
          comment: "Approved",
          signature: "0xsig012",
          decidedAt: "2024-01-15T13:00:00Z",
        },
      ],
      createdAt: "2024-01-15T12:00:00Z",
      executedAt: "2024-01-15T13:30:00Z",
      executionResult: { success: true },
    },
  ];

  const mockAgentState = [
    { key: "lastProcessedEventId", value: "evt-100", updatedAt: "2024-01-15T15:00:00Z" },
    { key: "anomalyThreshold", value: 0.85, updatedAt: "2024-01-15T10:00:00Z" },
  ];

  const mockAgentLogs = [
    { id: "log-001", agentId: "agent-ops-001", action: "START", details: {}, timestamp: "2024-01-15T10:00:00Z" },
    { id: "log-002", agentId: "agent-ops-001", action: "EVENT_PROCESSED", details: { eventId: "evt-001" }, timestamp: "2024-01-15T11:00:00Z" },
    { id: "log-003", agentId: "agent-ops-001", action: "OUTPUT_CREATED", details: { outputId: "out-001" }, timestamp: "2024-01-15T12:00:00Z" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();

    vi.mocked(getApiClient).mockReturnValue(mockApiClient as any);

    // Default mock responses
    mockApiClient.getAgents.mockResolvedValue({ success: true, data: mockAgents });
    mockApiClient.getAgentById.mockResolvedValue({ success: true, data: mockAgents[0] });
    mockApiClient.getAgentState.mockResolvedValue({ success: true, data: mockAgentState });
    mockApiClient.getAgentOutputs.mockResolvedValue({ success: true, data: [] });
    mockApiClient.getAgentLogs.mockResolvedValue({ success: true, data: mockAgentLogs });
    mockApiClient.startAgent.mockResolvedValue({ success: true });
    mockApiClient.stopAgent.mockResolvedValue({ success: true });
    mockApiClient.setAgentConfig.mockResolvedValue({ success: true });
    mockApiClient.getProposals.mockResolvedValue({ success: true, data: mockProposals });
    mockApiClient.approveProposal.mockResolvedValue({
      success: true,
      data: { ...mockProposals[0], status: "APPROVED" },
    });
    mockApiClient.rejectProposal.mockResolvedValue({
      success: true,
      data: { ...mockProposals[0], status: "REJECTED" },
    });

    registerAgentsCommand(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // AGENTS LIST
  // ===========================================================================

  describe("agents list", () => {
    it("should register agents command with list subcommand", () => {
      const agentsCmd = program.commands.find((c) => c.name() === "agents");
      expect(agentsCmd).toBeDefined();

      const listCmd = agentsCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all agents", async () => {
      await program.parseAsync(["node", "test", "agents", "list"]);

      expect(mockApiClient.getAgents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter agents by type", async () => {
      await program.parseAsync(["node", "test", "agents", "list", "--type", "OPS"]);

      expect(mockApiClient.getAgents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter agents by status", async () => {
      await program.parseAsync(["node", "test", "agents", "list", "--status", "ACTIVE"]);

      expect(mockApiClient.getAgents).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAgents);
    });

    it("should handle empty agents list", async () => {
      mockApiClient.getAgents.mockResolvedValue({ success: true, data: [] });

      await program.parseAsync(["node", "test", "agents", "list"]);

      expect(outputTable).not.toHaveBeenCalled();
    });

    it("should handle API errors", async () => {
      mockApiClient.getAgents.mockResolvedValue({ success: false, error: "Failed to fetch agents" });

      await program.parseAsync(["node", "test", "agents", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch agents"),
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // AGENTS STATUS
  // ===========================================================================

  describe("agents status", () => {
    it("should register status subcommand", () => {
      const agentsCmd = program.commands.find((c) => c.name() === "agents");
      const statusCmd = agentsCmd?.commands.find((c) => c.name() === "status");
      expect(statusCmd).toBeDefined();
    });

    it("should show agent status", async () => {
      await program.parseAsync(["node", "test", "agents", "status", "agent-ops-001"]);

      expect(mockApiClient.getAgentById).toHaveBeenCalledWith("agent-ops-001");
      expect(mockApiClient.getAgentState).toHaveBeenCalledWith("agent-ops-001");
      expect(mockApiClient.getAgentOutputs).toHaveBeenCalledWith("agent-ops-001");
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "status", "agent-ops-001", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        agent: mockAgents[0],
        state: mockAgentState,
      }));
    });

    it("should handle agent not found", async () => {
      mockApiClient.getAgentById.mockResolvedValue({ success: false, error: "Agent not found" });

      await program.parseAsync(["node", "test", "agents", "status", "invalid-agent"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Agent not found"),
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // AGENTS LOGS
  // ===========================================================================

  describe("agents logs", () => {
    it("should register logs subcommand", () => {
      const agentsCmd = program.commands.find((c) => c.name() === "agents");
      const logsCmd = agentsCmd?.commands.find((c) => c.name() === "logs");
      expect(logsCmd).toBeDefined();
    });

    it("should show agent logs", async () => {
      await program.parseAsync(["node", "test", "agents", "logs", "agent-ops-001"]);

      expect(mockApiClient.getAgentLogs).toHaveBeenCalledWith("agent-ops-001", 50);
      expect(outputSection).toHaveBeenCalled();
    });

    it("should respect --tail option", async () => {
      await program.parseAsync(["node", "test", "agents", "logs", "agent-ops-001", "--tail", "100"]);

      expect(mockApiClient.getAgentLogs).toHaveBeenCalledWith("agent-ops-001", 100);
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "logs", "agent-ops-001", "--json"]);

      expect(output).toHaveBeenCalledWith(mockAgentLogs);
    });
  });

  // ===========================================================================
  // AGENTS START/STOP/RESTART
  // ===========================================================================

  describe("agents start", () => {
    it("should start an agent", async () => {
      await program.parseAsync(["node", "test", "agents", "start", "agent-ops-001"]);

      expect(mockApiClient.startAgent).toHaveBeenCalledWith("agent-ops-001");
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("started successfully"));
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "start", "agent-ops-001", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        agentId: "agent-ops-001",
        status: "ACTIVE",
      }));
    });

    it("should handle start failure", async () => {
      mockApiClient.startAgent.mockResolvedValue({ success: false, error: "Agent already running" });

      await program.parseAsync(["node", "test", "agents", "start", "agent-ops-001"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start agent"),
        expect.anything()
      );
    });
  });

  describe("agents stop", () => {
    it("should stop an agent", async () => {
      await program.parseAsync(["node", "test", "agents", "stop", "agent-ops-001"]);

      expect(mockApiClient.stopAgent).toHaveBeenCalledWith("agent-ops-001");
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("stopped successfully"));
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "stop", "agent-ops-001", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        agentId: "agent-ops-001",
        status: "INACTIVE",
      }));
    });
  });

  describe("agents restart", () => {
    it("should restart an agent", async () => {
      await program.parseAsync(["node", "test", "agents", "restart", "agent-ops-001"]);

      expect(mockApiClient.stopAgent).toHaveBeenCalledWith("agent-ops-001");
      expect(mockApiClient.startAgent).toHaveBeenCalledWith("agent-ops-001");
      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("restarted successfully"));
    });
  });

  // ===========================================================================
  // AGENTS CONFIG
  // ===========================================================================

  describe("agents config", () => {
    it("should show agent configuration", async () => {
      await program.parseAsync(["node", "test", "agents", "config", "agent-ops-001"]);

      expect(mockApiClient.getAgentById).toHaveBeenCalledWith("agent-ops-001");
      expect(outputSection).toHaveBeenCalled();
    });

    it("should set configuration value", async () => {
      await program.parseAsync(["node", "test", "agents", "config", "agent-ops-001", "--set", "threshold=0.9"]);

      expect(mockApiClient.setAgentConfig).toHaveBeenCalledWith("agent-ops-001", "threshold", "0.9");
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should handle invalid --set format", async () => {
      await program.parseAsync(["node", "test", "agents", "config", "agent-ops-001", "--set", "invalid"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid format"),
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // PROPOSALS LIST
  // ===========================================================================

  describe("agents proposals list", () => {
    it("should register proposals subcommand", () => {
      const agentsCmd = program.commands.find((c) => c.name() === "agents");
      const proposalsCmd = agentsCmd?.commands.find((c) => c.name() === "proposals");
      expect(proposalsCmd).toBeDefined();

      const listCmd = proposalsCmd?.commands.find((c) => c.name() === "list");
      expect(listCmd).toBeDefined();
    });

    it("should list all proposals", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "list"]);

      expect(mockApiClient.getProposals).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter proposals by status", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "list", "--status", "PENDING_APPROVAL"]);

      expect(mockApiClient.getProposals).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should filter proposals by agent", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "list", "--agent", "agent-cc-001"]);

      expect(mockApiClient.getProposals).toHaveBeenCalled();
      expect(outputTable).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "list", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ id: "prop-001" }),
      ]));
    });
  });

  // ===========================================================================
  // PROPOSALS SHOW
  // ===========================================================================

  describe("agents proposals show", () => {
    it("should show proposal details", async () => {
      mockApiClient.getProposals.mockResolvedValue({ success: true, data: mockProposals });

      await program.parseAsync(["node", "test", "agents", "proposals", "show", "prop-001"]);

      expect(mockApiClient.getProposals).toHaveBeenCalled();
      expect(outputSection).toHaveBeenCalled();
      expect(outputKeyValue).toHaveBeenCalled();
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "show", "prop-001", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "prop-001" }));
    });

    it("should show action hint for pending proposals", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "show", "prop-001"]);

      expect(outputInfo).toHaveBeenCalled();
    });

    it("should handle proposal not found", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "show", "invalid-prop"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Proposal not found"),
        expect.anything()
      );
    });
  });

  // ===========================================================================
  // PROPOSALS APPROVE
  // ===========================================================================

  describe("agents proposals approve", () => {
    it("should approve a proposal", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "approve", "prop-001"]);

      expect(mockApiClient.approveProposal).toHaveBeenCalledWith("prop-001", expect.objectContaining({
        userId: "CLI_USER",
        userName: "CLI User",
      }));
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should include comment when provided", async () => {
      await program.parseAsync([
        "node", "test", "agents", "proposals", "approve", "prop-001",
        "--comment", "LGTM"
      ]);

      expect(mockApiClient.approveProposal).toHaveBeenCalledWith("prop-001", expect.objectContaining({
        comment: "LGTM",
      }));
    });

    it("should use custom user ID when provided", async () => {
      await program.parseAsync([
        "node", "test", "agents", "proposals", "approve", "prop-001",
        "--user", "custom-user"
      ]);

      expect(mockApiClient.approveProposal).toHaveBeenCalledWith("prop-001", expect.objectContaining({
        userId: "custom-user",
        userName: "custom-user",
      }));
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync(["node", "test", "agents", "proposals", "approve", "prop-001", "--json"]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        status: "APPROVED",
      }));
    });

    it("should indicate when proposal is fully approved", async () => {
      mockApiClient.approveProposal.mockResolvedValue({
        success: true,
        data: { ...mockProposals[0], status: "APPROVED" },
      });

      await program.parseAsync(["node", "test", "agents", "proposals", "approve", "prop-001"]);

      expect(outputSuccess).toHaveBeenCalledWith(expect.stringContaining("fully approved"));
    });
  });

  // ===========================================================================
  // PROPOSALS REJECT
  // ===========================================================================

  describe("agents proposals reject", () => {
    it("should reject a proposal with reason", async () => {
      await program.parseAsync([
        "node", "test", "agents", "proposals", "reject", "prop-001",
        "--reason", "Not needed at this time"
      ]);

      expect(mockApiClient.rejectProposal).toHaveBeenCalledWith("prop-001", expect.objectContaining({
        userId: "CLI_USER",
        userName: "CLI User",
        comment: "Not needed at this time",
      }));
      expect(outputSuccess).toHaveBeenCalled();
    });

    it("should require --reason option", async () => {
      try {
        await program.parseAsync([
          "node", "test", "agents", "proposals", "reject", "prop-001"
        ]);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("should output JSON when --json flag is provided", async () => {
      await program.parseAsync([
        "node", "test", "agents", "proposals", "reject", "prop-001",
        "--reason", "Not needed",
        "--json"
      ]);

      expect(output).toHaveBeenCalledWith(expect.objectContaining({
        status: "REJECTED",
      }));
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe("error handling", () => {
    it("should handle network errors in agents list", async () => {
      mockApiClient.getAgents.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "agents", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });

    it("should handle network errors in proposals", async () => {
      mockApiClient.getProposals.mockRejectedValue(new Error("Network error"));

      await program.parseAsync(["node", "test", "agents", "proposals", "list"]);

      expect(outputError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to connect"),
        expect.anything()
      );
    });
  });
});
