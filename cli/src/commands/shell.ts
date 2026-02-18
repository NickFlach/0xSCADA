import { Command } from "commander";
import * as readline from "readline";
import chalk from "chalk";
import { loadConfig } from "../config.js";

// Store command history
const history: string[] = [];
let historyIndex = -1;

// Multi-line input buffer
let multiLineBuffer: string[] = [];
let isMultiLineMode = false;

interface ShellContext {
  site?: string;
}

const context: ShellContext = {};

/**
 * Get available commands for tab completion.
 * Dynamically introspects the parent Commander program to include all
 * registered commands (agents, tags, alarms, gateway, container, db, etc.).
 */
function getAvailableCommands(program?: Command): string[] {
  const builtins = [
    "help",
    "exit",
    "quit",
    "clear",
    "history",
    "context",
    "use site",
  ];

  if (!program) {
    // Fallback static list when no program reference available
    return [
      ...builtins,
      "status",
      "sites", "sites list", "sites get", "sites create",
      "assets", "assets list", "assets get", "assets create",
      "events", "events list", "events anchor",
      "blockchain", "blockchain info", "blockchain balance",
      "dev", "dev start", "dev stop", "dev seed",
      "config", "config show", "config set",
      "agents", "agents list", "agents start", "agents stop", "agents outputs", "agents proposals",
      "tags", "tags read", "tags write", "tags list", "tags watch",
      "alarms", "alarms list", "alarms acknowledge", "alarms history",
      "gateway", "gateway list", "gateway status",
      "container", "container status", "container start", "container stop",
      "db", "db migrate", "db seed", "db status",
    ];
  }

  // Dynamically enumerate commands from the Commander program tree
  const commands: string[] = [...builtins];
  for (const cmd of program.commands) {
    if (cmd.name() === "shell") continue; // don't list shell inside shell
    commands.push(cmd.name());
    // Add subcommands
    for (const sub of cmd.commands) {
      commands.push(`${cmd.name()} ${sub.name()}`);
    }
  }
  return commands;
}

/**
 * Get completions for a partial input
 */
function getCompletions(line: string, program?: Command): string[] {
  const commands = getAvailableCommands(program);
  const trimmedLine = line.trim().toLowerCase();

  if (!trimmedLine) {
    return commands.filter(cmd => !cmd.includes(" "));
  }

  return commands.filter(cmd =>
    cmd.toLowerCase().startsWith(trimmedLine)
  );
}

/**
 * Display help for shell commands
 */
function showShellHelp(): void {
  console.log();
  console.log(chalk.bold.cyan("0xSCADA Interactive Shell"));
  console.log(chalk.dim("-".repeat(30)));
  console.log();
  console.log(chalk.bold("Available Commands:"));
  console.log();
  console.log("  " + chalk.yellow("status") + "              Show system health");
  console.log("  " + chalk.yellow("sites list") + "          List all registered sites");
  console.log("  " + chalk.yellow("sites get <id>") + "      Get site details");
  console.log("  " + chalk.yellow("sites create") + "        Create a new site");
  console.log("  " + chalk.yellow("assets list") + "         List all assets");
  console.log("  " + chalk.yellow("assets get <id>") + "     Get asset details");
  console.log("  " + chalk.yellow("events list") + "         List recent events");
  console.log("  " + chalk.yellow("events anchor") + "       Trigger batch anchoring");
  console.log("  " + chalk.yellow("blockchain info") + "     Show blockchain status");
  console.log("  " + chalk.yellow("config show") + "         Display current config");
  console.log("  " + chalk.yellow("dev start") + "           Start dev environment");
  console.log("  " + chalk.yellow("dev seed") + "            Seed test data");
  console.log("  " + chalk.yellow("agents list") + "         List governance agents");
  console.log("  " + chalk.yellow("agents outputs") + "      Show agent outputs");
  console.log("  " + chalk.yellow("agents proposals") + "    Show agent proposals");
  console.log("  " + chalk.yellow("tags read <id>") + "      Read a SCADA tag value");
  console.log("  " + chalk.yellow("tags list") + "           List all tags");
  console.log("  " + chalk.yellow("alarms list") + "         List active alarms");
  console.log("  " + chalk.yellow("gateway list") + "        List gateway connections");
  console.log("  " + chalk.yellow("container status") + "    Container status");
  console.log("  " + chalk.yellow("db migrate") + "          Run database migrations");
  console.log("  " + chalk.yellow("db seed") + "             Seed database");
  console.log();
  console.log(chalk.bold("Shell Commands:"));
  console.log();
  console.log("  " + chalk.yellow("help") + "                Show this help");
  console.log("  " + chalk.yellow("history") + "             Show command history");
  console.log("  " + chalk.yellow("context") + "             Show current context");
  console.log("  " + chalk.yellow("clear") + "               Clear the screen");
  console.log("  " + chalk.yellow("exit") + " / " + chalk.yellow("quit") + "        Exit the shell");
  console.log();
  console.log(chalk.bold("Tips:"));
  console.log(chalk.dim("  - Use up/down arrows to navigate command history"));
  console.log(chalk.dim("  - Use Tab for command completion"));
  console.log(chalk.dim("  - Use \\ at end of line for multi-line input"));
  console.log(chalk.dim("  - Options like --json, --site work as normal"));
  console.log();
}

/**
 * Show command history
 */
function showHistory(): void {
  if (history.length === 0) {
    console.log(chalk.dim("No command history yet."));
    return;
  }

  console.log();
  console.log(chalk.bold("Command History:"));
  history.forEach((cmd, i) => {
    console.log(chalk.dim(`  ${(i + 1).toString().padStart(3)}  `) + cmd);
  });
  console.log();
}

/**
 * Show current context
 */
function showContext(): void {
  console.log();
  console.log(chalk.bold("Current Context:"));
  if (context.site) {
    console.log(`  Site: ${chalk.cyan(context.site)}`);
  } else {
    console.log(chalk.dim("  No context set"));
  }
  console.log();
}

/**
 * Get the colored prompt string
 */
function getPrompt(): string {
  const config = loadConfig();
  const contextStr = context.site ? chalk.dim(`[${context.site}]`) + " " : "";

  if (config.colorOutput) {
    return contextStr + chalk.bold.green("0xscada") + chalk.bold.white("> ");
  }
  return contextStr + "0xscada> ";
}

/**
 * Get the continuation prompt for multi-line input
 */
function getContinuationPrompt(): string {
  return chalk.dim("... ");
}

/**
 * Parse command line into arguments, handling quotes
 */
function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      quoteChar = "";
    } else if (!inQuotes && char === " ") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Execute a command within the shell
 */
async function executeCommand(
  input: string,
  program: Command
): Promise<boolean> {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return true; // Continue shell
  }

  // Add to history (avoid duplicates)
  if (history[history.length - 1] !== trimmedInput) {
    history.push(trimmedInput);
  }
  historyIndex = history.length;

  // Handle shell-specific commands
  const lowerInput = trimmedInput.toLowerCase();

  if (lowerInput === "exit" || lowerInput === "quit") {
    console.log(chalk.dim("Goodbye!"));
    return false; // Exit shell
  }

  if (lowerInput === "help" || lowerInput === "?") {
    showShellHelp();
    return true;
  }

  if (lowerInput === "history") {
    showHistory();
    return true;
  }

  if (lowerInput === "context") {
    showContext();
    return true;
  }

  if (lowerInput === "clear" || lowerInput === "cls") {
    console.clear();
    return true;
  }

  // Parse command and execute via commander
  try {
    const args = parseCommandLine(trimmedInput);

    // Check for context commands
    if (args[0] === "use" && args[1] === "site" && args[2]) {
      context.site = args[2];
      console.log(chalk.green(`Context set to site: ${args[2]}`));
      return true;
    }

    // Create a child program for isolated command execution
    const shellProgram = createShellProgram(program);

    // Execute the command
    await shellProgram.parseAsync(["node", "0xscada", ...args]);
  } catch (error) {
    if (error instanceof Error) {
      // Commander throws for unknown commands, etc.
      if (error.message.includes("unknown command") ||
          error.message.includes("missing required")) {
        console.error(chalk.red("Error: ") + error.message);
      } else if (error.name !== "CommanderError") {
        console.error(chalk.red("Error: ") + error.message);
      }
    }
  }

  return true;
}

/**
 * Create a shell-compatible program instance
 */
function createShellProgram(parentProgram: Command): Command {
  const shellProgram = new Command();
  shellProgram.exitOverride(); // Don't exit process on errors
  shellProgram.configureOutput({
    writeErr: (str) => console.error(str),
    writeOut: (str) => console.log(str),
  });

  // Copy commands from parent program
  for (const cmd of parentProgram.commands) {
    if (cmd.name() !== "shell") {
      shellProgram.addCommand(cmd, { hidden: false });
    }
  }

  // Add shell-specific version of help
  shellProgram
    .command("help")
    .description("Show shell help")
    .action(() => {
      showShellHelp();
    });

  return shellProgram;
}

/**
 * Start the interactive shell
 */
async function startShell(program: Command): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: getPrompt(),
    historySize: 100,
    completer: (line: string) => {
      const completions = getCompletions(line, program);
      return [completions, line];
    },
  });

  // Set up stdin for raw mode to capture arrow keys
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);

    process.stdin.on("keypress", (_char, key) => {
      if (!key) return;

      if (key.name === "up" && history.length > 0) {
        if (historyIndex > 0) {
          historyIndex--;
          rl.write(null, { ctrl: true, name: "u" }); // Clear line
          rl.write(history[historyIndex]);
        }
      } else if (key.name === "down") {
        if (historyIndex < history.length - 1) {
          historyIndex++;
          rl.write(null, { ctrl: true, name: "u" }); // Clear line
          rl.write(history[historyIndex]);
        } else if (historyIndex === history.length - 1) {
          historyIndex = history.length;
          rl.write(null, { ctrl: true, name: "u" }); // Clear line
        }
      }
    });
  }

  console.log();
  console.log(chalk.bold.cyan("0xSCADA Interactive Shell"));
  console.log(chalk.dim("Type 'help' for available commands, 'exit' to quit"));
  console.log();

  rl.prompt();

  return new Promise<void>((resolve) => {
    rl.on("line", async (line) => {
      // Handle multi-line input
      if (line.endsWith("\\")) {
        multiLineBuffer.push(line.slice(0, -1));
        isMultiLineMode = true;
        rl.setPrompt(getContinuationPrompt());
        rl.prompt();
        return;
      }

      let fullLine = line;
      if (isMultiLineMode) {
        multiLineBuffer.push(line);
        fullLine = multiLineBuffer.join(" ");
        multiLineBuffer = [];
        isMultiLineMode = false;
        rl.setPrompt(getPrompt());
      }

      const shouldContinue = await executeCommand(fullLine, program);

      if (!shouldContinue) {
        rl.close();
        resolve();
        return;
      }

      rl.setPrompt(getPrompt());
      rl.prompt();
    });

    rl.on("close", () => {
      console.log();
      resolve();
    });

    // Handle Ctrl+C gracefully
    rl.on("SIGINT", () => {
      if (isMultiLineMode) {
        multiLineBuffer = [];
        isMultiLineMode = false;
        console.log();
        rl.setPrompt(getPrompt());
        rl.prompt();
      } else {
        console.log(chalk.dim("\n(Use 'exit' or 'quit' to leave the shell)"));
        rl.prompt();
      }
    });
  });
}

/**
 * Register the shell command with the CLI program
 */
export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description("Start interactive shell mode")
    .action(async () => {
      await startShell(program);
    });
}

// Export for testing
export {
  getAvailableCommands,
  getCompletions,
  parseCommandLine,
  executeCommand,
  showShellHelp,
  showHistory,
  showContext,
  getPrompt,
  history,
  context,
};
