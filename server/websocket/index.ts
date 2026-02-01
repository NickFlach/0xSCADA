/**
 * WebSocket Event Streaming Server
 * 
 * Issue #43: WebSocket / Event Streaming API
 * 
 * Real-time event subscription and streaming with:
 * - JWT authentication
 * - Event filtering
 * - Backpressure handling
 * - Reconnection support
 * - Metrics and monitoring
 */

import { WebSocket, WebSocketServer } from "ws";
import { createHash, randomBytes } from "crypto";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import { URL } from "url";

import { getEventService, type SignedEvent } from "../events";
import { getSecurityService } from "../security";
import {
  type WebSocketClient,
  type Subscription,
  type EventFilters,
  type ClientMessage,
  type ServerMessage,
  type SerializedEvent,
  type WebSocketMetrics,
  type WebSocketServerConfig,
  type ErrorCode,
  DEFAULT_CONFIG,
  ERROR_MESSAGES,
} from "./types";

// =============================================================================
// WEBSOCKET EVENT SERVER
// =============================================================================

export class WebSocketEventServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WebSocketClient> = new Map();
  private clientsByUser: Map<string, Set<string>> = new Map();
  private config: WebSocketServerConfig;
  private metrics: WebSocketMetrics;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private eventUnsubscribe: (() => void) | null = null;
  private eventBuffer: Map<string, SignedEvent[]> = new Map(); // For backpressure

  constructor(config: Partial<WebSocketServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      activeConnections: 0,
      totalConnections: 0,
      authenticatedConnections: 0,
      totalSubscriptions: 0,
      totalEventsDelivered: 0,
      messagesReceived: 0,
      messagesSent: 0,
      errors: 0,
      uptime: 0,
      startTime: new Date(),
    };
  }

  /**
   * Attach WebSocket server to HTTP server
   */
  attach(server: Server, path: string = "/ws/events"): void {
    this.wss = new WebSocketServer({ 
      server,
      path,
      maxPayload: this.config.maxMessageSize,
    });

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (error) => this.handleServerError(error));

    // Start heartbeat interval
    this.startHeartbeat();

    // Subscribe to events from EventService
    const eventService = getEventService();
    this.eventUnsubscribe = eventService.onEvent((event) => {
      this.broadcastEvent(event);
    });

    console.log(`🔌 WebSocket server attached at ${path}`);
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connectionId = this.generateId("conn");
    
    // Parse query parameters for initial filters and token
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || undefined;
    const clientId = url.searchParams.get("clientId") || undefined;
    
    // Parse filters from query params
    const filters = this.parseFiltersFromQuery(url.searchParams);

    // Create client record
    const client: WebSocketClient = {
      id: connectionId,
      ws,
      authenticated: false,
      subscriptions: new Map(),
      connectedAt: new Date(),
      lastPingAt: new Date(),
      eventsReceived: 0,
      sequence: 0,
      clientInfo: {
        ip: this.getClientIP(req),
        userAgent: req.headers["user-agent"],
        clientId,
      },
    };

    this.clients.set(connectionId, client);
    this.metrics.activeConnections++;
    this.metrics.totalConnections++;

    // Authenticate if token provided
    if (token) {
      this.authenticateClient(client, token);
    } else if (this.config.requireAuth) {
      this.sendError(client, "AUTHENTICATION_REQUIRED");
      ws.close(4001, "Authentication required");
      return;
    }

    // Send connected message
    this.send(client, {
      type: "connected",
      connectionId,
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
    });

    // Auto-subscribe if filters provided in query
    if (filters && Object.keys(filters).length > 0) {
      this.handleSubscribe(client, { type: "subscribe", filters });
    }

    // Setup event handlers
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", (code, reason) => this.handleClose(client, code, reason.toString()));
    ws.on("error", (error) => this.handleClientError(client, error));
    ws.on("pong", () => this.handlePong(client));

    console.log(`🔗 Client connected: ${connectionId} (${client.clientInfo.ip})`);
  }

  /**
   * Handle incoming message from client
   */
  private handleMessage(client: WebSocketClient, data: Buffer | ArrayBuffer | Buffer[]): void {
    this.metrics.messagesReceived++;

    let message: ClientMessage;
    try {
      const text = data.toString();
      message = JSON.parse(text);
    } catch {
      this.sendError(client, "INVALID_MESSAGE", "Failed to parse message as JSON");
      return;
    }

    switch (message.type) {
      case "subscribe":
        this.handleSubscribe(client, message);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(client, message);
        break;
      case "ping":
        this.handlePing(client, message);
        break;
      default:
        this.sendError(client, "INVALID_MESSAGE", `Unknown message type: ${(message as any).type}`);
    }
  }

  /**
   * Handle subscribe request
   */
  private handleSubscribe(
    client: WebSocketClient, 
    message: { type: "subscribe"; filters?: EventFilters; requestId?: string }
  ): void {
    // Check subscription limit
    if (client.subscriptions.size >= this.config.maxSubscriptionsPerClient) {
      this.sendError(client, "SUBSCRIPTION_LIMIT", undefined, message.requestId);
      return;
    }

    // Validate filters
    if (message.filters) {
      const validation = this.validateFilters(message.filters);
      if (!validation.valid) {
        this.sendError(client, "INVALID_FILTER", validation.error, message.requestId);
        return;
      }
    }

    const subscriptionId = this.generateId("sub");
    const subscription: Subscription = {
      id: subscriptionId,
      filters: message.filters || {},
      createdAt: new Date(),
      eventsMatched: 0,
    };

    client.subscriptions.set(subscriptionId, subscription);
    this.metrics.totalSubscriptions++;

    this.send(client, {
      type: "subscribed",
      subscriptionId,
      filters: subscription.filters,
      requestId: message.requestId,
    });

    console.log(`📡 Client ${client.id} subscribed: ${subscriptionId}`);
  }

  /**
   * Handle unsubscribe request
   */
  private handleUnsubscribe(
    client: WebSocketClient,
    message: { type: "unsubscribe"; subscriptionId?: string; requestId?: string }
  ): void {
    if (message.subscriptionId) {
      // Unsubscribe specific subscription
      if (client.subscriptions.delete(message.subscriptionId)) {
        this.metrics.totalSubscriptions--;
      }
    } else {
      // Unsubscribe all
      this.metrics.totalSubscriptions -= client.subscriptions.size;
      client.subscriptions.clear();
    }

    this.send(client, {
      type: "unsubscribed",
      subscriptionId: message.subscriptionId,
      requestId: message.requestId,
    });
  }

  /**
   * Handle ping message
   */
  private handlePing(
    client: WebSocketClient,
    message: { type: "ping"; timestamp?: number }
  ): void {
    client.lastPingAt = new Date();
    this.send(client, {
      type: "pong",
      timestamp: message.timestamp || Date.now(),
      serverTime: new Date().toISOString(),
    });
  }

  /**
   * Handle pong response
   */
  private handlePong(client: WebSocketClient): void {
    client.lastPingAt = new Date();
  }

  /**
   * Handle client disconnect
   */
  private handleClose(client: WebSocketClient, code: number, reason: string): void {
    this.removeClient(client);
    console.log(`🔌 Client disconnected: ${client.id} (code: ${code}, reason: ${reason})`);
  }

  /**
   * Handle client error
   */
  private handleClientError(client: WebSocketClient, error: Error): void {
    this.metrics.errors++;
    console.error(`❌ Client error (${client.id}):`, error.message);
  }

  /**
   * Handle server error
   */
  private handleServerError(error: Error): void {
    this.metrics.errors++;
    console.error("❌ WebSocket server error:", error.message);
  }

  /**
   * Remove client and cleanup
   */
  private removeClient(client: WebSocketClient): void {
    this.clients.delete(client.id);
    this.metrics.activeConnections--;
    this.metrics.totalSubscriptions -= client.subscriptions.size;

    // Remove from user tracking
    if (client.userId) {
      const userClients = this.clientsByUser.get(client.userId);
      if (userClients) {
        userClients.delete(client.id);
        if (userClients.size === 0) {
          this.clientsByUser.delete(client.userId);
        }
      }
      this.metrics.authenticatedConnections--;
    }

    // Clear any backpressure buffer
    this.eventBuffer.delete(client.id);
  }

  /**
   * Broadcast event to all matching subscriptions
   */
  private broadcastEvent(event: SignedEvent): void {
    const serialized = this.serializeEvent(event);

    for (const client of this.clients.values()) {
      this.deliverEventToClient(client, serialized);
    }
  }

  /**
   * Deliver event to a specific client if it matches their subscriptions
   */
  private deliverEventToClient(client: WebSocketClient, event: SerializedEvent): void {
    for (const [subscriptionId, subscription] of client.subscriptions) {
      if (this.eventMatchesFilters(event, subscription.filters)) {
        subscription.eventsMatched++;
        client.eventsReceived++;
        client.sequence++;

        // Check for backpressure
        if (this.config.enableBackpressure && this.isClientBackpressured(client)) {
          this.bufferEvent(client.id, event, subscriptionId);
          return;
        }

        this.send(client, {
          type: "event",
          subscriptionId,
          event,
          sequence: client.sequence,
        });

        this.metrics.totalEventsDelivered++;
      }
    }
  }

  /**
   * Check if event matches subscription filters
   */
  private eventMatchesFilters(event: SerializedEvent, filters: EventFilters): boolean {
    // Empty filters match everything
    if (!filters || Object.keys(filters).length === 0) {
      return true;
    }

    // Check site filter
    if (filters.siteIds && filters.siteIds.length > 0) {
      if (!filters.siteIds.includes(event.siteId)) {
        return false;
      }
    }

    // Check asset filter
    if (filters.assetIds && filters.assetIds.length > 0) {
      if (!event.assetId || !filters.assetIds.includes(event.assetId)) {
        return false;
      }
    }

    // Check event type filter
    if (filters.eventTypes && filters.eventTypes.length > 0) {
      if (!filters.eventTypes.includes(event.eventType)) {
        return false;
      }
    }

    // Check origin type filter
    if (filters.originTypes && filters.originTypes.length > 0) {
      if (!filters.originTypes.includes(event.originType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Serialize SignedEvent for transmission
   */
  private serializeEvent(event: SignedEvent): SerializedEvent {
    return {
      eventType: event.eventType,
      siteId: event.siteId,
      assetId: event.assetId,
      sourceTimestamp: event.sourceTimestamp.toISOString(),
      originType: event.originType,
      originId: event.originId,
      payload: event.payload,
      hash: event.hash,
      signature: event.signature,
      details: event.details,
    };
  }

  /**
   * Send message to client
   */
  private send(client: WebSocketClient, message: ServerMessage): void {
    if (client.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      client.ws.send(JSON.stringify(message));
      this.metrics.messagesSent++;
    } catch (error) {
      this.metrics.errors++;
      console.error(`Failed to send message to ${client.id}:`, error);
    }
  }

  /**
   * Send error message to client
   */
  private sendError(
    client: WebSocketClient, 
    code: ErrorCode, 
    details?: string,
    requestId?: string
  ): void {
    this.send(client, {
      type: "error",
      code,
      message: details || ERROR_MESSAGES[code],
      requestId,
    });
    this.metrics.errors++;
  }

  /**
   * Authenticate client with JWT token
   */
  private async authenticateClient(client: WebSocketClient, token: string): Promise<boolean> {
    try {
      const securityService = getSecurityService();
      const session = securityService.sessions.validateToken(token);

      if (!session) {
        this.sendError(client, "AUTHENTICATION_FAILED");
        return false;
      }

      // Check user connection limit
      const userClients = this.clientsByUser.get(session.userId) || new Set();
      if (userClients.size >= this.config.maxConnectionsPerUser) {
        this.sendError(client, "RATE_LIMIT", "Maximum connections per user exceeded");
        return false;
      }

      // Update client
      client.userId = session.userId;
      client.authenticated = true;

      // Track user connections
      userClients.add(client.id);
      this.clientsByUser.set(session.userId, userClients);
      this.metrics.authenticatedConnections++;

      return true;
    } catch (error) {
      this.sendError(client, "AUTHENTICATION_FAILED");
      return false;
    }
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.connectionTimeoutMs;

      for (const client of this.clients.values()) {
        const lastActivity = client.lastPingAt.getTime();
        
        if (now - lastActivity > timeout) {
          // Connection timed out
          console.log(`⏰ Client ${client.id} timed out`);
          client.ws.terminate();
        } else {
          // Send ping
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.ping();
          }
        }

        // Flush any buffered events
        this.flushEventBuffer(client.id);
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Check if client is experiencing backpressure
   */
  private isClientBackpressured(client: WebSocketClient): boolean {
    const ws = client.ws as WebSocket;
    return ws.bufferedAmount > this.config.maxMessageSize * 10;
  }

  /**
   * Buffer event for backpressured client
   */
  private bufferEvent(clientId: string, event: SerializedEvent, subscriptionId: string): void {
    let buffer = this.eventBuffer.get(clientId);
    if (!buffer) {
      buffer = [];
      this.eventBuffer.set(clientId, buffer);
    }

    // @ts-ignore - adding metadata
    event._subscriptionId = subscriptionId;
    buffer.push(event as any);

    // Trim buffer if too large
    if (buffer.length > this.config.backpressureBufferSize) {
      buffer.shift();
    }
  }

  /**
   * Flush buffered events for client
   */
  private flushEventBuffer(clientId: string): void {
    const client = this.clients.get(clientId);
    const buffer = this.eventBuffer.get(clientId);
    
    if (!client || !buffer || buffer.length === 0) return;
    if (this.isClientBackpressured(client)) return;

    // Send buffered events
    while (buffer.length > 0 && !this.isClientBackpressured(client)) {
      const event = buffer.shift()!;
      // @ts-ignore
      const subscriptionId = event._subscriptionId;
      // @ts-ignore
      delete event._subscriptionId;

      client.sequence++;
      this.send(client, {
        type: "event",
        subscriptionId,
        event,
        sequence: client.sequence,
      });
      this.metrics.totalEventsDelivered++;
    }

    if (buffer.length === 0) {
      this.eventBuffer.delete(clientId);
    }
  }

  /**
   * Validate event filters
   */
  private validateFilters(filters: EventFilters): { valid: boolean; error?: string } {
    // Validate site IDs format
    if (filters.siteIds) {
      if (!Array.isArray(filters.siteIds)) {
        return { valid: false, error: "siteIds must be an array" };
      }
    }

    // Validate asset IDs format
    if (filters.assetIds) {
      if (!Array.isArray(filters.assetIds)) {
        return { valid: false, error: "assetIds must be an array" };
      }
    }

    // Validate event types
    if (filters.eventTypes) {
      if (!Array.isArray(filters.eventTypes)) {
        return { valid: false, error: "eventTypes must be an array" };
      }
    }

    return { valid: true };
  }

  /**
   * Parse filters from URL query parameters
   */
  private parseFiltersFromQuery(params: URLSearchParams): EventFilters {
    const filters: EventFilters = {};

    const siteIds = params.getAll("siteId");
    if (siteIds.length > 0) filters.siteIds = siteIds;

    const assetIds = params.getAll("assetId");
    if (assetIds.length > 0) filters.assetIds = assetIds;

    const eventTypes = params.getAll("eventType");
    if (eventTypes.length > 0) filters.eventTypes = eventTypes;

    const originTypes = params.getAll("originType");
    if (originTypes.length > 0) filters.originTypes = originTypes;

    return filters;
  }

  /**
   * Get client IP address
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
  getMetrics(): WebSocketMetrics {
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.startTime.getTime(),
    };
  }

  /**
   * Get connected clients info
   */
  getClients(): Array<{
    id: string;
    authenticated: boolean;
    userId?: string;
    subscriptionCount: number;
    eventsReceived: number;
    connectedAt: string;
    ip?: string;
  }> {
    return Array.from(this.clients.values()).map((client) => ({
      id: client.id,
      authenticated: client.authenticated,
      userId: client.userId,
      subscriptionCount: client.subscriptions.size,
      eventsReceived: client.eventsReceived,
      connectedAt: client.connectedAt.toISOString(),
      ip: client.clientInfo.ip,
    }));
  }

  /**
   * Broadcast a custom message to all clients
   */
  broadcast(message: ServerMessage): void {
    for (const client of this.clients.values()) {
      this.send(client, message);
    }
  }

  /**
   * Disconnect a specific client
   */
  disconnectClient(clientId: string, reason: string = "Disconnected by server"): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    this.send(client, {
      type: "error",
      code: "CONNECTION_CLOSING",
      message: reason,
    });

    client.ws.close(1000, reason);
    return true;
  }

  /**
   * Close the WebSocket server
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stopHeartbeat();

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
        this.wss.close(() => {
          console.log("🔌 WebSocket server closed");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let wsServerInstance: WebSocketEventServer | null = null;

export function getWebSocketServer(): WebSocketEventServer {
  if (!wsServerInstance) {
    wsServerInstance = new WebSocketEventServer();
  }
  return wsServerInstance;
}

export function initWebSocketServer(config?: Partial<WebSocketServerConfig>): WebSocketEventServer {
  wsServerInstance = new WebSocketEventServer(config);
  return wsServerInstance;
}

// Re-export types
export * from "./types";
