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
  $ 0xscada blueprints list --type cm-types  List control modules
  $ 0xscada blueprints show <id>      Show blueprint details
  $ 0xscada blueprints create --file blueprint.yaml  Create blueprint
  $ 0xscada blueprints import --file package.yaml  Import blueprints
  $ 0xscada blueprints export <id>    Export blueprint
  $ 0xscada blueprints validate --file blueprint.yaml  Validate blueprint
  $ 0xscada auth login --key <api-key>  Login with API key
  $ 0xscada auth logout                 Logout and clear credentials
  $ 0xscada auth status                 Show authentication status
  $ 0xscada auth keys list              List stored API keys
  $ 0xscada auth keys create --name ci  Create new API key
  $ 0xscada auth keys revoke <id>       Revoke an API key
  $ 0xscada auth keys rotate <id>       Rotate an API key
  $ 0xscada wallet list                 List configured wallets
  $ 0xscada wallet add --name ops --keyfile key.json  Add wallet
  $ 0xscada wallet remove <name>        Remove a wallet
  $ 0xscada wallet balance [name]       Get wallet balance
  $ 0xscada wallet sign --message "data"  Sign a message
  $ 0xscada wallet set-default <name>   Set default wallet
  $ 0xscada logs server                   View server logs
  $ 0xscada logs server --tail 100        Last 100 lines
  $ 0xscada logs server --follow          Stream in real-time
  $ 0xscada logs server --level error     Filter by log level
  $ 0xscada logs blockchain               View blockchain logs
  $ 0xscada logs blockchain --tx <hash>   Specific transaction logs
  $ 0xscada logs export --from 2024-01-01 Export logs to file

Output Formats:
  json              JSON format
  yaml              YAML format
  csv               Comma-separated values
  tsv               Tab-separated values
  table             Default table (Unicode borders)
  table:minimal     Table without borders
  table:ascii       ASCII box drawing characters
  table:rounded     Rounded Unicode corners
  table:heavy       Bold/heavy borders
  table:double      Double-line borders

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
