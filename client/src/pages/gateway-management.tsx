/**
 * Gateway Management Page
 * 
 * Wave feature for managing gateway configurations, connections,
 * and communication settings across the 0xSCADA network.
 * Part of issue #277 - wave features implementation.
 */

import React from 'react';

const GatewayManagement: React.FC = () => {
  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>🌐 Gateway Management</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Manage gateway configurations, connections, and network communication settings
        </p>
      </div>

      {/* Status Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Active Gateways</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>4</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Connected Devices</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#60a5fa' }}>127</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Network Health</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>98%</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Data Throughput</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#f59e0b' }}>2.4MB/s</div>
        </div>
      </div>

      {/* Gateway Configuration Panel */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>⚙️ Gateway Configuration</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>Connection Settings</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Protocol: OPC UA</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Port: 4840</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Security: Sign & Encrypt</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Timeout: 30s</p>
            </div>
          </div>
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>Redundancy & Failover</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Primary Gateway: Active</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Backup Gateway: Standby</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Failover Time: &lt; 2s</p>
              <p style={{ margin: '8px 0', fontSize: 14 }}>• Health Check: 5s interval</p>
            </div>
          </div>
        </div>
      </div>

      {/* Placeholder Actions */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔧 Quick Actions</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            Add New Gateway
          </button>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            Import Configuration
          </button>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            Run Diagnostics
          </button>
        </div>
        <p style={{ marginTop: 16, fontSize: 14, color: '#666', fontStyle: 'italic' }}>
          Full gateway management functionality coming soon...
        </p>
      </div>
    </div>
  );
};

export default GatewayManagement;