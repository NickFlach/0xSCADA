/**
 * DNP3 Outstation Mode — deployment configuration.
 *
 * Issue #464. Mirrors `modbus-server/config.ts` (#462) because the exposure
 * problem is the same one: a protocol that does not authenticate its TCP peer is
 * about to be given a listening socket inside a control network.
 *
 * The listener is OFF by default and every unsafe choice has to be made
 * explicitly. The gates, from least to most dangerous:
 *
 *   1. `DNP3_OUTSTATION_ENABLED=true`        — start a listener at all.
 *   2. `DNP3_OUTSTATION_BIND_HOST`           — defaults to 127.0.0.1. Leaving
 *                                              loopback is a deliberate act and
 *                                              forces gate 3.
 *   3. `DNP3_OUTSTATION_ALLOWED_PEERS`       — mandatory (and wildcard-free)
 *                                              once the bind host is routable.
 *   4. `DNP3_OUTSTATION_ALLOW_CONTROLS=true` — separate opt-in before
 *                                              SELECT/OPERATE/DIRECT-OPERATE are
 *                                              executed at all; even then only
 *                                              point-map entries marked
 *                                              `writable` can move a tag.
 *   5. Enabling controls additionally requires the current Secure
 *      Authentication v5 Control Direction Session Key
 *      (`DNP3_OUTSTATION_SAV5_CONTROL_KEY`) unless the deployment
 *      *also* sets `DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS=true` and so
 *      states, on the record, that it is running a plant-output write path with
 *      no cryptographic authentication in front of it.
 *
 * WHAT SAv5 DOES AND DOES NOT COVER. With a Control Direction Session Key provisioned, the
 * critical function codes (SELECT, OPERATE, DIRECT_OPERATE, WRITE, restarts,
 * (en|dis)able-unsolicited) are challenged and their MAC verified before the
 * ASDU executes — see `secure-auth.ts`. Nothing else is authenticated: READs are
 * not, the TCP peer is not, and there is no confidentiality anywhere. A peer
 * that clears the allowlist can read every mapped point. Plain DNP3 without an
 * Control Direction Session Key has no authentication whatsoever.
 *
 * Validation is Zod-based and fails closed: a malformed value raises
 * `Dnp3OutstationConfigError` and no listener is created.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  isLoopbackHost,
  LOOPBACK_PEER_RULES,
  parsePeerRules,
  PeerRuleError,
} from "../peer-allowlist";
import { Dnp3PointMapConfigSchema, type Dnp3PointMapConfig } from "./point-map";
import {
  DEFAULT_MAX_TX_QUEUE_BYTES,
  DNP3_MAX_LINK_FRAME_BYTES,
} from "./server";

/** Raised when the deployment configuration cannot produce a safe listener. */
export class Dnp3OutstationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Dnp3OutstationConfigError";
  }
}

/** Environment flag that must be exactly "true" to arm the listener. */
export const DNP3_OUTSTATION_ENABLED_ENV = "DNP3_OUTSTATION_ENABLED";

/**
 * Treat a blank variable as unset. `.env` templates ship keys with empty values,
 * and "present but empty" must mean "not configured" rather than "configured to
 * nothing" — the latter would turn a template into a startup failure.
 */
const present = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** Parse a comma-separated list; a blank/absent value reads as unset. */
const csv = (raw: string | undefined): string[] | undefined => {
  const value = present(raw);
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
};

const boolFlag = (raw: string | undefined): boolean => raw?.trim() === "true";

/**
 * Minimum Control Direction Session Key length. Sixteen octets is the floor;
 * shorter input is refused rather than silently accepted as authentication.
 */
const MIN_CONTROL_KEY_BYTES = 16;

export const dnp3OutstationDeploymentConfigSchema = z
  .object({
    /** Bind address. Defaults to loopback — never 0.0.0.0. */
    host: z.string().trim().min(1).default("127.0.0.1"),
    /** Bind port. 20000 is the registered DNP3 port. */
    port: z.coerce.number().int().min(1).max(65535).default(20000),
    /** Site whose tags this outstation serves. */
    siteId: z.string().trim().min(1),
    /** This outstation's DNP3 link address. */
    localAddress: z.coerce.number().int().min(0).max(0xffff).default(10),
    /**
     * Peer IPs/CIDRs permitted to connect. Enforced at accept time. Wildcard
     * prefixes (`/0`) are rejected by `parsePeerRules`.
     */
    allowedPeers: z.array(z.string().trim().min(1)).min(1),
    /** Hard cap on simultaneous master associations. */
    maxConnections: z.coerce.number().int().min(1).max(64).default(1),
    /** Idle socket timeout in ms (0 disables). */
    socketTimeoutMs: z.coerce.number().int().min(0).default(60_000),
    /** Per-connection receive-buffer bound; must fit one maximum link frame. */
    maxRxBufferBytes: z.coerce
      .number()
      .int()
      .min(DNP3_MAX_LINK_FRAME_BYTES)
      .max(1_048_576)
      .default(8192),
    /**
     * Per-connection bound on unread response octets. A 17-octet Class 0 READ
     * asks for the whole static database, so a peer that pipelines requests and
     * then stops reading is the amplification risk the receive bound does not
     * cover; passing this bound drops that connection.
     */
    maxTxQueueBytes: z.coerce
      .number()
      .int()
      .min(4096)
      .max(67_108_864)
      .default(DEFAULT_MAX_TX_QUEUE_BYTES),
    /** Execute DNP3 controls at all. Separate, explicit opt-in. */
    allowControls: z.boolean().default(false),
    /** How long a SELECT stays armed before an OPERATE is refused with TIMEOUT. */
    selectTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .max(600_000)
      .default(5_000),
    /**
     * Run controls with no SAv5 Control Direction Session Key. Only consulted when controls are
     * enabled; it exists so that choice has to be written down.
     */
    allowUnauthenticatedControls: z.boolean().default(false),
    /** Enable unsolicited responses at startup. */
    unsolicitedEnabled: z.boolean().default(false),
    /** Path to the JSON point map served by this outstation. */
    pointMapFile: z.string().trim().min(1),
    /** How often mapped tags are re-read from the tag store, in ms. */
    pollIntervalMs: z.coerce
      .number()
      .int()
      .min(50)
      .max(3_600_000)
      .default(1_000),
    /** SAv5 user number the Control Direction Session Key belongs to. */
    sav5UserNumber: z.coerce.number().int().min(1).max(0xffff).default(1),
    /** Current SAv5 Control Direction Session Key, hex-encoded. */
    sav5ControlKeyHex: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]+$/, "must be hex-encoded")
      .refine(
        (hex) => hex.length % 2 === 0,
        "must have an even number of hex digits",
      )
      .refine(
        (hex) => hex.length / 2 >= MIN_CONTROL_KEY_BYTES,
        `must be at least ${MIN_CONTROL_KEY_BYTES} octets`,
      )
      .optional(),
  })
  .superRefine((config, ctx) => {
    try {
      parsePeerRules(config.allowedPeers);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedPeers"],
        message:
          err instanceof PeerRuleError
            ? err.message
            : `invalid peer allowlist: ${String(err)}`,
      });
    }

    // Controls move live plant state. DNP3 authenticates them only through SAv5,
    // so "controls on, no key" has to be an explicit, separate declaration.
    if (
      config.allowControls &&
      config.sav5ControlKeyHex === undefined &&
      !config.allowUnauthenticatedControls
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sav5ControlKeyHex"],
        message:
          "DNP3_OUTSTATION_ALLOW_CONTROLS=true without DNP3_OUTSTATION_SAV5_CONTROL_KEY " +
          "would execute plant-output commands from any allowlisted peer with no " +
          "cryptographic authentication. Provision the active SAv5 Control Direction Session Key, or set " +
          "DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS=true to accept that risk " +
          "explicitly.",
      });
    }
    if (config.sav5ControlKeyHex !== undefined && config.maxConnections !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxConnections"],
        message:
          "SAv5 Control Direction Session Keys are association-scoped; this deployment " +
          "supports one authenticated master association, so " +
          "DNP3_OUTSTATION_MAX_CONNECTIONS must be 1 when a key is provisioned",
      });
    }
  });

export type Dnp3OutstationDeploymentConfig = z.infer<
  typeof dnp3OutstationDeploymentConfigSchema
>;

/**
 * True only when the listener has been explicitly armed. Anything other than the
 * exact string "true" (including unset) leaves DNP3 Outstation Mode off.
 */
export function isDnp3OutstationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return boolFlag(env[DNP3_OUTSTATION_ENABLED_ENV]);
}

/**
 * Build and validate the listener configuration from the environment.
 *
 * @throws {Dnp3OutstationConfigError} with an operator-readable message when the
 *   configuration cannot produce a safe listener. The caller must not fall back
 *   to defaults — an unparseable configuration means no listener.
 */
export function loadDnp3OutstationConfig(
  env: NodeJS.ProcessEnv = process.env,
): Dnp3OutstationDeploymentConfig {
  const host = present(env.DNP3_OUTSTATION_BIND_HOST) ?? "127.0.0.1";
  const declaredPeers = csv(env.DNP3_OUTSTATION_ALLOWED_PEERS);

  // A routable bind must name its masters. Silently inheriting the loopback
  // default there would produce a listener that is exposed to the network but
  // rejects everything — confusing, and one edit away from being wide open.
  if (!isLoopbackHost(host) && declaredPeers === undefined) {
    throw new Dnp3OutstationConfigError(
      `DNP3_OUTSTATION_BIND_HOST="${host}" is not a loopback address, so ` +
        "DNP3_OUTSTATION_ALLOWED_PEERS must list the DNP3 masters permitted to " +
        "connect (IP or CIDR, comma-separated). DNP3 does not authenticate the " +
        "TCP peer; the allowlist is the only peer control available.",
    );
  }

  const parsed = dnp3OutstationDeploymentConfigSchema.safeParse({
    host,
    port: present(env.DNP3_OUTSTATION_PORT),
    siteId: present(env.DNP3_OUTSTATION_SITE_ID),
    localAddress: present(env.DNP3_OUTSTATION_LINK_ADDRESS),
    allowedPeers: declaredPeers ?? [...LOOPBACK_PEER_RULES],
    maxConnections: present(env.DNP3_OUTSTATION_MAX_CONNECTIONS),
    socketTimeoutMs: present(env.DNP3_OUTSTATION_SOCKET_TIMEOUT_MS),
    maxRxBufferBytes: present(env.DNP3_OUTSTATION_MAX_RX_BUFFER_BYTES),
    maxTxQueueBytes: present(env.DNP3_OUTSTATION_MAX_TX_QUEUE_BYTES),
    allowControls: boolFlag(env.DNP3_OUTSTATION_ALLOW_CONTROLS),
    selectTimeoutMs: present(env.DNP3_OUTSTATION_SELECT_TIMEOUT_MS),
    allowUnauthenticatedControls: boolFlag(
      env.DNP3_OUTSTATION_ALLOW_UNAUTHENTICATED_CONTROLS,
    ),
    unsolicitedEnabled: boolFlag(env.DNP3_OUTSTATION_UNSOLICITED_ENABLED),
    pointMapFile: present(env.DNP3_OUTSTATION_POINT_MAP_FILE),
    pollIntervalMs: present(env.DNP3_OUTSTATION_POLL_INTERVAL_MS),
    sav5UserNumber: present(env.DNP3_OUTSTATION_SAV5_USER),
    sav5ControlKeyHex: present(env.DNP3_OUTSTATION_SAV5_CONTROL_KEY),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Dnp3OutstationConfigError(
      `DNP3 Outstation Mode is enabled but its configuration is invalid — ${detail}. ` +
        "Refusing to start a listener.",
    );
  }

  return parsed.data;
}

/**
 * Read and validate the point-map JSON file.
 *
 * @throws {Dnp3OutstationConfigError} when the file is missing, is not JSON, or
 *   does not match `Dnp3PointMapConfigSchema`. The offending path is in the
 *   message so a misconfiguration is diagnosable from one log line.
 */
export function loadDnp3PointMapFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Dnp3PointMapConfig {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    throw new Dnp3OutstationConfigError(
      `DNP3_OUTSTATION_POINT_MAP_FILE could not be read (${path}): ${(err as Error).message}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Dnp3OutstationConfigError(
      `DNP3_OUTSTATION_POINT_MAP_FILE is not valid JSON (${path}): ${(err as Error).message}`,
    );
  }

  const parsed = Dnp3PointMapConfigSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "pointMap"}: ${issue.message}`)
      .join("; ");
    throw new Dnp3OutstationConfigError(
      `DNP3_OUTSTATION_POINT_MAP_FILE is not a valid point map (${path}) — ${detail}`,
    );
  }

  // Duplicate (type,index) pairs make `Dnp3PointMap` throw from its constructor
  // with a message that does not name the file; catch it here instead.
  const seen = new Set<string>();
  for (const point of parsed.data.points) {
    const key = `${point.type}:${point.index}`;
    if (seen.has(key)) {
      throw new Dnp3OutstationConfigError(
        `DNP3_OUTSTATION_POINT_MAP_FILE (${path}) maps ${key} more than once`,
      );
    }
    seen.add(key);
  }

  return parsed.data;
}

/**
 * A one-line, credential-free summary for the boot log. Operators need to be
 * able to see from the log alone whether they exposed a controllable listener.
 */
export function describeDnp3OutstationConfig(
  config: Dnp3OutstationDeploymentConfig,
): string {
  return (
    `site=${config.siteId} linkAddr=${config.localAddress} ` +
    `bind=${config.host}:${config.port} ` +
    `controls=${config.allowControls ? "ENABLED" : "disabled"} ` +
    `sav5=${config.sav5ControlKeyHex ? `user ${config.sav5UserNumber}` : "not provisioned"} ` +
    `maxConnections=${config.maxConnections} ` +
    `allowedPeers=[${config.allowedPeers.join(", ")}]`
  );
}
