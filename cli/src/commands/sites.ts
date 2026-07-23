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
  setOutputOptions,
  formatDate,
  colors,
} from "../output.js";
import { addOutputOptions } from "../lib/commandHelpers.js";

export function registerSitesCommand(program: Command): void {
  const sites = program
    .command("sites")
    .description("Manage registered sites");

  // List sites
  const listCmd = sites
    .command("list")
    .description("List all registered sites");
  addOutputOptions(listCmd)
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const useStructured = Boolean(options.json);
      const spinner = useStructured ? null : ora("Fetching sites...").start();
      const api = getApiClient();

      try {
        const response = await api.getSites();
        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to fetch sites", response.error);
          return;
        }

        if (useStructured) {
          output(response.data);
          return;
        }

        if (response.data.length === 0) {
          console.log(colors.dim("No sites registered yet."));
          return;
        }

        outputTable(
          ["ID", "Name", "Location", "Owner", "Created"],
          response.data.map((site) => [
            site.id,
            site.name,
            site.location,
            site.owner,
            formatDate(site.createdAt),
          ])
        );

        console.log(colors.dim(`\nTotal: ${response.data.length} sites`));
      } catch (error) {
        spinner?.fail("Failed to fetch sites");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get site by ID
  const getCmd = sites
    .command("get <id>")
    .description("Get details of a specific site")
    .option("--with-assets", "Include assets for this site");
  addOutputOptions(getCmd)
    .action(async (id: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const useStructured = Boolean(options.json);
      const spinner = useStructured ? null : ora("Fetching site details...").start();
      const api = getApiClient();

      try {
        const [siteResponse, assetsResponse] = await Promise.all([
          api.getSiteById(id),
          options.withAssets ? api.getAssetsBySite(id) : Promise.resolve(null),
        ]);

        spinner?.stop();

        if (!siteResponse.success || !siteResponse.data) {
          outputError("Site not found", siteResponse.error);
          return;
        }

        const site = siteResponse.data;

        if (useStructured) {
          output({
            ...site,
            assets: assetsResponse?.data || undefined,
          });
          return;
        }

        outputSection("Site Details");
        outputKeyValue([
          { key: "ID", value: site.id },
          { key: "Name", value: site.name },
          { key: "Location", value: site.location },
          { key: "Owner", value: site.owner },
          { key: "Created", value: formatDate(site.createdAt) },
        ]);

        if (options.withAssets && assetsResponse?.success && assetsResponse.data) {
          outputSection("Assets");
          if (assetsResponse.data.length === 0) {
            console.log(colors.dim("  No assets registered for this site."));
          } else {
            outputTable(
              ["ID", "Name/Tag", "Type", "Critical"],
              assetsResponse.data.map((asset) => [
                asset.id,
                asset.nameOrTag,
                asset.assetType,
                asset.critical ? "Yes" : "No",
              ])
            );
          }
        }

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch site");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Create site
  const createCmd = sites
    .command("create")
    .description("Create a new site")
    .requiredOption("--name <name>", "Site name")
    .requiredOption("--location <location>", "Site location")
    .requiredOption("--owner <owner>", "Site owner address");
  addOutputOptions(createCmd)
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const useStructured = Boolean(options.json);
      const spinner = useStructured ? null : ora("Creating site...").start();
      const api = getApiClient();

      try {
        const response = await api.createSite({
          name: options.name,
          location: options.location,
          owner: options.owner,
        });

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to create site", response.error);
          return;
        }

        if (useStructured) {
          output(response.data);
          return;
        }

        outputSuccess(`Site created: ${response.data.id}`);
        outputKeyValue([
          { key: "ID", value: response.data.id },
          { key: "Name", value: response.data.name },
          { key: "Location", value: response.data.location },
          { key: "Owner", value: response.data.owner },
        ]);
      } catch (error) {
        spinner?.fail("Failed to create site");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
