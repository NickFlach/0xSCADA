/**
 * P&ID Data Binding — Real-time tag data via WebSocket
 *
 * Provides a React context that connects P&ID symbols to live SCADA tag data.
 */

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { PIDTagValue, PIDDataSnapshot, AlarmState } from '@shared/types/pid';

// =============================================================================
// TYPES
// =============================================================================

interface PIDDataContextValue {
  /** Current tag values keyed by tagId */
  values: Record<string, PIDTagValue>;
  /** Subscribe to specific tags */
  subscribe: (tagIds: string[]) => void;
  /** Unsubscribe from tags */
  unsubscribe: (tagIds: string[]) => void;
  /** Connection status */
  connected: boolean;
  /** Last update timestamp */
  lastUpdate: string | null;
}

// =============================================================================
// CONTEXT
// =============================================================================

const PIDDataContext = createContext<PIDDataContextValue>({
  values: {},
  subscribe: () => {},
  unsubscribe: () => {},
  connected: false,
  lastUpdate: null,
});

export const usePIDData = () => useContext(PIDDataContext);

/**
 * Hook to get a specific tag's current value
 */
export function useTagValue(tagId: string | undefined): PIDTagValue | undefined {
  const { values } = usePIDData();
  return tagId ? values[tagId] : undefined;
}

/**
 * Hook to get alarm state for a tag
 */
export function useTagAlarm(tagId: string | undefined): AlarmState {
  const tag = useTagValue(tagId);
  return tag?.alarmState ?? 'normal';
}

// =============================================================================
// PROVIDER
// =============================================================================

interface PIDDataProviderProps {
  /** WebSocket URL (defaults to ws://localhost:5000/ws/tags) */
  wsUrl?: string;
  /** Diagram ID for scoped subscriptions */
  diagramId?: string;
  children: React.ReactNode;
}

export const PIDDataProvider: React.FC<PIDDataProviderProps> = ({
  wsUrl,
  diagramId,
  children,
}) => {
  const [values, setValues] = useState<Record<string, PIDTagValue>>({});
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedTags = useRef<Set<string>>(new Set());

  const getWsUrl = useCallback(() => {
    if (wsUrl) return wsUrl;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/tags`;
  }, [wsUrl]);

  useEffect(() => {
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Re-subscribe to any tags
      if (subscribedTags.current.size > 0) {
        ws.send(JSON.stringify({
          type: 'subscribe',
          tags: Array.from(subscribedTags.current),
          diagramId,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'tag-values' || msg.type === 'tag-update') {
          const snapshot = msg.data as PIDDataSnapshot;
          setValues(prev => ({ ...prev, ...snapshot.values }));
          setLastUpdate(snapshot.timestamp);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [getWsUrl, diagramId]);

  const subscribe = useCallback((tagIds: string[]) => {
    tagIds.forEach(t => subscribedTags.current.add(t));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', tags: tagIds, diagramId }));
    }
  }, [diagramId]);

  const unsubscribe = useCallback((tagIds: string[]) => {
    tagIds.forEach(t => subscribedTags.current.delete(t));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', tags: tagIds }));
    }
  }, []);

  return (
    <PIDDataContext.Provider value={{ values, subscribe, unsubscribe, connected, lastUpdate }}>
      {children}
    </PIDDataContext.Provider>
  );
};

export default PIDDataProvider;
