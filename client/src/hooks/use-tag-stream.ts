/**
 * [12.4] Real-Time Tag Stream Hook
 * 
 * Connects to /ws/tags WebSocket for live gateway tag data.
 * Used by P&ID renderer and live dashboard to display real-time values.
 * 
 * Closes #206
 */

import { useEffect, useRef, useState, useCallback } from "react";

export interface TagValue {
  tagName: string;
  value: number | string | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: string;
}

export interface AlarmEvent {
  id: string;
  name: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  state: "active" | "acknowledged" | "cleared";
  tagValue?: number;
  triggeredAt: string;
}

export interface PipelineHealth {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  eventsProcessed: number;
  eventsDropped: number;
  backpressureActive: boolean;
}

export interface UseTagStreamOptions {
  /** Specific tags to subscribe to (empty = all) */
  tags?: string[];
  /** Auto-connect on mount */
  autoConnect?: boolean;
}

export interface UseTagStreamReturn {
  connected: boolean;
  tagValues: Map<string, TagValue>;
  alarms: AlarmEvent[];
  health: PipelineHealth | null;
  recentEvents: TagValue[];
  subscribe: (tags: string[]) => void;
  unsubscribe: (tags: string[]) => void;
  requestSnapshot: () => void;
}

export function useTagStream(options: UseTagStreamOptions = {}): UseTagStreamReturn {
  const { tags: initialTags, autoConnect = true } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [tagValues, setTagValues] = useState<Map<string, TagValue>>(new Map());
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [recentEvents, setRecentEvents] = useState<TagValue[]>([]);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);

  const getWsUrl = useCallback(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/tags`;
  }, []);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((tags: string[]) => {
    send({ type: "subscribe", tags });
  }, [send]);

  const unsubscribe = useCallback((tags: string[]) => {
    send({ type: "unsubscribe", tags });
  }, [send]);

  const requestSnapshot = useCallback(() => {
    send({ type: "snapshot" });
  }, [send]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);

      // Subscribe to initial tags if specified
      if (initialTags?.length) {
        send({ type: "subscribe", tags: initialTags });
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Auto-reconnect
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onmessage = (msg) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(msg.data);
        switch (data.event) {
          case "tag:update":
            setTagValues((prev) => {
              const next = new Map(prev);
              next.set(data.payload.tagName, data.payload);
              return next;
            });
            setRecentEvents((prev) => [data.payload, ...prev].slice(0, 100));
            break;

          case "tag:batch":
            if (Array.isArray(data.payload)) {
              setTagValues((prev) => {
                const next = new Map(prev);
                for (const u of data.payload) next.set(u.tagName, u);
                return next;
              });
            }
            break;

          case "tag:snapshot":
            if (data.payload && typeof data.payload === "object") {
              const map = new Map<string, TagValue>();
              for (const [key, val] of Object.entries(data.payload)) {
                map.set(key, val as TagValue);
              }
              setTagValues(map);
            }
            break;

          case "alarm:update":
            setAlarms((prev) => {
              const filtered = prev.filter((a) => a.id !== data.payload.id);
              return [data.payload, ...filtered].slice(0, 200);
            });
            break;

          case "pipeline:health":
            setHealth(data.payload);
            break;
        }
      } catch { /* ignore parse errors */ }
    };
  }, [getWsUrl, initialTags, send]);

  useEffect(() => {
    mountedRef.current = true;
    if (autoConnect) connect();

    return () => {
      mountedRef.current = false;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close(1000);
    };
  }, [connect, autoConnect]);

  return {
    connected,
    tagValues,
    alarms,
    health,
    recentEvents,
    subscribe,
    unsubscribe,
    requestSnapshot,
  };
}

export default useTagStream;
