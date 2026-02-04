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
  // registerCompletionCommand, // TODO: Fix completion.ts syntax errors
  registerAgentsCommand,
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
  $ 0xscada agents list               List governance agents
  $ 0xscada agents status <id>        Show agent status
  $ 0xscada agents proposals list     List agent proposals
  $ 0xscada dev start                 Start local dev environment
  $ 0xscada dev seed                  Seed database with test data
  $ 0xscada config show               Display current configuration
  $ 0xscada config set apiUrl <url>   Update API URL

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
registerAgentsCommand(program);
registerDevCommand(program);
registerConfigCommand(program);
// registerCompletionCommand(program); // TODO: Fix completion.ts syntax errors

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
