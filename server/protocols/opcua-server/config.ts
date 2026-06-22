/**
 * OPC-UA Server Mode — Configuration
 *
 * Zod-validated configuration for the UA server (CROSS-CUTTING RULE #4: Zod for
 * input validation). Defaults match the acceptance criteria: endpoint
 * `opc.tcp://0.0.0.0:4840/0xscada`.
 *
 * Part of #461.
 */

import { z } from "zod";
import { DEFAULT_NAMESPACE_URI } from "./address-space";

/** Default listen endpoint per the issue acceptance criteria. */
export const DEFAULT_OPCUA_ENDPOINT = "opc.tcp://0.0.0.0:4840/0xscada";

export const OpcuaServerConfigSchema = z.object({
  /** Whether the server is started at boot. */
  enabled: z.boolean().default(false),
  /** Bind host. */
  host: z.string().default("0.0.0.0"),
  /** Listen port (UA default 4840). */
  port: z.coerce.number().int().min(1).max(65535).default(4840),
  /** Resource path appended to the endpoint URL. */
  resourcePath: z.string().default("/0xscada"),
  /** UA ApplicationUri / namespace URI for application nodes. */
  applicationUri: z.string().default(DEFAULT_NAMESPACE_URI),
  /** UA server name advertised to clients. */
  serverName: z.string().default("0xSCADA OPC-UA Server"),
  /** Deployment environment, drives security-policy selection. */
  env: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  /** PKI root folder for certificate material. */
  pkiFolder: z.string().default("./pki/opcua-server"),
  /**
   * How often (ms) the server samples tag changes for subscriptions. The UA
   * sampling/publishing intervals are negotiated per-monitored-item, but this
   * caps how fast we forward 0xSCADA tag updates into the address space.
   */
  minSamplingIntervalMs: z.coerce.number().int().min(10).default(100),
  /** Max concurrent client sessions. */
  maxSessions: z.coerce.number().int().min(1).default(100),
});

export type OpcuaServerConfig = z.infer<typeof OpcuaServerConfigSchema>;

/** Build the full endpoint URL from a validated config. */
export function endpointUrl(config: OpcuaServerConfig): string {
  const path = config.resourcePath.startsWith("/")
    ? config.resourcePath
    : `/${config.resourcePath}`;
  return `opc.tcp://${config.host}:${config.port}${path}`;
}

/**
 * Parse + validate raw config, applying defaults. Throws ZodError on invalid
 * input (callers convert to a friendly message).
 */
export function loadOpcuaServerConfig(
  raw: unknown = {},
): OpcuaServerConfig {
  return OpcuaServerConfigSchema.parse(raw ?? {});
}
