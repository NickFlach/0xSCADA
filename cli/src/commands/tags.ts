import { Command } from "commander";
import ora from "ora";
import { getApiClient } from "../api.js";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputWarning,
  setOutputOptions,
  colors,
} from "../output.js";

export function registerTagsCommand(program: Command): void {
  const tags = program
    .command("tags")
    .description("Read and manage SCADA tags (process variables)");

  tags
    .command("read <tagId>")
    .description("Read the current value of a tag")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--raw", "Output raw value only")
    .action(async (tagId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json || options.raw ? null : ora(`Reading tag ${tagId}...`).start();
      const api = getApiClient();

      try {
        const response = await api.get(`/api/tags/${tagId}`);
        spinner?.succeed(`Tag ${tagId} read`);

        const tag = response.data;

        if (options.raw) {
          console.log(tag.value ?? tag.currentValue ?? "");
          return;
        }

        if (options.json) {
          output(tag);
          return;
        }

        outputSection(`Tag: ${tag.name ?? tagId}`);
        outputKeyValue([
          ["ID", tag.id ?? tagId],
          ["Name", tag.name ?? "—"],
          ["Value", String(tag.value ?? tag.currentValue ?? "null")],
          ["Unit", tag.unit ?? tag.engineeringUnit ?? "—"],
          ["Quality", tag.quality ?? "Good"],
          ["Timestamp", tag.timestamp ?? tag.updatedAt ?? "—"],
          ["Data Type", tag.dataType ?? tag.type ?? "—"],
          ["Gateway", tag.gatewayId ?? "—"],
          ["Description", tag.description ?? "—"],
        ]);
      } catch (error: any) {
        spinner?.fail(`Failed to read tag ${tagId}`);
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  tags
    .command("list")
    .description("List all tags")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--gateway <gatewayId>", "Filter by gateway ID")
    .option("--site <siteId>", "Filter by site ID")
    .option("--search <query>", "Search tag names")
    .option("--limit <n>", "Limit results", "50")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching tags...").start();
      const api = getApiClient();

      try {
        const response = await api.get("/api/tags", {
          params: {
            ...(options.gateway && { gatewayId: options.gateway }),
            ...(options.site && { siteId: options.site }),
            ...(options.search && { search: options.search }),
            limit: parseInt(options.limit),
          },
        });
        spinner?.succeed("Tags retrieved");

        const tagList = response.data?.tags ?? response.data ?? [];

        if (options.json) {
          output(tagList);
          return;
        }

        if (!tagList.length) {
          outputWarning("No tags found");
          return;
        }

        outputSection(`Tags (${tagList.length})`);
        for (const tag of tagList) {
          const qualityColor = tag.quality === "Good" ? colors.green : colors.yellow;
          console.log(
            `  ${colors.cyan(tag.id ?? tag.tagId)} ${tag.name ?? "—"} = ${colors.bold(String(tag.value ?? "—"))} ${tag.unit ?? ""} [${qualityColor(tag.quality ?? "?")}]`
          );
        }
      } catch (error: any) {
        spinner?.fail("Failed to fetch tags");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  tags
    .command("write <tagId> <value>")
    .description("Write a value to a tag")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--force", "Skip confirmation")
    .action(async (tagId, value, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora(`Writing to tag ${tagId}...`).start();
      const api = getApiClient();

      try {
        await api.post(`/api/tags/${tagId}/write`, { value });
        spinner?.succeed(`Tag ${tagId} written`);

        if (options.json) {
          output({ success: true, tagId, value });
        } else {
          outputSuccess(`Tag ${tagId} set to ${value}`);
        }
      } catch (error: any) {
        spinner?.fail(`Failed to write tag ${tagId}`);
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  tags
    .command("history <tagId>")
    .description("Show tag value history")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--from <date>", "Start date (ISO 8601)")
    .option("--to <date>", "End date (ISO 8601)")
    .option("--limit <n>", "Max data points", "100")
    .action(async (tagId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora(`Fetching history for ${tagId}...`).start();
      const api = getApiClient();

      try {
        const response = await api.get(`/api/tags/${tagId}/history`, {
          params: {
            ...(options.from && { from: options.from }),
            ...(options.to && { to: options.to }),
            limit: parseInt(options.limit),
          },
        });
        spinner?.succeed("History retrieved");

        const points = response.data?.history ?? response.data ?? [];

        if (options.json) {
          output(points);
          return;
        }

        outputSection(`Tag History: ${tagId} (${points.length} points)`);
        for (const pt of points) {
          console.log(`  ${pt.timestamp ?? "—"}  ${colors.bold(String(pt.value ?? "—"))} ${pt.quality ?? ""}`);
        }
      } catch (error: any) {
        spinner?.fail("Failed to fetch tag history");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });
}
