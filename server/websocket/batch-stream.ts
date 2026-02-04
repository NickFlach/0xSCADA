/**
 * WebSocket Batch Event Stream
 *
 * Issue #85 - Performance: Event Batch Aggregation & Compression Pipeline
 *
 * Integrates the EventBatchAggregator with WebSocket streaming to provide
 * efficient batch delivery of compressed events to clients.
 *
 * Features:
 * - Batch streaming for high-throughput scenarios
 * - Compression toggle per client
 * - Automatic fallback to individual events for low-frequency scenarios
 * - Metrics exposure for monitoring
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import { URL } from "url";
import { randomBytes } from "crypto";

import {
  EventBatchAggregator,
  createEventBatchAggregator,
  type BatchEvent,
  type CompressedBatch,
  type BatchConfig,
  type BatchMetrics,
} from "../services/event-batch-aggregator";
import { getEventService, type SignedEvent } from "../events";

// =============================================================================
// TYPES
// =============================================================================

export interface BatchStreamConfig {
  /** Enable batch streaming (default: true) */
  enableBatching: boolean;
  /** Batch aggregator configuration */
  batchConfig: Partial<BatchConfig>;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatIntervalMs: number;
  /** Connection timeout in ms (default: 60000) */
  connectionTimeoutMs: number;
  /** Maximum message size in bytes (default: 1MB) */
  maxMessageSize: number;
}

export interface BatchStreamClient {
  id: string;
  ws: WebSocket;
  connectedAt: Date;
  lastPingAt: Date;
  /** Whether client wants compressed batches */
  acceptsBatches: boolean;
  /** Whether client wants compression */
  acceptsCompression: boolean;
  /** Filter for site IDs */
  siteIds?: string[];
  /** Filter for event types */
  eventTypes?: string[];
  /** Events received count */
  eventsReceived: number;
  /** Batches received count */
  batchesReceived: number;
  /** Bytes received */
  bytesReceived: number;
  /** Client metadata */
  metadata: {
    ip?: string;
    userAgent?: string;
    clientId?: string;
  };
}

export interface BatchStreamMessage {
  type:
    | "connected"
    | "batch"
    | "event"
    | "metrics"
    | "pong"
    | "error"
    | "subscribed";
  payload: unknown;
  timestamp: string;
}

export interface ClientSubscribeMessage {
  type: "subscribe";
  siteIds?: string[];
  eventTypes?: string[];
  acceptsBatches?: boolean;
  acceptsCompression?: boolean;
}

export interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "ping" | "metrics";
  payload?: unknown;
}

export interface BatchStreamMetrics {
  activeConnections: number;
  totalConnections: number;
  totalBatchesSent: number;
  totalEventsSent: number;
  totalBytesSent: number;
  avgBatchSize: number;
  avgCompressionRatio: number;
  uptime: number;
  aggregatorMetrics: BatchMetrics;
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

const DEFAULT_BATCH_STREAM_CONFIG: BatchStreamConfig = {
  enableBatching: true,
  batchConfig: {
    maxBatchSize: 100,
    maxBatchWindowMs: 1000,
    enableCompression: true,
    compressionLevel: 6,
    maxConcurrentFlushes: 3,
    enableBackpressure: true,
    backpressureThreshold: 10,
  },
  heartbeatIntervalMs: 30000,
  connectionTimeoutMs: 60000,
  maxMessageSize: 1024 * 1024, // 1MB
};

// =============================================================================
// BATCH STREAM SERVER
// =============================================================================

export class BatchStreamServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, BatchStreamClient> = new Map();
  private config: BatchStreamConfig;
  private aggregator: EventBatchAggregator;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private startedAt: Date = new Date();

  // Metrics
  private totalConnections = 0;
  private totalBatchesSent = 0;
  private totalEventsSent = 0;
  private totalBytesSent = 0;

  constructor(config: Partial<BatchStreamConfig> = {}) {
    this.config = { ...DEFAULT_BATCH_STREAM_CONFIG, ...config };

    // Create the batch aggregator
    this.aggregator = createEventBatchAggregator(this.config.batchConfig);

    // Register flush handler to send batches to clients
    this.aggregator.onFlush(async (batch) => {
      this.broadcastBatch(batch);
    });
  }

  /**
   * Attach to HTTP server
   */
  attach(server: Server, path: string = "/ws/batch-events"): void {
    this.wss = new WebSocketServer({
      server,
      path,
      maxPayload: this.config.maxMessageSize,
    });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (error) => this.handleServerError(error));

    // Start heartbeat
    this.startHeartbeat();

    // Subscribe to events from EventService
    this.subscribeToEvents();

    console.log(`[BatchStreamServer] Attached at ${path}`);
  }

  /**
   * Handle new connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = this.generateId("batch-client");

    // Parse query params
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const acceptsBatches = url.searchParams.get("batches") !== "false";
    const acceptsCompression = url.searchParams.get("compression") !== "false";

    const client: BatchStreamClient = {
      id: clientId,
      ws,
      connectedAt: new Date(),
      lastPingAt: new Date(),
      acceptsBatches,
      acceptsCompression,
      eventsReceived: 0,
      batchesReceived: 0,
      bytesReceived: 0,
      metadata: {
        ip: this.getClientIP(req),
        userAgent: req.headers["user-agent"],
        clientId: url.searchParams.get("clientId") || undefined,
      },
    };

    this.clients.set(clientId, client);
    this.totalConnections++;

    // Send connected message
    this.send(client, {
      type: "connected",
      payload: {
        connectionId: clientId,
        serverTime: new Date().toISOString(),
        batchingEnabled: this.config.enableBatching,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      },
      timestamp: new Date().toISOString(),
    });

    // Setup handlers
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", (code, reason) =>
      this.handleClose(client, code, reason.toString())
    );
    ws.on("error", (error) => this.handleClientError(client, error));
    ws.on("pong", () => this.handlePong(client));

    console.log(
      `[BatchStreamServer] Client connected: ${clientId} (batches: ${acceptsBatches}, compression: ${acceptsCompression})`
    );
  }

  /**
   * Handle incoming message
   */
  private handleMessage(
    client: BatchStreamClient,
    data: Buffer | ArrayBuffer | Buffer[]
  ): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.sendError(client, "Invalid message format");
      return;
    }

    switch (message.type) {
      case "subscribe":
        this.handleSubscribe(client, message.payload as ClientSubscribeMessage);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(client);
        break;
      case "ping":
        this.handlePing(client);
        break;
      case "metrics":
        this.sendMetrics(client);
        break;
      default:
        this.sendError(client, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle subscribe
   */
  private handleSubscribe(
    client: BatchStreamClient,
    payload: ClientSubscribeMessage
  ): void {
    if (payload.siteIds) client.siteIds = payload.siteIds;
    if (payload.eventTypes) client.eventTypes = payload.eventTypes;
    if (payload.acceptsBatches !== undefined)
      client.acceptsBatches = payload.acceptsBatches;
    if (payload.acceptsCompression !== undefined)
      client.acceptsCompression = payload.acceptsCompression;

    this.send(client, {
      type: "subscribed",
      payload: {
        siteIds: client.siteIds,
        eventTypes: client.eventTypes,
        acceptsBatches: client.acceptsBatches,
        acceptsCompression: client.acceptsCompression,
      },
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[BatchStreamServer] Client ${client.id} subscribed: sites=${client.siteIds?.join(",") || "all"}, types=${client.eventTypes?.join(",") || "all"}`
    );
  }

  /**
   * Handle unsubscribe
   */
  private handleUnsubscribe(client: BatchStreamClient): void {
    client.siteIds = undefined;
    client.eventTypes = undefined;
    console.log(`[BatchStreamServer] Client ${client.id} unsubscribed`);
  }

  /**
   * Handle ping
   */
  private handlePing(client: BatchStreamClient): void {
    client.lastPingAt = new Date();
    this.send(client, {
      type: "pong",
      payload: { serverTime: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle pong
   */
  private handlePong(client: BatchStreamClient): void {
    client.lastPingAt = new Date();
  }

  /**
   * Handle close
   */
  private handleClose(
    client: BatchStreamClient,
    code: number,
    reason: string
  ): void {
    this.clients.delete(client.id);
    console.log(
      `[BatchStreamServer] Client disconnected: ${client.id} (code: ${code})`
    );
  }

  /**
   * Handle client error
   */
  private handleClientError(client: BatchStreamClient, error: Error): void {
    console.error(`[BatchStreamServer] Client error (${client.id}):`, error.message);
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    console.error("[BatchStreamServer] Server error:", error.message);
  }

  /**
   * Subscribe to EventService
   */
  private subscribeToEvents(): void {
    const eventService = getEventService();
    this.eventUnsubscribe = eventService.onEvent((event) => {
      this.handleEvent(event);
    });
    console.log("[BatchStreamServer] Subscribed to EventService");
  }

  /**
   * Handle incoming event from EventService
   */
  private handleEvent(event: SignedEvent): void {
    // Convert SignedEvent to BatchEvent format
    const batchEvent: BatchEvent = {
      id: event.hash,
      type: event.eventType,
      timestamp: event.sourceTimestamp,
      siteId: event.siteId,
      payload: {
        ...event.payload,
        assetId: event.assetId,
        originType: event.originType,
        originId: event.originId,
        hash: event.hash,
        signature: event.signature,
        details: event.details,
      },
    };

    // Add to aggregator for batching
    if (this.config.enableBatching) {
      const added = this.aggregator.addEvent(batchEvent);
      if (!added) {
        console.warn(
          "[BatchStreamServer] Event rejected due to backpressure"
        );
      }
    } else {
      // Send immediately to clients that don't want batching
      this.broadcastIndividualEvent(batchEvent);
    }
  }

  /**
   * Broadcast a compressed batch to clients
   */
  private broadcastBatch(batch: CompressedBatch): void {
    for (const client of this.clients.values()) {
      // Check if batch matches client filters
      if (!this.batchMatchesClient(batch, client)) {
        continue;
      }

      if (client.acceptsBatches) {
        // Send compressed batch
        const message: BatchStreamMessage = {
          type: "batch",
          payload: {
            batchId: batch.batchId,
            eventCount: batch.eventCount,
            compressedData: client.acceptsCompression
              ? batch.compressedData
              : undefined,
            originalSize: batch.originalSize,
            compressedSize: batch.compressedSize,
            compressionRatio: batch.compressionRatio,
            siteIds: batch.siteIds,
            eventTypes: batch.eventTypes,
            createdAt: batch.createdAt.toISOString(),
          },
          timestamp: new Date().toISOString(),
        };

        this.send(client, message);
        client.batchesReceived++;
        client.bytesReceived += batch.compressedSize;
        this.totalBatchesSent++;
        this.totalBytesSent += batch.compressedSize;
      } else {
        // Decompress and send individual events
        this.sendDecompressedBatch(client, batch);
      }
    }
  }

  /**
   * Send decompressed batch as individual events
   */
  private async sendDecompressedBatch(
    client: BatchStreamClient,
    batch: CompressedBatch
  ): Promise<void> {
    try {
      const events = await this.aggregator.decompressBatch(batch);
      for (const event of events) {
        if (this.eventMatchesClient(event, client)) {
          this.send(client, {
            type: "event",
            payload: event,
            timestamp: new Date().toISOString(),
          });
          client.eventsReceived++;
          this.totalEventsSent++;
        }
      }
    } catch (error) {
      console.error("[BatchStreamServer] Failed to decompress batch:", error);
    }
  }

  /**
   * Broadcast individual event to clients not using batching
   */
  private broadcastIndividualEvent(event: BatchEvent): void {
    for (const client of this.clients.values()) {
      if (!client.acceptsBatches && this.eventMatchesClient(event, client)) {
        this.send(client, {
          type: "event",
          payload: event,
          timestamp: new Date().toISOString(),
        });
        client.eventsReceived++;
        this.totalEventsSent++;
      }
    }
  }

  /**
   * Check if batch matches client filters
   */
  private batchMatchesClient(
    batch: CompressedBatch,
    client: BatchStreamClient
  ): boolean {
    // Check site filter
    if (client.siteIds && client.siteIds.length > 0) {
      const hasMatchingSite = batch.siteIds.some((s) =>
        client.siteIds!.includes(s)
      );
      if (!hasMatchingSite) return false;
    }

    // Check event type filter
    if (client.eventTypes && client.eventTypes.length > 0) {
      const hasMatchingType = batch.eventTypes.some((t) =>
        client.eventTypes!.includes(t)
      );
      if (!hasMatchingType) return false;
    }

    return true;
  }

  /**
   * Check if event matches client filters
   */
  private eventMatchesClient(
    event: BatchEvent,
    client: BatchStreamClient
  ): boolean {
    // Check site filter
    if (
      client.siteIds &&
      client.siteIds.length > 0 &&
      !client.siteIds.includes(event.siteId)
    ) {
      return false;
    }

    // Check event type filter
    if (
      client.eventTypes &&
      client.eventTypes.length > 0 &&
      !client.eventTypes.includes(event.type)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Send message to client
   */
  private send(client: BatchStreamClient, message: BatchStreamMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const data = JSON.stringify(message);
      client.ws.send(data);
      this.totalBytesSent += Buffer.byteLength(data);
    } catch (error) {
      console.error(`[BatchStreamServer] Failed to send to ${client.id}:`, error);
    }
  }

  /**
   * Send error to client
   */
  private sendError(client: BatchStreamClient, message: string): void {
    this.send(client, {
      type: "error",
      payload: { message },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send metrics to client
   */
  private sendMetrics(client: BatchStreamClient): void {
    this.send(client, {
      type: "metrics",
      payload: this.getMetrics(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.connectionTimeoutMs;

      for (const client of this.clients.values()) {
        const lastActivity = client.lastPingAt.getTime();

        if (now - lastActivity > timeout) {
          console.log(`[BatchStreamServer] Client ${client.id} timed out`);
          client.ws.terminate();
        } else {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping();
          }
        }
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Get client IP
   */
  private getClientIP(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    }
    return req.socket.remoteAddress || "unknown";
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Get current metrics
   */
  getMetrics(): BatchStreamMetrics {
    const aggregatorMetrics = this.aggregator.getMetrics();
    const totalBatches =
      aggregatorMetrics.totalBatchesFlushed +
      aggregatorMetrics.totalBatchesFailed;

    return {
      activeConnections: this.clients.size,
      totalConnections: this.totalConnections,
      totalBatchesSent: this.totalBatchesSent,
      totalEventsSent: this.totalEventsSent,
      totalBytesSent: this.totalBytesSent,
      avgBatchSize:
        totalBatches > 0
          ? aggregatorMetrics.totalEventsProcessed / totalBatches
          : 0,
      avgCompressionRatio: aggregatorMetrics.avgCompressionRatio,
      uptime: Date.now() - this.startedAt.getTime(),
      aggregatorMetrics,
    };
  }

  /**
   * Get Prometheus metrics
   */
  toPrometheusMetrics(): string {
    const metrics = this.getMetrics();
    const labels = 'service="0xscada",component="batch_stream_server"';
    const lines: string[] = [];

    lines.push("# HELP batch_stream_connections_active Active connections");
    lines.push("# TYPE batch_stream_connections_active gauge");
    lines.push(
      `batch_stream_connections_active{${labels}} ${metrics.activeConnections}`
    );

    lines.push("# HELP batch_stream_batches_sent_total Total batches sent");
    lines.push("# TYPE batch_stream_batches_sent_total counter");
    lines.push(
      `batch_stream_batches_sent_total{${labels}} ${metrics.totalBatchesSent}`
    );

    lines.push("# HELP batch_stream_events_sent_total Total events sent");
    lines.push("# TYPE batch_stream_events_sent_total counter");
    lines.push(
      `batch_stream_events_sent_total{${labels}} ${metrics.totalEventsSent}`
    );

    lines.push("# HELP batch_stream_bytes_sent_total Total bytes sent");
    lines.push("# TYPE batch_stream_bytes_sent_total counter");
    lines.push(
      `batch_stream_bytes_sent_total{${labels}} ${metrics.totalBytesSent}`
    );

    // Include aggregator metrics
    lines.push(this.aggregator.toPrometheusMetrics());

    return lines.join("\n");
  }

  /**
   * Get connected clients info
   */
  getClients(): Array<{
    id: string;
    acceptsBatches: boolean;
    acceptsCompression: boolean;
    eventsReceived: number;
    batchesReceived: number;
    bytesReceived: number;
    connectedAt: string;
  }> {
    return Array.from(this.clients.values()).map((client) => ({
      id: client.id,
      acceptsBatches: client.acceptsBatches,
      acceptsCompression: client.acceptsCompression,
      eventsReceived: client.eventsReceived,
      batchesReceived: client.batchesReceived,
      bytesReceived: client.bytesReceived,
      connectedAt: client.connectedAt.toISOString(),
    }));
  }

  /**
   * Force flush aggregator
   */
  async flush(): Promise<void> {
    await this.aggregator.flush();
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    console.log("[BatchStreamServer] Shutting down...");

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Unsubscribe from events
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }

    // Shutdown aggregator (flushes remaining events)
    await this.aggregator.shutdown();

    // Close all clients
    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }

    console.log("[BatchStreamServer] Shutdown complete");
  }
}

// =============================================================================
// SINGLETON & FACTORY
// =============================================================================

let batchStreamServer: BatchStreamServer | null = null;

/**
 * Get or create the batch stream server instance
 */
export function getBatchStreamServer(
  config?: Partial<BatchStreamConfig>
): BatchStreamServer {
  if (!batchStreamServer) {
    batchStreamServer = new BatchStreamServer(config);
  }
  return batchStreamServer;
}

/**
 * Create a new batch stream server instance
 */
export function createBatchStreamServer(
  config?: Partial<BatchStreamConfig>
): BatchStreamServer {
  return new BatchStreamServer(config);
}

/**
 * Reset the batch stream server (for testing)
 */
export async function resetBatchStreamServer(): Promise<void> {
  if (batchStreamServer) {
    await batchStreamServer.shutdown();
    batchStreamServer = null;
  }
}

export default BatchStreamServer;
