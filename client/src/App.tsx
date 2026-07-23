/**
 * Main Application Component
 * 
 * Routes and renders the different pages of the 0xSCADA application,
 * including the new wave feature pages for issue #277.
 */

import React from 'react';
import { Router, Route, Link } from 'wouter';

// Existing pages
import LiveDashboard from './pages/live-dashboard';
import PIDView from './pages/pid-view';

// New wave feature pages (issue #277)
import GatewayManagement from './pages/gateway-management';
import Intelligence from './pages/intelligence';
import SecurityCompliance from './pages/security-compliance';
import Integrity from './pages/integrity';

// Admin: Anchor-Backend Switch UX (issue #455)
import AnchorBackend from './pages/admin/AnchorBackend';

const App: React.FC = () => {
  return (
    <div style={{ backgroundColor: '#0a0a0a', minHeight: '100vh', color: '#e5e5e5' }}>
      {/* Navigation Header */}
      <header style={{ 
        backgroundColor: '#111827', 
        borderBottom: '1px solid #374151', 
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 24
      }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 'bold' }}>
          0xSCADA
        </h1>
        <nav style={{ display: 'flex', gap: 20 }}>
          <Link href="/">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Dashboard
            </a>
          </Link>
          <Link href="/pid">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              P&ID View
            </a>
          </Link>
          <Link href="/gateway">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Gateway
            </a>
          </Link>
          <Link href="/intelligence">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Intelligence
            </a>
          </Link>
          <Link href="/security">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Security
            </a>
          </Link>
          <Link href="/integrity">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Integrity
            </a>
          </Link>
          <Link href="/admin/anchor-backend">
            <a style={{ color: '#e5e5e5', textDecoration: 'none', fontSize: 14 }}>
              Anchor Backend
            </a>
          </Link>
        </nav>
      </header>

      {/* Main Content */}
      <main>
        <Router>
          <Route path="/" component={LiveDashboard} />
          <Route path="/dashboard" component={LiveDashboard} />
          <Route path="/pid" component={PIDView} />
          
          {/* Wave Feature Routes (issue #277) */}
          <Route path="/gateway" component={GatewayManagement} />
          <Route path="/intelligence" component={Intelligence} />
          <Route path="/security" component={SecurityCompliance} />
          <Route path="/integrity" component={Integrity} />

          {/* Admin: Anchor-Backend Switch UX (issue #455) */}
          <Route path="/admin/anchor-backend" component={AnchorBackend} />

          {/* Catch-all route */}
          <Route>
            <div style={{ padding: 24 }}>
              <h1 style={{ fontSize: 24, marginBottom: 16 }}>404 - Page Not Found</h1>
              <p style={{ color: '#888' }}>
                The page you're looking for doesn't exist.
              </p>
              <Link href="/">
                <a style={{ color: '#60a5fa', textDecoration: 'none' }}>
                  ← Back to Dashboard
                </a>
              </Link>
            </div>
          </Route>
        </Router>
      </main>
    </div>
  );
};

export default App;