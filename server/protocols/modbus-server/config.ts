/**
 * Modbus TCP Server Mode — deployment configuration.
 *
 * Issue #462: Modbus TCP Server Mode.
 *
 * The listener is OFF by default and every unsafe choice has to be made
 * explicitly, because Modbus TCP authenticates nothing: any peer that can open
 * the socket is a fully privileged master. The gates, from least to most
 * dangerous:
 *
 *   1. `MODBUS_SERVER_ENABLED=true`            — start a listener at all.
 *   2. `MODBUS_SERVER_BIND_HOST`               — defaults to 127.0.0.1. Leaving
 *                                                loopback is a deliberate act
 *                                                and forces gate 3.
 *   3. `MODBUS_SERVER_ALLOWED_PEERS`           — mandatory (and wildcard-free)
 *                                                once the bind host is routable.
 *   4. `MODBUS_SERVER_ALLOW_WRITES=true`       — separate opt-in before FC05 /
 *                                                FC06 / FC15 / FC16 are served
 *                                                at all; even then only register
 *                                                map entries marked `writable`
 *                                                can be mutated.
 *
 * Validation is Zod-based and fails closed: a malformed value raises
 * `ModbusServerConfigError` and no listener is created.
 */

import { z } from "zod";
import {
  isLoopbackHost,
  LOOPBACK_PEER_RULES,
  parsePeerRules,
  PeerRuleError,
} from "./peer-filter";

/** Raised when the deployment configuration cannot produce a safe listener. */
export class ModbusServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModbusServerConfigError";
  }
}

/** Environment flag that must be exactly "true" to arm the listener. */
export const MODBUS_SERVER_ENABLED_ENV = "MODBUS_SERVER_ENABLED";

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

export const modbusServerDeploymentConfigSchema = z
  .object({
    /** Bind address. Defaults to loopback — never 0.0.0.0. */
    host: z.string().trim().min(1).default("127.0.0.1"),
    /** Bind port. 502 is the registered Modbus port and needs privileges. */
    port: z.coerce.number().int().min(1).max(65535).default(502),
    /** Site whose register map this listener serves. */
    siteId: z.string().trim().min(1),
    /** Modbus unit id whose register-map rows are served. */
    unitId: z.coerce.number().int().min(0).max(255).default(1),
    /**
     * Peer IPs/CIDRs permitted to connect. Enforced at accept time. Wildcard
     * prefixes (`/0`) are rejected by `parsePeerRules`.
     */
    allowedPeers: z.array(z.string().trim().min(1)).min(1),
    /** Hard cap on simultaneous master connections. */
    maxConnections: z.coerce.number().int().min(1).max(1024).default(4),
    /** Serve Modbus write function codes at all. Separate, explicit opt-in. */
    allowWrites: z.boolean().default(false),
    /** Idle socket timeout in ms (0 disables). */
    socketTimeoutMs: z.coerce.number().int().min(0).default(60_000),
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
  });

export type ModbusServerDeploymentConfig = z.infer<
  typeof modbusServerDeploymentConfigSchema
>;

/**
 * True only when the listener has been explicitly armed. Anything other than
 * the exact string "true" (including unset) leaves Modbus TCP Server Mode off.
 */
export function isModbusServerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return boolFlag(env[MODBUS_SERVER_ENABLED_ENV]);
}

/**
 * Build and validate the listener configuration from the environment.
 *
 * @throws {ModbusServerConfigError} with an operator-readable message when the
 *   configuration cannot produce a safe listener. The caller must not fall back
 *   to defaults — an unparseable configuration means no listener.
 */
export function loadModbusServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModbusServerDeploymentConfig {
  const host = present(env.MODBUS_SERVER_BIND_HOST) ?? "127.0.0.1";
  const declaredPeers = csv(env.MODBUS_SERVER_ALLOWED_PEERS);

  // A routable bind must name its masters. Silently inheriting the loopback
  // default there would produce a listener that is exposed to the network but
  // rejects everything — confusing, and one edit away from being wide open.
  if (!isLoopbackHost(host) && declaredPeers === undefined) {
    throw new ModbusServerConfigError(
      `MODBUS_SERVER_BIND_HOST="${host}" is not a loopback address, so ` +
        "MODBUS_SERVER_ALLOWED_PEERS must list the Modbus masters permitted to " +
        "connect (IP or CIDR, comma-separated). Modbus TCP has no client " +
        "authentication; the allowlist is the only peer control available.",
    );
  }

  const parsed = modbusServerDeploymentConfigSchema.safeParse({
    host,
    port: present(env.MODBUS_SERVER_PORT),
    siteId: present(env.MODBUS_SERVER_SITE_ID),
    unitId: present(env.MODBUS_SERVER_UNIT_ID),
    allowedPeers: declaredPeers ?? [...LOOPBACK_PEER_RULES],
    maxConnections: present(env.MODBUS_SERVER_MAX_CONNECTIONS),
    allowWrites: boolFlag(env.MODBUS_SERVER_ALLOW_WRITES),
    socketTimeoutMs: present(env.MODBUS_SERVER_SOCKET_TIMEOUT_MS),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ModbusServerConfigError(
      `Modbus TCP Server Mode is enabled but its configuration is invalid — ${detail}. ` +
        "Refusing to start a listener.",
    );
  }

  return parsed.data;
}

/**
 * A one-line, credential-free summary for the boot log. Operators need to be
 * able to see from the log alone whether they exposed a writable listener.
 */
export function describeModbusServerConfig(
  config: ModbusServerDeploymentConfig,
): string {
  return (
    `site=${config.siteId} unit=${config.unitId} bind=${config.host}:${config.port} ` +
    `writes=${config.allowWrites ? "ENABLED" : "disabled"} ` +
    `maxConnections=${config.maxConnections} ` +
    `allowedPeers=[${config.allowedPeers.join(", ")}]`
  );
}
