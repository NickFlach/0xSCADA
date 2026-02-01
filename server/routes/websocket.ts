/**
 * WebSocket REST API Routes
 * 
 * Issue #43: WebSocket / Event Streaming API
 * 
 * REST endpoints for WebSocket server metrics and management.
 */

import { Router } from "express";
import { getWebSocketServer } from "../websocket";

export const websocketRoutes = Router();

/**
 * GET /api/ws/metrics
 * Get WebSocket server metrics
 */
websocketRoutes.get("/metrics", (req, res) => {
  try {
    const wsServer = getWebSocketServer();
    const metrics = wsServer.getMetrics();
    
    res.json({
      success: true,
      metrics: {
        connections: {
          active: metrics.activeConnections,
          total: metrics.totalConnections,
          authenticated: metrics.authenticatedConnections,
        },
        subscriptions: {
          total: metrics.totalSubscriptions,
        },
        messages: {
          received: metrics.messagesReceived,
          sent: metrics.messagesSent,
          eventsDelivered: metrics.totalEventsDelivered,
        },
        errors: metrics.errors,
        uptime: metrics.uptime,
        startTime: metrics.startTime.toISOString(),
      },
    });
  } catch (error) {
    console.error("Error fetching WebSocket metrics:", error);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

/**
 * GET /api/ws/clients
 * Get connected WebSocket clients
 */
websocketRoutes.get("/clients", (req, res) => {
  try {
    const wsServer = getWebSocketServer();
    const clients = wsServer.getClients();
    
    res.json({
      success: true,
      count: clients.length,
      clients,
    });
  } catch (error) {
    console.error("Error fetching WebSocket clients:", error);
    res.status(500).json({ error: "Failed to fetch clients" });
  }
});

/**
 * DELETE /api/ws/clients/:clientId
 * Disconnect a specific WebSocket client
 */
websocketRoutes.delete("/clients/:clientId", (req, res) => {
  try {
    const { clientId } = req.params;
    const reason = (req.query.reason as string) || "Disconnected by administrator";
    
    const wsServer = getWebSocketServer();
    const success = wsServer.disconnectClient(clientId, reason);
    
    if (success) {
      res.json({ success: true, message: `Client ${clientId} disconnected` });
    } else {
      res.status(404).json({ error: "Client not found" });
    }
  } catch (error) {
    console.error("Error disconnecting WebSocket client:", error);
    res.status(500).json({ error: "Failed to disconnect client" });
  }
});

/**
 * GET /api/ws/health
 * WebSocket server health check
 */
websocketRoutes.get("/health", (req, res) => {
  try {
    const wsServer = getWebSocketServer();
    const metrics = wsServer.getMetrics();
    
    res.json({
      status: "healthy",
      uptime: metrics.uptime,
      connections: metrics.activeConnections,
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
