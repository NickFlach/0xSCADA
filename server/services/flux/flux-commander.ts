/**
 * FluxCommander — Bidirectional control via Flux control entities.
 * 
 * Polls `/control` entities for incoming commands, executes them via
 * registered handlers, and publishes acknowledgments.
 * See ADR-0015 §4 "Command Property Protocol".
 */

import { log, logError, logWarn } from "../../logger";
import type { FluxConfig, FluxCommand, FluxCommandAck } from "./types";

export type CommandHandler = (
  entityId: string,
  command: FluxCommand
) => Promise<FluxCommandAck>;

export class FluxCommander {
  private config: FluxConfig;
  private handlers: Map<string, CommandHandler> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSeenCmdIds: Map<string, string> = new Map();
  private watchedEntities: Set<string> = new Set();

  constructor(config: FluxConfig) {
    this.config = config;
  }

  /** Register a command handler for a specific command type */
  registerHandler(commandType: string, handler: CommandHandler): void {
    this.handlers.set(commandType, handler);
    log(`⚡ Flux command handler registered: ${commandType}`, "flux");
  }

  /** Add an entity to the command watch list */
  watchEntity(entityIdSuffix: string): void {
    this.watchedEntities.add(entityIdSuffix);
  }

  /** Start polling for commands */
  start(): void {
    if (!this.config.enabled || this.watchedEntities.size === 0) return;

    log(`⚡ Flux commander started, watching ${this.watchedEntities.size} control entities`, "flux");
    // Poll at 2x the publish interval for responsiveness
    const pollInterval = Math.max(this.config.publishIntervalMs / 2, 2000);
    this.pollTimer = setInterval(() => this.pollAll(), pollInterval);
  }

  /** Stop polling */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollAll(): Promise<void> {
    for (const entitySuffix of this.watchedEntities) {
      try {
        await this.pollEntity(entitySuffix);
      } catch (error) {
        logError(`⚡ Flux command poll failed: ${entitySuffix}`, error, "flux");
      }
    }
  }

  private async pollEntity(entitySuffix: string): Promise<void> {
    const controlEntityId = `${this.config.entityPrefix}${entitySuffix}/control`;
    
    const res = await fetch(
      `${this.config.url}/api/state/entities/${encodeURIComponent(controlEntityId)}`,
      { headers: this.authHeaders() }
    );
    
    if (res.status === 404) return; // No control entity yet
    if (!res.ok) return;

    const entity = await res.json();
    const props = entity.properties || {};
    const cmdId = props.cmd_id as string;
    const command = props.command as string;

    if (!cmdId || !command) return;
    if (this.lastSeenCmdIds.get(controlEntityId) === cmdId) return; // Already processed

    this.lastSeenCmdIds.set(controlEntityId, cmdId);
    log(`⚡ Flux command received: ${command} (${cmdId}) for ${entitySuffix}`, "flux");

    const handler = this.handlers.get(command);
    let ack: FluxCommandAck;

    if (!handler) {
      ack = { cmd_ack: cmdId, cmd_status: "rejected", error: `Unknown command: ${command}` };
      logWarn(`⚡ No handler for command: ${command}`, "flux");
    } else {
      try {
        ack = await handler(entitySuffix, props as unknown as FluxCommand);
      } catch (error) {
        ack = { cmd_ack: cmdId, cmd_status: "failed", error: String(error) };
        logError(`⚡ Command handler failed: ${command}`, error, "flux");
      }
    }

    // Publish acknowledgment
    await this.publishAck(controlEntityId, ack);
  }

  private async publishAck(controlEntityId: string, ack: FluxCommandAck): Promise<void> {
    try {
      const res = await fetch(`${this.config.url}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({
          stream: this.config.stream,
          source: this.config.source,
          timestamp: Date.now(),
          payload: {
            entity_id: controlEntityId,
            properties: ack,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (error) {
      logError(`⚡ Failed to publish command ack`, error, "flux");
    }
  }

  private authHeaders(): Record<string, string> {
    if (this.config.authToken) {
      return { Authorization: `Bearer ${this.config.authToken}` };
    }
    return {};
  }
}
