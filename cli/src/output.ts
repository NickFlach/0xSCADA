import chalk from "chalk";
import { loadConfig } from "./config.js";
import {
  Formatter,
  createFormatter,
  OutputFormat,
  TableTheme,
  isValidOutputFormat,
  VALID_OUTPUT_FORMATS,
  parseOutputFormat,
} from "./lib/formatter.js";

export interface OutputOptions {
  json?: boolean;
  color?: boolean;
  output?: OutputFormat | string;
}

let globalOptions: OutputOptions = {};
let globalFormatter: Formatter | null = null;

// Re-export formatter types and utilities
export { OutputFormat, TableTheme, isValidOutputFormat, VALID_OUTPUT_FORMATS, parseOutputFormat };
export type { Formatter };

export function setOutputOptions(options: OutputOptions): void {
  globalOptions = { ...globalOptions, ...options };
  // Create formatter based on options
  if (options.output || options.json !== undefined) {
    const format = options.output || (options.json ? "json" : "table");
    globalFormatter = createFormatter({
      format: format as OutputFormat,
      color: options.color,
    });
  }
}

/**
 * Get the current formatter instance
 */
export function getFormatter(): Formatter {
  if (!globalFormatter) {
    globalFormatter = createFormatter({
      format: globalOptions.output as OutputFormat || (globalOptions.json ? "json" : "table"),
      color: globalOptions.color,
    });
  }
  return globalFormatter;
}

/**
 * Get the current output format
 */
export function getOutputFormat(): OutputFormat | string {
  return globalOptions.output || (globalOptions.json ? "json" : "table");
}

/**
 * Check if using a structured output format (non-table)
 */
export function isStructuredOutput(): boolean {
  const format = getOutputFormat();
  const { format: baseFormat } = parseOutputFormat(format);
  return ["json", "yaml", "csv", "tsv"].includes(baseFormat);
}

function shouldUseColor(): boolean {
  if (globalOptions.color !== undefined) return globalOptions.color;
  const config = loadConfig();
  return config.colorOutput;
}

// Color helpers
export const colors = {
  success: (text: string) => (shouldUseColor() ? chalk.green(text) : text),
  error: (text: string) => (shouldUseColor() ? chalk.red(text) : text),
  warning: (text: string) => (shouldUseColor() ? chalk.yellow(text) : text),
  info: (text: string) => (shouldUseColor() ? chalk.blue(text) : text),
  dim: (text: string) => (shouldUseColor() ? chalk.dim(text) : text),
  bold: (text: string) => (shouldUseColor() ? chalk.bold(text) : text),
  cyan: (text: string) => (shouldUseColor() ? chalk.cyan(text) : text),
  magenta: (text: string) => (shouldUseColor() ? chalk.magenta(text) : text),
};

// Status indicators
export function statusIcon(status: string): string {
  if (!shouldUseColor()) {
    return status === "up" || status === "healthy" ? "[OK]" : "[FAIL]";
  }

  switch (status.toLowerCase()) {
    case "up":
    case "healthy":
    case "enabled":
    case "connected":
      return chalk.green("●");
    case "down":
    case "unhealthy":
    case "disabled":
    case "disconnected":
      return chalk.red("●");
    case "warning":
    case "degraded":
      return chalk.yellow("●");
    default:
      return chalk.gray("○");
  }
}

// Output functions
export function output(data: unknown): void {
  const formatter = getFormatter();
  if (isStructuredOutput()) {
    console.log(formatter.formatData(data));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(formatter.formatData(data));
  }
}

export function outputTable(
  headers: string[],
  rows: string[][],
  _options?: { head?: string[] }
): void {
  const formatter = getFormatter();
  console.log(formatter.formatTableData(headers, rows));
}

export function outputSuccess(message: string): void {
  if (isStructuredOutput()) {
    const formatter = getFormatter();
    console.log(formatter.formatData({ success: true, message }));
  } else {
    console.log(colors.success("✓ ") + message);
  }
}

export function outputError(message: string, details?: string): void {
  if (isStructuredOutput()) {
    const formatter = getFormatter();
    console.log(formatter.formatData({ success: false, error: message, details }));
  } else {
    console.error(colors.error("✗ ") + message);
    if (details) {
      console.error(colors.dim("  " + details));
    }
  }
  process.exitCode = 1;
}

export function outputWarning(message: string): void {
  if (isStructuredOutput()) {
    const formatter = getFormatter();
    console.log(formatter.formatData({ warning: message }));
  } else {
    console.log(colors.warning("⚠ ") + message);
  }
}

export function outputInfo(message: string): void {
  if (!isStructuredOutput()) {
    console.log(colors.info("ℹ ") + message);
  }
}

// Section headers
export function outputSection(title: string): void {
  if (!isStructuredOutput()) {
    console.log();
    console.log(colors.bold(colors.cyan(title)));
    console.log(colors.dim("─".repeat(title.length)));
  }
}

// Key-value output
export function outputKeyValue(items: Array<{ key: string; value: string }>): void {
  if (isStructuredOutput()) {
    const obj: Record<string, string> = {};
    items.forEach(({ key, value }) => {
      obj[key] = value;
    });
    const formatter = getFormatter();
    console.log(formatter.formatData(obj));
    return;
  }

  const maxKeyLength = Math.max(...items.map((i) => i.key.length));
  items.forEach(({ key, value }) => {
    const paddedKey = key.padEnd(maxKeyLength);
    console.log(`  ${colors.dim(paddedKey)}  ${value}`);
  });
}

// Format helpers
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString();
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

export function formatBoolean(value: boolean): string {
  if (shouldUseColor()) {
    return value ? chalk.green("Yes") : chalk.red("No");
  }
  return value ? "Yes" : "No";
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
