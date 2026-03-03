/**
 * Integrity Dashboard Page
 * 
 * Wave feature for Merkle tree verification, HSM management,
 * and data integrity monitoring within the 0xSCADA ecosystem.
 * Part of issue #277 - wave features implementation.
 */

import React, { useState } from 'react';

const Integrity: React.FC = () => {
  const [selectedTab, setSelectedTab] = useState<'merkle' | 'hsm' | 'verification'>('merkle');

  const handleTabChange = (tab: 'merkle' | 'hsm' | 'verification') => {
    setSelectedTab(tab);
  };

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>🔐 Integrity Dashboard</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Merkle tree verification, HSM management, and cryptographic data integrity monitoring
        </p>
      </div>

      {/* Status Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Integrity Score</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>100%</div>
          <div style={{ fontSize: 12, color: '#888' }}>All verified</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>HSM Status</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>Online</div>
          <div style={{ fontSize: 12, color: '#888' }}>3 modules active</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Merkle Proofs</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#60a5fa' }}>12,847</div>
          <div style={{ fontSize: 12, color: '#888' }}>Generated today</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Last Verification</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>2m</div>
          <div style={{ fontSize: 12, color: '#888' }}>ago</div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', marginBottom: 24, borderBottom: '2px solid #333' }}>
        {[
          { key: 'merkle', label: '🌳 Merkle Trees', icon: '📊' },
          { key: 'hsm', label: '🔒 HSM Management', icon: '⚡' },
          { key: 'verification', label: '✅ Verification', icon: '🔍' }
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

      {/* Merkle Trees Tab */}
      {selectedTab === 'merkle' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
            <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
              <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🌳 Active Merkle Trees</h2>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
                {[
                  { name: 'Process Data Tree', height: 15, leaves: 32768, lastUpdate: '2m ago', status: 'healthy' },
                  { name: 'Alarm Events Tree', height: 12, leaves: 4096, lastUpdate: '5m ago', status: 'healthy' },
                  { name: 'Configuration Tree', height: 8, leaves: 256, lastUpdate: '1h ago', status: 'healthy' },
                  { name: 'Audit Log Tree', height: 14, leaves: 16384, lastUpdate: '1m ago', status: 'healthy' }
                ].map(tree => (
                  <div key={tree.name} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #333' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <strong style={{ fontSize: 16 }}>{tree.name}</strong>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        backgroundColor: '#22c55e',
                        color: 'white',
                        fontSize: 12
                      }}>
                        {tree.status.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 14, color: '#888', lineHeight: 1.5 }}>
                      <div>Height: {tree.height} levels • Leaves: {tree.leaves.toLocaleString()}</div>
                      <div>Last update: {tree.lastUpdate}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
              <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>📊 Tree Statistics</h2>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', marginBottom: 16 }}>
                <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>Performance Metrics</h3>
                <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>Proof Generation Time</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>0.23ms avg</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>Verification Time</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>0.08ms avg</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>Tree Build Time</span>
                    <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>1.2s avg</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Storage Efficiency</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>97.8%</span>
                  </div>
                </div>
              </div>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
                <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>Recent Activity</h3>
                <div style={{ fontSize: 13, fontFamily: 'monospace', lineHeight: 1.5, maxHeight: 150, overflowY: 'auto' }}>
                  <div>16:24:33 - Tree rebuilt: Process Data</div>
                  <div>16:23:15 - Proof verified: Alarm#4829</div>
                  <div>16:22:58 - New leaf added: Config change</div>
                  <div>16:21:42 - Batch verification: 128 proofs</div>
                  <div>16:20:31 - Tree height increased: +1 level</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔍 Merkle Proof Verification</h2>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
              <input
                type="text"
                placeholder="Enter transaction ID or data hash..."
                style={{
                  flex: 1,
                  padding: 12,
                  backgroundColor: '#0a0a0a',
                  border: '1px solid #374151',
                  borderRadius: 6,
                  color: '#e5e5e5',
                  fontSize: 14,
                  fontFamily: 'monospace'
                }}
              />
              <button style={{
                padding: '12px 24px',
                backgroundColor: '#3b82f6',
                border: 'none',
                borderRadius: 6,
                color: 'white',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 'bold'
              }}>
                Verify Proof
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HSM Management Tab */}
      {selectedTab === 'hsm' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
            <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
              <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔒 HSM Status</h2>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
                {[
                  { name: 'Primary HSM', model: 'SafeNet Luna K7', status: 'online', temp: '32°C', load: '24%' },
                  { name: 'Backup HSM', model: 'SafeNet Luna K7', status: 'online', temp: '29°C', load: '8%' },
                  { name: 'Archive HSM', model: 'Thales nShield', status: 'standby', temp: '26°C', load: '0%' }
                ].map(hsm => (
                  <div key={hsm.name} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #333' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <div>
                        <strong style={{ fontSize: 16 }}>{hsm.name}</strong>
                        <div style={{ fontSize: 12, color: '#888' }}>{hsm.model}</div>
                      </div>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        backgroundColor: hsm.status === 'online' ? '#22c55e' : '#f59e0b',
                        color: 'white',
                        fontSize: 12
                      }}>
                        {hsm.status.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 14, color: '#888', display: 'flex', gap: 16 }}>
                      <span>Temp: {hsm.temp}</span>
                      <span>Load: {hsm.load}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
              <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔑 Key Management</h2>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', marginBottom: 16 }}>
                <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>Active Keys</h3>
                <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>Signing Keys</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>12 active</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>Encryption Keys</span>
                    <span style={{ fontFamily: 'monospace', color: '#22c55e' }}>8 active</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span>Root CA Keys</span>
                    <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>2 active</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Backup Keys</span>
                    <span style={{ fontFamily: 'monospace', color: '#888' }}>24 archived</span>
                  </div>
                </div>
              </div>
              <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
                <h3 style={{ fontSize: 16, marginTop: 0, marginBottom: 12 }}>Key Operations</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button style={{
                    padding: '8px 16px',
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: 4,
                    color: '#e5e5e5',
                    cursor: 'pointer',
                    fontSize: 12
                  }}>
                    Generate New Key Pair
                  </button>
                  <button style={{
                    padding: '8px 16px',
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: 4,
                    color: '#e5e5e5',
                    cursor: 'pointer',
                    fontSize: 12
                  }}>
                    Rotate Signing Key
                  </button>
                  <button style={{
                    padding: '8px 16px',
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: 4,
                    color: '#e5e5e5',
                    cursor: 'pointer',
                    fontSize: 12
                  }}>
                    Export Public Keys
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>📊 HSM Performance</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#22c55e' }}>1,847</div>
                <div style={{ fontSize: 12, color: '#888' }}>Operations/sec</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#60a5fa' }}>99.99%</div>
                <div style={{ fontSize: 12, color: '#888' }}>Uptime</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#f59e0b' }}>0.7ms</div>
                <div style={{ fontSize: 12, color: '#888' }}>Avg response</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 'bold', color: '#22c55e' }}>0</div>
                <div style={{ fontSize: 12, color: '#888' }}>Failed ops</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Verification Tab */}
      {selectedTab === 'verification' && (
        <div>
          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
            <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>✅ Data Integrity Verification</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
              <div>
                <h3 style={{ fontSize: 16, marginBottom: 12 }}>🔍 Real-time Verification</h3>
                <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', marginBottom: 16 }}>
                  <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span>Process Data</span>
                      <span style={{ color: '#22c55e' }}>✅ Verified</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span>Configuration Files</span>
                      <span style={{ color: '#22c55e' }}>✅ Verified</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span>Alarm Records</span>
                      <span style={{ color: '#22c55e' }}>✅ Verified</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Audit Logs</span>
                      <span style={{ color: '#f59e0b' }}>⏳ Verifying...</span>
                    </div>
                  </div>
                </div>
                <button style={{
                  width: '100%',
                  padding: '12px',
                  backgroundColor: '#3b82f6',
                  border: 'none',
                  borderRadius: 6,
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 'bold'
                }}>
                  🔄 Run Full Verification
                </button>
              </div>
              
              <div>
                <h3 style={{ fontSize: 16, marginBottom: 12 }}>📈 Verification History</h3>
                <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', maxHeight: 200, overflowY: 'auto' }}>
                  {[
                    { time: '16:25:42', type: 'Process Data', result: 'passed', duration: '0.23s' },
                    { time: '16:20:15', type: 'Full System', result: 'passed', duration: '15.7s' },
                    { time: '16:15:31', type: 'Config Files', result: 'passed', duration: '1.2s' },
                    { time: '16:10:08', type: 'Alarm Records', result: 'passed', duration: '0.89s' },
                    { time: '16:05:22', type: 'Process Data', result: 'passed', duration: '0.31s' },
                    { time: '16:00:45', type: 'Full System', result: 'passed', duration: '14.2s' }
                  ].map((verification, i) => (
                    <div key={i} style={{ marginBottom: 8, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                      <div>
                        <span style={{ color: '#888', fontFamily: 'monospace' }}>{verification.time}</span>
                        {' '}
                        <span>{verification.type}</span>
                      </div>
                      <div>
                        <span style={{ color: verification.result === 'passed' ? '#22c55e' : '#ef4444', marginRight: 8 }}>
                          {verification.result === 'passed' ? '✅' : '❌'}
                        </span>
                        <span style={{ color: '#888', fontSize: 11 }}>{verification.duration}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🚨 Integrity Alerts & Actions</h2>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', marginBottom: 16 }}>
              <div style={{ fontSize: 14, color: '#22c55e', marginBottom: 12 }}>
                ✅ <strong>All systems verified</strong> - No integrity issues detected
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>
                Last full verification: 20 minutes ago • Next scheduled: in 40 minutes
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 12 }}>
              <button style={{
                padding: '12px 24px',
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 6,
                color: '#e5e5e5',
                cursor: 'pointer'
              }}>
                📋 Export Report
              </button>
              <button style={{
                padding: '12px 24px',
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 6,
                color: '#e5e5e5',
                cursor: 'pointer'
              }}>
                ⚙️ Configure Alerts
              </button>
              <button style={{
                padding: '12px 24px',
                backgroundColor: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 6,
                color: '#e5e5e5',
                cursor: 'pointer'
              }}>
                📊 View Metrics
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, padding: 16, backgroundColor: '#111827', borderRadius: 8 }}>
        <p style={{ fontSize: 14, color: '#666', fontStyle: 'italic', margin: 0 }}>
          🔬 Advanced cryptographic features and blockchain integration coming soon...
        </p>
      </div>
    </div>
  );
};

export default Integrity;