import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputWarning,
  outputInfo,
  setOutputOptions,
  colors,
} from "../output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is three levels up from commands directory
const PROJECT_ROOT = path.resolve(__dirname, "../../../../");

export function registerDevCommand(program: Command): void {
  const dev = program
    .command("dev")
    .description("Development environment commands");

  // Start local dev environment
  dev
    .command("start")
    .description("Start the local development environment")
    .option("--no-blockchain", "Skip starting blockchain node")
    .option("--port <port>", "Server port", "5000")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (options.json) {
        output({
          message: "Starting development environment",
          projectRoot: PROJECT_ROOT,
          port: options.port,
          blockchain: options.blockchain,
        });
      } else {
        outputSection("Starting Development Environment");
        outputKeyValue([
          { key: "Project Root", value: PROJECT_ROOT },
          { key: "Server Port", value: options.port },
          { key: "Blockchain", value: options.blockchain ? "Enabled" : "Disabled" },
        ]);
        console.log();
      }

      // Start the development server
      if (!options.json) {
        outputInfo("Starting server with npm run dev...");
      }

      const env = {
        ...process.env,
        PORT: options.port,
      };

      const serverProcess = spawn("npm", ["run", "dev"], {
        cwd: PROJECT_ROOT,
        env,
        stdio: "inherit",
        shell: true,
      });

      serverProcess.on("error", (error) => {
        outputError("Failed to start development server", error.message);
        process.exit(1);
      });

      serverProcess.on("close", (code) => {
        if (code !== 0) {
          outputError(`Development server exited with code ${code}`);
          process.exit(code || 1);
        }
      });

      // Handle graceful shutdown
      const shutdown = () => {
        if (!options.json) {
          console.log();
          outputInfo("Shutting down development environment...");
        }
        serverProcess.kill("SIGTERM");
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  // Seed database
  dev
    .command("seed")
    .description("Seed the database with test/default data")
    .option("--force", "Force re-seed even if already seeded")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Seeding database...").start();
      const api = getApiClient();

      try {
        const response = await api.seedDatabase(options.force);
        spinner?.stop();

        if (!response.success) {
          outputError("Failed to seed database", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data?.skipped) {
          outputWarning(response.data.message || "Database already seeded");
          console.log(colors.dim("Use --force to re-seed the database."));
        } else {
          outputSuccess(response.data?.message || "Database seeded successfully");
        }
      } catch (error) {
        spinner?.fail("Failed to seed database");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
        console.log();
        console.log(colors.dim("Make sure the development server is running:"));
        console.log(colors.dim("  0xscada dev start"));
      }
    });

  // Check environment
  dev
    .command("check")
    .description("Check development environment prerequisites")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const checks: Array<{ name: string; status: "ok" | "warning" | "error"; message: string }> = [];

      // Check Node.js version
      const nodeVersion = process.version;
      const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
      if (nodeMajor >= 18) {
        checks.push({ name: "Node.js", status: "ok", message: `${nodeVersion}` });
      } else {
        checks.push({
          name: "Node.js",
          status: "error",
          message: `${nodeVersion} (requires >= 18)`,
        });
      }

      // Check if server is running
      const api = getApiClient();
      try {
        const health = await api.getHealth();
        if (health.success) {
          checks.push({ name: "Server", status: "ok", message: "Running" });
        } else {
          checks.push({ name: "Server", status: "warning", message: "Not responding" });
        }
      } catch {
        checks.push({ name: "Server", status: "warning", message: "Not running" });
      }

      // Check database
      try {
        const health = await api.getHealth();
        if (health.success && health.data?.components.database.status === "up") {
          checks.push({
            name: "Database",
            status: "ok",
            message: `Connected (${health.data.components.database.latencyMs}ms)`,
          });
        } else {
          checks.push({ name: "Database", status: "error", message: "Not connected" });
        }
      } catch {
        checks.push({ name: "Database", status: "warning", message: "Unable to check" });
      }

      // Check blockchain
      try {
        const bcStatus = await api.getBlockchainStatus();
        if (bcStatus.success && bcStatus.data?.enabled) {
          checks.push({ name: "Blockchain", status: "ok", message: "Enabled" });
        } else {
          checks.push({
            name: "Blockchain",
            status: "warning",
            message: "Disabled (optional)",
          });
        }
      } catch {
        checks.push({ name: "Blockchain", status: "warning", message: "Unable to check" });
      }

      // Check environment variables
      const requiredEnvVars = ["DATABASE_URL"];
      const optionalEnvVars = ["BLOCKCHAIN_RPC_URL", "BLOCKCHAIN_PRIVATE_KEY"];

      for (const envVar of requiredEnvVars) {
        if (process.env[envVar]) {
          checks.push({ name: envVar, status: "ok", message: "Set" });
        } else {
          checks.push({ name: envVar, status: "error", message: "Not set" });
        }
      }

      for (const envVar of optionalEnvVars) {
        if (process.env[envVar]) {
          checks.push({ name: envVar, status: "ok", message: "Set" });
        } else {
          checks.push({ name: envVar, status: "warning", message: "Not set (optional)" });
        }
      }

      if (options.json) {
        output({ checks });
        return;
      }

      outputSection("Environment Check");

      for (const check of checks) {
        const icon =
          check.status === "ok"
            ? colors.success("✓")
            : check.status === "warning"
              ? colors.warning("⚠")
              : colors.error("✗");
        console.log(`  ${icon} ${check.name}: ${check.message}`);
      }

      console.log();

      const hasErrors = checks.some((c) => c.status === "error");
      const hasWarnings = checks.some((c) => c.status === "warning");

      if (hasErrors) {
        outputError("Some required checks failed");
      } else if (hasWarnings) {
        outputWarning("All required checks passed with warnings");
      } else {
        outputSuccess("All checks passed");
      }
    });
}
