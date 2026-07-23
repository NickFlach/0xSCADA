import { Command } from "commander";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  outputSection,
  outputKeyValue,
  outputError,
  statusIcon,
  formatUptime,
  colors,
  output,
  setOutputOptions,
} from "../output.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show system health (database, blockchain, services)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Checking system status...").start();
      const api = getApiClient();

      try {
        const [healthResponse, blockchainResponse, blueprintsResponse] = await Promise.all([
          api.getHealth(),
          api.getBlockchainStatus(),
          api.getBlueprintsSummary(),
        ]);

        spinner?.stop();

        if (options.json) {
          output({
            health: healthResponse.data,
            blockchain: blockchainResponse.data,
            blueprints: blueprintsResponse.data,
          });
          return;
        }

        // System Health
        outputSection("System Health");
        
        if (healthResponse.success && healthResponse.data) {
          const health = healthResponse.data;
          const db = health.components.database;
          const bc = health.components.blockchain;

          outputKeyValue([
            { key: "Status", value: `${statusIcon(health.status)} ${health.status.toUpperCase()}` },
            { key: "Version", value: health.version },
            { key: "Uptime", value: formatUptime(health.uptime) },
          ]);

          outputSection("Components");
          outputKeyValue([
            {
              key: "Database",
              value: `${statusIcon(db.status)} ${db.status}${db.latencyMs ? ` (${db.latencyMs}ms)` : ""}`,
            },
            {
              key: "Blockchain",
              value: `${statusIcon(bc.status)} ${bc.status}`,
            },
          ]);
        } else {
          outputError("Failed to fetch health status", healthResponse.error);
        }

        // Blockchain Status
        outputSection("Blockchain");
        if (blockchainResponse.success && blockchainResponse.data) {
          const enabled = blockchainResponse.data.enabled;
          outputKeyValue([
            {
              key: "Enabled",
              value: `${statusIcon(enabled ? "enabled" : "disabled")} ${enabled ? "Yes" : "No"}`,
            },
          ]);
        } else {
          outputKeyValue([
            { key: "Status", value: colors.dim("Unable to fetch") },
          ]);
        }

        // Blueprints Summary
        outputSection("Blueprints");
        if (blueprintsResponse.success && blueprintsResponse.data) {
          const bp = blueprintsResponse.data;
          outputKeyValue([
            { key: "Control Module Types", value: String(bp.controlModuleTypes) },
            { key: "Control Module Instances", value: String(bp.controlModuleInstances) },
            { key: "Unit Types", value: String(bp.unitTypes) },
            { key: "Unit Instances", value: String(bp.unitInstances) },
            { key: "Phase Types", value: String(bp.phaseTypes) },
            { key: "Phase Instances", value: String(bp.phaseInstances) },
            { key: "Vendors", value: String(bp.vendors) },
          ]);
        } else {
          outputKeyValue([
            { key: "Status", value: colors.dim("Unable to fetch") },
          ]);
        }

        console.log();
      } catch (error) {
        spinner?.fail("Failed to check system status");
        outputError(
          "Failed to connect to 0xSCADA server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
