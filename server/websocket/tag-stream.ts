/**
 * [12.4] Real-Time Tag Data WebSocket Stream
 * 
 * Bridges gateway tag data to WebSocket clients for P&ID and dashboard rendering.
 * Subscribes to the field simulator and broadcasts tag updates, alarms, and
 * pipeline health to connected clients.
 * 
 * Closes #206
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { URL } from "url";
import {
  authorizeWebSocketUpgrade,
  rejectWebSocketUpgrade,
  selectOxscadaWebSocketProtocol,
  type AuthenticatedWebSocketRequest,
  type WebSocketAuthOptions,
} from "./upgrade-auth";

// --- Types ---

export interface TagUpdate {
  tagName: string;
  value: number | string | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: string;
}

export interface TagStreamClient {
  id: string;
  ws: WebSocket;
  subscribedTags: Set<string>; // empty = subscribe all
  connectedAt: Date;
  isAlive: boolean;
  messagesSent: number;
}

export interface TagStreamMetrics {
  activeClients: number;
  totalTagUpdates: number;
  uniqueTags: number;
  uptime: number;
}

// --- Tag Stream Server ---

export class TagStreamServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, TagStreamClient>();
  private latestValues = new Map<string, TagUpdate>();
  private totalUpdates = 0;
  private startTime = Date.now();
  private pingInterval?: ReturnType<typeof setInterval>;
  private httpServer?: HttpServer;
  private upgradeHandler?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  private updateListeners: Array<(update: TagUpdate) => void> = [];

  /**
   * Register a server-side listener for every tag update flowing through the
   * stream (e.g. predictive maintenance ingestion). Listener errors are
   * swallowed so a consumer can never break broadcasting.
   */
  onTagUpdate(listener: (update: TagUpdate) => void): void {
    this.updateListeners.push(listener);
  }

  private notifyListeners(update: TagUpdate): void {
    for (const listener of this.updateListeners) {
      try {
        listener(update);
      } catch { /* consumer error — never disrupt broadcasting */ }
    }
  }

  initialize(
    httpServer: HttpServer,
    path = "/ws/tags",
    auth: WebSocketAuthOptions = { required: false, apiKeys: new Map() },
  ): void {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: selectOxscadaWebSocketProtocol,
    });
    this.httpServer = httpServer;

    this.upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const reqUrl = new URL(request.url || "/", `http://${request.headers.host}`);
      if (reqUrl.pathname !== path) return; // let other WSS handle

      const decision = authorizeWebSocketUpgrade(
        request as AuthenticatedWebSocketRequest,
        auth,
      );
      if (!decision.ok) {
        rejectWebSocketUpgrade(socket, decision);
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit("connection", ws, request);
      });
    };
    httpServer.on("upgrade", this.upgradeHandler);

    this.wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const clientId = crypto.randomUUID();
      const client: TagStreamClient = {
        id: clientId,
        ws,
        subscribedTags: new Set(),
        connectedAt: new Date(),
        isAlive: true,
        messagesSent: 0,
      };
      this.clients.set(clientId, client);

      // Send current snapshot
      this.sendSnapshot(client);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleClientMessage(client, msg);
        } catch { /* ignore bad messages */ }
      });

      ws.on("pong", () => { client.isAlive = true; });

      ws.on("close", () => {
        this.clients.delete(clientId);
      });

      // Welcome message
      this.sendToClient(client, {
        event: "connected",
        payload: { clientId, tagCount: this.latestValues.size },
      });
    });

    // Ping/pong for keepalive
    this.pingInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (!client.isAlive) {
          client.ws.terminate();
          this.clients.delete(id);
          continue;
        }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 30000);
  }

  /** Broadcast a tag update from the gateway/simulator */
  broadcastTagUpdate(update: TagUpdate): void {
    this.latestValues.set(update.tagName, update);
    this.totalUpdates++;
    this.notifyListeners(update);

    const message = JSON.stringify({ event: "tag:update", payload: update });

    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      // If client has tag subscriptions, filter
      if (client.subscribedTags.size > 0 && !client.subscribedTags.has(update.tagName)) {
        continue;
      }

      client.ws.send(message);
      client.messagesSent++;
    }
  }

  /** Broadcast alarm event */
  broadcastAlarm(alarm: {
    id: string;
    name: string;
    severity: string;
    state: string;
    tagValue?: number;
    triggeredAt: string;
  }): void {
    const message = JSON.stringify({ event: "alarm:update", payload: alarm });
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        client.messagesSent++;
      }
    }
  }

  /** Broadcast pipeline health */
  broadcastHealth(health: {
    status: string;
    uptime: number;
    eventsProcessed: number;
    eventsDropped: number;
    backpressureActive: boolean;
  }): void {
    const message = JSON.stringify({ event: "pipeline:health", payload: health });
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
        client.messagesSent++;
      }
    }
  }

  /** Broadcast batch of tag updates (efficient for high-frequency data) */
  broadcastBatch(updates: TagUpdate[]): void {
    for (const u of updates) {
      this.latestValues.set(u.tagName, u);
      this.notifyListeners(u);
    }
    this.totalUpdates += updates.length;

    const message = JSON.stringify({ event: "tag:batch", payload: updates });
    for (const client of this.clients.values()) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      client.ws.send(message);
      client.messagesSent++;
    }
  }

  /** Send current snapshot of all tags to a client */
  private sendSnapshot(client: TagStreamClient): void {
    const snapshot = Object.fromEntries(this.latestValues);
    this.sendToClient(client, { event: "tag:snapshot", payload: snapshot });
  }

  /** Handle client messages (subscribe/unsubscribe) */
  private handleClientMessage(client: TagStreamClient, msg: any): void {
    switch (msg.type) {
      case "subscribe":
        if (Array.isArray(msg.tags)) {
          for (const tag of msg.tags) client.subscribedTags.add(tag);
        }
        // Send current values for subscribed tags
        for (const tag of client.subscribedTags) {
          const val = this.latestValues.get(tag);
          if (val) this.sendToClient(client, { event: "tag:update", payload: val });
        }
        break;
      case "unsubscribe":
        if (Array.isArray(msg.tags)) {
          for (const tag of msg.tags) client.subscribedTags.delete(tag);
        }
        break;
      case "snapshot":
        this.sendSnapshot(client);
        break;
      case "ping":
        this.sendToClient(client, { event: "pong", payload: { timestamp: new Date().toISOString() } });
        break;
    }
  }

  private sendToClient(client: TagStreamClient, data: object): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
      client.messagesSent++;
    }
  }

  getMetrics(): TagStreamMetrics {
    return {
      activeClients: this.clients.size,
      totalTagUpdates: this.totalUpdates,
      uniqueTags: this.latestValues.size,
      uptime: Date.now() - this.startTime,
    };
  }

  getLatestValues(): Map<string, TagUpdate> {
    return new Map(this.latestValues);
  }

  destroy(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off("upgrade", this.upgradeHandler);
    }
    for (const client of this.clients.values()) {
      client.ws.close(1000);
    }
    this.clients.clear();
    this.wss?.close();
    this.httpServer = undefined;
    this.upgradeHandler = undefined;
  }
}

/** Singleton instance */
export const tagStreamServer = new TagStreamServer();
export default tagStreamServer;
