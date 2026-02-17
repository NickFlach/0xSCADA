import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import ora from "ora";
import {
  outputSection,
  outputError,
  outputSuccess,
  outputInfo,
  setOutputOptions,
  output,
} from "../output.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../../../");

function runCommand(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; process.stdout.write(d); });
    child.stderr?.on("data", (d) => { stderr += d; process.stderr.write(d); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

export function registerDbCommand(program: Command): void {
  const db = program
    .command("db")
    .description("Database management commands");

  db
    .command("migrate")
    .description("Run database migrations")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--dry-run", "Show pending migrations without applying")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (options.json) {
        output({ action: "migrate", status: "running", dryRun: options.dryRun ?? false });
      } else {
        outputSection("Database Migration");
      }

      if (options.dryRun) {
        outputInfo("Dry run — showing pending migrations");
      }

      const spinner = options.json ? null : ora("Running migrations...").start();

      try {
        const args = options.dryRun ? ["drizzle-kit", "check"] : ["drizzle-kit", "push"];
        const result = await runCommand("npx", args, PROJECT_ROOT);

        if (result.code === 0) {
          spinner?.succeed("Migrations complete");
          if (options.json) {
            output({ action: "migrate", status: "success" });
          } else {
            outputSuccess("Database migrations applied successfully");
          }
        } else {
          spinner?.fail("Migration failed");
          outputError(`Migration exited with code ${result.code}`);
          process.exitCode = 1;
        }
      } catch (error: any) {
        spinner?.fail("Migration failed");
        outputError(error.message);
        process.exitCode = 1;
      }
    });

  db
    .command("seed")
    .description("Seed the database with development data")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--reset", "Clear existing data before seeding")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (!options.json) {
        outputSection("Database Seeding");
      }

      if (options.reset) {
        outputInfo("Resetting database before seeding...");
      }

      const spinner = options.json ? null : ora("Seeding database...").start();

      try {
        const scriptPath = path.join(PROJECT_ROOT, "scripts", "seed.ts");
        const args = ["tsx", scriptPath];
        if (options.reset) args.push("--reset");

        const result = await runCommand("npx", args, PROJECT_ROOT);

        if (result.code === 0) {
          spinner?.succeed("Database seeded");
          if (options.json) {
            output({ action: "seed", status: "success", reset: options.reset ?? false });
          } else {
            outputSuccess("Development data seeded successfully");
          }
        } else {
          spinner?.fail("Seeding failed");
          outputError(`Seed script exited with code ${result.code}`);
          process.exitCode = 1;
        }
      } catch (error: any) {
        spinner?.fail("Seeding failed");
        outputError(error.message);
        process.exitCode = 1;
      }
    });

  db
    .command("status")
    .description("Show database connection status and info")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Checking database...").start();

      try {
        const dbUrl = process.env.DATABASE_URL;
        const hasConnection = !!dbUrl;

        spinner?.succeed("Database status checked");

        const info = {
          configured: hasConnection,
          url: hasConnection ? dbUrl!.replace(/\/\/.*@/, "//***@") : "Not configured",
          provider: hasConnection ? (dbUrl!.startsWith("postgres") ? "PostgreSQL" : "Unknown") : "—",
        };

        if (options.json) {
          output(info);
        } else {
          outputSection("Database Status");
          outputInfo(`Configured: ${info.configured ? "Yes" : "No"}`);
          outputInfo(`Provider: ${info.provider}`);
          outputInfo(`Connection: ${info.url}`);
        }
      } catch (error: any) {
        spinner?.fail("Failed to check database");
        outputError(error.message);
        process.exitCode = 1;
      }
    });
}
