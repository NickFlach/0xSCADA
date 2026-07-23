import { Command } from "commander";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  setOutputOptions,
  colors,
  statusIcon,
} from "../output.js";

export function registerBlockchainCommand(program: Command): void {
  const blockchain = program
    .command("blockchain")
    .description("Blockchain status and information");

  // Info command
  blockchain
    .command("info")
    .description("Show blockchain connection status and information")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Fetching blockchain info...").start();
      const api = getApiClient();

      try {
        const [statusResponse, healthResponse] = await Promise.all([
          api.getBlockchainStatus(),
          api.getHealth(),
        ]);

        spinner?.stop();

        const enabled = statusResponse.success && statusResponse.data?.enabled;
        const blockchainComponent = healthResponse.data?.components?.blockchain;

        if (options.json) {
          output({
            enabled,
            status: blockchainComponent?.status || "unknown",
            rpcUrl: process.env.BLOCKCHAIN_RPC_URL || "http://127.0.0.1:8545",
          });
          return;
        }

        outputSection("Blockchain Status");
        outputKeyValue([
          {
            key: "Enabled",
            value: `${statusIcon(enabled ? "enabled" : "disabled")} ${enabled ? "Yes" : "No"}`,
          },
          {
            key: "Status",
            value: `${statusIcon(blockchainComponent?.status || "unknown")} ${
              blockchainComponent?.status || "Unknown"
            }`,
          },
          {
            key: "RPC URL",
            value: process.env.BLOCKCHAIN_RPC_URL || colors.dim("http://127.0.0.1:8545 (default)"),
          },
        ]);

        if (!enabled) {
          console.log();
          console.log(colors.dim("Blockchain features are disabled."));
          console.log(colors.dim("Set BLOCKCHAIN_PRIVATE_KEY and deploy the contract to enable."));
        }

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch blockchain info");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Status alias (same as info)
  blockchain
    .command("status")
    .description("Show blockchain connection status (alias for info)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      // Reuse the info command logic
      const infoCmd = blockchain.commands.find((c) => c.name() === "info");
      if (infoCmd) {
        await infoCmd.parseAsync(["info", ...(options.json ? ["--json"] : [])], {
          from: "user",
        });
      }
    });
}
