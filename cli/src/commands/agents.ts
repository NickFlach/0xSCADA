import { Command } from "commander";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  output,
  outputTable,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  formatDate,
  setOutputOptions,
  colors,
  statusIcon,
  truncate,
} from "../output.js";

export function registerAgentsCommand(program: Command): void {
  const agents = program
    .command("agents")
    .description("Manage governance agents");

  agents
    .command("list")
    .description("List all registered agents")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--type <type>", "Filter by agent type (OPS, CHANGE_CONTROL, COMPLIANCE)")
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

        let agentsData = response.data;
        if (options.type) {
          agentsData = agentsData.filter(
            (a) => a.agentType?.toLowerCase() === options.type.toLowerCase()
          );
        }

        if (options.json) {
          output(agentsData);
          return;
        }

        if (agentsData.length === 0) {
          console.log(colors.dim("No agents registered yet."));
          return;
        }

        outputTable(
          ["ID", "Name", "Type", "Status", "Created"],
          agentsData.map((agent) => [
            truncate(agent.id, 20),
            agent.displayName || agent.name,
            agent.agentType || "UNKNOWN",
            `${statusIcon(agent.status?.toLowerCase() || "unknown")} ${agent.status || "UNKNOWN"}`,
            formatDate(agent.createdAt),
          ])
        );
        console.log(colors.dim(`\nTotal: ${agentsData.length} agents`));
      } catch (error) {
        spinner?.fail("Failed to fetch agents");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("status <agent-id>")
    .description("Get detailed status of a specific agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching agent status...").start();
      const api = getApiClient();

      try {
        const response = await api.getAgentById(agentId);
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Agent not found", response.error);
          return;
        }

        const agent = response.data;

        if (options.json) {
          output(agent);
          return;
        }

        outputSection("Agent Details");
        outputKeyValue([
          { key: "ID", value: agent.id },
          { key: "Name", value: agent.displayName || agent.name },
          { key: "Type", value: agent.agentType || "UNKNOWN" },
          { key: "Status", value: `${statusIcon(agent.status?.toLowerCase() || "unknown")} ${agent.status || "UNKNOWN"}` },
          { key: "Version", value: agent.version || "N/A" },
          { key: "Created", value: formatDate(agent.createdAt) },
        ]);

        if (agent.capabilities?.length > 0) {
          outputSection("Capabilities");
          agent.capabilities.forEach((cap: string) => console.log(`  - ${cap}`));
        }

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch agent");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("logs <agent-id>")
    .description("Get logs for a specific agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--tail <lines>", "Number of lines to show", "100")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching agent logs...").start();
      const api = getApiClient();

      try {
        const response = await api.getAgentLogs(agentId, parseInt(options.tail, 10));
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch agent logs", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        const logs = response.data;
        if (logs.length === 0) {
          console.log(colors.dim("No logs available for this agent."));
          return;
        }

        outputSection(`Agent Logs (last ${options.tail} entries)`);
        logs.forEach((log: { timestamp: string; level: string; message: string }) => {
          const levelColor = log.level === "error" ? colors.error : log.level === "warn" ? colors.warning : colors.dim;
          console.log(`${colors.dim(formatDate(log.timestamp))} ${levelColor(`[${log.level.toUpperCase()}]`)} ${log.message}`);
        });
      } catch (error) {
        spinner?.fail("Failed to fetch agent logs");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("start <agent-id>")
    .description("Start a stopped agent")
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
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("stop <agent-id>")
    .description("Stop a running agent")
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
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("restart <agent-id>")
    .description("Restart an agent")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Restarting agent...").start();
      const api = getApiClient();

      try {
        const stopResponse = await api.stopAgent(agentId);
        if (!stopResponse.success) {
          spinner?.fail("Failed to stop agent");
          outputError("Failed to restart agent (stop phase)", stopResponse.error);
          return;
        }

        const startResponse = await api.startAgent(agentId);
        spinner?.stop();

        if (!startResponse.success) {
          outputError("Failed to restart agent (start phase)", startResponse.error);
          return;
        }

        if (options.json) {
          output({ success: true, agentId, status: "ACTIVE" });
          return;
        }
        outputSuccess(`Agent ${agentId} restarted successfully`);
      } catch (error) {
        spinner?.fail("Failed to restart agent");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  agents
    .command("config <agent-id>")
    .description("Get or set agent configuration")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--set <key=value>", "Set a configuration value")
    .action(async (agentId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const api = getApiClient();

      if (options.set) {
        const [key, ...valueParts] = options.set.split("=");
        const value = valueParts.join("=");
        if (!key || value === undefined) {
          outputError("Invalid format", "Use --set key=value");
          return;
        }

        const spinner = options.json ? null : ora("Updating configuration...").start();
        try {
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
          outputSuccess(`Configuration updated: ${key}=${value}`);
        } catch (error) {
          spinner?.fail("Failed to update configuration");
          outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
        }
      } else {
        const spinner = options.json ? null : ora("Fetching configuration...").start();
        try {
          const response = await api.getAgentConfig(agentId);
          spinner?.stop();
          if (!response.success || !response.data) {
            outputError("Failed to fetch configuration", response.error);
            return;
          }
          if (options.json) {
            output(response.data);
            return;
          }
          outputSection(`Configuration for ${agentId}`);
          const configData = response.data;
          if (Array.isArray(configData) && configData.length === 0) {
            console.log(colors.dim("  No configuration entries."));
          } else if (Array.isArray(configData)) {
            configData.forEach((entry: { key: string; value: unknown }) => {
              console.log(`  ${colors.bold(entry.key)}: ${JSON.stringify(entry.value)}`);
            });
          }
          console.log();
        } catch (error) {
          spinner?.fail("Failed to fetch configuration");
          outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
        }
      }
    });

  const proposals = agents.command("proposals").description("Manage agent proposals");

  proposals
    .command("list")
    .description("List all proposals")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--status <status>", "Filter by status")
    .option("--agent <agent-id>", "Filter by agent ID")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching proposals...").start();
      const api = getApiClient();

      try {
        const response = options.agent ? await api.getAgentProposals(options.agent) : await api.getProposals();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch proposals", response.error);
          return;
        }

        let proposalsData = response.data;
        if (options.status) {
          proposalsData = proposalsData.filter((p) => p.status?.toLowerCase() === options.status.toLowerCase());
        }

        if (options.json) {
          output(proposalsData);
          return;
        }

        if (proposalsData.length === 0) {
          console.log(colors.dim("No proposals found."));
          return;
        }

        outputTable(
          ["ID", "Title", "Type", "Risk", "Status", "Created"],
          proposalsData.map((p) => [
            truncate(p.id, 12),
            truncate(p.title || "Untitled", 30),
            p.proposalType || "UNKNOWN",
            formatRiskLevel(p.riskLevel),
            formatProposalStatus(p.status),
            formatDate(p.createdAt),
          ])
        );
        console.log(colors.dim(`\nTotal: ${proposalsData.length} proposals`));
      } catch (error) {
        spinner?.fail("Failed to fetch proposals");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  proposals
    .command("show <proposal-id>")
    .description("Show detailed proposal information")
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
          { key: "Title", value: proposal.title || "Untitled" },
          { key: "Type", value: proposal.proposalType || "UNKNOWN" },
          { key: "Status", value: formatProposalStatus(proposal.status) },
          { key: "Risk Level", value: formatRiskLevel(proposal.riskLevel) },
          { key: "Confidence", value: `${proposal.confidence || 0}%` },
          { key: "Agent", value: proposal.agentId },
          { key: "Created", value: formatDate(proposal.createdAt) },
        ]);

        if (proposal.description) {
          outputSection("Description");
          console.log(`  ${proposal.description}`);
        }
        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch proposal");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  proposals
    .command("approve <proposal-id>")
    .description("Approve a pending proposal")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--comment <comment>", "Add a comment")
    .option("--user <user-id>", "User ID for approval", "cli-user")
    .option("--user-name <name>", "User name for approval", "CLI User")
    .action(async (proposalId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Approving proposal...").start();
      const api = getApiClient();

      try {
        const response = await api.approveProposal(proposalId, {
          userId: options.user,
          userName: options.userName,
          comment: options.comment,
        });
        spinner?.stop();

        if (!response.success) {
          outputError("Failed to approve proposal", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }
        outputSuccess(`Proposal ${proposalId} approved successfully`);
      } catch (error) {
        spinner?.fail("Failed to approve proposal");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });

  proposals
    .command("reject <proposal-id>")
    .description("Reject a pending proposal")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .requiredOption("--reason <reason>", "Reason for rejection")
    .option("--user <user-id>", "User ID for rejection", "cli-user")
    .option("--user-name <name>", "User name for rejection", "CLI User")
    .action(async (proposalId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Rejecting proposal...").start();
      const api = getApiClient();

      try {
        const response = await api.rejectProposal(proposalId, {
          userId: options.user,
          userName: options.userName,
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
        console.log(colors.dim(`  Reason: ${options.reason}`));
      } catch (error) {
        spinner?.fail("Failed to reject proposal");
        outputError("Failed to connect to server", error instanceof Error ? error.message : "Unknown error");
      }
    });
}

function formatRiskLevel(riskLevel?: string): string {
  if (!riskLevel) return colors.dim("UNKNOWN");
  switch (riskLevel.toUpperCase()) {
    case "LOW": return colors.success("LOW");
    case "MEDIUM": return colors.warning("MEDIUM");
    case "HIGH": return colors.error("HIGH");
    case "CRITICAL": return colors.error(colors.bold("CRITICAL"));
    default: return colors.dim(riskLevel);
  }
}

function formatProposalStatus(status?: string): string {
  if (!status) return colors.dim("UNKNOWN");
  switch (status.toUpperCase()) {
    case "PENDING_APPROVAL": return colors.warning("PENDING");
    case "APPROVED": return colors.success("APPROVED");
    case "REJECTED": return colors.error("REJECTED");
    case "EXECUTED": return colors.success("EXECUTED");
    case "FAILED": return colors.error("FAILED");
    case "EXPIRED": return colors.dim("EXPIRED");
    default: return colors.dim(status);
  }
}
