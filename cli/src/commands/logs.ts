import { Command } from "commander";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  output,
  outputSection,
  outputError,
  outputWarning,
  outputSuccess,
  setOutputOptions,
  colors,
  formatDate,
} from "../output.js";

// Minimal shape used by the logs command: the API client exposes a generic
// request<T>() that the (mockable) tests target directly.
interface RequestCapableClient {
  request<T>(endpoint: string): Promise<{ success: boolean; data?: T; error?: string }>;
}

// Log entry interface
export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  service?: string;
  metadata?: Record<string, unknown>;
}

// Blockchain log entry interface
export interface BlockchainLogEntry {
  blockNumber: number;
  transactionHash?: string;
  eventType: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// Log filter options
export interface LogFilterOptions {
  tail?: number;
  follow?: boolean;
  level?: string;
  since?: string;
  tx?: string;
  block?: string;
  service?: string;
}

// Export options
export interface LogExportOptions {
  from?: string;
  to?: string;
  output?: string;
  format?: "json" | "csv";
}

// Parse duration string (e.g., "1h", "30m", "7d") to milliseconds
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: ${duration}. Use format like 1h, 30m, 7d`
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

// Format log level with color
function formatLevel(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return colors.error(level.toUpperCase());
    case "warn":
      return colors.warning(level.toUpperCase());
    case "info":
      return colors.info(level.toUpperCase());
    case "debug":
      return colors.dim(level.toUpperCase());
    default:
      return level.toUpperCase();
  }
}

// Format a single log entry for display
function formatLogEntry(entry: LogEntry): string {
  const timestamp = colors.dim(formatDate(entry.timestamp));
  const level = formatLevel(entry.level);
  const service = entry.service ? colors.cyan(`[${entry.service}]`) : "";
  const message = entry.message;

  return `${timestamp} ${level} ${service} ${message}`.trim();
}

// Format blockchain log entry for display
function formatBlockchainLogEntry(entry: BlockchainLogEntry): string {
  const timestamp = colors.dim(formatDate(entry.timestamp));
  const block = colors.cyan(`Block #${entry.blockNumber}`);
  const event = colors.bold(entry.eventType);
  const tx = entry.transactionHash
    ? colors.dim(` tx:${entry.transactionHash.slice(0, 10)}...`)
    : "";

  return `${timestamp} ${block} ${event}${tx}`;
}

// Simulate fetching server logs (would be replaced with actual API call)
async function fetchServerLogs(
  options: LogFilterOptions
): Promise<LogEntry[]> {
  const api = getApiClient();

  // Build query parameters
  const params = new URLSearchParams();
  if (options.tail) params.append("limit", options.tail.toString());
  if (options.level) params.append("level", options.level);
  if (options.since) {
    const sinceMs = parseDuration(options.since);
    const sinceDate = new Date(Date.now() - sinceMs).toISOString();
    params.append("since", sinceDate);
  }
  if (options.service) params.append("service", options.service);

  // Note: This would be replaced with actual API endpoint
  // For now, we'll return mock data or make a request to /api/logs
  const response = await (api as unknown as RequestCapableClient).request<LogEntry[]>(
    `/api/logs?${params.toString()}`
  );
  if (response.success && response.data) {
    return response.data;
  }
  return [];
}

// Simulate fetching blockchain logs
async function fetchBlockchainLogs(
  options: LogFilterOptions
): Promise<BlockchainLogEntry[]> {
  const api = getApiClient();

  // Build query parameters
  const params = new URLSearchParams();
  if (options.tail) params.append("limit", options.tail.toString());
  if (options.tx) params.append("tx", options.tx);
  if (options.block) params.append("block", options.block);
  if (options.since) {
    const sinceMs = parseDuration(options.since);
    const sinceDate = new Date(Date.now() - sinceMs).toISOString();
    params.append("since", sinceDate);
  }

  const response = await (api as unknown as RequestCapableClient).request<BlockchainLogEntry[]>(
    `/api/blockchain/logs?${params.toString()}`
  );
  if (response.success && response.data) {
    return response.data;
  }
  return [];
}

// Stream logs in real-time (follow mode)
async function streamLogs(
  logType: "server" | "blockchain",
  options: LogFilterOptions,
  onEntry: (entry: LogEntry | BlockchainLogEntry) => void
): Promise<void> {
  console.log(colors.dim("Streaming logs... Press Ctrl+C to stop."));
  console.log();

  // In a real implementation, this would establish a WebSocket or SSE connection
  // For now, we'll poll the API at intervals
  const pollInterval = 2000; // 2 seconds

  let lastTimestamp = new Date().toISOString();

  const poll = async () => {
    try {
      const fetchOptions = { ...options, since: "10s" };
      const logs =
        logType === "server"
          ? await fetchServerLogs(fetchOptions)
          : await fetchBlockchainLogs(fetchOptions);

      for (const entry of logs) {
        if (entry.timestamp > lastTimestamp) {
          onEntry(entry);
          lastTimestamp = entry.timestamp;
        }
      }
    } catch {
      // Ignore poll errors in follow mode
    }
  };

  // Poll continuously
  const intervalId = setInterval(poll, pollInterval);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(intervalId);
    console.log();
    console.log(colors.dim("Stopped streaming logs."));
    process.exit(0);
  });

  // Initial poll
  await poll();

  // Keep the process running
  await new Promise(() => {
    // Never resolves - runs until interrupted
  });
}

// Export logs to file
async function exportLogs(options: LogExportOptions): Promise<void> {
  const spinner = ora("Exporting logs...").start();

  try {
    const params = new URLSearchParams();
    if (options.from) params.append("from", options.from);
    if (options.to) params.append("to", options.to);
    if (options.format) params.append("format", options.format);

    const api = getApiClient();
    const response = await (api as unknown as RequestCapableClient).request<{ logs: LogEntry[] }>(
      `/api/logs/export?${params.toString()}`
    );

    spinner.stop();

    if (response.success && response.data) {
      const outputPath = options.output || `logs-${Date.now()}.json`;
      const fs = await import("fs");
      const path = await import("path");

      const fullPath = path.resolve(process.cwd(), outputPath);
      const content =
        options.format === "csv"
          ? convertToCsv(response.data.logs)
          : JSON.stringify(response.data.logs, null, 2);

      fs.writeFileSync(fullPath, content, "utf-8");
      outputSuccess(`Logs exported to ${fullPath}`);
    } else {
      outputError("Failed to export logs", response.error);
    }
  } catch (error) {
    spinner.stop();
    outputError(
      "Failed to export logs",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

// Convert logs to CSV format
function convertToCsv(logs: LogEntry[]): string {
  if (logs.length === 0) return "";

  const headers = ["timestamp", "level", "service", "message"];
  const rows = logs.map((log) => [
    log.timestamp,
    log.level,
    log.service || "",
    `"${log.message.replace(/"/g, '""')}"`,
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

export function registerLogsCommand(program: Command): void {
  const logs = program
    .command("logs")
    .description("View server and blockchain logs");

  // Server logs subcommand
  logs
    .command("server")
    .description("View server application logs")
    .option("--tail <lines>", "Number of lines to show", "100")
    .option("--follow, -f", "Stream logs in real-time")
    .option(
      "--level <level>",
      "Filter by log level (debug, info, warn, error)"
    )
    .option("--since <duration>", "Show logs since duration (e.g., 1h, 30m, 7d)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const filterOptions: LogFilterOptions = {
        tail: parseInt(options.tail, 10),
        follow: options.follow || options.f,
        level: options.level,
        since: options.since,
      };

      if (filterOptions.follow) {
        await streamLogs("server", filterOptions, (entry) => {
          if (options.json) {
            console.log(JSON.stringify(entry));
          } else {
            console.log(formatLogEntry(entry as LogEntry));
          }
        });
        return;
      }

      const spinner = options.json
        ? null
        : ora("Fetching server logs...").start();

      try {
        const logs = await fetchServerLogs(filterOptions);

        spinner?.stop();

        if (options.json) {
          output(logs);
          return;
        }

        if (logs.length === 0) {
          outputWarning("No server logs found matching the criteria.");
          return;
        }

        outputSection("Server Logs");
        for (const entry of logs) {
          console.log(formatLogEntry(entry));
        }
        console.log();
        console.log(colors.dim(`Showing ${logs.length} log entries`));
      } catch (error) {
        spinner?.fail("Failed to fetch server logs");
        outputError(
          "Failed to fetch server logs",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Blockchain logs subcommand
  logs
    .command("blockchain")
    .description("View blockchain node logs and events")
    .option("--tail <lines>", "Number of entries to show", "100")
    .option("--follow, -f", "Stream logs in real-time")
    .option("--tx <hash>", "Filter by transaction hash")
    .option("--block <number>", "Filter by block number")
    .option("--since <duration>", "Show logs since duration (e.g., 1h, 30m, 7d)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const filterOptions: LogFilterOptions = {
        tail: parseInt(options.tail, 10),
        follow: options.follow || options.f,
        tx: options.tx,
        block: options.block,
        since: options.since,
      };

      if (filterOptions.follow) {
        await streamLogs("blockchain", filterOptions, (entry) => {
          if (options.json) {
            console.log(JSON.stringify(entry));
          } else {
            console.log(formatBlockchainLogEntry(entry as BlockchainLogEntry));
          }
        });
        return;
      }

      const spinner = options.json
        ? null
        : ora("Fetching blockchain logs...").start();

      try {
        const logs = await fetchBlockchainLogs(filterOptions);

        spinner?.stop();

        if (options.json) {
          output(logs);
          return;
        }

        if (logs.length === 0) {
          outputWarning("No blockchain logs found matching the criteria.");
          return;
        }

        outputSection("Blockchain Logs");
        for (const entry of logs) {
          console.log(formatBlockchainLogEntry(entry));
          if (Object.keys(entry.data).length > 0) {
            console.log(
              colors.dim(`  Data: ${JSON.stringify(entry.data)}`)
            );
          }
        }
        console.log();
        console.log(colors.dim(`Showing ${logs.length} log entries`));
      } catch (error) {
        spinner?.fail("Failed to fetch blockchain logs");
        outputError(
          "Failed to fetch blockchain logs",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Batch anchoring service logs
  logs
    .command("batch-anchoring")
    .description("View batch anchoring service logs")
    .option("--tail <lines>", "Number of lines to show", "100")
    .option("--follow, -f", "Stream logs in real-time")
    .option("--level <level>", "Filter by log level")
    .option("--since <duration>", "Show logs since duration")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const filterOptions: LogFilterOptions = {
        tail: parseInt(options.tail, 10),
        follow: options.follow || options.f,
        level: options.level,
        since: options.since,
        service: "batch-anchoring",
      };

      if (filterOptions.follow) {
        await streamLogs("server", filterOptions, (entry) => {
          if (options.json) {
            console.log(JSON.stringify(entry));
          } else {
            console.log(formatLogEntry(entry as LogEntry));
          }
        });
        return;
      }

      const spinner = options.json
        ? null
        : ora("Fetching batch anchoring logs...").start();

      try {
        const logs = await fetchServerLogs(filterOptions);

        spinner?.stop();

        if (options.json) {
          output(logs);
          return;
        }

        if (logs.length === 0) {
          outputWarning("No batch anchoring logs found.");
          return;
        }

        outputSection("Batch Anchoring Logs");
        for (const entry of logs) {
          console.log(formatLogEntry(entry));
        }
        console.log();
        console.log(colors.dim(`Showing ${logs.length} log entries`));
      } catch (error) {
        spinner?.fail("Failed to fetch batch anchoring logs");
        outputError(
          "Failed to fetch logs",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Agent framework logs
  logs
    .command("agents")
    .description("View agent framework logs")
    .option("--tail <lines>", "Number of lines to show", "100")
    .option("--follow, -f", "Stream logs in real-time")
    .option("--level <level>", "Filter by log level")
    .option("--since <duration>", "Show logs since duration")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const filterOptions: LogFilterOptions = {
        tail: parseInt(options.tail, 10),
        follow: options.follow || options.f,
        level: options.level,
        since: options.since,
        service: "agents",
      };

      if (filterOptions.follow) {
        await streamLogs("server", filterOptions, (entry) => {
          if (options.json) {
            console.log(JSON.stringify(entry));
          } else {
            console.log(formatLogEntry(entry as LogEntry));
          }
        });
        return;
      }

      const spinner = options.json
        ? null
        : ora("Fetching agent framework logs...").start();

      try {
        const logs = await fetchServerLogs(filterOptions);

        spinner?.stop();

        if (options.json) {
          output(logs);
          return;
        }

        if (logs.length === 0) {
          outputWarning("No agent framework logs found.");
          return;
        }

        outputSection("Agent Framework Logs");
        for (const entry of logs) {
          console.log(formatLogEntry(entry));
        }
        console.log();
        console.log(colors.dim(`Showing ${logs.length} log entries`));
      } catch (error) {
        spinner?.fail("Failed to fetch agent framework logs");
        outputError(
          "Failed to fetch logs",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Export logs
  logs
    .command("export")
    .description("Export logs to a file")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--output <file>", "Output file path")
    .option("--format <format>", "Output format (json or csv)", "json")
    .option("--json", "Output status as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (!options.from) {
        outputError("Missing required option: --from <date>");
        return;
      }

      const exportOptions: LogExportOptions = {
        from: options.from,
        to: options.to || new Date().toISOString().split("T")[0],
        output: options.output,
        format: options.format as "json" | "csv",
      };

      await exportLogs(exportOptions);
    });

  // Add help examples
  logs.addHelpText(
    "after",
    `
Examples:
  $ 0xscada logs server                     View server application logs
  $ 0xscada logs server --tail 100          Last 100 lines
  $ 0xscada logs server --follow            Stream in real-time
  $ 0xscada logs server --level error       Filter by log level
  $ 0xscada logs server --since 1h          Last hour

  $ 0xscada logs blockchain                 View blockchain node logs
  $ 0xscada logs blockchain --tx <hash>     Specific transaction
  $ 0xscada logs blockchain --block <num>   Specific block

  $ 0xscada logs batch-anchoring            Batch anchoring service logs
  $ 0xscada logs agents                     Agent framework logs

  $ 0xscada logs export --from 2024-01-01 --to 2024-01-31 --output logs.json
`
  );
}
