/**
 * WebSocket Event Stream Server
 * 
 * Issue #10: [Track B2.1] Implement WebSocket Event Stream Server
 * 
 * Implements real-time event streaming via WebSocket with:
 * - Broadcasting new events to all connected clients
 * - Filtering by site/asset/event type
 * - Graceful connection handling
 * - Heartbeat/ping mechanism
 * - Connection metrics logging
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import type { SignedEvent } from "../events";
import { getEventService } from "../events";
import { URL } from "url";

// =============================================================================
// TYPES
// =============================================================================

export interface ClientFilter {
  siteIds?: string[];
  assetIds?: string[];
  eventTypes?: string[];
}

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  filter: ClientFilter;
  connectedAt: Date;
  lastPingAt: Date;
  messagesSent: number;
  isAlive: boolean;
}

export interface ConnectionMetrics {
  totalConnections: number;
  activeConnections: number;
  totalMessagesSent: number;
  totalEventsStreamed: number;
  uptime: number;
}

export interface WebSocketMessage {
  type: "event" | "ping" | "pong" | "subscribe" | "unsubscribe" | "error" | "connected" | "metrics";
  payload?: unknown;
  timestamp: string;
}

// =============================================================================
// EVENT STREAM SERVER
// =============================================================================

export class EventStreamServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private startedAt: Date = new Date();
  
  // Metrics
  private totalMessagesSent = 0;
  private totalEventsStreamed = 0;
  private totalConnectionsEver = 0;

  // Configuration
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  private readonly PING_TIMEOUT_MS = 10000; // 10 seconds
  private readonly METRICS_LOG_INTERVAL_MS = 60000; // 1 minute

  /**
   * Initialize the WebSocket server on the given HTTP server
   */
  initialize(httpServer: HttpServer, path: string = "/ws/events"): void {
    this.wss = new WebSocketServer({ 
      server: httpServer,
      path,
      clientTracking: true,
    });

    console.log(`🔌 WebSocket Event Stream initialized on ${path}`);

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (error) => this.handleServerError(error));

    // Start heartbeat checking
    this.startHeartbeat();
    
    // Start metrics logging
    this.startMetricsLogging();

    // Subscribe to events from EventService
    this.subscribeToEvents();
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = this.generateClientId();
    const filter = this.parseFilterFromUrl(req.url || "");

    const client: ClientConnection = {
      id: clientId,
      ws,
      filter,
      connectedAt: new Date(),
      lastPingAt: new Date(),
      messagesSent: 0,
      isAlive: true,
    };

    this.clients.set(clientId, client);
    this.totalConnectionsEver++;

    console.log(`📡 Client connected: ${clientId} (total: ${this.clients.size})`);
    if (Object.keys(filter).length > 0) {
      console.log(`   Filter: ${JSON.stringify(filter)}`);
    }

    // Send connection confirmation
    this.sendToClient(client, {
      type: "connected",
      payload: {
        clientId,
        filter,
        serverTime: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

    // Set up client event handlers
    ws.on("message", (data) => this.handleClientMessage(client, data));
    ws.on("close", () => this.handleClientDisconnect(client));
    ws.on("error", (error) => this.handleClientError(client, error));
    ws.on("pong", () => this.handlePong(client));
  }

  /**
   * Handle incoming message from client
   */
  private handleClientMessage(client: ClientConnection, data: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;

      switch (message.type) {
        case "subscribe":
          this.handleSubscribe(client, message.payload as ClientFilter);
          break;
        case "unsubscribe":
          this.handleUnsubscribe(client);
          break;
        case "ping":
          this.sendToClient(client, {
            type: "pong",
            timestamp: new Date().toISOString(),
          });
          break;
        case "metrics":
          this.sendMetricsToClient(client);
          break;
        default:
          console.log(`Unknown message type from ${client.id}: ${message.type}`);
      }
    } catch (error) {
      console.error(`Failed to parse message from ${client.id}:`, error);
      this.sendToClient(client, {
        type: "error",
        payload: { message: "Invalid message format" },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Handle subscribe request - update client filter
   */
  private handleSubscribe(client: ClientConnection, filter: ClientFilter): void {
    client.filter = {
      ...client.filter,
      ...filter,
    };
    console.log(`📋 Client ${client.id} updated filter: ${JSON.stringify(client.filter)}`);
    
    this.sendToClient(client, {
      type: "subscribe",
      payload: { filter: client.filter, status: "ok" },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle unsubscribe request - clear client filter
   */
  private handleUnsubscribe(client: ClientConnection): void {
    client.filter = {};
    console.log(`📋 Client ${client.id} cleared filter`);
    
    this.sendToClient(client, {
      type: "unsubscribe",
      payload: { status: "ok" },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle pong response from client
   */
  private handlePong(client: ClientConnection): void {
    client.isAlive = true;
    client.lastPingAt = new Date();
  }

  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(client: ClientConnection): void {
    const duration = Date.now() - client.connectedAt.getTime();
    console.log(`📴 Client disconnected: ${client.id} (duration: ${Math.round(duration / 1000)}s, messages: ${client.messagesSent})`);
    this.clients.delete(client.id);
  }

  /**
   * Handle client error
   */
  private handleClientError(client: ClientConnection, error: Error): void {
    console.error(`❌ Client ${client.id} error:`, error.message);
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    console.error("❌ WebSocket server error:", error);
  }

  /**
   * Subscribe to EventService events
   */
  private subscribeToEvents(): void {
    const eventService = getEventService();
    this.eventUnsubscribe = eventService.onEvent((event) => {
      this.broadcastEvent(event);
    });
    console.log("📢 WebSocket server subscribed to EventService");
  }

  /**
   * Broadcast event to all matching clients
   */
  private broadcastEvent(event: SignedEvent): void {
    const message: WebSocketMessage = {
      type: "event",
      payload: {
        eventType: event.eventType,
        siteId: event.siteId,
        assetId: event.assetId,
        sourceTimestamp: event.sourceTimestamp.toISOString(),
        originType: event.originType,
        originId: event.originId,
        payload: event.payload,
        hash: event.hash,
        details: event.details,
      },
      timestamp: new Date().toISOString(),
    };

    let sentCount = 0;
    for (const client of this.clients.values()) {
      if (this.matchesFilter(event, client.filter)) {
        this.sendToClient(client, message);
        sentCount++;
      }
    }

    if (sentCount > 0) {
      this.totalEventsStreamed++;
    }
  }

  /**
   * Check if event matches client filter
   */
  private matchesFilter(event: SignedEvent, filter: ClientFilter): boolean {
    // No filter = receive all events
    if (!filter.siteIds?.length && !filter.assetIds?.length && !filter.eventTypes?.length) {
      return true;
    }

    // Check site filter
    if (filter.siteIds?.length && !filter.siteIds.includes(event.siteId)) {
      return false;
    }

    // Check asset filter
    if (filter.assetIds?.length && event.assetId && !filter.assetIds.includes(event.assetId)) {
      return false;
    }

    // Check event type filter
    if (filter.eventTypes?.length && !filter.eventTypes.includes(event.eventType)) {
      return false;
    }

    return true;
  }

  /**
   * Send message to specific client
   */
  private sendToClient(client: ClientConnection, message: WebSocketMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(message));
        client.messagesSent++;
        this.totalMessagesSent++;
      } catch (error) {
        console.error(`Failed to send to ${client.id}:`, error);
      }
    }
  }

  /**
   * Send metrics to specific client
   */
  private sendMetricsToClient(client: ClientConnection): void {
    const metrics = this.getMetrics();
    this.sendToClient(client, {
      type: "metrics",
      payload: metrics,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Start heartbeat checking
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          console.log(`💔 Client ${client.id} failed heartbeat, terminating`);
          client.ws.terminate();
          this.clients.delete(client.id);
          continue;
        }

        client.isAlive = false;
        client.ws.ping();
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Start metrics logging
   */
  private startMetricsLogging(): void {
    this.metricsInterval = setInterval(() => {
      const metrics = this.getMetrics();
      console.log(`📊 WebSocket Metrics: ${metrics.activeConnections} active, ${metrics.totalEventsStreamed} events streamed`);
    }, this.METRICS_LOG_INTERVAL_MS);
  }

  /**
   * Get current metrics
   */
  getMetrics(): ConnectionMetrics {
    return {
      totalConnections: this.totalConnectionsEver,
      activeConnections: this.clients.size,
      totalMessagesSent: this.totalMessagesSent,
      totalEventsStreamed: this.totalEventsStreamed,
      uptime: Date.now() - this.startedAt.getTime(),
    };
  }

  /**
   * Get list of connected clients (for debugging/admin)
   */
  getConnectedClients(): Array<{ id: string; filter: ClientFilter; connectedAt: Date; messagesSent: number }> {
    return Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      filter: c.filter,
      connectedAt: c.connectedAt,
      messagesSent: c.messagesSent,
    }));
  }

  /**
   * Parse filter from URL query parameters
   */
  private parseFilterFromUrl(urlString: string): ClientFilter {
    try {
      // Handle relative URLs by adding a base
      const url = new URL(urlString, "http://localhost");
      const filter: ClientFilter = {};

      const siteIds = url.searchParams.getAll("siteId");
      if (siteIds.length) filter.siteIds = siteIds;

      const assetIds = url.searchParams.getAll("assetId");
      if (assetIds.length) filter.assetIds = assetIds;

      const eventTypes = url.searchParams.getAll("eventType");
      if (eventTypes.length) filter.eventTypes = eventTypes;

      return filter;
    } catch {
      return {};
    }
  }

  /**
   * Generate unique client ID
   */
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Shutdown the server
   */
  shutdown(): void {
    console.log("🛑 Shutting down WebSocket Event Stream...");

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }

    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    console.log("✅ WebSocket Event Stream shutdown complete");
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const eventStreamServer = new EventStreamServer();
