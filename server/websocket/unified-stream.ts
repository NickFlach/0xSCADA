/**
 * Unified WebSocket Stream
 *
 * Consolidates the tag-stream (real-time P&ID data) and the event-stream
 * (v2 event subscriptions) into a single WebSocket layer with consistent
 * message schemas and subscription management.
 *
 * Clients connect to /ws and use subscription messages to opt into:
 *   - tag updates  (type: "subscribe:tags")
 *   - events       (type: "subscribe:events")
 *   - alarms       (type: "subscribe:alarms")
 *   - health       (type: "subscribe:health")
 *
 * Closes #255
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';
import { tagStreamServer, type TagUpdate } from './tag-stream.js';
import type { EventFilters, WebSocketMetrics } from './types.js';
import {
  authorizeWebSocketUpgrade,
  rejectWebSocketUpgrade,
  selectOxscadaWebSocketProtocol,
  type AuthenticatedWebSocketRequest,
  type WebSocketAuthOptions,
} from './upgrade-auth.js';

// ── Unified Message Schema ───────────────────────────────────────────────────

export interface UnifiedMessage {
  /** Message type following "namespace:action" convention */
  type: string;
  /** Correlation id for request-response pairs */
  requestId?: string;
  /** Payload varies by type */
  payload?: unknown;
}

export interface UnifiedClient {
  id: string;
  ws: WebSocket;
  subscribedChannels: Set<string>;  // 'tags' | 'events' | 'alarms' | 'health'
  tagFilters: Set<string>;          // empty = all tags
  eventFilters: Partial<EventFilters>;
  connectedAt: Date;
  isAlive: boolean;
  authenticated: boolean;
  messagesSent: number;
  messagesReceived: number;
}

// ── Unified Stream Server ────────────────────────────────────────────────────

export class UnifiedStreamServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, UnifiedClient>();
  private startTime = Date.now();
  private pingInterval?: ReturnType<typeof setInterval>;
  private totalEventsDelivered = 0;
  private httpServer?: HttpServer;
  private upgradeHandler?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;

  /**
   * Attach to an HTTP server and listen on the given path (default /ws).
   * Also wires into the existing TagStreamServer for tag data.
   */
  initialize(
    httpServer: HttpServer,
    path = '/ws',
    auth: WebSocketAuthOptions = { required: false, apiKeys: new Map() },
  ): void {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: selectOxscadaWebSocketProtocol,
    });
    this.httpServer = httpServer;

    this.upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const reqUrl = new URL(request.url || '/', `http://${request.headers.host}`);
      if (reqUrl.pathname !== path) return; // let tag-stream / event-stream handle their own paths

      const decision = authorizeWebSocketUpgrade(
        request as AuthenticatedWebSocketRequest,
        auth,
      );
      if (!decision.ok) {
        rejectWebSocketUpgrade(socket, decision);
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    };
    httpServer.on('upgrade', this.upgradeHandler);

    this.wss.on('connection', (ws: WebSocket, request: AuthenticatedWebSocketRequest) => {
      const clientId = crypto.randomUUID();
      const client: UnifiedClient = {
        id: clientId,
        ws,
        subscribedChannels: new Set(),
        tagFilters: new Set(),
        eventFilters: {},
        connectedAt: new Date(),
        isAlive: true,
        authenticated: !!request.apiKeyRecord,
        messagesSent: 0,
        messagesReceived: 0,
      };
      this.clients.set(clientId, client);

      this.send(client, {
        type: 'connected',
        payload: {
          clientId,
          serverTime: new Date().toISOString(),
          channels: ['tags', 'events', 'alarms', 'health'],
        },
      });

      ws.on('message', (raw) => {
        client.messagesReceived++;
        try {
          const msg = JSON.parse(raw.toString()) as UnifiedMessage;
          this.handleMessage(client, msg);
        } catch {
          this.send(client, { type: 'error', payload: { code: 'INVALID_MESSAGE', message: 'Invalid JSON' } });
        }
      });

      ws.on('pong', () => { client.isAlive = true; });
      ws.on('close', () => { this.clients.delete(clientId); });
    });

    // Keep-alive
    this.pingInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (!client.isAlive) { client.ws.terminate(); this.clients.delete(id); continue; }
        client.isAlive = false;
        client.ws.ping();
      }
    }, 30_000);
  }

  // ── Inbound Message Router ─────────────────────────────────────────────────

  private handleMessage(client: UnifiedClient, msg: UnifiedMessage): void {
    switch (msg.type) {
      case 'subscribe:tags': {
        client.subscribedChannels.add('tags');
        const tags = (msg.payload as any)?.tags;
        if (Array.isArray(tags)) tags.forEach((t: string) => client.tagFilters.add(t));
        // Send current tag snapshot
        const snapshot = tagStreamServer.getLatestValues();
        const entries = Object.fromEntries(snapshot);
        this.send(client, { type: 'tag:snapshot', requestId: msg.requestId, payload: entries });
        break;
      }
      case 'subscribe:events': {
        client.subscribedChannels.add('events');
        const filters = (msg.payload as any)?.filters;
        if (filters) client.eventFilters = filters;
        this.send(client, { type: 'subscribed', requestId: msg.requestId, payload: { channel: 'events' } });
        break;
      }
      case 'subscribe:alarms':
        client.subscribedChannels.add('alarms');
        this.send(client, { type: 'subscribed', requestId: msg.requestId, payload: { channel: 'alarms' } });
        break;
      case 'subscribe:health':
        client.subscribedChannels.add('health');
        this.send(client, { type: 'subscribed', requestId: msg.requestId, payload: { channel: 'health' } });
        break;
      case 'unsubscribe': {
        const channel = (msg.payload as any)?.channel;
        if (channel) {
          client.subscribedChannels.delete(channel);
          if (channel === 'tags') client.tagFilters.clear();
          if (channel === 'events') client.eventFilters = {};
        }
        this.send(client, { type: 'unsubscribed', requestId: msg.requestId, payload: { channel } });
        break;
      }
      case 'ping':
        this.send(client, { type: 'pong', payload: { timestamp: Date.now(), serverTime: new Date().toISOString() } });
        break;
      default:
        this.send(client, { type: 'error', payload: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg.type}` } });
    }
  }

  // ── Broadcast Methods (called by server-side producers) ────────────────────

  /** Broadcast a tag update to unified clients subscribed to tags */
  broadcastTagUpdate(update: TagUpdate): void {
    const message: UnifiedMessage = { type: 'tag:update', payload: update };
    const json = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (!client.subscribedChannels.has('tags')) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.tagFilters.size > 0 && !client.tagFilters.has(update.tagName)) continue;
      client.ws.send(json);
      client.messagesSent++;
      this.totalEventsDelivered++;
    }
  }

  /** Broadcast a domain event to unified clients subscribed to events */
  broadcastEvent(event: Record<string, unknown>): void {
    const message: UnifiedMessage = { type: 'event', payload: event };
    const json = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (!client.subscribedChannels.has('events')) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      // Apply event filters
      if (this.matchesEventFilters(event, client.eventFilters)) {
        client.ws.send(json);
        client.messagesSent++;
        this.totalEventsDelivered++;
      }
    }
  }

  /** Broadcast an alarm to unified clients subscribed to alarms */
  broadcastAlarm(alarm: Record<string, unknown>): void {
    const message: UnifiedMessage = { type: 'alarm:update', payload: alarm };
    const json = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (!client.subscribedChannels.has('alarms')) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      client.ws.send(json);
      client.messagesSent++;
      this.totalEventsDelivered++;
    }
  }

  /** Broadcast health status to unified clients subscribed to health */
  broadcastHealth(health: Record<string, unknown>): void {
    const message: UnifiedMessage = { type: 'pipeline:health', payload: health };
    const json = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (!client.subscribedChannels.has('health')) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      client.ws.send(json);
      client.messagesSent++;
      this.totalEventsDelivered++;
    }
  }

  // ── Metrics / Admin ────────────────────────────────────────────────────────

  getMetrics(): WebSocketMetrics & { unifiedClients: number } {
    const tagMetrics = tagStreamServer.getMetrics();
    return {
      activeConnections: this.clients.size,
      totalConnections: this.clients.size,
      authenticatedConnections: Array.from(this.clients.values())
        .filter((client) => client.authenticated).length,
      totalSubscriptions: Array.from(this.clients.values())
        .reduce((sum, c) => sum + c.subscribedChannels.size, 0),
      totalEventsDelivered: this.totalEventsDelivered,
      messagesReceived: Array.from(this.clients.values()).reduce((s, c) => s + c.messagesReceived, 0),
      messagesSent: Array.from(this.clients.values()).reduce((s, c) => s + c.messagesSent, 0),
      errors: 0,
      uptime: Date.now() - this.startTime,
      startTime: new Date(this.startTime),
      unifiedClients: this.clients.size,
    };
  }

  getConnectedClients(): Array<{
    id: string;
    channels: string[];
    connectedAt: string;
    messagesSent: number;
  }> {
    return Array.from(this.clients.values()).map(c => ({
      id: c.id,
      channels: Array.from(c.subscribedChannels),
      connectedAt: c.connectedAt.toISOString(),
      messagesSent: c.messagesSent,
    }));
  }

  disconnectClient(clientId: string, reason?: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.ws.close(1000, reason);
    this.clients.delete(clientId);
    return true;
  }

  destroy(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off('upgrade', this.upgradeHandler);
    }
    for (const client of this.clients.values()) client.ws.close(1000);
    this.clients.clear();
    this.wss?.close();
    this.httpServer = undefined;
    this.upgradeHandler = undefined;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private send(client: UnifiedClient, msg: UnifiedMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
      client.messagesSent++;
    }
  }

  private matchesEventFilters(
    event: Record<string, unknown>,
    filters: Partial<EventFilters>,
  ): boolean {
    if (!filters || Object.keys(filters).length === 0) return true;
    if (filters.siteIds?.length && !filters.siteIds.includes(event.siteId as string)) return false;
    if (filters.assetIds?.length && !filters.assetIds.includes(event.assetId as string)) return false;
    if (filters.eventTypes?.length && !filters.eventTypes.includes(event.eventType as string)) return false;
    if (filters.severities?.length && !filters.severities.includes(event.severity as string)) return false;
    return true;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const unifiedStreamServer = new UnifiedStreamServer();
export default unifiedStreamServer;
