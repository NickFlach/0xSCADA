/**
 * Intelligence Page
 * 
 * Wave feature for natural language query, predictive maintenance,
 * and digital twin capabilities within the 0xSCADA ecosystem.
 * Part of issue #277 - wave features implementation.
 */

import React, { useState } from 'react';

const Intelligence: React.FC = () => {
  const [query, setQuery] = useState('');
  const [selectedTab, setSelectedTab] = useState<'nl-query' | 'predictive' | 'digital-twin'>('nl-query');

  const handleTabChange = (tab: 'nl-query' | 'predictive' | 'digital-twin') => {
    setSelectedTab(tab);
  };

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>🧠 Intelligence Hub</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Natural language queries, predictive analytics, and digital twin visualization
        </p>
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', marginBottom: 24, borderBottom: '2px solid #333' }}>
        {[
          { key: 'nl-query', label: '💬 Natural Language', icon: '🔍' },
          { key: 'predictive', label: '📈 Predictive Maintenance', icon: '⚡' },
          { key: 'digital-twin', label: '🔗 Digital Twin', icon: '🌐' }
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key as any)}
            style={{
              padding: '12px 24px',
              backgroundColor: selectedTab === tab.key ? '#1f2937' : 'transparent',
              border: 'none',
              borderBottom: selectedTab === tab.key ? '2px solid #60a5fa' : '2px solid transparent',
              color: selectedTab === tab.key ? '#e5e5e5' : '#888',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: selectedTab === tab.key ? 'bold' : 'normal'
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Natural Language Query Tab */}
      {selectedTab === 'nl-query' && (
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔍 Ask Anything About Your System</h2>
          <div style={{ marginBottom: 20 }}>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g., 'Show me all pumps with efficiency below 80%' or 'What caused the temperature spike in reactor R-301?'"
              style={{
                width: '100%',
                minHeight: 100,
                padding: 16,
                backgroundColor: '#0a0a0a',
                border: '1px solid #374151',
                borderRadius: 6,
                color: '#e5e5e5',
                fontSize: 14,
                resize: 'vertical'
              }}
            />
            <button style={{
              marginTop: 12,
              padding: '12px 32px',
              backgroundColor: '#3b82f6',
              border: 'none',
              borderRadius: 6,
              color: 'white',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 'bold'
            }}>
              ⚡ Analyze Query
            </button>
          </div>
          <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
            <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>💡 Recent Insights</h3>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>
              <p>• Tank TK-101 level trending downward - recommend inspection</p>
              <p>• Pump P-205 showing increased vibration patterns</p>
              <p>• Energy efficiency up 12% this quarter vs last</p>
              <p>• 3 valves due for calibration next week</p>
            </div>
          </div>
        </div>
      )}

      {/* Predictive Maintenance Tab */}
      {selectedTab === 'predictive' && (
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>📈 Predictive Analytics</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
              <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>⚠️ Risk Assessment</h3>
              <div style={{ fontSize: 14 }}>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Pump P-101</span>
                  <span style={{ color: '#f59e0b' }}>Medium Risk</span>
                </div>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Heat Exchanger E-201</span>
                  <span style={{ color: '#ef4444' }}>High Risk</span>
                </div>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Compressor C-301</span>
                  <span style={{ color: '#22c55e' }}>Low Risk</span>
                </div>
              </div>
            </div>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
              <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>🗓️ Maintenance Schedule</h3>
              <div style={{ fontSize: 14 }}>
                <p>• P-101 Bearing replacement: 14 days</p>
                <p>• E-201 Tube cleaning: 7 days</p>
                <p>• V-105 Calibration: 21 days</p>
                <p>• TK-203 Inspection: 30 days</p>
              </div>
            </div>
          </div>
          <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
            <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>🤖 ML Model Status</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, fontSize: 14 }}>
              <div>Vibration Analysis: <span style={{ color: '#22c55e' }}>Active</span></div>
              <div>Temperature Trends: <span style={{ color: '#22c55e' }}>Active</span></div>
              <div>Flow Pattern Recognition: <span style={{ color: '#f59e0b' }}>Training</span></div>
            </div>
          </div>
        </div>
      )}

      {/* Digital Twin Tab */}
      {selectedTab === 'digital-twin' && (
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🌐 Digital Twin Mirror</h2>
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              <div style={{ padding: 16, backgroundColor: '#0a0a0a', borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Simulation Accuracy</div>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#22c55e' }}>97.3%</div>
              </div>
              <div style={{ padding: 16, backgroundColor: '#0a0a0a', borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Twin Sync Status</div>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#22c55e' }}>Real-time</div>
              </div>
              <div style={{ padding: 16, backgroundColor: '#0a0a0a', borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Active Scenarios</div>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#60a5fa' }}>5</div>
              </div>
              <div style={{ padding: 16, backgroundColor: '#0a0a0a', borderRadius: 6, textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Optimization Gains</div>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#f59e0b' }}>+8.2%</div>
              </div>
            </div>
          </div>
          <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>🎮 Simulation Controls</h3>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <button style={{
                padding: '8px 16px',
                backgroundColor: '#22c55e',
                border: 'none',
                borderRadius: 4,
                color: 'white',
                cursor: 'pointer',
                fontSize: 12
              }}>
                ▶️ Run Simulation
              </button>
              <button style={{
                padding: '8px 16px',
                backgroundColor: '#f59e0b',
                border: 'none',
                borderRadius: 4,
                color: 'white',
                cursor: 'pointer',
                fontSize: 12
              }}>
                ⏸️ Pause
              </button>
              <button style={{
                padding: '8px 16px',
                backgroundColor: '#ef4444',
                border: 'none',
                borderRadius: 4,
                color: 'white',
                cursor: 'pointer',
                fontSize: 12
              }}>
                🔄 Reset
              </button>
            </div>
            <div style={{ fontSize: 14, color: '#888' }}>
              Current scenario: Normal operation + 15% throughput increase
            </div>
          </div>
          <p style={{ fontSize: 14, color: '#666', fontStyle: 'italic' }}>
            3D visualization and advanced twin modeling features coming soon...
          </p>
        </div>
      )}
    </div>
  );
};

export default Intelligence;