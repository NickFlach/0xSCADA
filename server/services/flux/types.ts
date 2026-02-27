/**
 * Flux State Engine Integration Types
 * See ADR-0015 for design rationale
 */

export interface FluxConfig {
  /** Flux instance URL (e.g., https://flux.eckman-tech.com) */
  url: string;
  /** Bearer token for namespaced Flux instances */
  authToken?: string;
  /** Minimum interval between entity updates (ms) */
  publishIntervalMs: number;
  /** Namespace prefix for all entities */
  entityPrefix: string;
  /** Event stream name */
  stream: string;
  /** Source identifier for events */
  source: string;
  /** Enable Flux integration */
  enabled: boolean;
}

export interface FluxEvent {
  stream: string;
  source: string;
  timestamp: number;
  payload: {
    entity_id: string;
    properties: Record<string, unknown>;
  };
}

export interface FluxEntity {
  entity_id: string;
  properties: Record<string, unknown>;
  last_updated?: number;
}

export interface FluxCommand {
  command: string;
  cmd_id: string;
  [key: string]: unknown;
}

export interface FluxCommandAck {
  cmd_ack: string;
  cmd_status: "accepted" | "rejected" | "completed" | "failed";
  error?: string;
}

export function loadFluxConfig(): FluxConfig {
  return {
    url: process.env.FLUX_URL || "",
    authToken: process.env.FLUX_AUTH_TOKEN,
    publishIntervalMs: parseInt(process.env.FLUX_PUBLISH_INTERVAL_MS || "10000", 10),
    entityPrefix: process.env.FLUX_ENTITY_PREFIX || "scada/",
    stream: process.env.FLUX_STREAM || "scada",
    source: process.env.FLUX_SOURCE || `0xscada-${require("os").hostname()}`,
    enabled: !!process.env.FLUX_URL,
  };
}
