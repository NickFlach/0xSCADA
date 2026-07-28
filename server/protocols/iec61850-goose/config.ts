/**
 * Environment configuration for the GOOSE subscriber service.
 *
 * The subscriber is OFF unless subscriptions are configured — a substation
 * control block map cannot be guessed, so there is deliberately no default.
 * Capture is OFF unless a source is selected: with none of these variables set
 * the service behaves exactly as it did before live capture existed.
 *
 *   GOOSE_SUBSCRIPTIONS_FILE  path to a JSON array of subscription configs
 *                             (the shape validated by
 *                             `gooseSubscriptionConfigSchema`). Required to
 *                             enable the service.
 *   GOOSE_CAPTURE             none | pcap | live. Selects the capture backend.
 *                             Defaults to "pcap" when GOOSE_PCAP_FILE is set
 *                             (the pre-existing behaviour) and "none"
 *                             otherwise. "live" opts in to real Layer-2
 *                             capture and is never chosen implicitly.
 *   GOOSE_PCAP_FILE           path to a classic `.pcap` capture to replay.
 *   GOOSE_PCAP_REALTIME       "false"/"0" to drain the capture with no delay
 *                             instead of honouring recorded timing.
 *   GOOSE_IFACE               interface to capture on. Default "eth0". Used by
 *                             the live backend, and named in the "capture
 *                             unavailable" explanation otherwise.
 *   GOOSE_CAPTURE_TOOL        auto | dumpcap | tcpdump. Which libpcap CLI tool
 *                             the live backend spawns. Default "auto"
 *                             (dumpcap, then tcpdump).
 *   GOOSE_CAPTURE_TOOL_PATH   absolute path to that tool, bypassing the PATH
 *                             search. Requires an explicit GOOSE_CAPTURE_TOOL
 *                             because the argument style differs per tool.
 *   GOOSE_CAPTURE_SNAPLEN     capture snapshot length in bytes. Default 65535.
 *   GOOSE_CAPTURE_FILTER      override the BPF filter (advanced). The
 *                             EtherType 0x88B8 check is still applied to every
 *                             delivered frame regardless of this value.
 *
 * Issue: #465
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { gooseSubscriptionConfigSchema } from "./subscription.js";

/** Which capture backend the service should construct. */
export const gooseCaptureModeSchema = z.enum(["none", "pcap", "live"]);
export type GooseCaptureMode = z.infer<typeof gooseCaptureModeSchema>;

/** Which libpcap CLI tool the live backend should drive. */
export const gooseCaptureToolSchema = z.enum(["auto", "dumpcap", "tcpdump"]);
export type GooseCaptureToolConfig = z.infer<typeof gooseCaptureToolSchema>;

export const gooseServiceConfigSchema = z
  .object({
    /** Capture backend selection. "none" delivers no frames (the default). */
    capture: gooseCaptureModeSchema.default("none"),
    /** Interface the live backend binds, and the one the null backend names. */
    iface: z.string().min(1).default("eth0"),
    /** Capture file to replay, when the pcap backend should be used. */
    pcapPath: z.string().min(1).optional(),
    /** Honour recorded inter-frame timing during replay. */
    pcapRealtime: z.boolean().default(true),
    /** Capture tool selection for the live backend. */
    captureTool: gooseCaptureToolSchema.default("auto"),
    /** Explicit capture-tool path, bypassing the PATH search. */
    captureToolPath: z.string().min(1).optional(),
    /**
     * Snapshot length. The floor of 68 is libpcap's own minimum useful snaplen;
     * the ceiling is dumpcap's maximum. A GOOSE frame fits in ~1500 bytes, so
     * the default of 65535 never truncates one.
     */
    captureSnapLen: z.number().int().min(68).max(262_144).default(65535),
    /** BPF filter override for the live backend. */
    captureFilter: z.string().min(1).optional(),
    /** Control blocks to subscribe to. Empty means the service stays off. */
    subscriptions: z.array(gooseSubscriptionConfigSchema).default([]),
  })
  .superRefine((config, ctx) => {
    if (config.capture === "pcap" && !config.pcapPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pcapPath"],
        message: "GOOSE_CAPTURE=pcap requires GOOSE_PCAP_FILE to point at a capture file",
      });
    }
    if (config.captureToolPath && config.captureTool === "auto") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captureTool"],
        message:
          "GOOSE_CAPTURE_TOOL_PATH requires GOOSE_CAPTURE_TOOL=dumpcap or tcpdump — " +
          "the two tools take different arguments, so the path alone is ambiguous",
      });
    }
  });

export type GooseServiceConfig = z.output<typeof gooseServiceConfigSchema>;

/** Parse a boolean-ish env var; undefined/empty falls back to `fallback`. */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Parse an integer env var. Rejected here rather than in Zod so the error names
 * the variable and the offending text instead of reporting "expected number,
 * received nan".
 */
function envInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/**
 * Read the subscription list from a JSON file. Throws with the offending path
 * in the message so a misconfiguration is diagnosable from one log line.
 */
export function loadGooseSubscriptionsFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): unknown[] {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    throw new Error(
      `GOOSE_SUBSCRIPTIONS_FILE could not be read (${path}): ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `GOOSE_SUBSCRIPTIONS_FILE is not valid JSON (${path}): ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `GOOSE_SUBSCRIPTIONS_FILE must contain a JSON array of subscriptions (${path})`,
    );
  }
  return parsed;
}

/**
 * Build the service config from the environment. Throws on malformed input —
 * the caller logs it and leaves the subscriber off rather than starting with a
 * half-applied configuration.
 */
export function loadGooseServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): GooseServiceConfig {
  const subscriptionsFile = env.GOOSE_SUBSCRIPTIONS_FILE?.trim();
  const subscriptions = subscriptionsFile
    ? loadGooseSubscriptionsFile(subscriptionsFile, read)
    : [];

  const pcapPath = env.GOOSE_PCAP_FILE?.trim() || undefined;
  // Back-compatible default: GOOSE_PCAP_FILE alone still selects replay, and an
  // environment with none of these variables still selects no capture at all.
  // Live capture is only ever reached by asking for it explicitly.
  const capture = env.GOOSE_CAPTURE?.trim().toLowerCase() || (pcapPath ? "pcap" : "none");

  return gooseServiceConfigSchema.parse({
    capture,
    iface: env.GOOSE_IFACE?.trim() || undefined,
    pcapPath,
    pcapRealtime: envFlag(env.GOOSE_PCAP_REALTIME, true),
    captureTool: env.GOOSE_CAPTURE_TOOL?.trim().toLowerCase() || undefined,
    captureToolPath: env.GOOSE_CAPTURE_TOOL_PATH?.trim() || undefined,
    captureSnapLen: envInt("GOOSE_CAPTURE_SNAPLEN", env.GOOSE_CAPTURE_SNAPLEN),
    captureFilter: env.GOOSE_CAPTURE_FILTER?.trim() || undefined,
    subscriptions,
  });
}
