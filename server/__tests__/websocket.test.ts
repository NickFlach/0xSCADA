/**
 * WebSocket Event Streaming API Tests
 * 
 * Issue #43: WebSocket / Event Streaming API
 * 
 * Test coverage:
 * - Connection lifecycle
 * - Authentication
 * - Event subscription/filtering
 * - Message types
 * - Reconnection handling
 * - Error handling
 * - Metrics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "http";
import WebSocket from "ws";

import { WebSocketEventServer, type WebSocketServerConfig } from "../websocket";
import type { 
  ClientMessage, 
  ServerMessage, 
  ConnectedMessage,
  SubscribedMessage,
  EventMessage,
  ErrorMessage,
  PongMessage,
} from "../websocket/types";

// =============================================================================
// MOCKS
// =============================================================================

// Mock EventService
const mockEventCallbacks: Array<(event: any) => void> = [];
vi.mock("../events", () => ({
  getEventService: () => ({
    onEvent: (callback: (event: any) => void) => {
      mockEventCallbacks.push(callback);
      return () => {
        const index = mockEventCallbacks.indexOf(callback);
        if (index > -1) mockEventCallbacks.splice(index, 1);
      };
    },
  }),
}));

// Mock SecurityService
vi.mock("../security", () => ({
  getSecurityService: () => ({
    sessions: {
      validateToken: (token: string) => {
        if (token === "valid-token") {
          return { userId: "user-001" };
        }
        if (token === "admin-token") {
          return { userId: "admin-001" };
        }
        return null;
      },
    },
  }),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createTestServer(config?: Partial<WebSocketServerConfig>): {
  server: Server;
  wsServer: WebSocketEventServer;
  port: number;
} {
  const server = createServer();
  const wsServer = new WebSocketEventServer({
    requireAuth: false,
    heartbeatIntervalMs: 30000,
    connectionTimeoutMs: 60000,
    ...config,
  });
  
  wsServer.attach(server, "/ws/events");
  
  // Find an available port
  server.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  
  return { server, wsServer, port };
}

function connectClient(port: number, query: string = ""): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${port}/ws/events${query}`;
    const ws = new WebSocket(url);
    
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage<T extends ServerMessage>(ws: WebSocket, type?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Message timeout")), 5000);
    
    const handler = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (!type || message.type === type) {
        clearTimeout(timeout);
        ws.off("message", handler);
        resolve(message as T);
      }
    };
    
    ws.on("message", handler);
  });
}

function sendMessage(ws: WebSocket, message: ClientMessage): void {
  ws.send(JSON.stringify(message));
}

function emitTestEvent(event: any = {}): void {
  const testEvent = {
    eventType: "TELEMETRY",
    siteId: "site-001",
    assetId: "asset-001",
    sourceTimestamp: new Date(),
    originType: "GATEWAY",
    originId: "gateway-001",
    payload: { temperature: 75.5 },
    hash: "testhash123",
    signature: "testsig456",
    ...event,
  };
  
  for (const callback of mockEventCallbacks) {
    callback(testEvent);
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe("WebSocket Event Streaming Server", () => {
  let testServer: Server;
  let wsServer: WebSocketEventServer;
  let port: number;

  beforeEach(() => {
    mockEventCallbacks.length = 0;
    const setup = createTestServer();
    testServer = setup.server;
    wsServer = setup.wsServer;
    port = setup.port;
  });

  afterEach(async () => {
    await wsServer.close();
    testServer.close();
  });

  // ===========================================================================
  // CONNECTION LIFECYCLE
  // ===========================================================================

  describe("Connection Lifecycle", () => {
    it("should accept new connections and send connected message", async () => {
      const ws = await connectClient(port);
      
      const message = await waitForMessage<ConnectedMessage>(ws, "connected");
      
      expect(message.type).toBe("connected");
      expect(message.connectionId).toMatch(/^conn_/);
      expect(message.serverTime).toBeDefined();
      expect(message.heartbeatIntervalMs).toBe(30000);
      
      ws.close();
    });

    it("should track active connections in metrics", async () => {
      const ws1 = await connectClient(port);
      await waitForMessage(ws1, "connected");
      
      let metrics = wsServer.getMetrics();
      expect(metrics.activeConnections).toBe(1);
      expect(metrics.totalConnections).toBe(1);
      
      const ws2 = await connectClient(port);
      await waitForMessage(ws2, "connected");
      
      metrics = wsServer.getMetrics();
      expect(metrics.activeConnections).toBe(2);
      expect(metrics.totalConnections).toBe(2);
      
      ws1.close();
      ws2.close();
    });

    it("should handle client disconnect gracefully", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      expect(wsServer.getMetrics().activeConnections).toBe(1);
      
      ws.close();
      
      // Wait for close to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));
      
      expect(wsServer.getMetrics().activeConnections).toBe(0);
    });
  });

  // ===========================================================================
  // AUTHENTICATION
  // ===========================================================================

  describe("Authentication", () => {
    it("should authenticate with valid token", async () => {
      const ws = await connectClient(port, "?token=valid-token");
      
      const message = await waitForMessage<ConnectedMessage>(ws, "connected");
      expect(message.type).toBe("connected");
      
      const clients = wsServer.getClients();
      expect(clients[0].authenticated).toBe(true);
      expect(clients[0].userId).toBe("user-001");
      
      ws.close();
    });

    it("should reject invalid token with error", async () => {
      const ws = await connectClient(port, "?token=invalid-token");
      
      // Should still connect but get error
      await waitForMessage(ws, "connected");
      const error = await waitForMessage<ErrorMessage>(ws, "error");
      
      expect(error.type).toBe("error");
      expect(error.code).toBe("AUTHENTICATION_FAILED");
      
      ws.close();
    });

    it("should require auth when configured", async () => {
      await wsServer.close();
      testServer.close();
      
      const setup = createTestServer({ requireAuth: true });
      testServer = setup.server;
      wsServer = setup.wsServer;
      port = setup.port;
      
      // Connection without token should be rejected
      const ws = new WebSocket(`ws://localhost:${port}/ws/events`);
      
      await new Promise<void>((resolve) => {
        ws.on("close", (code) => {
          expect(code).toBe(4001);
          resolve();
        });
      });
    });
  });

  // ===========================================================================
  // SUBSCRIPTION
  // ===========================================================================

  describe("Subscription", () => {
    it("should create subscription and respond with subscribed message", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { siteIds: ["site-001"] },
        requestId: "req-001",
      });
      
      const response = await waitForMessage<SubscribedMessage>(ws, "subscribed");
      
      expect(response.type).toBe("subscribed");
      expect(response.subscriptionId).toMatch(/^sub_/);
      expect(response.filters.siteIds).toEqual(["site-001"]);
      expect(response.requestId).toBe("req-001");
      
      ws.close();
    });

    it("should subscribe to all events with empty filters", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, { type: "subscribe" });
      
      const response = await waitForMessage<SubscribedMessage>(ws, "subscribed");
      expect(response.filters).toEqual({});
      
      ws.close();
    });

    it("should unsubscribe from specific subscription", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, { type: "subscribe" });
      const subResponse = await waitForMessage<SubscribedMessage>(ws, "subscribed");
      
      sendMessage(ws, {
        type: "unsubscribe",
        subscriptionId: subResponse.subscriptionId,
        requestId: "unsub-001",
      });
      
      const unsubResponse = await waitForMessage(ws, "unsubscribed");
      expect(unsubResponse.subscriptionId).toBe(subResponse.subscriptionId);
      expect(unsubResponse.requestId).toBe("unsub-001");
      
      ws.close();
    });

    it("should reject subscription beyond limit", async () => {
      await wsServer.close();
      testServer.close();
      
      const setup = createTestServer({ maxSubscriptionsPerClient: 2 });
      testServer = setup.server;
      wsServer = setup.wsServer;
      port = setup.port;
      
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      // Create 2 subscriptions (at limit)
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      // Third should fail
      sendMessage(ws, { type: "subscribe", requestId: "third" });
      const error = await waitForMessage<ErrorMessage>(ws, "error");
      
      expect(error.code).toBe("SUBSCRIPTION_LIMIT");
      expect(error.requestId).toBe("third");
      
      ws.close();
    });

    it("should auto-subscribe with query params", async () => {
      const ws = await connectClient(port, "?siteId=site-001&eventType=ALARM");
      
      await waitForMessage(ws, "connected");
      const subResponse = await waitForMessage<SubscribedMessage>(ws, "subscribed");
      
      expect(subResponse.filters.siteIds).toEqual(["site-001"]);
      expect(subResponse.filters.eventTypes).toEqual(["ALARM"]);
      
      ws.close();
    });
  });

  // ===========================================================================
  // EVENT STREAMING
  // ===========================================================================

  describe("Event Streaming", () => {
    it("should deliver events matching subscription filters", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { siteIds: ["site-001"] },
      });
      await waitForMessage(ws, "subscribed");
      
      // Emit matching event
      emitTestEvent({ siteId: "site-001" });
      
      const eventMessage = await waitForMessage<EventMessage>(ws, "event");
      
      expect(eventMessage.type).toBe("event");
      expect(eventMessage.event.siteId).toBe("site-001");
      expect(eventMessage.sequence).toBe(1);
      
      ws.close();
    });

    it("should not deliver events that don't match filters", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { siteIds: ["site-001"] },
      });
      await waitForMessage(ws, "subscribed");
      
      // Emit non-matching event
      emitTestEvent({ siteId: "site-002" });
      
      // Should not receive event - use timeout
      const eventPromise = waitForMessage(ws, "event");
      const timeoutPromise = new Promise((resolve) => 
        setTimeout(() => resolve("timeout"), 200)
      );
      
      const result = await Promise.race([eventPromise, timeoutPromise]);
      expect(result).toBe("timeout");
      
      ws.close();
    });

    it("should filter by event type", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { eventTypes: ["ALARM"] },
      });
      await waitForMessage(ws, "subscribed");
      
      // Emit TELEMETRY (should not match)
      emitTestEvent({ eventType: "TELEMETRY" });
      
      // Emit ALARM (should match)
      emitTestEvent({ eventType: "ALARM" });
      
      const eventMessage = await waitForMessage<EventMessage>(ws, "event");
      expect(eventMessage.event.eventType).toBe("ALARM");
      
      ws.close();
    });

    it("should filter by asset ID", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { assetIds: ["asset-001"] },
      });
      await waitForMessage(ws, "subscribed");
      
      emitTestEvent({ assetId: "asset-001" });
      
      const eventMessage = await waitForMessage<EventMessage>(ws, "event");
      expect(eventMessage.event.assetId).toBe("asset-001");
      
      ws.close();
    });

    it("should increment sequence numbers", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      emitTestEvent();
      const event1 = await waitForMessage<EventMessage>(ws, "event");
      expect(event1.sequence).toBe(1);
      
      emitTestEvent();
      const event2 = await waitForMessage<EventMessage>(ws, "event");
      expect(event2.sequence).toBe(2);
      
      emitTestEvent();
      const event3 = await waitForMessage<EventMessage>(ws, "event");
      expect(event3.sequence).toBe(3);
      
      ws.close();
    });
  });

  // ===========================================================================
  // PING/PONG
  // ===========================================================================

  describe("Heartbeat", () => {
    it("should respond to ping with pong", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "ping",
        timestamp: Date.now(),
      });
      
      const pong = await waitForMessage<PongMessage>(ws, "pong");
      
      expect(pong.type).toBe("pong");
      expect(pong.timestamp).toBeDefined();
      expect(pong.serverTime).toBeDefined();
      
      ws.close();
    });
  });

  // ===========================================================================
  // ERROR HANDLING
  // ===========================================================================

  describe("Error Handling", () => {
    it("should handle invalid JSON messages", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      ws.send("invalid json {{{");
      
      const error = await waitForMessage<ErrorMessage>(ws, "error");
      expect(error.code).toBe("INVALID_MESSAGE");
      
      ws.close();
    });

    it("should handle unknown message types", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      ws.send(JSON.stringify({ type: "unknown_type" }));
      
      const error = await waitForMessage<ErrorMessage>(ws, "error");
      expect(error.code).toBe("INVALID_MESSAGE");
      expect(error.message).toContain("unknown_type");
      
      ws.close();
    });

    it("should validate filter format", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, {
        type: "subscribe",
        filters: { siteIds: "not-an-array" as any },
        requestId: "bad-filter",
      });
      
      const error = await waitForMessage<ErrorMessage>(ws, "error");
      expect(error.code).toBe("INVALID_FILTER");
      expect(error.requestId).toBe("bad-filter");
      
      ws.close();
    });
  });

  // ===========================================================================
  // METRICS
  // ===========================================================================

  describe("Metrics", () => {
    it("should track message counts", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      const initialMetrics = wsServer.getMetrics();
      expect(initialMetrics.messagesSent).toBeGreaterThan(0); // connected message
      
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      sendMessage(ws, { type: "ping" });
      await waitForMessage(ws, "pong");
      
      const finalMetrics = wsServer.getMetrics();
      expect(finalMetrics.messagesReceived).toBeGreaterThanOrEqual(2);
      expect(finalMetrics.messagesSent).toBeGreaterThan(initialMetrics.messagesSent);
      
      ws.close();
    });

    it("should track events delivered", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      const beforeMetrics = wsServer.getMetrics();
      
      emitTestEvent();
      await waitForMessage(ws, "event");
      
      emitTestEvent();
      await waitForMessage(ws, "event");
      
      const afterMetrics = wsServer.getMetrics();
      expect(afterMetrics.totalEventsDelivered).toBe(beforeMetrics.totalEventsDelivered + 2);
      
      ws.close();
    });

    it("should track subscription count", async () => {
      const ws = await connectClient(port);
      await waitForMessage(ws, "connected");
      
      expect(wsServer.getMetrics().totalSubscriptions).toBe(0);
      
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      expect(wsServer.getMetrics().totalSubscriptions).toBe(1);
      
      sendMessage(ws, { type: "subscribe" });
      await waitForMessage(ws, "subscribed");
      
      expect(wsServer.getMetrics().totalSubscriptions).toBe(2);
      
      ws.close();
    });
  });

  // ===========================================================================
  // CLIENT MANAGEMENT
  // ===========================================================================

  describe("Client Management", () => {
    it("should list connected clients", async () => {
      const ws1 = await connectClient(port, "?token=valid-token&clientId=client-1");
      await waitForMessage(ws1, "connected");
      
      const ws2 = await connectClient(port, "?clientId=client-2");
      await waitForMessage(ws2, "connected");
      
      const clients = wsServer.getClients();
      expect(clients.length).toBe(2);
      
      const authClient = clients.find(c => c.authenticated);
      expect(authClient).toBeDefined();
      expect(authClient?.userId).toBe("user-001");
      
      ws1.close();
      ws2.close();
    });

    it("should disconnect client by ID", async () => {
      const ws = await connectClient(port);
      const connected = await waitForMessage<ConnectedMessage>(ws, "connected");
      
      const disconnected = wsServer.disconnectClient(connected.connectionId, "Test disconnect");
      expect(disconnected).toBe(true);
      
      // Wait for close
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
      });
      
      expect(wsServer.getMetrics().activeConnections).toBe(0);
    });

    it("should return false when disconnecting non-existent client", () => {
      const result = wsServer.disconnectClient("non-existent-id");
      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // SERVER SHUTDOWN
  // ===========================================================================

  describe("Server Shutdown", () => {
    it("should close all connections on shutdown", async () => {
      const ws1 = await connectClient(port);
      await waitForMessage(ws1, "connected");
      
      const ws2 = await connectClient(port);
      await waitForMessage(ws2, "connected");
      
      expect(wsServer.getMetrics().activeConnections).toBe(2);
      
      const closePromises = [
        new Promise<void>((resolve) => ws1.on("close", () => resolve())),
        new Promise<void>((resolve) => ws2.on("close", () => resolve())),
      ];
      
      await wsServer.close();
      
      await Promise.all(closePromises);
    });
  });
});
