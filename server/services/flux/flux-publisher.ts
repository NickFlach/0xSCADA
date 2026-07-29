/**
 * FluxPublisher — Publishes SCADA equipment state to Flux world state engine.
 * 
 * Batches entity updates and publishes at configurable intervals.
 * Non-blocking: publish failures are logged but never crash the SCADA server.
 * See ADR-0015 for architecture details.
 */

import { log, logError, logWarn } from "../../logger";
import type { FluxConfig, FluxEvent, FluxEntity } from "./types";
import { classifyEntity } from "../geometry/classifier";
import { computePhi, type PhiReport } from "../geometry/phi";
import type { ScadaCoordinates } from "../geometry/types";

/** Tracked entity with SGA coordinates (#331) */
export interface TrackedEntity {
  id: string;
  coords: ScadaCoordinates;
  linkCount: number;
  lastSeen: number;
}

export class FluxPublisher {
  private config: FluxConfig;
  private pendingEvents: FluxEvent[] = [];
  private publishTimer: NodeJS.Timeout | null = null;
  private lastPublishByEntity: Map<string, number> = new Map();
  private consecutiveFailures = 0;
  private readonly MAX_BATCH_SIZE = 50;
  private readonly MAX_RETRY_BACKOFF_MS = 60_000;

  /** SGA-classified entities (#331) */
  private classifiedEntities: Map<string, TrackedEntity> = new Map();
  /** Entity links for Phi computation */
  private entityLinks: { sourceId: string; targetId: string }[] = [];

  constructor(config: FluxConfig) {
    this.config = config;
  }

  /** Start periodic publishing */
  start(): void {
    if (!this.config.enabled) {
      log("⚡ Flux integration disabled (no FLUX_URL configured)", "flux");
      return;
    }

    log(`⚡ Flux publisher started → ${this.config.url}`, "flux");
    log(`   Stream: ${this.config.stream}, Prefix: ${this.config.entityPrefix}, Interval: ${this.config.publishIntervalMs}ms`, "flux");

    this.publishTimer = setInterval(() => this.flush(), this.config.publishIntervalMs);
  }

  /** Stop publishing */
  stop(): void {
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
    // Final flush attempt
    if (this.pendingEvents.length > 0) {
      this.flush().catch(() => {});
    }
    log("⚡ Flux publisher stopped", "flux");
  }

  /** Queue an entity update for next publish cycle */
  publishEntity(entityIdSuffix: string, properties: Record<string, unknown>): void {
    if (!this.config.enabled) return;

    const entityId = `${this.config.entityPrefix}${entityIdSuffix}`;
    const now = Date.now();

    // Throttle per-entity updates
    const lastPublish = this.lastPublishByEntity.get(entityId) || 0;
    if (now - lastPublish < this.config.publishIntervalMs / 2) {
      return; // Skip — too soon since last update for this entity
    }

    // SGA classification (#331) — classify and attach geometry to properties
    const coords = classifyEntity(entityId, properties);
    const sgaProps = {
      ...properties,
      sga_class: coords.classIndex,
      sga_quadrant: ["sensor", "control", "alarm", "maintenance"][coords.h2],
      sga_triality: ["site", "asset", "event"][coords.d],
      sga_slot: coords.l,
      sga_amplitude: coords.amplitude,
    };

    // Track classified entity
    const existing = this.classifiedEntities.get(entityId);
    this.classifiedEntities.set(entityId, {
      id: entityId,
      coords,
      linkCount: existing?.linkCount ?? 0,
      lastSeen: now,
    });

    this.pendingEvents.push({
      stream: this.config.stream,
      source: this.config.source,
      timestamp: now,
      payload: { entity_id: entityId, properties: sgaProps },
    });

    this.lastPublishByEntity.set(entityId, now);
  }

  /** Publish a site entity */
  publishSite(siteId: string, properties: Record<string, unknown>): void {
    this.publishEntity(`site/${siteId}`, properties);
  }

  /** Publish an asset/equipment entity */
  publishAsset(assetId: string, properties: Record<string, unknown>): void {
    this.publishEntity(assetId, properties);
  }

  /** Publish an alert entity */
  publishAlert(alertId: string, properties: Record<string, unknown>): void {
    this.publishEntity(`alert/${alertId}`, properties);
  }

  /** Flush pending events to Flux */
  async flush(): Promise<void> {
    if (this.pendingEvents.length === 0) return;

    // Drain the queue
    const events = this.pendingEvents.splice(0, this.MAX_BATCH_SIZE);

    try {
      if (events.length === 1) {
        await this.postEvent(events[0]);
      } else {
        await this.postBatch(events);
      }
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      const backoff = Math.min(
        this.config.publishIntervalMs * Math.pow(2, this.consecutiveFailures),
        this.MAX_RETRY_BACKOFF_MS
      );
      logWarn(`⚡ Flux publish failed (attempt ${this.consecutiveFailures}, retry in ${backoff}ms): ${error}`, "flux");
      
      // Put events back for retry (at front)
      this.pendingEvents.unshift(...events);
    }
  }

  /** Read an entity from Flux */
  async getEntity(entityIdSuffix: string): Promise<FluxEntity | null> {
    const entityId = `${this.config.entityPrefix}${entityIdSuffix}`;
    try {
      const res = await fetch(`${this.config.url}/api/state/entities/${encodeURIComponent(entityId)}`, {
        headers: this.authHeaders(),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as FluxEntity;
    } catch (error) {
      logError({ error, entityId }, "⚡ Flux entity read failed");
      return null;
    }
  }

  /** List all SCADA entities from Flux */
  async listEntities(): Promise<FluxEntity[]> {
    try {
      const res = await fetch(`${this.config.url}/api/state/entities?prefix=${encodeURIComponent(this.config.entityPrefix)}`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (Array.isArray(data) ? data : data.entities || []) as FluxEntity[];
    } catch (error) {
      logError("⚡ Flux entity list failed", error as any);
      return [];
    }
  }

  /** Compute Phi for all classified entities (#331) */
  computePhi(): PhiReport {
    const entities = Array.from(this.classifiedEntities.values()).map((e) => ({
      id: e.id,
      coords: e.coords,
    }));
    return computePhi(entities, this.entityLinks);
  }

  /** Get all classified entities (#331) */
  getClassifiedEntities(): TrackedEntity[] {
    return Array.from(this.classifiedEntities.values());
  }

  /** Add a link between two entities (used for Phi computation) */
  addEntityLink(sourceId: string, targetId: string): void {
    this.entityLinks.push({ sourceId, targetId });
    // Update link counts
    const src = this.classifiedEntities.get(sourceId);
    if (src) src.linkCount++;
    const tgt = this.classifiedEntities.get(targetId);
    if (tgt) tgt.linkCount++;
  }

  /** Get publisher status */
  getStatus(): { enabled: boolean; url: string; pendingEvents: number; consecutiveFailures: number } {
    return {
      enabled: this.config.enabled,
      url: this.config.url,
      pendingEvents: this.pendingEvents.length,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async postEvent(event: FluxEvent): Promise<void> {
    const res = await fetch(`${this.config.url}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  private async postBatch(events: FluxEvent[]): Promise<void> {
    const res = await fetch(`${this.config.url}/api/events/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(events),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  private authHeaders(): Record<string, string> {
    if (this.config.authToken) {
      return { Authorization: `Bearer ${this.config.authToken}` };
    }
    return {};
  }
}
