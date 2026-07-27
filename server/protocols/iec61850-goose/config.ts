/**
 * Environment configuration for the GOOSE subscriber service.
 *
 * The subscriber is OFF unless subscriptions are configured — a substation
 * control block map cannot be guessed, so there is deliberately no default.
 *
 *   GOOSE_SUBSCRIPTIONS_FILE  path to a JSON array of subscription configs
 *                             (the shape validated by
 *                             `gooseSubscriptionConfigSchema`). Required to
 *                             enable the service.
 *   GOOSE_PCAP_FILE           path to a classic `.pcap` capture to replay.
 *                             When set, the pcap replay backend is used and
 *                             the subscriber genuinely receives frames.
 *   GOOSE_PCAP_REALTIME       "false"/"0" to drain the capture with no delay
 *                             instead of honouring recorded timing.
 *   GOOSE_IFACE               interface a live backend would bind. Used only in
 *                             the "capture unavailable" explanation, because no
 *                             live backend ships with this repository.
 *
 * Issue: #465
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { gooseSubscriptionConfigSchema } from "./subscription.js";

export const gooseServiceConfigSchema = z.object({
  /** Interface name reported by the null backend. */
  iface: z.string().min(1).default("eth0"),
  /** Capture file to replay, when the pcap backend should be used. */
  pcapPath: z.string().min(1).optional(),
  /** Honour recorded inter-frame timing during replay. */
  pcapRealtime: z.boolean().default(true),
  /** Control blocks to subscribe to. Empty means the service stays off. */
  subscriptions: z.array(gooseSubscriptionConfigSchema).default([]),
});

export type GooseServiceConfig = z.output<typeof gooseServiceConfigSchema>;

/** Parse a boolean-ish env var; undefined/empty falls back to `fallback`. */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
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

  return gooseServiceConfigSchema.parse({
    iface: env.GOOSE_IFACE?.trim() || undefined,
    pcapPath: env.GOOSE_PCAP_FILE?.trim() || undefined,
    pcapRealtime: envFlag(env.GOOSE_PCAP_REALTIME, true),
    subscriptions,
  });
}
