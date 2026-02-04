import { Command } from "commander";
import ora from "ora";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputWarning,
  outputTable,
  setOutputOptions,
  colors,
  formatDate,
} from "../output.js";
import {
  login,
  logout,
  getAuthStatus,
  getCurrentApiKey,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  getStoragePaths,
} from "../secure-storage.js";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage API authentication and keys");

  // Login command
  auth
    .command("login")
    .description("Login with an API key")
    .option("--key <apiKey>", "API key to use for authentication")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      let apiKey = options.key;

      // If no key provided, check environment variable
      if (!apiKey) {
        apiKey = process.env.OXSCADA_API_KEY || process.env["0XSCADA_API_KEY"];
      }

      if (!apiKey) {
        outputError(
          "No API key provided",
          "Use --key <apiKey> or set OXSCADA_API_KEY environment variable"
        );
        return;
      }

      try {
        login(apiKey);

        if (options.json) {
          output({ success: true, message: "Logged in successfully" });
          return;
        }

        outputSuccess("Logged in successfully");
        console.log();
        console.log(
          colors.dim("Your API key has been securely stored.")
        );
        console.log(
          colors.dim("Use 'auth logout' to clear stored credentials.")
        );
        console.log();
      } catch (error) {
        outputError(
          "Login failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Logout command
  auth
    .command("logout")
    .description("Logout and clear stored credentials")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        logout();

        if (options.json) {
          output({ success: true, message: "Logged out successfully" });
          return;
        }

        outputSuccess("Logged out successfully");
        console.log();
        console.log(colors.dim("Stored credentials have been cleared."));
        console.log();
      } catch (error) {
        outputError(
          "Logout failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Status command
  auth
    .command("status")
    .description("Show current authentication status")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const status = getAuthStatus();
        const currentKey = getCurrentApiKey();
        const paths = getStoragePaths();

        if (options.json) {
          output({
            isLoggedIn: status.isLoggedIn,
            hasEnvKey: status.hasEnvKey,
            loginTime: status.loginTime,
            apiKeyCount: status.apiKeyCount,
            hasApiKey: !!currentKey,
          });
          return;
        }

        outputSection("Authentication Status");

        const statusIcon = status.isLoggedIn
          ? colors.success("Authenticated")
          : colors.error("Not authenticated");

        outputKeyValue([
          { key: "Status", value: statusIcon },
          {
            key: "API Key",
            value: currentKey
              ? `${currentKey.substring(0, 12)}...${currentKey.substring(currentKey.length - 4)}`
              : colors.dim("Not set"),
          },
          {
            key: "Source",
            value: status.hasEnvKey
              ? "Environment variable (OXSCADA_API_KEY)"
              : status.isLoggedIn
                ? "Stored credentials"
                : colors.dim("None"),
          },
          {
            key: "Login Time",
            value: status.loginTime
              ? formatDate(status.loginTime)
              : colors.dim("N/A"),
          },
          { key: "Stored API Keys", value: String(status.apiKeyCount) },
        ]);

        console.log();
        outputSection("Storage Locations");
        console.log(`  ${colors.dim("Credentials:")} ${paths.credentialsPath}`);
        console.log(`  ${colors.dim("Wallets:")}     ${paths.walletsPath}`);
        console.log();
      } catch (error) {
        outputError(
          "Failed to get status",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Keys subcommand group
  const keys = auth
    .command("keys")
    .description("Manage API keys");

  // List keys
  keys
    .command("list")
    .description("List all stored API keys")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const apiKeys = listApiKeys();

        if (options.json) {
          output(apiKeys);
          return;
        }

        if (apiKeys.length === 0) {
          outputWarning("No API keys stored");
          console.log();
          console.log(
            colors.dim("Use 'auth keys create --name <name>' to create a new API key")
          );
          console.log();
          return;
        }

        outputSection("Stored API Keys");
        outputTable(
          ["ID", "Name", "Key", "Scopes", "Created"],
          apiKeys.map((k) => [
            k.id,
            k.name,
            k.key,
            k.scopes.join(", ") || colors.dim("none"),
            formatDate(k.createdAt),
          ])
        );
        console.log();
      } catch (error) {
        outputError(
          "Failed to list keys",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Create key
  keys
    .command("create")
    .description("Create a new API key")
    .requiredOption("--name <name>", "Name for the API key")
    .option("--scopes <scopes>", "Comma-separated list of scopes", "read,write")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const scopes = options.scopes.split(",").map((s: string) => s.trim());
        const newKey = createApiKey(options.name, scopes);

        if (options.json) {
          output({
            success: true,
            key: newKey,
          });
          return;
        }

        outputSuccess(`API key '${options.name}' created successfully`);
        console.log();
        console.log(colors.bold("Your new API key:"));
        console.log();
        console.log(`  ${colors.cyan(newKey.key)}`);
        console.log();
        console.log(
          colors.warning(
            "Important: Save this key now. You won't be able to see it again!"
          )
        );
        console.log();
        outputKeyValue([
          { key: "ID", value: newKey.id },
          { key: "Name", value: newKey.name },
          { key: "Scopes", value: newKey.scopes.join(", ") },
          { key: "Created", value: formatDate(newKey.createdAt) },
        ]);
        console.log();
      } catch (error) {
        outputError(
          "Failed to create key",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Revoke key
  keys
    .command("revoke <key-id>")
    .description("Revoke an API key")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((keyId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const success = revokeApiKey(keyId);

        if (!success) {
          outputError("Key not found", `No API key with ID '${keyId}' exists`);
          return;
        }

        if (options.json) {
          output({ success: true, message: "API key revoked" });
          return;
        }

        outputSuccess(`API key '${keyId}' has been revoked`);
        console.log();
      } catch (error) {
        outputError(
          "Failed to revoke key",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Rotate key
  keys
    .command("rotate <key-id>")
    .description("Rotate an API key (generate new key value)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((keyId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const rotatedKey = rotateApiKey(keyId);

        if (!rotatedKey) {
          outputError("Key not found", `No API key with ID '${keyId}' exists`);
          return;
        }

        if (options.json) {
          output({
            success: true,
            key: rotatedKey,
          });
          return;
        }

        outputSuccess(`API key '${keyId}' has been rotated`);
        console.log();
        console.log(colors.bold("Your new API key:"));
        console.log();
        console.log(`  ${colors.cyan(rotatedKey.key)}`);
        console.log();
        console.log(
          colors.warning(
            "Important: Save this key now. You won't be able to see it again!"
          )
        );
        console.log();
      } catch (error) {
        outputError(
          "Failed to rotate key",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
