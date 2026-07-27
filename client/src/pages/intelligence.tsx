/**
 * Intelligence Page
 *
 * Issue #216 (ADR-0013 [13.5]) review: this page previously rendered a fully
 * fabricated dashboard — invented asset risk ratings ("Pump P-101: Medium
 * Risk"), an invented maintenance schedule, and invented twin metrics
 * ("Simulation Accuracy 97.3%", "Optimization Gains +8.2%"). None of it came
 * from an API call; the values were literals in this file, and the query box
 * and simulation buttons had no handlers. On an operator-facing SCADA screen
 * that reads as live plant state, which is exactly what the repository
 * integrity rule forbids.
 *
 * The fabricated panels are gone. Each tab now states plainly what is and is
 * not implemented, and names the API that actually serves the capability, so
 * this page cannot be mistaken for a working readout. It renders no numbers
 * because it has none to render.
 */

import React, { useState } from 'react';

type TabKey = 'nl-query' | 'predictive' | 'digital-twin';

interface TabDefinition {
  key: TabKey;
  label: string;
  icon: string;
}

interface TabContent {
  heading: string;
  /** Server contract for this capability: 501 unbuilt, 410 moved. */
  status: 'not-implemented' | 'moved';
  /** What the legacy /api/intelligence path now returns. */
  legacyPath: string;
  summary: string;
  /** Endpoints that actually serve this capability; empty when unbuilt. */
  endpoints: readonly string[];
}

const TABS: readonly TabDefinition[] = [
  { key: 'nl-query', label: 'Natural Language', icon: '🔍' },
  { key: 'predictive', label: 'Predictive Maintenance', icon: '📈' },
  { key: 'digital-twin', label: 'Digital Twin', icon: '🔗' },
];

const CONTENT: Record<TabKey, TabContent> = {
  'nl-query': {
    heading: 'Natural language query',
    status: 'not-implemented',
    legacyPath: 'POST /api/intelligence/nlquery',
    summary:
      'Not implemented. No natural-language query engine is wired to this '
      + 'service, so there is nothing to display here. The endpoint returns '
      + '501 with { error: "not_implemented" } rather than a placeholder '
      + 'answer.',
    endpoints: [],
  },
  predictive: {
    heading: 'Predictive maintenance',
    status: 'moved',
    legacyPath: 'POST /api/intelligence/maintenance/analyze',
    summary:
      'Implemented, but not on this page and not on the legacy '
      + '/api/intelligence path, which now returns 410. The predictive '
      + 'maintenance engine is tag-scoped: ingest a tag series, then read its '
      + 'assessment, failure prediction, or alerts. Access requires '
      + 'predictive.* control-plane scopes.',
    endpoints: [
      'POST /api/predictive/ingest',
      'GET /api/predictive/analyze/:tagId',
      'GET /api/predictive/prediction/:tagId',
      'GET /api/predictive/alerts',
    ],
  },
  'digital-twin': {
    heading: 'Digital twin',
    status: 'moved',
    legacyPath: 'POST /api/intelligence/digitaltwin/operate',
    summary:
      'Implemented, but not on this page and not on the legacy '
      + '/api/intelligence path, which now returns 410. The twin runtime holds '
      + 'the model registry, simulation stepping, live-state compare, and '
      + 'what-if scenarios. Access requires twin.* control-plane scopes.',
    endpoints: [
      'POST /api/twin/models',
      'POST /api/twin/models/:modelId/step',
      'GET /api/twin/models/:modelId/state',
      'POST /api/twin/scenarios',
    ],
  },
};

const STATUS_LABEL: Record<TabContent['status'], string> = {
  'not-implemented': 'Not implemented',
  moved: 'Moved — this path returns 410',
};

const STATUS_COLOR: Record<TabContent['status'], string> = {
  'not-implemented': '#ef4444',
  moved: '#f59e0b',
};

const Intelligence: React.FC = () => {
  const [selectedTab, setSelectedTab] = useState<TabKey>('nl-query');
  const content = CONTENT[selectedTab];

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>Intelligence Hub</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Status of the natural language, predictive maintenance, and digital twin surfaces.
          This page reports what exists; it does not display plant data.
        </p>
      </div>

      {/* Tab Navigation */}
      <div style={{ display: 'flex', marginBottom: 24, borderBottom: '2px solid #333' }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSelectedTab(tab.key)}
            style={{
              padding: '12px 24px',
              backgroundColor: selectedTab === tab.key ? '#1f2937' : 'transparent',
              border: 'none',
              borderBottom: selectedTab === tab.key ? '2px solid #60a5fa' : '2px solid transparent',
              color: selectedTab === tab.key ? '#e5e5e5' : '#888',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: selectedTab === tab.key ? 'bold' : 'normal',
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h2 style={{ fontSize: 20, margin: 0 }}>{content.heading}</h2>
          <span
            style={{
              fontSize: 12,
              fontWeight: 'bold',
              padding: '4px 10px',
              borderRadius: 4,
              border: `1px solid ${STATUS_COLOR[content.status]}`,
              color: STATUS_COLOR[content.status],
            }}
          >
            {STATUS_LABEL[content.status]}
          </span>
        </div>

        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#d1d5db', marginTop: 0 }}>
          {content.summary}
        </p>

        <div
          style={{
            backgroundColor: '#0a0a0a',
            padding: 16,
            borderRadius: 6,
            border: '1px solid #333',
            marginTop: 20,
          }}
        >
          <h3 style={{ fontSize: 14, marginTop: 0, marginBottom: 8, color: '#888' }}>
            Legacy path
          </h3>
          <code style={{ fontSize: 13, color: '#f87171' }}>{content.legacyPath}</code>
        </div>

        {content.endpoints.length > 0 && (
          <div
            style={{
              backgroundColor: '#0a0a0a',
              padding: 16,
              borderRadius: 6,
              border: '1px solid #333',
              marginTop: 16,
            }}
          >
            <h3 style={{ fontSize: 14, marginTop: 0, marginBottom: 8, color: '#888' }}>
              Implemented endpoints
            </h3>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9 }}>
              {content.endpoints.map(endpoint => (
                <li key={endpoint}>
                  <code style={{ color: '#86efac' }}>{endpoint}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default Intelligence;
