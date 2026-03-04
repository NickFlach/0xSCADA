/**
 * [12.4] Real-Time Dashboard
 * 
 * Live dashboard connecting to /ws/tags WebSocket for actual gateway tag data,
 * alarm status, pipeline health, and recent events.
 * 
 * Uses the useTagStream hook for WebSocket connection management.
 * Closes #206
 */

import React from 'react';
import { useTagStream } from '../hooks/use-tag-stream';
import type { TagValue } from '../hooks/use-tag-stream';

interface AlarmEvent {
  id: string;
  tag: string;
  level: string;
  message: string;
  timestamp: Date;
  state?: string;
  severity?: string;
  name?: string;
  triggeredAt?: Date;
}

interface PipelineHealth {
  overall: 'good' | 'warning' | 'critical';
  uptime: number;
  throughput: number;
  status?: string;
  eventsProcessed?: number;
  eventsDropped?: number;
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
    .filter((a) => (a as any).state !== 'cleared')
    .sort((a, b) => (severityOrder as any)[(a as any).severity] - (severityOrder as any)[(b as any).severity]);

  return (
    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
      {sorted.map((alarm) => (
        <div key={alarm.id} style={{
          padding: '8px 12px', marginBottom: 4, borderRadius: 4,
          backgroundColor: (alarm as any).severity === 'critical' ? '#7f1d1d' : (alarm as any).severity === 'high' ? '#78350f' : '#1f2937',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>
            <StatusBadge status={(alarm as any).state} />
            <strong>{(alarm as any).name}</strong>
            <span style={{ marginLeft: 8, fontSize: 11, color: '#aaa' }}>{(alarm as any).severity}</span>
          </span>
          <span style={{ fontSize: 11, color: '#888' }}>
            {new Date((alarm as any).triggeredAt).toLocaleTimeString()}
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
  const { connected, tagValues: tags, alarms, health, recentEvents: events } = useTagStream();
  const typedAlarms = alarms as any as AlarmEvent[];
  const typedHealth = health as any as PipelineHealth | null;

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
      <HealthPanel health={typedHealth} connected={connected} />

      {/* Main Content */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>📊 Live Tags</h2>
          <TagTable tags={tags} />
        </div>

        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 16 }}>
          <h2 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>🚨 Active Alarms</h2>
          <AlarmList alarms={typedAlarms} />
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
