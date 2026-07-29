/**
 * Output Formatter for 0xSCADA CLI
 * Supports multiple output formats: JSON, YAML, CSV, TSV, and Table themes
 */

import Table from "cli-table3";
import chalk from "chalk";

// Output format types
export type OutputFormat =
  | "json"
  | "yaml"
  | "csv"
  | "tsv"
  | "table"
  | "table:minimal"
  | "table:ascii"
  | "table:rounded"
  | "table:heavy"
  | "table:double";

export type TableTheme = "default" | "minimal" | "ascii" | "rounded" | "heavy" | "double";

export interface FormatterOptions {
  format?: OutputFormat;
  color?: boolean;
}

export interface TableCharacters {
  top: string;
  "top-mid": string;
  "top-left": string;
  "top-right": string;
  bottom: string;
  "bottom-mid": string;
  "bottom-left": string;
  "bottom-right": string;
  left: string;
  "left-mid": string;
  mid: string;
  "mid-mid": string;
  right: string;
  "right-mid": string;
  middle: string;
}

// Table theme character sets
const tableThemes: Record<TableTheme, TableCharacters> = {
  default: {
    top: "─",
    "top-mid": "┬",
    "top-left": "┌",
    "top-right": "┐",
    bottom: "─",
    "bottom-mid": "┴",
    "bottom-left": "└",
    "bottom-right": "┘",
    left: "│",
    "left-mid": "├",
    mid: "─",
    "mid-mid": "┼",
    right: "│",
    "right-mid": "┤",
    middle: "│",
  },
  minimal: {
    top: "",
    "top-mid": "",
    "top-left": "",
    "top-right": "",
    bottom: "",
    "bottom-mid": "",
    "bottom-left": "",
    "bottom-right": "",
    left: "",
    "left-mid": "",
    mid: "",
    "mid-mid": "",
    right: "",
    "right-mid": "",
    middle: "  ",
  },
  ascii: {
    top: "-",
    "top-mid": "+",
    "top-left": "+",
    "top-right": "+",
    bottom: "-",
    "bottom-mid": "+",
    "bottom-left": "+",
    "bottom-right": "+",
    left: "|",
    "left-mid": "+",
    mid: "-",
    "mid-mid": "+",
    right: "|",
    "right-mid": "+",
    middle: "|",
  },
  rounded: {
    top: "─",
    "top-mid": "┬",
    "top-left": "╭",
    "top-right": "╮",
    bottom: "─",
    "bottom-mid": "┴",
    "bottom-left": "╰",
    "bottom-right": "╯",
    left: "│",
    "left-mid": "├",
    mid: "─",
    "mid-mid": "┼",
    right: "│",
    "right-mid": "┤",
    middle: "│",
  },
  heavy: {
    top: "━",
    "top-mid": "┳",
    "top-left": "┏",
    "top-right": "┓",
    bottom: "━",
    "bottom-mid": "┻",
    "bottom-left": "┗",
    "bottom-right": "┛",
    left: "┃",
    "left-mid": "┣",
    mid: "━",
    "mid-mid": "╋",
    right: "┃",
    "right-mid": "┫",
    middle: "┃",
  },
  double: {
    top: "═",
    "top-mid": "╦",
    "top-left": "╔",
    "top-right": "╗",
    bottom: "═",
    "bottom-mid": "╩",
    "bottom-left": "╚",
    "bottom-right": "╝",
    left: "║",
    "left-mid": "╠",
    mid: "═",
    "mid-mid": "╬",
    right: "║",
    "right-mid": "╣",
    middle: "║",
  },
};

/**
 * Parse output format string to extract format and theme
 */
export function parseOutputFormat(format: string): { format: string; theme?: TableTheme } {
  const [baseFormat, theme] = format.split(":");
  if (baseFormat === "table" && theme) {
    if (isValidTableTheme(theme)) {
      return { format: "table", theme };
    }
    // Invalid theme, use default
    return { format: "table", theme: "default" };
  }
  return { format: baseFormat };
}

/**
 * Check if a string is a valid table theme
 */
export function isValidTableTheme(theme: string): theme is TableTheme {
  return ["default", "minimal", "ascii", "rounded", "heavy", "double"].includes(theme);
}

/**
 * Check if format requires structured data (non-table formats)
 */
export function isStructuredFormat(format: string): boolean {
  const { format: baseFormat } = parseOutputFormat(format);
  return ["json", "yaml", "csv", "tsv"].includes(baseFormat);
}

/**
 * Format data as JSON
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** True if the string carries any C0 control character or DEL. */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Render a string as a YAML double-quoted scalar.
 *
 * The escaping has to be complete and in this order: `\` first, so the escapes
 * added after it are not themselves re-escaped, then `"`, then every control
 * character. A raw control character inside a quoted scalar is invalid YAML — a
 * carriage return ends the line as far as the parser is concerned, so a value
 * carrying one truncates the document there and every key after it silently
 * disappears.
 *
 * This matters because `oxscada ... -o yaml` output is piped into other tools.
 * The values come from API responses, not from the operator typing them.
 */
export function quoteYamlString(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") {
      escaped += "\\\\";
    } else if (char === '"') {
      escaped += '\\"';
    } else if (code >= 32 && code !== 127) {
      escaped += char;
    } else if (char === "\n") {
      escaped += "\\n";
    } else if (char === "\r") {
      escaped += "\\r";
    } else if (char === "\t") {
      escaped += "\\t";
    } else {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return `"${escaped}"`;
}

/**
 * Format data as YAML
 * Simple YAML formatter without external dependencies
 */
export function formatYaml(data: unknown, indent: number = 0): string {
  const spaces = "  ".repeat(indent);

  if (data === null || data === undefined) {
    return "null";
  }

  if (typeof data === "boolean") {
    return data.toString();
  }

  if (typeof data === "number") {
    return data.toString();
  }

  if (typeof data === "string") {
    // Check if string needs quoting
    if (
      data === "" ||
      data.includes(":") ||
      data.includes("#") ||
      hasControlCharacter(data) ||
      data.startsWith(" ") ||
      data.endsWith(" ") ||
      /^[\d.]+$/.test(data) ||
      ["true", "false", "null", "yes", "no"].includes(data.toLowerCase())
    ) {
      return quoteYamlString(data);
    }
    return data;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return "[]";
    }
    return data
      .map((item) => {
        const formatted = formatYaml(item, indent + 1);
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          return `${spaces}- ${formatted.trimStart()}`;
        }
        return `${spaces}- ${formatted}`;
      })
      .join("\n");
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    return entries
      .map(([key, value]) => {
        const formattedValue = formatYaml(value, indent + 1);
        if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
          return `${spaces}${key}:\n${formattedValue}`;
        }
        if (Array.isArray(value) && value.length > 0) {
          return `${spaces}${key}:\n${formattedValue}`;
        }
        return `${spaces}${key}: ${formattedValue}`;
      })
      .join("\n");
  }

  return String(data);
}

/**
 * Escape a value for CSV/TSV output
 */
function escapeDelimitedValue(value: string, delimiter: string): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");

  if (needsQuoting) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format data as CSV
 */
export function formatCsv(headers: string[], rows: string[][]): string {
  const headerLine = headers.map(h => escapeDelimitedValue(h, ",")).join(",");
  const dataLines = rows.map(row =>
    row.map(cell => escapeDelimitedValue(cell, ",")).join(",")
  );
  return [headerLine, ...dataLines].join("\n");
}

/**
 * Format data as TSV (Tab-separated values)
 */
export function formatTsv(headers: string[], rows: string[][]): string {
  const headerLine = headers.map(h => escapeDelimitedValue(h, "\t")).join("\t");
  const dataLines = rows.map(row =>
    row.map(cell => escapeDelimitedValue(cell, "\t")).join("\t")
  );
  return [headerLine, ...dataLines].join("\n");
}

/**
 * Format data as a table with specified theme
 */
export function formatTable(
  headers: string[],
  rows: string[][],
  options: { theme?: TableTheme; color?: boolean } = {}
): string {
  const { theme = "default", color = true } = options;
  const chars = tableThemes[theme];

  const table = new Table({
    head: color ? headers.map(h => chalk.bold.cyan(h)) : headers,
    chars,
    style: {
      head: color ? ["cyan"] : [],
      border: color ? ["gray"] : [],
      "padding-left": 1,
      "padding-right": 1,
    },
  });

  rows.forEach(row => table.push(row));
  return table.toString();
}

/**
 * Convert array of objects to headers and rows
 */
export function objectsToTable(data: Record<string, unknown>[]): { headers: string[]; rows: string[][] } {
  if (!Array.isArray(data) || data.length === 0) {
    return { headers: [], rows: [] };
  }

  // Get all unique keys from all objects
  const headerSet = new Set<string>();
  data.forEach(obj => {
    Object.keys(obj).forEach(key => headerSet.add(key));
  });
  const headers = Array.from(headerSet);

  // Convert objects to rows
  const rows = data.map(obj =>
    headers.map(header => {
      const value = obj[header];
      if (value === null || value === undefined) {
        return "";
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    })
  );

  return { headers, rows };
}

/**
 * Main formatter class for flexible output formatting
 */
export class Formatter {
  private format: OutputFormat;
  private theme: TableTheme;
  private color: boolean;

  constructor(options: FormatterOptions = {}) {
    const parsed = options.format ? parseOutputFormat(options.format) : { format: "table" };
    this.format = (parsed.format || "table") as OutputFormat;
    this.theme = parsed.theme || "default";
    this.color = options.color !== false;
  }

  /**
   * Get the current format
   */
  getFormat(): OutputFormat {
    return this.format;
  }

  /**
   * Get the current theme
   */
  getTheme(): TableTheme {
    return this.theme;
  }

  /**
   * Check if color output is enabled
   */
  isColorEnabled(): boolean {
    return this.color;
  }

  /**
   * Check if format is structured (JSON, YAML, CSV, TSV)
   */
  isStructured(): boolean {
    return isStructuredFormat(this.format);
  }

  /**
   * Format table data
   */
  formatTableData(headers: string[], rows: string[][]): string {
    switch (this.format) {
      case "json":
        const jsonData = rows.map(row => {
          const obj: Record<string, string> = {};
          headers.forEach((header, i) => {
            obj[header] = row[i];
          });
          return obj;
        });
        return formatJson(jsonData);

      case "yaml":
        const yamlData = rows.map(row => {
          const obj: Record<string, string> = {};
          headers.forEach((header, i) => {
            obj[header] = row[i];
          });
          return obj;
        });
        return formatYaml(yamlData);

      case "csv":
        return formatCsv(headers, rows);

      case "tsv":
        return formatTsv(headers, rows);

      default:
        // Table format (including themed tables)
        return formatTable(headers, rows, { theme: this.theme, color: this.color });
    }
  }

  /**
   * Format arbitrary data
   */
  formatData(data: unknown): string {
    switch (this.format) {
      case "json":
        return formatJson(data);

      case "yaml":
        return formatYaml(data);

      case "csv":
      case "tsv":
        // For CSV/TSV, try to convert to table format
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
          const { headers, rows } = objectsToTable(data as Record<string, unknown>[]);
          return this.format === "csv" ? formatCsv(headers, rows) : formatTsv(headers, rows);
        }
        // Fall back to JSON for non-tabular data
        return formatJson(data);

      default:
        // For table format with arbitrary data, convert if possible
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
          const { headers, rows } = objectsToTable(data as Record<string, unknown>[]);
          return formatTable(headers, rows, { theme: this.theme, color: this.color });
        }
        // Fall back to JSON for non-tabular data
        return formatJson(data);
    }
  }
}

/**
 * Create a formatter with the specified options
 */
export function createFormatter(options: FormatterOptions = {}): Formatter {
  return new Formatter(options);
}

/**
 * Valid output format values for CLI option validation
 */
export const VALID_OUTPUT_FORMATS = [
  "json",
  "yaml",
  "csv",
  "tsv",
  "table",
  "table:minimal",
  "table:ascii",
  "table:rounded",
  "table:heavy",
  "table:double",
] as const;

/**
 * Check if a format string is valid
 */
export function isValidOutputFormat(format: string): format is OutputFormat {
  return VALID_OUTPUT_FORMATS.includes(format as OutputFormat);
}
