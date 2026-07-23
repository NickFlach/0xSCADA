import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getAllConfigPaths,
  type Config,
} from "../config.js";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  setOutputOptions,
  colors,
} from "../output.js";

const VALID_KEYS: Array<keyof Config> = [
  "apiUrl",
  "timeout",
  "colorOutput",
  "jsonOutput",
];

function parseValue(key: string, value: string): string | number | boolean {
  switch (key) {
    case "timeout":
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        throw new Error(`Invalid value for timeout: ${value} (must be a positive number)`);
      }
      return num;
    case "colorOutput":
    case "jsonOutput":
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") {
        return true;
      }
      if (lower === "false" || lower === "0" || lower === "no") {
        return false;
      }
      throw new Error(`Invalid value for ${key}: ${value} (must be true/false)`);
    case "apiUrl":
      try {
        new URL(value);
        return value;
      } catch {
        throw new Error(`Invalid URL for apiUrl: ${value}`);
      }
    default:
      return value;
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command("config")
    .description("Manage CLI configuration");

  // Show configuration
  config
    .command("show")
    .description("Display current configuration")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const currentConfig = loadConfig();
      const configPath = getConfigPath();

      if (options.json) {
        output({
          config: currentConfig,
          configFile: configPath,
          searchPaths: getAllConfigPaths(),
        });
        return;
      }

      outputSection("Current Configuration");
      outputKeyValue([
        { key: "API URL", value: currentConfig.apiUrl },
        { key: "Timeout", value: `${currentConfig.timeout}ms` },
        { key: "Color Output", value: currentConfig.colorOutput ? "Yes" : "No" },
        { key: "JSON Output", value: currentConfig.jsonOutput ? "Yes" : "No" },
      ]);

      console.log();
      outputSection("Configuration Sources");
      
      if (configPath) {
        console.log(`  ${colors.success("●")} Config file: ${configPath}`);
      } else {
        console.log(`  ${colors.dim("○")} No config file found`);
      }

      console.log();
      console.log(colors.dim("Environment variable overrides:"));
      console.log(colors.dim("  OXSCADA_API_URL    - Override API URL"));
      console.log(colors.dim("  OXSCADA_TIMEOUT    - Override timeout (ms)"));
      console.log(colors.dim("  OXSCADA_NO_COLOR   - Disable color output"));
      console.log(colors.dim("  NO_COLOR           - Disable color output (standard)"));
      console.log();
    });

  // Set configuration value
  config
    .command("set <key> <value>")
    .description("Update a configuration value")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((key: string, value: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (!VALID_KEYS.includes(key as keyof Config)) {
        outputError(
          `Invalid configuration key: ${key}`,
          `Valid keys are: ${VALID_KEYS.join(", ")}`
        );
        return;
      }

      let parsedValue: string | number | boolean;
      try {
        parsedValue = parseValue(key, value);
      } catch (error) {
        outputError(
          "Invalid value",
          error instanceof Error ? error.message : "Unknown error"
        );
        return;
      }

      try {
        saveConfig({ [key]: parsedValue } as Partial<Config>);

        if (options.json) {
          output({
            success: true,
            key,
            value: parsedValue,
          });
          return;
        }

        outputSuccess(`Configuration updated: ${key} = ${parsedValue}`);
      } catch (error) {
        outputError(
          "Failed to save configuration",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get specific configuration value
  config
    .command("get <key>")
    .description("Get a specific configuration value")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((key: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (!VALID_KEYS.includes(key as keyof Config)) {
        outputError(
          `Invalid configuration key: ${key}`,
          `Valid keys are: ${VALID_KEYS.join(", ")}`
        );
        return;
      }

      const currentConfig = loadConfig();
      const value = currentConfig[key as keyof Config];

      if (options.json) {
        output({ [key]: value });
        return;
      }

      console.log(value);
    });

  // List valid configuration keys
  config
    .command("keys")
    .description("List all valid configuration keys")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const keyDescriptions: Record<string, string> = {
        apiUrl: "Base URL for the 0xSCADA API server",
        timeout: "Request timeout in milliseconds",
        colorOutput: "Enable/disable colorized terminal output",
        jsonOutput: "Default to JSON output format",
      };

      if (options.json) {
        output(
          VALID_KEYS.map((key) => ({
            key,
            description: keyDescriptions[key],
          }))
        );
        return;
      }

      outputSection("Configuration Keys");
      VALID_KEYS.forEach((key) => {
        console.log(`  ${colors.bold(key)}`);
        console.log(`    ${colors.dim(keyDescriptions[key])}`);
      });
      console.log();
    });

  // Show config file paths
  config
    .command("paths")
    .description("Show configuration file search paths")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const paths = getAllConfigPaths();
      const activePath = getConfigPath();

      if (options.json) {
        output({
          searchPaths: paths,
          activeFile: activePath,
        });
        return;
      }

      outputSection("Configuration File Search Paths");
      paths.forEach((p) => {
        const isActive = p === activePath;
        const marker = isActive ? colors.success("● ") : colors.dim("○ ");
        console.log(`  ${marker}${p}${isActive ? colors.dim(" (active)") : ""}`);
      });
      console.log();
      console.log(colors.dim("Files are searched in order. First found is used."));
      console.log();
    });
}
