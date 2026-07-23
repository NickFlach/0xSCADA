import { Command } from "commander";
import ora from "ora";
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

export function registerEventsCommand(program: Command): void {
  const events = program
    .command("events")
    .description("Manage and view event anchors");

  // List events
  events
    .command("list")
    .description("List recent events")
    .option("--page <page>", "Page number", "1")
    .option("--limit <limit>", "Items per page", "20")
    .option("--type <type>", "Filter by event type")
    .option("--asset <assetId>", "Filter by asset ID")
    .option("--anchored", "Show only anchored events")
    .option("--pending", "Show only pending (not anchored) events")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Fetching events...").start();
      const api = getApiClient();

      try {
        const page = parseInt(options.page, 10);
        const limit = parseInt(options.limit, 10);

        const response = await api.getEvents(page, limit);
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch events", response.error);
          return;
        }

        let events = response.data.data;

        // Apply filters
        if (options.type) {
          events = events.filter((e) =>
            e.eventType.toLowerCase().includes(options.type.toLowerCase())
          );
        }
        if (options.asset) {
          events = events.filter((e) => e.assetId === options.asset);
        }
        if (options.anchored) {
          events = events.filter((e) => e.txHash !== null);
        }
        if (options.pending) {
          events = events.filter((e) => e.txHash === null);
        }

        if (options.json) {
          output({
            data: events,
            pagination: {
              page: response.data.page,
              limit: response.data.limit,
              total: response.data.total,
              totalPages: response.data.totalPages,
              hasNextPage: response.data.hasNextPage,
              hasPrevPage: response.data.hasPrevPage,
            },
          });
          return;
        }

        if (events.length === 0) {
          console.log(colors.dim("No events found matching criteria."));
          return;
        }

        outputTable(
          ["ID", "Type", "Asset ID", "Timestamp", "Anchored", "TX Hash"],
          events.map((event) => [
            truncate(event.id, 12),
            event.eventType,
            truncate(event.assetId, 12),
            formatDate(event.timestamp),
            event.txHash ? colors.success("Yes") : colors.warning("No"),
            event.txHash ? truncate(event.txHash, 16) : colors.dim("-"),
          ])
        );

        console.log();
        console.log(
          colors.dim(
            `Page ${response.data.page} of ${response.data.totalPages} ` +
              `(${response.data.total} total events)`
          )
        );

        if (response.data.hasNextPage) {
          console.log(
            colors.dim(`Use --page ${response.data.page + 1} to see more`)
          );
        }
      } catch (error) {
        spinner?.fail("Failed to fetch events");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Anchor command - trigger batch anchoring
  events
    .command("anchor")
    .description("Manually trigger batch anchoring of pending events")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Triggering batch anchoring...").start();
      const api = getApiClient();

      try {
        // First get batch stats
        const statsResponse = await api.getBatchStats();
        
        if (statsResponse.success && statsResponse.data) {
          const pending = statsResponse.data.pendingEvents;
          if (pending === 0) {
            spinner?.stop();
            if (options.json) {
              output({ success: true, message: "No pending events to anchor", pendingEvents: 0 });
            } else {
              outputWarning("No pending events to anchor");
            }
            return;
          }
          if (spinner) spinner.text = `Anchoring ${pending} pending events...`;
        }

        const response = await api.triggerBatchAnchor();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to trigger batch anchoring", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        if (response.data.success) {
          outputSuccess(response.data.message || "Batch anchoring completed");
          if (response.data.batchId || response.data.txHash) {
            outputKeyValue([
              ...(response.data.batchId
                ? [{ key: "Batch ID", value: response.data.batchId }]
                : []),
              ...(response.data.txHash
                ? [{ key: "TX Hash", value: response.data.txHash }]
                : []),
              ...(response.data.eventCount !== undefined
                ? [{ key: "Events Anchored", value: String(response.data.eventCount) }]
                : []),
            ]);
          }
        } else {
          outputWarning(response.data.message || "Batch anchoring returned with warnings");
        }
      } catch (error) {
        spinner?.fail("Failed to trigger batch anchoring");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Stats command
  events
    .command("stats")
    .description("Show batch anchoring statistics")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Fetching batch stats...").start();
      const api = getApiClient();

      try {
        const response = await api.getBatchStats();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch batch stats", response.error);
          return;
        }

        const stats = response.data;

        if (options.json) {
          output(stats);
          return;
        }

        outputSection("Batch Anchoring Statistics");
        outputKeyValue([
          {
            key: "Pending Events",
            value: stats.pendingEvents > 0
              ? colors.warning(String(stats.pendingEvents))
              : colors.success("0"),
          },
          { key: "Total Batches", value: String(stats.totalBatchesAnchored) },
          { key: "Total Events Anchored", value: String(stats.totalEventsAnchored) },
          {
            key: "Avg Events/Batch",
            value: stats.averageEventsPerBatch.toFixed(1),
          },
          {
            key: "Est. Gas Savings",
            value: `${stats.estimatedGasSavings.toFixed(2)}%`,
          },
          {
            key: "Last Batch",
            value: stats.lastBatchTime
              ? formatDate(stats.lastBatchTime)
              : colors.dim("Never"),
          },
        ]);

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch batch stats");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Create event
  events
    .command("create")
    .description("Create a new event")
    .requiredOption("--asset <assetId>", "Asset ID")
    .requiredOption("--type <type>", "Event type")
    .requiredOption("--payload <json>", "Event payload as JSON string")
    .option("--details <details>", "Additional details")
    .option("--recorded-by <address>", "Recorded by address")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      let payload: unknown;
      try {
        payload = JSON.parse(options.payload);
      } catch {
        outputError("Invalid JSON payload", "Please provide valid JSON for --payload");
        return;
      }

      const spinner = options.json ? null : ora("Creating event...").start();
      const api = getApiClient();

      try {
        const response = await api.createEvent({
          assetId: options.asset,
          eventType: options.type,
          payload,
          details: options.details,
          recordedBy: options.recordedBy,
        });

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to create event", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Event created: ${response.data.id}`);
        outputKeyValue([
          { key: "ID", value: response.data.id },
          { key: "Type", value: response.data.eventType },
          { key: "Asset ID", value: response.data.assetId },
          { key: "Payload Hash", value: response.data.payloadHash },
          {
            key: "TX Hash",
            value: response.data.txHash || colors.dim("Pending batch anchoring"),
          },
        ]);
      } catch (error) {
        spinner?.fail("Failed to create event");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
