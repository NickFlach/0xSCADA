/**
 * WebSocket Event Stream Server Tests
 * 
 * Issue #10: [Track B2.1] Implement WebSocket Event Stream Server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import WebSocket from "ws";
import { EventStreamServer, type WebSocketMessage, type ClientFilter } from "../websocket/event-stream";

// Mock the events module
vi.mock("../events", () => {
  const callbacks: ((event: any) => void)[] = [];
  return {
    getEventService: () => ({
      onEvent: (cb: (event: any) => void) => {
        callbacks.push(cb);
        return () => {
          const idx = callbacks.indexOf(cb);
          if (idx > -1) callbacks.splice(idx, 1);
        };
      },
    }),
    // Expose for testing
    __triggerEvent: (event: any) => {
      callbacks.forEach((cb) => cb(event));
    },
    __getCallbackCount: () => callbacks.length,
  };
});

// Helper to wait for WebSocket to be ready
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

// Helper to receive a message
function waitForMessage(ws: WebSocket, timeout = 5000): Promise<WebSocketMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("EventStreamServer", () => {
  let httpServer: HttpServer;
  let eventStreamServer: EventStreamServer;
  let serverUrl: string;

  beforeEach(async () => {
    // Create HTTP server
    httpServer = createServer();
    
    // Create new EventStreamServer instance
    eventStreamServer = new EventStreamServer();
    eventStreamServer.initialize(httpServer, "/ws/events");

    // Start server on random port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as { port: number };
        serverUrl = `ws://127.0.0.1:${addr.port}/ws/events`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    eventStreamServer.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  describe("Connection Handling", () => {
    it("should accept WebSocket connections", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("should send connected message on connection", async () => {
      const ws = new WebSocket(serverUrl);
      const message = await waitForMessage(ws);

      expect(message.type).toBe("connected");
      expect(message.payload).toHaveProperty("clientId");
      expect(message.payload).toHaveProperty("serverTime");
      ws.close();
    });

    it("should track connected clients", async () => {
      const ws1 = new WebSocket(serverUrl);
      const ws2 = new WebSocket(serverUrl);

      await waitForOpen(ws1);
      await waitForOpen(ws2);

      // Wait for connected messages
      await waitForMessage(ws1);
      await waitForMessage(ws2);

      const clients = eventStreamServer.getConnectedClients();
      expect(clients.length).toBe(2);

      ws1.close();
      ws2.close();
    });

    it("should handle client disconnection gracefully", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws);

      expect(eventStreamServer.getConnectedClients().length).toBe(1);

      ws.close();

      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 100));

      expect(eventStreamServer.getConnectedClients().length).toBe(0);
    });
  });

  describe("Filtering", () => {
    it("should parse filters from URL query parameters", async () => {
      const ws = new WebSocket(`${serverUrl}?siteId=site1&eventType=TELEMETRY`);
      const message = await waitForMessage(ws);

      expect(message.type).toBe("connected");
      expect((message.payload as any).filter).toEqual({
        siteIds: ["site1"],
        eventTypes: ["TELEMETRY"],
      });

      ws.close();
    });

    it("should update filter via subscribe message", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws); // connected message

      ws.send(
        JSON.stringify({
          type: "subscribe",
          payload: { siteIds: ["site2"], eventTypes: ["ALARM"] },
        })
      );

      const response = await waitForMessage(ws);
      expect(response.type).toBe("subscribe");
      expect((response.payload as any).filter).toEqual({
        siteIds: ["site2"],
        eventTypes: ["ALARM"],
      });

      ws.close();
    });

    it("should clear filter via unsubscribe message", async () => {
      const ws = new WebSocket(`${serverUrl}?siteId=site1`);
      await waitForOpen(ws);
      await waitForMessage(ws); // connected message

      ws.send(JSON.stringify({ type: "unsubscribe" }));

      const response = await waitForMessage(ws);
      expect(response.type).toBe("unsubscribe");
      expect((response.payload as any).status).toBe("ok");

      ws.close();
    });
  });

  describe("Ping/Pong", () => {
    it("should respond to ping messages", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws); // connected message

      ws.send(JSON.stringify({ type: "ping" }));

      const response = await waitForMessage(ws);
      expect(response.type).toBe("pong");
      expect(response.timestamp).toBeDefined();

      ws.close();
    });
  });

  describe("Metrics", () => {
    it("should provide metrics on request", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws); // connected message

      ws.send(JSON.stringify({ type: "metrics" }));

      const response = await waitForMessage(ws);
      expect(response.type).toBe("metrics");
      expect(response.payload).toHaveProperty("totalConnections");
      expect(response.payload).toHaveProperty("activeConnections");
      expect(response.payload).toHaveProperty("totalMessagesSent");
      expect(response.payload).toHaveProperty("totalEventsStreamed");
      expect(response.payload).toHaveProperty("uptime");

      ws.close();
    });

    it("should return correct metrics via getMetrics()", async () => {
      const ws1 = new WebSocket(serverUrl);
      const ws2 = new WebSocket(serverUrl);

      await waitForOpen(ws1);
      await waitForOpen(ws2);
      await waitForMessage(ws1);
      await waitForMessage(ws2);

      const metrics = eventStreamServer.getMetrics();
      
      expect(metrics.activeConnections).toBe(2);
      expect(metrics.totalConnections).toBe(2);
      expect(metrics.uptime).toBeGreaterThan(0);

      ws1.close();
      ws2.close();
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid JSON gracefully", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws); // connected message

      ws.send("not valid json");

      const response = await waitForMessage(ws);
      expect(response.type).toBe("error");
      expect((response.payload as any).message).toBe("Invalid message format");

      ws.close();
    });
  });

  describe("Shutdown", () => {
    it("should close all connections on shutdown", async () => {
      const ws = new WebSocket(serverUrl);
      await waitForOpen(ws);
      await waitForMessage(ws);

      let closeReceived = false;
      ws.on("close", () => {
        closeReceived = true;
      });

      eventStreamServer.shutdown();

      // Wait for close to propagate
      await new Promise((r) => setTimeout(r, 100));

      expect(closeReceived).toBe(true);
    });
  });
});

describe("Event Broadcasting", () => {
  let httpServer: HttpServer;
  let eventStreamServer: EventStreamServer;
  let serverUrl: string;

  beforeEach(async () => {
    httpServer = createServer();
    eventStreamServer = new EventStreamServer();
    eventStreamServer.initialize(httpServer, "/ws/events");

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as { port: number };
        serverUrl = `ws://127.0.0.1:${addr.port}/ws/events`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    eventStreamServer.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("should broadcast events to all connected clients without filters", async () => {
    const { __triggerEvent } = await import("../events");

    const ws1 = new WebSocket(serverUrl);
    const ws2 = new WebSocket(serverUrl);

    await waitForOpen(ws1);
    await waitForOpen(ws2);
    await waitForMessage(ws1); // connected
    await waitForMessage(ws2); // connected

    // Trigger an event
    const testEvent = {
      eventType: "TELEMETRY",
      siteId: "site1",
      assetId: "asset1",
      sourceTimestamp: new Date(),
      originType: "GATEWAY",
      originId: "gw1",
      payload: { tag: "temp", value: 25 },
      hash: "abc123",
      details: "temp = 25",
    };

    (__triggerEvent as any)(testEvent);

    // Both clients should receive the event
    const msg1 = await waitForMessage(ws1);
    const msg2 = await waitForMessage(ws2);

    expect(msg1.type).toBe("event");
    expect(msg2.type).toBe("event");
    expect((msg1.payload as any).eventType).toBe("TELEMETRY");
    expect((msg2.payload as any).siteId).toBe("site1");

    ws1.close();
    ws2.close();
  });

  it("should filter events based on client subscription", async () => {
    const { __triggerEvent } = await import("../events");

    const ws1 = new WebSocket(`${serverUrl}?siteId=site1`);
    const ws2 = new WebSocket(`${serverUrl}?siteId=site2`);

    await waitForOpen(ws1);
    await waitForOpen(ws2);
    await waitForMessage(ws1); // connected
    await waitForMessage(ws2); // connected

    // Trigger event for site1
    const testEvent = {
      eventType: "TELEMETRY",
      siteId: "site1",
      assetId: "asset1",
      sourceTimestamp: new Date(),
      originType: "GATEWAY",
      originId: "gw1",
      payload: { tag: "temp", value: 25 },
      hash: "abc123",
      details: "temp = 25",
    };

    (__triggerEvent as any)(testEvent);

    // Only ws1 should receive (subscribed to site1)
    const msg1 = await waitForMessage(ws1, 1000);
    expect(msg1.type).toBe("event");

    // ws2 should not receive (subscribed to site2)
    await expect(waitForMessage(ws2, 500)).rejects.toThrow("Timeout");

    ws1.close();
    ws2.close();
  });

  it("should filter events by event type", async () => {
    const { __triggerEvent } = await import("../events");

    const ws = new WebSocket(`${serverUrl}?eventType=ALARM`);
    await waitForOpen(ws);
    await waitForMessage(ws); // connected

    // Trigger TELEMETRY event (should not match)
    (__triggerEvent as any)({
      eventType: "TELEMETRY",
      siteId: "site1",
      sourceTimestamp: new Date(),
      originType: "GATEWAY",
      originId: "gw1",
      payload: {},
      hash: "abc",
    });

    // Should not receive TELEMETRY
    await expect(waitForMessage(ws, 300)).rejects.toThrow("Timeout");

    // Trigger ALARM event (should match)
    (__triggerEvent as any)({
      eventType: "ALARM",
      siteId: "site1",
      sourceTimestamp: new Date(),
      originType: "GATEWAY",
      originId: "gw1",
      payload: {},
      hash: "def",
    });

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe("event");
    expect((msg.payload as any).eventType).toBe("ALARM");

    ws.close();
  });
});
