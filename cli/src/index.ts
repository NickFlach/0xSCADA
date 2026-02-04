#!/usr/bin/env node

import { Command } from "commander";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

import {
  registerStatusCommand,
  registerSitesCommand,
  registerAssetsCommand,
  registerEventsCommand,
  registerBlockchainCommand,
  registerDevCommand,
  registerConfigCommand,
  registerBlueprintsCommand,
  registerAuthCommand,
  registerWalletCommand,
  registerLogsCommand,
  registerDeployCommand,
  registerShellCommand,
  registerAnchorCommand,
  registerCompletionCommand,
  registerAgentsCommand,
  registerWatchCommand,
} from "./commands/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from multiple locations
const envPaths = [
  path.join(process.cwd(), ".env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../.env"),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

// Read version from package.json
let version = "1.0.0";
try {
  const pkgPath = path.resolve(__dirname, "../package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    version = pkg.version;
  }
} catch {
  // Use default version
}

const program = new Command();

program
  .name("0xscada")
  .description("CLI tool for 0xSCADA development and operations")
  .version(version, "-v, --version", "Output the version number")
  .option("--json", "Output as JSON (applies to all commands)")
  .option("-o, --output <format>", "Output format: json, yaml, csv, tsv, table, table:minimal, table:ascii, table:rounded, table:heavy, table:double")
  .option("--no-color", "Disable colorized output")
  .helpOption("-h, --help", "Display help for command")
  .addHelpText(
    "after",
    `
Examples:
  $ 0xscada status                    Show system health
  $ 0xscada sites list                List all registered sites
  $ 0xscada sites list -o json        Output as JSON
  $ 0xscada sites list -o yaml        Output as YAML
  $ 0xscada sites list -o csv         Output as CSV
  $ 0xscada sites list -o tsv         Output as TSV
  $ 0xscada sites list -o table:rounded  Use rounded table theme
  $ 0xscada sites get <id>            Get site details
  $ 0xscada assets list               List all assets
  $ 0xscada events list --limit 10    List recent events
  $ 0xscada events anchor             Trigger batch anchoring
  $ 0xscada blockchain info           Show blockchain status
  $ 0xscada dev start                 Start local dev environment
  $ 0xscada dev seed                  Seed database with test data
  $ 0xscada config show               Display current configuration
  $ 0xscada config set apiUrl <url>   Update API URL
  $ 0xscada blueprints list           List all blueprints
  $ 0xscada blueprints show <id>      Show blueprint details
  $ 0xscada auth login --key <api-key>  Login with API key
  $ 0xscada auth status                 Show authentication status
  $ 0xscada wallet list                 List configured wallets
  $ 0xscada wallet balance [name]       Get wallet balance
  $ 0xscada logs server                   View server logs
  $ 0xscada logs server --follow          Stream in real-time
  $ 0xscada deploy compose generate   Generate docker-compose.yml
  $ 0xscada deploy k8s generate       Generate Kubernetes manifests
  $ 0xscada shell                     Start interactive shell mode
  $ 0xscada completion bash           Generate bash completion script
  $ 0xscada agents list               List all governance agents
  $ 0xscada agents proposals list     List all proposals
  $ 0xscada anchor create --data <hash>   Create a new anchor
  $ 0xscada anchor verify <id>        Verify an anchor
  $ 0xscada anchor tree show          Show Merkle tree info

Environment Variables:
  OXSCADA_API_URL     API server URL (default: http://localhost:5000)
  OXSCADA_API_KEY     API key for authentication (fallback)
  OXSCADA_TIMEOUT     Request timeout in ms (default: 30000)
  OXSCADA_NO_COLOR    Disable color output
  DATABASE_URL        PostgreSQL connection string
  BLOCKCHAIN_RPC_URL  Ethereum RPC endpoint
  BLOCKCHAIN_PRIVATE_KEY  Wallet private key for transactions

Configuration:
  Config can be stored in 0xscada.config.json in the current directory
  or ~/.0xscada.config.json in your home directory.
`
  );

// Register all commands
registerStatusCommand(program);
registerSitesCommand(program);
registerAssetsCommand(program);
registerEventsCommand(program);
registerBlockchainCommand(program);
registerDevCommand(program);
registerConfigCommand(program);
registerBlueprintsCommand(program);
registerAuthCommand(program);
registerWalletCommand(program);
registerLogsCommand(program);
registerDeployCommand(program);
registerShellCommand(program);
registerAnchorCommand(program);
registerCompletionCommand(program);
registerAgentsCommand(program);
registerWatchCommand(program);

// Error handling for unknown commands
program.on("command:*", (operands) => {
  console.error(`Error: Unknown command '${operands[0]}'`);
  console.error();
  console.error("Run '0xscada --help' to see available commands.");
  process.exitCode = 1;
});

// Parse arguments
program.parse();

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
