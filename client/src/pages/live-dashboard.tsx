/**
 * [12.4] Real-Time Dashboard
 * 
 * Live dashboard connecting to WebSocket for tag data, alarm status,
 * gateway health, and recent events.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';

// --- Types ---

interface TagValue {
  tagName: string;
  value: number | string | boolean;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: string;
}

interface AlarmEvent {
  id: string;
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  state: 'active' | 'acknowledged' | 'cleared';
  tagValue?: number;
  triggeredAt: string;
}

interface PipelineHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  eventsProcessed: number;
  eventsDropped: number;
  backpressureActive: boolean;
}

interface GatewayStatus {
  connected: boolean;
  tagCount: number;
  lastUpdate: string;
}

// --- Hooks ---

function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [tags, setTags] = useState<Map<string, TagValue>>(new Map());
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [events, setEvents] = useState<TagValue[]>([]);

  const connect = useCallback(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 3000); // Auto-reconnect
    };

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        switch (data.event) {
          case 'tag:update':
            setTags((prev) => {
              const next = new Map(prev);
              next.set(data.payload.tagName, data.payload);
              return next;
            });
            setEvents((prev) => [data.payload, ...prev].slice(0, 50));
            break;
          case 'alarm:update':
            setAlarms((prev) => {
              const filtered = prev.filter((a) => a.id !== data.payload.id);
              return [data.payload, ...filtered].slice(0, 100);
            });
            break;
          case 'pipeline:health':
            setHealth(data.payload);
            break;
        }
      } catch { /* ignore parse errors */ }
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  return { connected, tags, alarms, health, events };
}

// --- Components ---

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = {
    healthy: '#22c55e', good: '#22c55e', connected: '#22c55e',
    degraded: '#f59e0b', uncertain: '#f59e0b',
    unhealthy: '#ef4444', bad: '#ef4444', disconnected: '#ef4444',
    active: '#ef4444', acknowledged: '#f59e0b', cleared: '#6b7280',
  };
  return (
    <span style={{
      display: 'inline-block',
      width: 10, height: 10,
      borderRadius: '50%',
      backgroundColor: colors[status] || '#6b7280',
      marginRight: 6,
    }} />
  );
};

const TagTable: React.FC<{ tags: Map<string, TagValue> }> = ({ tags }) => (
  <div style={{ overflowY: 'auto', maxHeight: 400 }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #333', textAlign: 'left' }}>
          <th style={{ padding: '8px 4px' }}>Tag</th>
          <th>Value</th>
          <th>Quality</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {[...tags.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, tag]) => (
          <tr key={name} style={{ borderBottom: '1px solid #222' }}>
            <td style={{ padding: '6px 4px', fontFamily: 'monospace' }}>{name}</td>
            <td style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
              {typeof tag.value === 'number' ? tag.value.toFixed(2) : String(tag.value)}
            </td>
            <td><StatusBadge status={tag.quality} /> {tag.quality}</td>
            <td style={{ fontSize: 11, color: '#888' }}>
              {new Date(tag.timestamp).toLocaleTimeString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {tags.size === 0 && <p style={{ textAlign: 'center', color: '#666', padding: 20 }}>No tags received yet</p>}
  </div>
);

const AlarmList: React.FC<{ alarms: AlarmEvent[] }> = ({ alarms }) => {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...alarms]
    .filter((a) => a.state !== 'cleared')
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return (
    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
      {sorted.map((alarm) => (
        <div key={alarm.id} style={{
          padding: '8px 12px', marginBottom: 4, borderRadius: 4,
          backgroundColor: alarm.severity === 'critical' ? '#7f1d1d' : alarm.severity === 'high' ? '#78350f' : '#1f2937',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>
            <StatusBadge status={alarm.state} />
            <strong>{alarm.name}</strong>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#aaa' }}>{alarm.severity}</span>
          </span>
          <span style={{ fontSize: 11, color: '#888' }}>
            {new Date(alarm.triggeredAt).toLocaleTimeString()}
          </span>
        </div>
      ))}
      {sorted.length === 0 && <p style={{ textAlign: 'center', color: '#666', padding: 20 }}>No active alarms</p>}
    </div>
  );
};

const HealthPanel: React.FC<{ health: PipelineHealth | null; connected: boolean }> = ({ health, connected }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
    <div style={{ padding: 16, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Gateway</div>
      <StatusBadge status={connected ? 'connected' : 'disconnected'} />
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
    <div style={{ padding: 16, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Pipeline</div>
      <StatusBadge status={health?.status || 'unknown'} />
      <span>{health?.status || 'Unknown'}</span>
    </div>
    <div style={{ padding: 16, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Events</div>
      <span style={{ fontSize: 20, fontWeight: 'bold' }}>{health?.eventsProcessed?.toLocaleString() || '—'}</span>
    </div>
    <div style={{ padding: 16, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Dropped</div>
      <span style={{ fontSize: 20, fontWeight: 'bold', color: (health?.eventsDropped || 0) > 0 ? '#ef4444' : '#22c55e' }}>
        {health?.eventsDropped?.toLocaleString() || '0'}
      </span>
    </div>
  </div>
);

// --- Main Dashboard ---

const LiveDashboard: React.FC = () => {
  const wsUrl = `ws://${window.location.hostname}:${window.location.port || '3000'}/ws`;
  const { connected, tags, alarms, health, events } = useWebSocket(wsUrl);

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>
          <StatusBadge status={connected ? 'connected' : 'disconnected'} />
          0xSCADA Live Dashboard
        </h1>
        <span style={{ fontSize: 12, color: '#666' }}>
          {new Date().toLocaleString()}
        </span>
      </div>

      {/* Health Overview */}
      <HealthPanel health={health} connected={connected} />

      {/* Main Content */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>📊 Live Tags</h2>
          <TagTable tags={tags} />
        </div>

        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>🚨 Active Alarms</h2>
          <AlarmList alarms={alarms} />
        </div>
      </div>

      {/* Recent Events */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 16, marginTop: 16 }}>
        <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>📡 Recent Events</h2>
        <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace' }}>
          {events.map((e, i) => (
            <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid #1f2937' }}>
              <span style={{ color: '#888' }}>{new Date(e.timestamp).toLocaleTimeString()}</span>
              {' '}
              <span style={{ color: '#60a5fa' }}>{e.tagName}</span>
              {' = '}
              <span style={{ fontWeight: 'bold' }}>
                {typeof e.value === 'number' ? e.value.toFixed(2) : String(e.value)}
              </span>
              {' '}
              <StatusBadge status={e.quality} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default LiveDashboard;
