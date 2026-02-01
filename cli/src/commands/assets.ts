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
  formatDate,
  formatBoolean,
  setOutputOptions,
  colors,
} from "../output.js";

export function registerAssetsCommand(program: Command): void {
  const assets = program
    .command("assets")
    .description("Manage registered assets");

  // List assets
  assets
    .command("list")
    .description("List all registered assets")
    .option("--site <siteId>", "Filter by site ID")
    .option("--type <type>", "Filter by asset type")
    .option("--critical", "Show only critical assets")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Fetching assets...").start();
      const api = getApiClient();

      try {
        const response = options.site
          ? await api.getAssetsBySite(options.site)
          : await api.getAssets();

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch assets", response.error);
          return;
        }

        let assets = response.data;

        // Apply filters
        if (options.type) {
          assets = assets.filter((a) =>
            a.assetType.toLowerCase().includes(options.type.toLowerCase())
          );
        }
        if (options.critical) {
          assets = assets.filter((a) => a.critical);
        }

        if (options.json) {
          output(assets);
          return;
        }

        if (assets.length === 0) {
          console.log(colors.dim("No assets found matching criteria."));
          return;
        }

        outputTable(
          ["ID", "Name/Tag", "Type", "Site ID", "Critical", "Created"],
          assets.map((asset) => [
            asset.id,
            asset.nameOrTag,
            asset.assetType,
            asset.siteId,
            formatBoolean(asset.critical),
            formatDate(asset.createdAt),
          ])
        );

        console.log(colors.dim(`\nTotal: ${assets.length} assets`));
      } catch (error) {
        spinner?.fail("Failed to fetch assets");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get asset by ID
  assets
    .command("get <id>")
    .description("Get details of a specific asset")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (id: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Fetching asset details...").start();
      const api = getApiClient();

      try {
        const response = await api.getAssetById(id);
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Asset not found", response.error);
          return;
        }

        const asset = response.data;

        if (options.json) {
          output(asset);
          return;
        }

        outputSection("Asset Details");
        outputKeyValue([
          { key: "ID", value: asset.id },
          { key: "Name/Tag", value: asset.nameOrTag },
          { key: "Type", value: asset.assetType },
          { key: "Site ID", value: asset.siteId },
          { key: "Critical", value: formatBoolean(asset.critical) },
          { key: "Created", value: formatDate(asset.createdAt) },
        ]);

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch asset");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Create asset
  assets
    .command("create")
    .description("Create a new asset")
    .requiredOption("--site <siteId>", "Site ID this asset belongs to")
    .requiredOption("--name <name>", "Asset name or tag")
    .requiredOption("--type <type>", "Asset type (e.g., PLC, HMI, Sensor)")
    .option("--critical", "Mark as critical asset", false)
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      
      const spinner = options.json ? null : ora("Creating asset...").start();
      const api = getApiClient();

      try {
        const response = await api.createAsset({
          siteId: options.site,
          nameOrTag: options.name,
          assetType: options.type,
          critical: options.critical,
        });

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to create asset", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Asset created: ${response.data.id}`);
        outputKeyValue([
          { key: "ID", value: response.data.id },
          { key: "Name/Tag", value: response.data.nameOrTag },
          { key: "Type", value: response.data.assetType },
          { key: "Site ID", value: response.data.siteId },
          { key: "Critical", value: formatBoolean(response.data.critical) },
        ]);
      } catch (error) {
        spinner?.fail("Failed to create asset");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
