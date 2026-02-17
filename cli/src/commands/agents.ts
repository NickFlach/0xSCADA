/**
 * 0xSCADA CLI - Agents Command
 *
 * Governance agent management for autonomous decision-making.
 * Supports Ops, ChangeControl, and Compliance agents.
 *
 * Issue #90: [CLI] Add 'agents' command for governance agent management
 */

import { Command } from "commander";
import ora from "ora";
import { getApiClient, type Agent } from "../api.js";
import {
  output,
  outputTable,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputInfo,
  formatDate,
  truncate,
  setOutputOptions,
  colors,
  formatBoolean,
} from "../output.js";

// Re-export Agent type for consumers
export type { Agent } from "../api.js";

export interface AgentProposal {
  id: string;
  agentId: string;
  proposalType: string;
  title: string;
  description: string;
  action: unknown;
  reasoning: string;
  confidence: number;
  supportingEventIds: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  riskFactors: string[];
  hash: string;
  signature: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";
  requiredApprovals: number;
  approvals: Array<{
    userId: string;
    userName: string;
    decision: "APPROVE" | "REJECT";
    comment?: string;
    signature: string;
    decidedAt: string;
  }>;
  createdAt: string;
  expiresAt?: string;
  executedAt?: string;
  executionResult?: unknown;
  executionError?: string;
}

export interface AgentOutput {
  id: string;
  agentId: string;
  outputType: string;
  title: string;
  content: unknown;
  siteId?: string;
  assetIds?: string[];
  eventIds?: string[];
  hash: string;
  signature: string;
  confidence?: number;
  reasoning?: string;
  createdAt: string;
}

export interface AgentState {
  key: string;
  value: unknown;
  updatedAt?: string;
  expiresAt?: string;
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command("agents")
    .description("Manage governance agents (Ops, ChangeControl, Compliance)");

  // ---------------------------------------------------------------------------
  // List agents
  // ---------------------------------------------------------------------------
  agents
    .command("list")
    .description("List all governance agents")
    .option("--type <type>", "Filter by agent type (OPS, CHANGE_CONTROL, COMPLIANCE)")
    .option("--status <status>", "Filter by status (ACTIVE, INACTIVE, SUSPENDED, ERROR)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching agents...").start();
      const api = getApiClient();

      try {
        const response = await api.getAgents();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch agents", response.error);
          return;
        }

        let agentList = response.data;

        // Apply filters
        if (options.type) {
          agentList = agentList.filter((a: Agent) =>
            a.agentType.toUpperCase().includes(options.type.toUpperCase())
          );
        }
        if (options.status) {
          agentList = agentList.filter(
            (a: Agent) => a.status.toUpperCase() === options.status.toUpperCase()
          );
        }

        if (options.json) {
          output(agentList);
          return;
        }

        if (agentList.length === 0) {
          console.log(colors.dim("No agents found matching criteria."));
          return;
        }

        outputTable(
          ["ID", "Name", "Type", "Status", "Last Active", "Errors"],
          agentList.map((agent: Agent) => [
            truncate(agent.id, 12),
            agent.displayName || agent.name,
            agent.agentType,
            formatAgentStatus(agent.status),
            agent.lastActiveAt ? formatDate(agent.lastActiveAt) : colors.dim("Never"),
            String(agent.errorCount || 0),
          ])
        );

        console.log();
        console.log(colors.dim(`Total: ${agentList.length} agent(s)`));
      } catch (error) {
        spinner?.fail("Failed to fetch agents");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Get agent status
  // ---------------------------------------------------------------------------
  agents
    .command("status <agent-id>")
    .description("Show detailed status for an agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching agent status...").start();
      const api = getApiClient();

      try {
        const [agentResponse, stateResponse, outputsResponse] = await Promise.all([
          api.getAgentById(agentId),
          api.getAgentState(agentId),
          api.getAgentOutputs(agentId),
        ]);

        spinner?.stop();

        if (!agentResponse.success || !agentResponse.data) {
          outputError("Agent not found", agentResponse.error);
          return;
        }

        const agent = agentResponse.data;

        if (options.json) {
          output({
            agent,
            state: stateResponse.data || [],
            recentOutputs: outputsResponse.data?.slice(0, 5) || [],
          });
          return;
        }

        outputSection("Agent Information");
        outputKeyValue([
          { key: "ID", value: agent.id },
          { key: "Name", value: agent.displayName || agent.name },
          { key: "Type", value: agent.agentType },
          { key: "Status", value: formatAgentStatus(agent.status) },
          { key: "Version", value: agent.version || colors.dim("N/A") },
          { key: "Public Key", value: truncate(agent.publicKey, 32) },
        ]);

        outputSection("Runtime");
        outputKeyValue([
          {
            key: "Last Active",
            value: agent.lastActiveAt ? formatDate(agent.lastActiveAt) : colors.dim("Never"),
          },
          { key: "Error Count", value: String(agent.errorCount || 0) },
          {
            key: "Last Error",
            value: agent.lastError || colors.dim("None"),
          },
        ]);

        outputSection("Capabilities");
        if (agent.capabilities && agent.capabilities.length > 0) {
          agent.capabilities.forEach((cap: string) => {
            console.log(`  ${colors.cyan("+")} ${cap}`);
          });
        } else {
          console.log(colors.dim("  No capabilities defined"));
        }

        outputSection("Scope");
        const scope = agent.scope || {};
        outputKeyValue([
          { key: "All Sites", value: formatBoolean(scope.allSites || false) },
          { key: "Sites", value: scope.siteIds?.join(", ") || colors.dim("None") },
          { key: "All Assets", value: formatBoolean(scope.allAssets || false) },
          { key: "Asset Types", value: scope.assetTypes?.join(", ") || colors.dim("None") },
          { key: "All Event Types", value: formatBoolean(scope.allEventTypes || false) },
          { key: "Event Types", value: scope.eventTypes?.join(", ") || colors.dim("None") },
        ]);

        if (stateResponse.success && stateResponse.data && stateResponse.data.length > 0) {
          outputSection("State");
          stateResponse.data.slice(0, 5).forEach((entry: AgentState) => {
            const value = typeof entry.value === "object"
              ? JSON.stringify(entry.value)
              : String(entry.value);
            console.log(`  ${colors.dim(entry.key)}: ${truncate(value, 50)}`);
          });
        }

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch agent status");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Get agent logs
  // ---------------------------------------------------------------------------
  agents
    .command("logs <agent-id>")
    .description("Show agent activity logs")
    .option("--tail <n>", "Number of log entries to show", "50")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching agent logs...").start();
      const api = getApiClient();
      const limit = parseInt(options.tail, 10);

      try {
        const response = await api.getAgentLogs(agentId, limit);
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch logs", response.error);
          return;
        }

        const logs = response.data;

        if (options.json) {
          output(logs);
          return;
        }

        if (logs.length === 0) {
          console.log(colors.dim("No log entries found."));
          return;
        }

        outputSection(`Agent Logs (${logs.length} entries)`);
        logs.forEach((entry: any) => {
          const timestamp = formatDate(entry.timestamp);
          const action = formatLogAction(entry.action);
          const details = entry.details ? JSON.stringify(entry.details) : "";
          console.log(`  ${colors.dim(timestamp)} ${action} ${details}`);
        });

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch logs");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Start agent
  // ---------------------------------------------------------------------------
  agents
    .command("start <agent-id>")
    .description("Start a governance agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Starting agent...").start();
      const api = getApiClient();

      try {
        const response = await api.startAgent(agentId);
        spinner?.stop();

        if (!response.success) {
          outputError("Failed to start agent", response.error);
          return;
        }

        if (options.json) {
          output({ success: true, agentId, status: "ACTIVE" });
          return;
        }

        outputSuccess(`Agent ${agentId} started successfully`);
      } catch (error) {
        spinner?.fail("Failed to start agent");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Stop agent
  // ---------------------------------------------------------------------------
  agents
    .command("stop <agent-id>")
    .description("Stop a governance agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Stopping agent...").start();
      const api = getApiClient();

      try {
        const response = await api.stopAgent(agentId);
        spinner?.stop();

        if (!response.success) {
          outputError("Failed to stop agent", response.error);
          return;
        }

        if (options.json) {
          output({ success: true, agentId, status: "INACTIVE" });
          return;
        }

        outputSuccess(`Agent ${agentId} stopped successfully`);
      } catch (error) {
        spinner?.fail("Failed to stop agent");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Restart agent
  // ---------------------------------------------------------------------------
  agents
    .command("restart <agent-id>")
    .description("Restart a governance agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Restarting agent...").start();
      const api = getApiClient();

      try {
        // Stop then start
        await api.stopAgent(agentId);
        if (spinner) spinner.text = "Starting agent...";
        const response = await api.startAgent(agentId);
        spinner?.stop();

        if (!response.success) {
          outputError("Failed to restart agent", response.error);
          return;
        }

        if (options.json) {
          output({ success: true, agentId, status: "ACTIVE", restarted: true });
          return;
        }

        outputSuccess(`Agent ${agentId} restarted successfully`);
      } catch (error) {
        spinner?.fail("Failed to restart agent");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // ---------------------------------------------------------------------------
  // Agent config
  // ---------------------------------------------------------------------------
  agents
    .command("config <agent-id>")
    .description("View or update agent configuration")
    .option("--set <key=value>", "Set a configuration value")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const api = getApiClient();

      if (options.set) {
        // Set configuration
        const spinner = options.json ? null : ora("Updating agent configuration...").start();

        try {
          const [key, ...valueParts] = options.set.split("=");
          const value = valueParts.join("=");

          if (!key || value === undefined) {
            spinner?.stop();
            outputError("Invalid format", "Use --set key=value");
            return;
          }

          const response = await api.setAgentConfig(agentId, key, value);
          spinner?.stop();

          if (!response.success) {
            outputError("Failed to update configuration", response.error);
            return;
          }

          if (options.json) {
            output({ success: true, agentId, key, value });
            return;
          }

          outputSuccess(`Configuration updated: ${key} = ${value}`);
        } catch (error) {
          spinner?.fail("Failed to update configuration");
          outputError(
            "Failed to connect to server",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      } else {
        // View configuration
        const spinner = options.json ? null : ora("Fetching agent configuration...").start();

        try {
          const response = await api.getAgentById(agentId);
          spinner?.stop();

          if (!response.success || !response.data) {
            outputError("Agent not found", response.error);
            return;
          }

          const agent = response.data;

          if (options.json) {
            output({
              id: agent.id,
              name: agent.name,
              displayName: agent.displayName,
              agentType: agent.agentType,
              capabilities: agent.capabilities,
              scope: agent.scope,
            });
            return;
          }

          outputSection("Agent Configuration");
          outputKeyValue([
            { key: "ID", value: agent.id },
            { key: "Name", value: agent.name },
            { key: "Display Name", value: agent.displayName || colors.dim("Not set") },
            { key: "Type", value: agent.agentType },
          ]);

          outputSection("Capabilities");
          if (agent.capabilities && agent.capabilities.length > 0) {
            agent.capabilities.forEach((cap: string) => {
              console.log(`  ${colors.cyan("+")} ${cap}`);
            });
          } else {
            console.log(colors.dim("  No capabilities defined"));
          }

          outputSection("Scope");
          console.log(JSON.stringify(agent.scope, null, 2).split("\n").map((l: string) => "  " + l).join("\n"));

          console.log();
        } catch (error) {
          spinner?.fail("Failed to fetch configuration");
          outputError(
            "Failed to connect to server",
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      }
    });

  // ---------------------------------------------------------------------------
  // Proposals command group
  // ---------------------------------------------------------------------------
  const proposals = agents
    .command("proposals")
    .description("Manage agent proposals");

  // List proposals
  proposals
    .command("list")
    .description("List all proposals")
    .option("--status <status>", "Filter by status (PENDING_APPROVAL, APPROVED, REJECTED, EXPIRED, EXECUTED, FAILED)")
    .option("--agent <agentId>", "Filter by agent ID")
    .option("--limit <n>", "Number of proposals to show", "20")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching proposals...").start();
      const api = getApiClient();

      try {
        const response = await api.getProposals();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch proposals", response.error);
          return;
        }

        let proposalList = response.data;

        // Apply filters
        if (options.status) {
          proposalList = proposalList.filter(
            (p: AgentProposal) => p.status.toUpperCase() === options.status.toUpperCase()
          );
        }
        if (options.agent) {
          proposalList = proposalList.filter(
            (p: AgentProposal) => p.agentId === options.agent
          );
        }

        // Apply limit
        const limit = parseInt(options.limit, 10);
        proposalList = proposalList.slice(0, limit);

        if (options.json) {
          output(proposalList);
          return;
        }

        if (proposalList.length === 0) {
          console.log(colors.dim("No proposals found matching criteria."));
          return;
        }

        outputTable(
          ["ID", "Title", "Type", "Risk", "Status", "Approvals", "Created"],
          proposalList.map((p: AgentProposal) => [
            truncate(p.id, 12),
            truncate(p.title, 30),
            p.proposalType,
            formatRiskLevel(p.riskLevel),
            formatProposalStatus(p.status),
            `${p.approvals?.length || 0}/${p.requiredApprovals}`,
            formatDate(p.createdAt),
          ])
        );

        console.log();
        console.log(colors.dim(`Total: ${proposalList.length} proposal(s)`));
      } catch (error) {
        spinner?.fail("Failed to fetch proposals");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Show proposal details
  proposals
    .command("show <proposal-id>")
    .description("Show proposal details")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (proposalId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching proposal...").start();
      const api = getApiClient();

      try {
        const response = await api.getProposalById(proposalId);
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Proposal not found", response.error);
          return;
        }

        const proposal = response.data;

        if (options.json) {
          output(proposal);
          return;
        }

        outputSection("Proposal Details");
        outputKeyValue([
          { key: "ID", value: proposal.id },
          { key: "Title", value: proposal.title },
          { key: "Type", value: proposal.proposalType },
          { key: "Agent ID", value: proposal.agentId },
          { key: "Status", value: formatProposalStatus(proposal.status) },
          { key: "Risk Level", value: formatRiskLevel(proposal.riskLevel) },
          { key: "Confidence", value: `${proposal.confidence}%` },
          { key: "Created", value: formatDate(proposal.createdAt) },
          { key: "Expires", value: proposal.expiresAt ? formatDate(proposal.expiresAt) : colors.dim("N/A") },
        ]);

        outputSection("Description");
        console.log(`  ${proposal.description}`);

        outputSection("Reasoning");
        console.log(`  ${proposal.reasoning}`);

        if (proposal.riskFactors && proposal.riskFactors.length > 0) {
          outputSection("Risk Factors");
          proposal.riskFactors.forEach((factor: string) => {
            console.log(`  ${colors.warning("!")} ${factor}`);
          });
        }

        outputSection("Action");
        console.log(JSON.stringify(proposal.action, null, 2).split("\n").map((l: string) => "  " + l).join("\n"));

        outputSection("Approvals");
        console.log(`  Required: ${proposal.requiredApprovals}`);
        console.log(`  Current: ${proposal.approvals?.length || 0}`);
        if (proposal.approvals && proposal.approvals.length > 0) {
          console.log();
          proposal.approvals.forEach((approval: any) => {
            const icon = approval.decision === "APPROVE" ? colors.success("V") : colors.error("X");
            console.log(
              `  ${icon} ${approval.userName} (${approval.decision}) - ${formatDate(approval.decidedAt)}`
            );
            if (approval.comment) {
              console.log(`    ${colors.dim(approval.comment)}`);
            }
          });
        }

        if (proposal.executedAt) {
          outputSection("Execution");
          outputKeyValue([
            { key: "Executed At", value: formatDate(proposal.executedAt) },
            {
              key: "Result",
              value: proposal.executionError
                ? colors.error(`Error: ${proposal.executionError}`)
                : colors.success("Success"),
            },
          ]);
        }

        console.log();

        // Show action hint for pending proposals
        if (proposal.status === "PENDING_APPROVAL") {
          outputInfo(
            `Use '0xscada agents proposals approve ${proposalId}' to approve this proposal`
          );
          console.log();
        }
      } catch (error) {
        spinner?.fail("Failed to fetch proposal");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Approve proposal
  proposals
    .command("approve <proposal-id>")
    .description("Approve a proposal")
    .option("--comment <comment>", "Approval comment")
    .option("--user <userId>", "User ID (defaults to CLI_USER)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (proposalId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Approving proposal...").start();
      const api = getApiClient();

      try {
        const response = await api.approveProposal(proposalId, {
          userId: options.user || "CLI_USER",
          userName: options.user || "CLI User",
          comment: options.comment,
        });

        spinner?.stop();

        if (!response.success) {
          outputError("Failed to approve proposal", response.error);
          return;
        }

        const proposal = response.data;

        if (options.json) {
          output(proposal);
          return;
        }

        if (proposal?.status === "APPROVED") {
          outputSuccess(`Proposal ${proposalId} fully approved and will be executed`);
        } else if (proposal) {
          outputSuccess(`Approval recorded for proposal ${proposalId}`);
          outputInfo(
            `${proposal.approvals?.length || 0}/${proposal.requiredApprovals} approvals received`
          );
        }
      } catch (error) {
        spinner?.fail("Failed to approve proposal");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Reject proposal
  proposals
    .command("reject <proposal-id>")
    .description("Reject a proposal")
    .requiredOption("--reason <reason>", "Rejection reason")
    .option("--user <userId>", "User ID (defaults to CLI_USER)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (proposalId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Rejecting proposal...").start();
      const api = getApiClient();

      try {
        const response = await api.rejectProposal(proposalId, {
          userId: options.user || "CLI_USER",
          userName: options.user || "CLI User",
          comment: options.reason,
        });

        spinner?.stop();

        if (!response.success) {
          outputError("Failed to reject proposal", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Proposal ${proposalId} rejected`);
      } catch (error) {
        spinner?.fail("Failed to reject proposal");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function formatAgentStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return colors.success("ACTIVE");
    case "INACTIVE":
      return colors.dim("INACTIVE");
    case "SUSPENDED":
      return colors.warning("SUSPENDED");
    case "ERROR":
      return colors.error("ERROR");
    default:
      return status;
  }
}

function formatProposalStatus(status: string): string {
  switch (status.toUpperCase()) {
    case "PENDING_APPROVAL":
      return colors.warning("PENDING");
    case "APPROVED":
      return colors.success("APPROVED");
    case "REJECTED":
      return colors.error("REJECTED");
    case "EXPIRED":
      return colors.dim("EXPIRED");
    case "EXECUTED":
      return colors.success("EXECUTED");
    case "FAILED":
      return colors.error("FAILED");
    case "DRAFT":
      return colors.dim("DRAFT");
    default:
      return status;
  }
}

function formatRiskLevel(level: string): string {
  switch (level.toUpperCase()) {
    case "LOW":
      return colors.success("LOW");
    case "MEDIUM":
      return colors.warning("MEDIUM");
    case "HIGH":
      return colors.error("HIGH");
    case "CRITICAL":
      return colors.error(colors.bold("CRITICAL"));
    default:
      return level;
  }
}

function formatLogAction(action: string): string {
  switch (action) {
    case "START":
      return colors.success("[START]");
    case "STOP":
      return colors.warning("[STOP]");
    case "EVENT_PROCESSED":
      return colors.info("[EVENT]");
    case "OUTPUT_CREATED":
      return colors.cyan("[OUTPUT]");
    case "PROPOSAL_CREATED":
      return colors.magenta("[PROPOSAL]");
    case "PROPOSAL_APPROVED":
      return colors.success("[APPROVED]");
    case "PROPOSAL_REJECTED":
      return colors.error("[REJECTED]");
    case "ERROR":
      return colors.error("[ERROR]");
    default:
      return `[${action}]`;
  }
}
