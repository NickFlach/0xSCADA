/**
 * useWebSocket Hook
 * 
 * Issue #9: [Track A2.1] Build Real-Time Event Stream Component
 * 
 * Custom hook for WebSocket connection management with:
 * - Automatic reconnection
 * - Connection status tracking
 * - Message handling
 * - Heartbeat/ping support
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  buildWebSocketProtocols,
  useApiCredential,
} from "../lib/api-credential";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WebSocketMessage {
  type: string;
  payload?: unknown;
  timestamp: string;
}

export interface UseWebSocketOptions {
  url: string;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  /** Optional application protocols; defaults to the tab-scoped API key protocol. */
  protocols?: string[];
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
  lastMessage: WebSocketMessage | null;
  send: (message: WebSocketMessage | object) => void;
  connect: () => void;
  disconnect: () => void;
  reconnectAttempts: number;
}

export function useWebSocket({
  url,
  onMessage,
  onConnect,
  onDisconnect,
  onError,
  reconnect = true,
  reconnectInterval = 3000,
  maxReconnectAttempts = 10,
  heartbeatInterval = 25000,
  protocols,
}: UseWebSocketOptions): UseWebSocketReturn {
  const { apiKey } = useApiCredential();
  const effectiveProtocols = useMemo(
    () => protocols ?? buildWebSocketProtocols(apiKey),
    [protocols, apiKey],
  );
  const protocolSignature = effectiveProtocols.join(",");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    heartbeatIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
      }
    }, heartbeatInterval);
  }, [heartbeatInterval]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    clearTimers();
    setStatus("connecting");

    try {
      wsRef.current = new WebSocket(
        url,
        effectiveProtocols.length > 0 ? effectiveProtocols : undefined,
      );

      wsRef.current.onopen = () => {
        if (!mountedRef.current) return;
        setStatus("connected");
        setReconnectAttempts(0);
        startHeartbeat();
        onConnect?.();
      };

      wsRef.current.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          setLastMessage(message);
          onMessage?.(message);
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      };

      wsRef.current.onclose = () => {
        if (!mountedRef.current) return;
        setStatus("disconnected");
        clearTimers();
        onDisconnect?.();

        // Attempt reconnection if enabled
        if (reconnect && reconnectAttempts < maxReconnectAttempts) {
          reconnectTimeoutRef.current = setTimeout(() => {
            if (mountedRef.current) {
              setReconnectAttempts((prev) => prev + 1);
              connect();
            }
          }, reconnectInterval);
        }
      };

      wsRef.current.onerror = (error) => {
        if (!mountedRef.current) return;
        setStatus("error");
        onError?.(error);
      };
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      setStatus("error");
    }
  }, [
    url,
    onMessage,
    onConnect,
    onDisconnect,
    onError,
    reconnect,
    reconnectInterval,
    maxReconnectAttempts,
    reconnectAttempts,
    clearTimers,
    startHeartbeat,
    protocolSignature,
  ]);

  const disconnect = useCallback(() => {
    clearTimers();
    if (wsRef.current) {
      wsRef.current.close(1000, "Client disconnected");
      wsRef.current = null;
    }
    setStatus("disconnected");
    setReconnectAttempts(0);
  }, [clearTimers]);

  const send = useCallback((message: WebSocketMessage | object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn("WebSocket is not connected");
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [url, protocolSignature]); // Reconnect if URL or tab credential changes

  return {
    status,
    lastMessage,
    send,
    connect,
    disconnect,
    reconnectAttempts,
  };
}

export default useWebSocket;
