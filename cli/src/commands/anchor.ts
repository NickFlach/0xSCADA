import { Command } from "commander";
import ora from "ora";
import fs from "fs";
import path from "path";
import { getApiClient } from "../api.js";
import {
  output,
  outputTable,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputWarning,
  formatDate,
  truncate,
  setOutputOptions,
  colors,
} from "../output.js";

export function registerAnchorCommand(program: Command): void {
  const anchor = program
    .command("anchor")
    .description("Merkle tree anchoring operations");

  // Create anchor
  anchor
    .command("create")
    .description("Create a new anchor from data hash")
    .requiredOption("--data <hash>", "Data hash or event hash to anchor")
    .option("--metadata <json>", "Optional metadata as JSON string")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      let metadata: Record<string, unknown> | undefined;
      if (options.metadata) {
        try {
          metadata = JSON.parse(options.metadata);
        } catch {
          outputError("Invalid JSON metadata", "Please provide valid JSON for --metadata");
          return;
        }
      }

      const spinner = options.json ? null : ora("Creating anchor...").start();
      const api = getApiClient();

      try {
        const response = await api.createAnchor({
          dataHash: options.data,
          metadata,
        });

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to create anchor", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Anchor created: ${response.data.anchorId}`);
        outputKeyValue([
          { key: "Anchor ID", value: response.data.anchorId },
          { key: "Data Hash", value: response.data.dataHash },
          { key: "Status", value: response.data.status },
          {
            key: "Batch ID",
            value: response.data.batchId || colors.dim("Pending batching"),
          },
        ]);
      } catch (error) {
        spinner?.fail("Failed to create anchor");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Batch anchoring from file
  anchor
    .command("batch")
    .description("Batch anchor multiple hashes from a file")
    .requiredOption("--file <path>", "Path to file containing hashes (one per line)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      // Read hashes from file
      let hashes: string[];
      try {
        const filePath = path.resolve(options.file);
        const content = fs.readFileSync(filePath, "utf-8");
        hashes = content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith("#"));
      } catch (error) {
        outputError(
          "Failed to read file",
          error instanceof Error ? error.message : "Unknown error"
        );
        return;
      }

      if (hashes.length === 0) {
        outputWarning("No hashes found in file");
        return;
      }

      const spinner = options.json ? null : ora(`Batch anchoring ${hashes.length} hashes...`).start();
      const api = getApiClient();

      try {
        const response = await api.batchAnchor(hashes);

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to batch anchor", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Batch anchoring initiated: ${response.data.batchId}`);
        outputKeyValue([
          { key: "Batch ID", value: response.data.batchId },
          { key: "Hashes Queued", value: String(response.data.hashCount) },
          { key: "Status", value: response.data.status },
        ]);
      } catch (error) {
        spinner?.fail("Failed to batch anchor");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Verify anchor
  anchor
    .command("verify <anchor-id>")
    .description("Verify an anchor exists and is valid")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (anchorId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Verifying anchor...").start();
      const api = getApiClient();

      try {
        const response = await api.verifyAnchor(anchorId);

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to verify anchor", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data.valid) {
          outputSuccess("Anchor is valid");
        } else {
          outputWarning("Anchor verification failed");
        }

        outputKeyValue([
          { key: "Anchor ID", value: response.data.anchorId },
          { key: "Valid", value: response.data.valid ? colors.success("Yes") : colors.error("No") },
          { key: "Data Hash", value: response.data.dataHash },
          { key: "Merkle Root", value: response.data.merkleRoot || colors.dim("N/A") },
          { key: "Block Number", value: response.data.blockNumber ? String(response.data.blockNumber) : colors.dim("N/A") },
          { key: "TX Hash", value: response.data.txHash || colors.dim("N/A") },
        ]);
      } catch (error) {
        spinner?.fail("Failed to verify anchor");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get proof for anchor
  anchor
    .command("proof <anchor-id>")
    .description("Get Merkle proof for an anchor")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (anchorId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching proof...").start();
      const api = getApiClient();

      try {
        const response = await api.getAnchorProof(anchorId);

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to get proof", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSection("Merkle Proof");
        outputKeyValue([
          { key: "Anchor ID", value: response.data.anchorId },
          { key: "Data Hash", value: response.data.dataHash },
          { key: "Merkle Root", value: response.data.merkleRoot },
          { key: "Leaf Index", value: String(response.data.leafIndex) },
        ]);

        console.log();
        console.log(colors.bold("Proof Path:"));
        if (response.data.proof.length === 0) {
          console.log(colors.dim("  (Single element tree - no siblings)"));
        } else {
          response.data.proof.forEach((hash, index) => {
            console.log(`  ${index + 1}. ${hash}`);
          });
        }
      } catch (error) {
        spinner?.fail("Failed to get proof");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get anchor status
  anchor
    .command("status <anchor-id>")
    .description("Get the status of an anchor")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (anchorId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching anchor status...").start();
      const api = getApiClient();

      try {
        const response = await api.getAnchorStatus(anchorId);

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Anchor not found", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        const statusColor =
          response.data.status === "ANCHORED"
            ? colors.success
            : response.data.status === "PENDING"
            ? colors.warning
            : colors.error;

        outputSection("Anchor Status");
        outputKeyValue([
          { key: "Anchor ID", value: response.data.anchorId },
          { key: "Status", value: statusColor(response.data.status) },
          { key: "Data Hash", value: response.data.dataHash },
          {
            key: "Batch ID",
            value: response.data.batchId || colors.dim("Not yet batched"),
          },
          {
            key: "Merkle Root",
            value: response.data.merkleRoot || colors.dim("N/A"),
          },
          {
            key: "TX Hash",
            value: response.data.txHash || colors.dim("N/A"),
          },
          {
            key: "Block Number",
            value: response.data.blockNumber
              ? String(response.data.blockNumber)
              : colors.dim("N/A"),
          },
          {
            key: "Created",
            value: formatDate(response.data.createdAt),
          },
          {
            key: "Anchored",
            value: response.data.anchoredAt
              ? formatDate(response.data.anchoredAt)
              : colors.dim("N/A"),
          },
        ]);
      } catch (error) {
        spinner?.fail("Failed to fetch anchor status");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Tree subcommands
  const tree = anchor
    .command("tree")
    .description("Merkle tree operations");

  // Show tree structure
  tree
    .command("show")
    .description("Show current Merkle tree structure")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching tree structure...").start();
      const api = getApiClient();

      try {
        const response = await api.getTreeInfo();

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch tree info", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSection("Merkle Tree");
        outputKeyValue([
          { key: "Root", value: response.data.root || colors.dim("Empty tree") },
          { key: "Leaf Count", value: String(response.data.leafCount) },
          { key: "Height", value: String(response.data.height) },
          { key: "Last Updated", value: response.data.lastUpdated ? formatDate(response.data.lastUpdated) : colors.dim("N/A") },
        ]);
      } catch (error) {
        spinner?.fail("Failed to fetch tree structure");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get current root
  tree
    .command("root")
    .description("Get the current Merkle root")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching Merkle root...").start();
      const api = getApiClient();

      try {
        const response = await api.getTreeRoot();

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch Merkle root", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data.root) {
          console.log(response.data.root);
        } else {
          console.log(colors.dim("(empty tree)"));
        }
      } catch (error) {
        spinner?.fail("Failed to fetch Merkle root");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Show pending events
  tree
    .command("pending")
    .description("Show pending events waiting to be batched")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching pending events...").start();
      const api = getApiClient();

      try {
        const response = await api.getPendingAnchors();

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch pending events", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data.count === 0) {
          console.log(colors.dim("No pending events."));
          return;
        }

        outputSection(`Pending Events (${response.data.count})`);

        if (response.data.events && response.data.events.length > 0) {
          outputTable(
            ["ID", "Type", "Asset ID", "Received"],
            response.data.events.map((event: any) => [
              truncate(event.id, 12),
              event.eventType || event.type || "N/A",
              truncate(event.assetId || "N/A", 12),
              formatDate(event.receivedAt || event.timestamp),
            ])
          );
        }
      } catch (error) {
        spinner?.fail("Failed to fetch pending events");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Show batch history
  tree
    .command("history")
    .description("Show batch anchoring history")
    .option("--limit <limit>", "Number of batches to show", "20")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Fetching batch history...").start();
      const api = getApiClient();

      try {
        const limit = parseInt(options.limit, 10);
        const response = await api.getBatchHistory(limit);

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch batch history", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data.length === 0) {
          console.log(colors.dim("No batch history."));
          return;
        }

        outputSection("Batch History");
        outputTable(
          ["Batch ID", "Events", "Merkle Root", "TX Hash", "Anchored"],
          response.data.map((batch: any) => [
            truncate(batch.batchId, 12),
            String(batch.eventCount),
            truncate(batch.merkleRoot, 16),
            batch.txHash ? truncate(batch.txHash, 16) : colors.dim("-"),
            batch.anchoredAt ? formatDate(batch.anchoredAt) : colors.dim("N/A"),
          ])
        );

        console.log(colors.dim(`\nShowing ${response.data.length} batches`));
      } catch (error) {
        spinner?.fail("Failed to fetch batch history");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Export anchor data
  anchor
    .command("export <anchor-id>")
    .description("Export anchor data and proof")
    .option("--format <format>", "Output format (json, yaml)", "json")
    .option("--output <file>", "Output file path")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (anchorId: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Exporting anchor data...").start();
      const api = getApiClient();

      try {
        // Fetch anchor status and proof
        const [statusResponse, proofResponse] = await Promise.all([
          api.getAnchorStatus(anchorId),
          api.getAnchorProof(anchorId),
        ]);

        spinner?.stop();

        if (!statusResponse.success || !statusResponse.data) {
          outputError("Failed to fetch anchor", statusResponse.error);
          return;
        }

        const exportData = {
          anchor: statusResponse.data,
          proof: proofResponse.success ? proofResponse.data : null,
          exportedAt: new Date().toISOString(),
          format: options.format,
        };

        let outputContent: string;
        if (options.format === "yaml") {
          // Simple YAML-like output
          outputContent = formatAsYaml(exportData);
        } else {
          outputContent = JSON.stringify(exportData, null, 2);
        }

        if (options.output) {
          const outputPath = path.resolve(options.output);
          fs.writeFileSync(outputPath, outputContent);
          outputSuccess(`Exported to ${outputPath}`);
        } else if (options.json) {
          output(exportData);
        } else {
          console.log(outputContent);
        }
      } catch (error) {
        spinner?.fail("Failed to export anchor data");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Audit anchors by date range
  anchor
    .command("audit")
    .description("Audit anchors within a date range")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Running audit...").start();
      const api = getApiClient();

      try {
        const fromDate = options.from ? new Date(options.from) : undefined;
        const toDate = options.to ? new Date(options.to) : undefined;

        if (fromDate && isNaN(fromDate.getTime())) {
          spinner?.stop();
          outputError("Invalid from date", "Please use YYYY-MM-DD format");
          return;
        }

        if (toDate && isNaN(toDate.getTime())) {
          spinner?.stop();
          outputError("Invalid to date", "Please use YYYY-MM-DD format");
          return;
        }

        const response = await api.auditAnchors({
          from: fromDate?.toISOString(),
          to: toDate?.toISOString(),
        });

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to run audit", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSection("Anchor Audit Report");
        outputKeyValue([
          {
            key: "Period",
            value: `${options.from || "Beginning"} to ${options.to || "Now"}`,
          },
          { key: "Total Anchors", value: String(response.data.totalAnchors) },
          {
            key: "Anchored",
            value: colors.success(String(response.data.anchoredCount)),
          },
          {
            key: "Pending",
            value: colors.warning(String(response.data.pendingCount)),
          },
          {
            key: "Failed",
            value: response.data.failedCount > 0
              ? colors.error(String(response.data.failedCount))
              : "0",
          },
          { key: "Total Batches", value: String(response.data.batchCount) },
          {
            key: "Avg Events/Batch",
            value: response.data.avgEventsPerBatch?.toFixed(1) || "N/A",
          },
        ]);

        if (response.data.issues && response.data.issues.length > 0) {
          console.log();
          outputSection("Issues Found");
          response.data.issues.forEach((issue: string, index: number) => {
            console.log(`  ${index + 1}. ${issue}`);
          });
        } else {
          console.log();
          outputSuccess("No issues found");
        }
      } catch (error) {
        spinner?.fail("Failed to run audit");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}

// Helper to format data as YAML-like string
function formatAsYaml(data: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (data === null || data === undefined) {
    return "null";
  }

  if (typeof data === "string") {
    return data.includes("\n") ? `|\n${data.split("\n").map(l => spaces + "  " + l).join("\n")}` : data;
  }

  if (typeof data === "number" || typeof data === "boolean") {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return "[]";
    return data.map(item => `${spaces}- ${formatAsYaml(item, indent + 1).trim()}`).join("\n");
  }

  if (typeof data === "object") {
    const entries = Object.entries(data);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const formatted = formatAsYaml(value, indent + 1);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return `${spaces}${key}:\n${formatted}`;
        }
        return `${spaces}${key}: ${formatted}`;
      })
      .join("\n");
  }

  return String(data);
}
