/**
 * Security & Compliance Page
 * 
 * Wave feature for security monitoring, compliance tracking,
 * and audit management within the 0xSCADA ecosystem.
 * Part of issue #277 - wave features implementation.
 */

import React from 'react';

const SecurityCompliance: React.FC = () => {
  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>🛡️ Security & Compliance</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Monitor security status, track compliance metrics, and manage audit trails
        </p>
      </div>

      {/* Security Status Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Security Score</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>94</div>
          <div style={{ fontSize: 12, color: '#888' }}>Excellent</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Active Threats</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#ef4444' }}>2</div>
          <div style={{ fontSize: 12, color: '#888' }}>Medium Risk</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Compliance Status</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#22c55e' }}>98%</div>
          <div style={{ fontSize: 12, color: '#888' }}>IEC 62443</div>
        </div>
        <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Last Audit</div>
          <div style={{ fontSize: 32, fontWeight: 'bold', color: '#60a5fa' }}>7</div>
          <div style={{ fontSize: 12, color: '#888' }}>days ago</div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
        
        {/* Security Monitoring */}
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>🔍 Security Monitoring</h2>
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, marginBottom: 12, color: '#f59e0b' }}>⚠️ Active Alerts</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 12, borderRadius: 6, border: '1px solid #333', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 'bold', color: '#ef4444', marginBottom: 4 }}>
                Unauthorized Access Attempt
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>
                IP: 192.168.1.47 | Gateway: GW-02 | 14:32:15
              </div>
            </div>
            <div style={{ backgroundColor: '#0a0a0a', padding: 12, borderRadius: 6, border: '1px solid #333' }}>
              <div style={{ fontSize: 14, fontWeight: 'bold', color: '#f59e0b', marginBottom: 4 }}>
                Certificate Expiry Warning
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>
                OPC UA Server Cert | Expires: 23 days | GW-01
              </div>
            </div>
          </div>
          
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12, color: '#22c55e' }}>✅ Security Status</h3>
            <div style={{ fontSize: 14, lineHeight: 1.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>Firewall Status</span>
                <span style={{ color: '#22c55e' }}>Active</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>IDS/IPS</span>
                <span style={{ color: '#22c55e' }}>Monitoring</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>VPN Tunnels</span>
                <span style={{ color: '#22c55e' }}>4/4 Active</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>User Sessions</span>
                <span style={{ color: '#60a5fa' }}>12 Active</span>
              </div>
            </div>
          </div>
        </div>

        {/* Compliance Tracking */}
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>📋 Compliance Dashboard</h2>
          
          <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>🏆 Standards Compliance</h3>
            {[
              { standard: 'IEC 62443', score: 98, color: '#22c55e' },
              { standard: 'ISO 27001', score: 95, color: '#22c55e' },
              { standard: 'NIST CSF', score: 92, color: '#22c55e' },
              { standard: 'NERC CIP', score: 87, color: '#f59e0b' }
            ].map(item => (
              <div key={item.standard} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
                  <span>{item.standard}</span>
                  <span style={{ color: item.color, fontWeight: 'bold' }}>{item.score}%</span>
                </div>
                <div style={{ width: '100%', height: 6, backgroundColor: '#333', borderRadius: 3 }}>
                  <div style={{
                    width: `${item.score}%`,
                    height: '100%',
                    backgroundColor: item.color,
                    borderRadius: 3
                  }} />
                </div>
              </div>
            ))}
          </div>

          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>📊 Recent Audits</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 12, borderRadius: 6, border: '1px solid #333', fontSize: 14 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>Q1 2026 Security Review</strong> - <span style={{ color: '#22c55e' }}>Passed</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>IEC 62443 Assessment</strong> - <span style={{ color: '#22c55e' }}>Compliant</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Penetration Test</strong> - <span style={{ color: '#f59e0b' }}>2 Minor Issues</span>
              </div>
              <div>
                <strong>Access Control Review</strong> - <span style={{ color: '#22c55e' }}>Clean</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Access Control & Audit Trail */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>👥 Access Control & Audit Trail</h2>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>🔑 User Access Summary</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333' }}>
              <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>Active Users</span>
                  <span style={{ color: '#60a5fa' }}>47</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>Admin Accounts</span>
                  <span style={{ color: '#f59e0b' }}>5</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>Service Accounts</span>
                  <span style={{ color: '#888' }}>12</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Failed Logins (24h)</span>
                  <span style={{ color: '#ef4444' }}>3</span>
                </div>
              </div>
            </div>
          </div>
          
          <div>
            <h3 style={{ fontSize: 16, marginBottom: 12 }}>📖 Recent Audit Events</h3>
            <div style={{ backgroundColor: '#0a0a0a', padding: 16, borderRadius: 6, border: '1px solid #333', maxHeight: 200, overflowY: 'auto' }}>
              {[
                { time: '15:42:17', user: 'john.doe', action: 'Modified PID drawing', level: 'info' },
                { time: '15:38:22', user: 'admin', action: 'Updated gateway config', level: 'warning' },
                { time: '15:35:01', user: 'system', action: 'Backup completed', level: 'info' },
                { time: '15:32:15', user: 'unknown', action: 'Failed login attempt', level: 'error' },
                { time: '15:28:44', user: 'mary.smith', action: 'Exported trend data', level: 'info' }
              ].map((event, i) => (
                <div key={i} style={{ marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: '#888' }}>{event.time}</span>
                  {' '}
                  <span style={{ fontWeight: 'bold' }}>{event.user}</span>
                  {' '}
                  <span>{event.action}</span>
                  <span style={{
                    marginLeft: 8,
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 10,
                    backgroundColor: event.level === 'error' ? '#7f1d1d' : event.level === 'warning' ? '#78350f' : '#1f2937',
                    color: '#fff'
                  }}>
                    {event.level.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>⚡ Security Actions</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#ef4444',
            border: 'none',
            borderRadius: 6,
            color: 'white',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}>
            🚨 Incident Response
          </button>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            📊 Generate Report
          </button>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            🔐 Review Permissions
          </button>
          <button style={{
            padding: '12px 24px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer'
          }}>
            🛡️ Security Scan
          </button>
        </div>
        <p style={{ marginTop: 16, fontSize: 14, color: '#666', fontStyle: 'italic' }}>
          Advanced threat detection and automated response features coming soon...
        </p>
      </div>
    </div>
  );
};

export default SecurityCompliance;