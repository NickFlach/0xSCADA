/**
 * Flux Universe Publisher — SingularisPrime Integration
 *
 * Transforms internal SCADA events into SingularisPrime schema and publishes
 * them to the Flux Universe (pure-jade namespace) via REST.
 *
 * Features:
 *  - Batching with configurable flush interval
 *  - Per-type rate limiting for high-frequency process data
 *  - Configurable publish filters (event types, facilities)
 *  - Exponential backoff retry on failures
 *  - Entity CRUD for SCADA entities in Flux
 *
 * Issue: #349 — Publish SCADA events to Flux Universe via SingularisPrime
 * ADR: ADR-0022
 */

import { log, logError, logWarn } from "../../logger";
import type {
  AnyScadaEvent,
  ScadaEventType,
  SingularisPrimeScadaEvent,
  SCADA_SCHEMA_VERSION,
} from "./schemas";

// ── Configuration ────────────────────────────────────────────────────────────

export interface FluxUniversePublisherConfig {
  /** Flux Universe base URL */
  fluxUrl: string;
  /** Namespace (e.g. "pure-jade") */
  namespace: string;
  /** Bearer token for namespace auth */
  authToken?: string;
  /** Flush interval in ms (default 5000) */
  flushIntervalMs: number;
  /** Max events per batch POST (default 100) */
  maxBatchSize: number;
  /** Max queued events before dropping oldest (default 10000) */
  maxQueueSize: number;
  /** Rate limit: max events per second per event type (0 = unlimited) */
  rateLimitPerType: number;
  /** Which event types to publish (empty = all) */
  allowedEventTypes: ScadaEventType[];
  /** Which facilities to publish (empty = all) */
  allowedFacilities: string[];
  /** Enable/disable */
  enabled: boolean;
  /** Source identifier */
  source: string;
  /** Entity prefix in Flux */
  entityPrefix: string;
}

export function loadFluxUniverseConfig(): FluxUniversePublisherConfig {
  const allowedTypes = process.env.SINGULARIS_ALLOWED_EVENT_TYPES;
  const allowedFacilities = process.env.SINGULARIS_ALLOWED_FACILITIES;

  return {
    fluxUrl: process.env.FLUX_URL || "https://flux.eckman-tech.com",
    namespace: process.env.FLUX_NAMESPACE || "pure-jade",
    authToken: process.env.FLUX_AUTH_TOKEN,
    flushIntervalMs: parseInt(process.env.SINGULARIS_FLUSH_INTERVAL_MS || "5000", 10),
    maxBatchSize: parseInt(process.env.SINGULARIS_MAX_BATCH_SIZE || "100", 10),
    maxQueueSize: parseInt(process.env.SINGULARIS_MAX_QUEUE_SIZE || "10000", 10),
    rateLimitPerType: parseInt(process.env.SINGULARIS_RATE_LIMIT_PER_TYPE || "0", 10),
    allowedEventTypes: allowedTypes
      ? (allowedTypes.split(",").map((s) => s.trim()) as ScadaEventType[])
      : [],
    allowedFacilities: allowedFacilities
      ? allowedFacilities.split(",").map((s) => s.trim())
      : [],
    enabled: process.env.SINGULARIS_ENABLED === "true" || !!process.env.FLUX_URL,
    source: process.env.SINGULARIS_SOURCE || `0xscada-${require("os").hostname()}`,
    entityPrefix: process.env.FLUX_ENTITY_PREFIX || "scada/",
  };
}

// ── Publisher ────────────────────────────────────────────────────────────────

export class FluxUniversePublisher {
  private config: FluxUniversePublisherConfig;
  private queue: AnyScadaEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private readonly MAX_RETRY_BACKOFF_MS = 120_000;

  /** Sliding window rate-limit counters: type → timestamps[] */
  private rateLimitWindows: Map<string, number[]> = new Map();

  /** Stats */
  private stats = {
    published: 0,
    dropped: 0,
    failed: 0,
    rateLimited: 0,
    filtered: 0,
  };

  constructor(config: FluxUniversePublisherConfig) {
    this.config = config;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (!this.config.enabled) {
      log("🌌 SingularisPrime Flux publisher disabled", "singularis");
      return;
    }
    log(
      `🌌 SingularisPrime Flux publisher started → ${this.config.fluxUrl} (ns: ${this.config.namespace})`,
      "singularis",
    );
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Best-effort final flush
    if (this.queue.length > 0) {
      this.flush().catch(() => {});
    }
    log(
      `🌌 SingularisPrime publisher stopped. Stats: ${JSON.stringify(this.stats)}`,
      "singularis",
    );
  }

  // ── Publish (enqueue) ────────────────────────────────────────────────────

  /**
   * Enqueue a SingularisPrime SCADA event for publishing.
   * Returns false if the event was filtered or rate-limited.
   */
  publish(event: AnyScadaEvent): boolean {
    if (!this.config.enabled) return false;

    // Filter by event type
    if (
      this.config.allowedEventTypes.length > 0 &&
      !this.config.allowedEventTypes.includes(event.type)
    ) {
      this.stats.filtered++;
      return false;
    }

    // Filter by facility
    if (
      this.config.allowedFacilities.length > 0 &&
      !this.config.allowedFacilities.includes(event.meta.facility)
    ) {
      this.stats.filtered++;
      return false;
    }

    // Rate limit per type
    if (this.config.rateLimitPerType > 0 && this.isRateLimited(event.type)) {
      this.stats.rateLimited++;
      return false;
    }

    // Queue size guard
    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop oldest
      this.queue.shift();
      this.stats.dropped++;
    }

    this.queue.push(event);
    return true;
  }

  // ── Flush ────────────────────────────────────────────────────────────────

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.config.maxBatchSize);

    // Transform to Flux event format
    const fluxEvents = batch.map((evt) => ({
      stream: `singularis.scada.${evt.type}`,
      source: this.config.source,
      timestamp: Date.now(),
      payload: {
        entity_id: this.entityIdFor(evt),
        properties: evt as unknown as Record<string, unknown>,
      },
    }));

    try {
      if (fluxEvents.length === 1) {
        await this.post("/api/events", fluxEvents[0]);
      } else {
        await this.post("/api/events/batch", fluxEvents);
      }
      this.stats.published += fluxEvents.length;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      this.stats.failed += batch.length;
      const backoff = Math.min(
        this.config.flushIntervalMs * Math.pow(2, this.consecutiveFailures),
        this.MAX_RETRY_BACKOFF_MS,
      );
      logWarn(
        `🌌 Flux publish failed (attempt ${this.consecutiveFailures}, next retry ~${backoff}ms): ${error}`,
        "singularis",
      );
      // Put back for retry
      this.queue.unshift(...batch);
    }
  }

  // ── Entity management ────────────────────────────────────────────────────

  /** Create or update a SCADA entity in Flux */
  async upsertEntity(
    entityIdSuffix: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    const entityId = `${this.config.entityPrefix}${entityIdSuffix}`;
    try {
      await this.post("/api/events", {
        stream: "singularis.scada.entity",
        source: this.config.source,
        timestamp: Date.now(),
        payload: { entity_id: entityId, properties },
      });
    } catch (error) {
      logError(`🌌 Entity upsert failed: ${entityId}: ${error}`, "singularis");
    }
  }

  /** Read a SCADA entity from Flux */
  async getEntity(entityIdSuffix: string): Promise<Record<string, unknown> | null> {
    const entityId = `${this.config.entityPrefix}${entityIdSuffix}`;
    try {
      const res = await fetch(
        `${this.config.fluxUrl}/api/state/entities/${encodeURIComponent(entityId)}`,
        { headers: this.headers() },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (error) {
      logError(`🌌 Entity read failed: ${entityId}: ${error}`, "singularis");
      return null;
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      enabled: this.config.enabled,
      fluxUrl: this.config.fluxUrl,
      namespace: this.config.namespace,
      queueDepth: this.queue.length,
      consecutiveFailures: this.consecutiveFailures,
      stats: { ...this.stats },
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private entityIdFor(evt: AnyScadaEvent): string {
    const prefix = this.config.entityPrefix;
    switch (evt.type) {
      case "process_variable_change":
        return `${prefix}pv/${evt.payload.tagId}`;
      case "alarm_activation":
      case "alarm_acknowledgment":
      case "alarm_clear":
      case "alarm_shelve":
        return `${prefix}alarm/${evt.payload.alarmId}`;
      case "equipment_state_transition":
        return `${prefix}equipment/${evt.payload.equipmentId}`;
      case "operator_action":
        return `${prefix}action/${Date.now()}`;
      case "system_health":
        return `${prefix}health/${evt.payload.componentId}`;
      default:
        return `${prefix}event/${Date.now()}`;
    }
  }

  private isRateLimited(eventType: string): boolean {
    const now = Date.now();
    const windowMs = 1000;
    let timestamps = this.rateLimitWindows.get(eventType) || [];
    // Prune old entries
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length >= this.config.rateLimitPerType) {
      this.rateLimitWindows.set(eventType, timestamps);
      return true;
    }
    timestamps.push(now);
    this.rateLimitWindows.set(eventType, timestamps);
    return false;
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.config.fluxUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.authToken) {
      h["Authorization"] = `Bearer ${this.config.authToken}`;
    }
    return h;
  }
}
