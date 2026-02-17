/**
 * Shared helper functions for CLI commands
 */

import { Command } from "commander";
import { setOutputOptions, isStructuredOutput, OutputOptions } from "../output.js";

/**
 * Get merged output options from command and parent command
 */
export function getOutputOptions(
  options: Record<string, unknown>,
  parentOptions: Record<string, unknown>
): OutputOptions {
  return {
    json: options.json as boolean | undefined,
    color: options.color as boolean | undefined,
    output: (options.output || parentOptions.output) as string | undefined,
  };
}

/**
 * Initialize output settings from command options
 * Returns true if using structured output (should skip spinner/human-friendly formatting)
 */
export function initOutputFromCommand(
  options: Record<string, unknown>,
  command: Command
): boolean {
  const parentOpts = command.parent?.parent?.opts() || {};
  const outputOpts = getOutputOptions(options, parentOpts);
  setOutputOptions(outputOpts);
  return isStructuredOutput();
}

/**
 * Add common output options to a command
 */
export function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON")
    .option("-o, --output <format>", "Output format")
    .option("--no-color", "Disable colorized output");
}
