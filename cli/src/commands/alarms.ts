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

export function registerAlarmsCommand(program: Command): void {
  const alarms = program
    .command("alarms")
    .description("Alarm management and monitoring");

  alarms
    .command("list")
    .description("List active alarms")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--severity <level>", "Filter by severity (critical|high|medium|low|info)")
    .option("--site <siteId>", "Filter by site ID")
    .option("--state <state>", "Filter by state (active|acknowledged|cleared)")
    .option("--limit <n>", "Limit results", "50")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching alarms...").start();
      const api = getApiClient();

      try {
        const response = await api.get("/api/alarms", {
          params: {
            ...(options.severity && { severity: options.severity }),
            ...(options.site && { siteId: options.site }),
            ...(options.state && { state: options.state }),
            limit: parseInt(options.limit),
          },
        });
        spinner?.succeed("Alarms retrieved");

        const alarmList = response.data?.alarms ?? response.data ?? [];

        if (options.json) {
          output(alarmList);
          return;
        }

        if (!alarmList.length) {
          outputSuccess("No active alarms");
          return;
        }

        outputSection(`Active Alarms (${alarmList.length})`);
        for (const alarm of alarmList) {
          const sevColor =
            alarm.severity === "critical" ? colors.red :
            alarm.severity === "high" ? colors.red :
            alarm.severity === "medium" ? colors.yellow :
            colors.cyan;

          console.log(
            `  ${sevColor(`[${(alarm.severity ?? "?").toUpperCase()}]`)} ${alarm.message ?? alarm.description ?? "—"}`
          );
          console.log(
            `    ID: ${alarm.id}  Tag: ${alarm.tagId ?? "—"}  State: ${alarm.state ?? "active"}  Time: ${alarm.triggeredAt ?? alarm.timestamp ?? "—"}`
          );
          console.log();
        }
      } catch (error: any) {
        spinner?.fail("Failed to fetch alarms");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  alarms
    .command("ack <alarmId>")
    .description("Acknowledge an alarm")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .option("--comment <text>", "Acknowledgement comment")
    .action(async (alarmId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora(`Acknowledging alarm ${alarmId}...`).start();
      const api = getApiClient();

      try {
        await api.post(`/api/alarms/${alarmId}/acknowledge`, {
          ...(options.comment && { comment: options.comment }),
        });
        spinner?.succeed(`Alarm ${alarmId} acknowledged`);
        if (options.json) {
          output({ success: true, alarmId, action: "acknowledge" });
        } else {
          outputSuccess(`Alarm ${alarmId} acknowledged`);
        }
      } catch (error: any) {
        spinner?.fail("Failed to acknowledge alarm");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  alarms
    .command("clear <alarmId>")
    .description("Clear an alarm")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (alarmId, options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora(`Clearing alarm ${alarmId}...`).start();
      const api = getApiClient();

      try {
        await api.post(`/api/alarms/${alarmId}/clear`);
        spinner?.succeed(`Alarm ${alarmId} cleared`);
        if (options.json) {
          output({ success: true, alarmId, action: "clear" });
        } else {
          outputSuccess(`Alarm ${alarmId} cleared`);
        }
      } catch (error: any) {
        spinner?.fail("Failed to clear alarm");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });

  alarms
    .command("summary")
    .description("Show alarm summary by severity")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });
      const spinner = options.json ? null : ora("Fetching alarm summary...").start();
      const api = getApiClient();

      try {
        const response = await api.get("/api/alarms/summary");
        spinner?.succeed("Alarm summary retrieved");

        const summary = response.data;

        if (options.json) {
          output(summary);
          return;
        }

        outputSection("Alarm Summary");
        outputKeyValue([
          ["Critical", colors.red(String(summary.critical ?? 0))],
          ["High", colors.red(String(summary.high ?? 0))],
          ["Medium", colors.yellow(String(summary.medium ?? 0))],
          ["Low", colors.cyan(String(summary.low ?? 0))],
          ["Info", String(summary.info ?? 0)],
          ["Total Active", colors.bold(String(summary.total ?? 0))],
          ["Unacknowledged", colors.yellow(String(summary.unacknowledged ?? 0))],
        ]);
      } catch (error: any) {
        spinner?.fail("Failed to fetch alarm summary");
        outputError(error.response?.data?.message ?? error.message);
        process.exitCode = 1;
      }
    });
}
