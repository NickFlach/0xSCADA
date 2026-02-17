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
  outputInfo,
  setOutputOptions,
  colors,
} from "../output.js";

export function registerGatewayCommand(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Gateway connection management");

  gateway
    .command("list")
    .description("List all gateway connections")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--site <siteId>", "Filter by site ID")
    .option("--status <status>", "Filter by status (online|offline|error)")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching gateway connections...").start();
      const api = getApiClient();

      try {
        const response = await api.get("/api/gateways", {
          params: {
            ...(options.site && { siteId: options.site }),
            ...(options.status && { status: options.status }),
          },
        });
        spinner?.succeed("Gateway connections retrieved");

        const gateways = response.data?.gateways ?? response.data ?? [];

        if (options.json) {
          output(gateways);
          return;
        }

        if (!gateways.length) {
          outputWarning("No gateway connections found");
          return;
        }

        outputSection("Gateway Connections");
        for (const gw of gateways) {
          const statusColor = gw.status === "online" ? colors.green : gw.status === "error" ? colors.red : colors.yellow;
          outputKeyValue([
            ["ID", gw.id],
            ["Name", gw.name ?? "—"],
            ["Site", gw.siteId ?? "—"],
            ["Protocol", gw.protocol ?? "OPC-UA"],
            ["Status", statusColor(gw.status ?? "unknown")],
            ["Endpoint", gw.endpoint ?? "—"],
            ["Tags", String(gw.tagCount ?? 0)],
            ["Last Seen", gw.lastSeen ?? "—"],
          ]);
          console.log();
        }
      } catch (error: any) {
        spinner?.fail("Failed to fetch gateways");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  gateway
    .command("info <gatewayId>")
    .description("Show detailed gateway information")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (gatewayId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching gateway info...").start();
      const api = getApiClient();

      try {
        const response = await api.get(`/api/gateways/${gatewayId}`);
        spinner?.succeed("Gateway info retrieved");

        if (options.json) {
          output(response.data);
          return;
        }

        const gw = response.data;
        outputSection(`Gateway: ${gw.name ?? gatewayId}`);
        outputKeyValue([
          ["ID", gw.id],
          ["Protocol", gw.protocol ?? "OPC-UA"],
          ["Endpoint", gw.endpoint ?? "—"],
          ["Status", gw.status ?? "unknown"],
          ["Uptime", gw.uptime ?? "—"],
          ["Tag Count", String(gw.tagCount ?? 0)],
          ["Throughput", `${gw.throughput ?? 0} msg/s`],
          ["Last Error", gw.lastError ?? "None"],
        ]);
      } catch (error: any) {
        spinner?.fail("Failed to fetch gateway info");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  gateway
    .command("restart <gatewayId>")
    .description("Restart a gateway connection")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (gatewayId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora(`Restarting gateway ${gatewayId}...`).start();
      const api = getApiClient();

      try {
        await api.post(`/api/gateways/${gatewayId}/restart`);
        spinner?.succeed(`Gateway ${gatewayId} restarted`);
        if (options.json) {
          output({ success: true, gatewayId, action: "restart" });
        } else {
          outputSuccess(`Gateway ${gatewayId} restart initiated`);
        }
      } catch (error: any) {
        spinner?.fail("Failed to restart gateway");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });
}
