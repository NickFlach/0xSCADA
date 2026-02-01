/**
 * useEventStream Hook
 * 
 * Issue #9: [Track A2.1] Build Real-Time Event Stream Component
 * 
 * Custom hook for subscribing to the WebSocket event stream with:
 * - Event filtering
 * - Event history management
 * - Connection status
 */

import { useState, useCallback, useMemo } from "react";
import { useWebSocket, type ConnectionStatus, type WebSocketMessage } from "./use-websocket";

// =============================================================================
// TYPES
// =============================================================================

export interface StreamEvent {
  id: string;
  eventType: string;
  siteId: string;
  assetId?: string;
  sourceTimestamp: string;
  receivedAt: string;
  originType: string;
  originId: string;
  payload: Record<string, unknown>;
  hash: string;
  details?: string;
}

export interface EventFilter {
  siteIds?: string[];
  assetIds?: string[];
  eventTypes?: string[];
}

export interface UseEventStreamOptions {
  /** Maximum number of events to keep in memory */
  maxEvents?: number;
  /** Initial filter to apply */
  filter?: EventFilter;
  /** Enable auto-reconnect */
  reconnect?: boolean;
  /** Callback when a new event is received */
  onEvent?: (event: StreamEvent) => void;
}

export interface UseEventStreamReturn {
  /** Array of received events (newest first) */
  events: StreamEvent[];
  /** Current connection status */
  status: ConnectionStatus;
  /** Number of reconnection attempts */
  reconnectAttempts: number;
  /** Current filter */
  filter: EventFilter;
  /** Update the filter */
  setFilter: (filter: EventFilter) => void;
  /** Clear all events */
  clearEvents: () => void;
  /** Manually connect */
  connect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
  /** Connection metrics from server */
  metrics: StreamMetrics | null;
  /** Request metrics from server */
  requestMetrics: () => void;
}

export interface StreamMetrics {
  totalConnections: number;
  activeConnections: number;
  totalMessagesSent: number;
  totalEventsStreamed: number;
  uptime: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function buildWebSocketUrl(filter: EventFilter): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const baseUrl = `${protocol}//${host}/ws/events`;

  const params = new URLSearchParams();
  filter.siteIds?.forEach((id) => params.append("siteId", id));
  filter.assetIds?.forEach((id) => params.append("assetId", id));
  filter.eventTypes?.forEach((type) => params.append("eventType", type));

  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// =============================================================================
// HOOK
// =============================================================================

export function useEventStream({
  maxEvents = 1000,
  filter: initialFilter = {},
  reconnect = true,
  onEvent,
}: UseEventStreamOptions = {}): UseEventStreamReturn {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [filter, setFilterState] = useState<EventFilter>(initialFilter);
  const [metrics, setMetrics] = useState<StreamMetrics | null>(null);

  // Build WebSocket URL based on filter
  const wsUrl = useMemo(() => buildWebSocketUrl(filter), [filter]);

  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case "event": {
          const eventPayload = message.payload as Partial<StreamEvent>;
          const newEvent: StreamEvent = {
            id: generateEventId(),
            eventType: eventPayload.eventType || "UNKNOWN",
            siteId: eventPayload.siteId || "",
            assetId: eventPayload.assetId,
            sourceTimestamp: eventPayload.sourceTimestamp || message.timestamp,
            receivedAt: new Date().toISOString(),
            originType: eventPayload.originType || "UNKNOWN",
            originId: eventPayload.originId || "",
            payload: eventPayload.payload || {},
            hash: eventPayload.hash || "",
            details: eventPayload.details,
          };

          setEvents((prev) => {
            const updated = [newEvent, ...prev];
            return updated.slice(0, maxEvents);
          });

          onEvent?.(newEvent);
          break;
        }

        case "metrics": {
          setMetrics(message.payload as StreamMetrics);
          break;
        }

        case "connected": {
          console.log("Connected to event stream:", message.payload);
          break;
        }

        case "subscribe": {
          console.log("Subscription updated:", message.payload);
          break;
        }

        case "pong": {
          // Heartbeat acknowledged
          break;
        }

        default:
          console.log("Unknown message type:", message.type);
      }
    },
    [maxEvents, onEvent]
  );

  const { status, send, connect, disconnect, reconnectAttempts } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
    reconnect,
    onConnect: () => {
      console.log("Event stream connected");
    },
    onDisconnect: () => {
      console.log("Event stream disconnected");
    },
  });

  const setFilter = useCallback((newFilter: EventFilter) => {
    setFilterState(newFilter);
    // The wsUrl will update, causing a reconnect with new filter
    // Or we can send a subscribe message if already connected
    if (status === "connected") {
      send({
        type: "subscribe",
        payload: newFilter,
        timestamp: new Date().toISOString(),
      });
    }
  }, [status, send]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const requestMetrics = useCallback(() => {
    send({
      type: "metrics",
      timestamp: new Date().toISOString(),
    });
  }, [send]);

  return {
    events,
    status,
    reconnectAttempts,
    filter,
    setFilter,
    clearEvents,
    connect,
    disconnect,
    metrics,
    requestMetrics,
  };
}

export default useEventStream;
