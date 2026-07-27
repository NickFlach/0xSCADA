/**
 * ValidatorDashboard — operator surface for the oxscada validator set.
 *
 * Issue #453 — [wave:2a] Validator Dashboard.
 *
 * Data comes from the authenticated, same-origin `/api/validators` proxy. This
 * component contains no node URL, no port number and no cross-origin fetch: the
 * server owns `ANCHOR_NODE_URLS` and does the `:9090` polling, which is what
 * makes the page work behind TLS without a CORS grant from every node.
 *
 * It renders three things an operator needs to read together:
 *   - the PROVENANCE of the data (unsigned node reports — never presented as
 *     attested fact), including which validators the reporting nodes disagree about
 *   - per-node reachability and per-validator Kuramoto phase
 *   - an explicit list of the metrics the node RPC cannot supply, so a blank
 *     panel is never mistaken for "zero"
 *
 * Classification/formatting comes from the pure `lib/validator-metrics` helpers;
 * the numeric aggregation is done server-side on the data the server polled.
 */

import React from 'react';
import type {
  ValidatorNodeView,
  ValidatorOverview,
  ValidatorProvenance,
  ValidatorRow,
} from '@shared/types/services/validator-dashboard';
import { useValidatorOverview } from '../hooks/use-validator-overview';
import {
  STALE_THRESHOLD_MS,
  COHERENCE_RED_THRESHOLD,
  classifyNodeHealth,
  formatAge,
  isCoherenceCritical,
  nodeSampleLagMs,
  orderParameterDivergence,
  shortId,
  validatorSampleAgeMs,
  type NodeHealth,
} from '../lib/validator-metrics';

const HEALTH_COLORS: Record<NodeHealth, string> = {
  live: '#22c55e',
  stale: '#f59e0b',
  error: '#ef4444',
};

const PANEL: React.CSSProperties = {
  backgroundColor: '#111827',
  borderRadius: 8,
  padding: 20,
};

const StatusDot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      display: 'inline-block',
      width: 10,
      height: 10,
      borderRadius: '50%',
      backgroundColor: color,
      marginRight: 6,
    }}
  />
);

// ─── Provenance banner ───────────────────────────────────────────────────────

/**
 * Always rendered, never collapsible. The whole point of #453's review is that
 * an operator must not be able to mistake unsigned node claims for attested facts.
 */
const ProvenanceBanner: React.FC<{ provenance: ValidatorProvenance; disputedCount: number }> = ({
  provenance,
  disputedCount,
}) => {
  const verified = provenance.verified;
  return (
    <div
      role="note"
      aria-label="Data provenance"
      data-testid="validator-provenance"
      data-verified={String(verified)}
      data-method={provenance.method}
      style={{
        padding: '12px 16px',
        marginBottom: 20,
        borderRadius: 8,
        border: `1px solid ${verified ? '#22c55e' : '#f59e0b'}`,
        backgroundColor: verified ? '#052e16' : '#3f2d09',
      }}
    >
      <div style={{ fontWeight: 'bold', color: verified ? '#22c55e' : '#f59e0b', fontSize: 14 }}>
        {verified
          ? `Verified — signatures checked (${provenance.method})`
          : 'UNVERIFIED — unsigned node reports'}
      </div>
      <div style={{ color: '#d4d4d4', fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
        {provenance.detail}
      </div>
      {disputedCount > 0 && (
        <div style={{ color: '#f59e0b', fontSize: 13, marginTop: 6, fontWeight: 'bold' }}>
          {disputedCount} validator{disputedCount === 1 ? '' : 's'} reported with conflicting phases
          by different nodes.
        </div>
      )}
    </div>
  );
};

// ─── Coherence ───────────────────────────────────────────────────────────────

const CoherenceIndicator: React.FC<{ overview: ValidatorOverview }> = ({ overview }) => {
  const { r, count } = overview.coherence;
  const critical = isCoherenceCritical(r, COHERENCE_RED_THRESHOLD);
  const color = critical ? '#ef4444' : r >= 0.9 ? '#22c55e' : '#f59e0b';
  const divergence = orderParameterDivergence(overview);

  return (
    <div style={{ ...PANEL, border: `1px solid ${critical ? '#ef4444' : '#374151'}` }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        Kuramoto coherence — derived from the reported phase set
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 40, fontWeight: 'bold', color }}>{r.toFixed(3)}</span>
        <span style={{ fontSize: 14, color: '#888' }}>r over {count} oscillators</span>
      </div>

      <div style={{ position: 'relative', height: 10, backgroundColor: '#0a0a0a', borderRadius: 5, marginTop: 12 }}>
        <div
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, r)) * 100)}%`,
            height: '100%',
            backgroundColor: color,
            borderRadius: 5,
          }}
        />
        <div
          title={`red threshold ${COHERENCE_RED_THRESHOLD}`}
          style={{
            position: 'absolute',
            left: `${COHERENCE_RED_THRESHOLD * 100}%`,
            top: -3,
            width: 2,
            height: 16,
            backgroundColor: '#e5e5e5',
          }}
        />
      </div>

      {critical && (
        <div style={{ marginTop: 10, color: '#ef4444', fontSize: 13, fontWeight: 'bold' }}>
          Coherence below {COHERENCE_RED_THRESHOLD} — the reported validator set is desynchronizing.
        </div>
      )}

      {divergence !== null && (
        <div style={{ marginTop: 10, fontSize: 12, color: divergence > 0.05 ? '#f59e0b' : '#666' }}>
          Largest gap vs. a node&apos;s self-reported order parameter: {divergence.toFixed(3)}
          {divergence > 0.05 && ' — a node’s claim disagrees with the phases it published.'}
        </div>
      )}
    </div>
  );
};

// ─── Node health ─────────────────────────────────────────────────────────────

const NodeHealthPanel: React.FC<{ overview: ValidatorOverview; overviewAgeMs: number }> = ({
  overview,
  overviewAgeMs,
}) => (
  <div style={PANEL}>
    <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Node health</div>
    {overview.nodes.length === 0 ? (
      <p style={{ color: '#666', fontSize: 13, margin: 0 }}>No nodes configured on the server.</p>
    ) : (
      overview.nodes.map((node: ValidatorNodeView) => {
        const health = classifyNodeHealth(node, overviewAgeMs);
        return (
          <div
            key={node.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            <span style={{ fontFamily: 'monospace' }}>
              <StatusDot color={HEALTH_COLORS[health]} />
              {node.label}
              {node.status && (
                <span style={{ color: '#666', marginLeft: 8 }}>
                  h{node.status.height} · {node.status.role} · {node.status.peers}p · mempool{' '}
                  {node.status.mempool}
                </span>
              )}
            </span>
            <span style={{ color: HEALTH_COLORS[health], textAlign: 'right' }}>
              {health === 'error'
                ? (node.error ?? 'unreachable')
                : `${health} · sampled ${formatAge(nodeSampleLagMs(overview, node))}`}
            </span>
          </div>
        );
      })
    )}
    <div style={{ marginTop: 8, fontSize: 11, color: '#666' }}>
      The view turns stale after {(STALE_THRESHOLD_MS / 1000).toFixed(0)}s without a successful
      refresh. Node polling happens on the server; the browser only calls /api/validators.
    </div>
  </div>
);

// ─── Validator table ─────────────────────────────────────────────────────────

const ValidatorTable: React.FC<{ rows: ValidatorRow[]; generatedAt: number }> = ({
  rows,
  generatedAt,
}) => (
  <div style={{ ...PANEL, padding: 24 }}>
    <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 4 }}>Validator set</h2>
    <p style={{ fontSize: 12, color: '#888', marginTop: 0, marginBottom: 16 }}>
      As reported by the nodes above. Not attested — a node can list validators that do not exist.
    </p>
    {rows.length === 0 ? (
      <p style={{ color: '#666', fontSize: 13, margin: 0 }}>
        No validators reported by any reachable node.
      </p>
    ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #333', textAlign: 'left', color: '#888' }}>
              <th style={{ padding: '8px 4px' }}>Validator</th>
              <th>Phase (rad)</th>
              <th>Natural freq (Hz)</th>
              <th>Node-reported age</th>
              <th>Reported by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ageMs = validatorSampleAgeMs(row, generatedAt);
              return (
                <tr key={row.id} style={{ borderBottom: '1px solid #222' }}>
                  <td style={{ padding: '8px 4px', fontFamily: 'monospace' }} title={row.id}>
                    <StatusDot color={row.disputed ? HEALTH_COLORS.stale : HEALTH_COLORS.live} />
                    {shortId(row.id)}
                    {row.disputed && (
                      <span style={{ color: '#f59e0b', marginLeft: 8, fontFamily: 'inherit' }}>
                        disputed
                      </span>
                    )}
                  </td>
                  <td style={{ fontFamily: 'monospace' }}>{row.phase.toFixed(3)}</td>
                  <td style={{ fontFamily: 'monospace' }}>
                    {row.naturalFrequency === null ? '—' : row.naturalFrequency.toFixed(3)}
                  </td>
                  <td style={{ color: '#888' }}>{ageMs === null ? '—' : formatAge(ageMs)}</td>
                  <td style={{ color: '#888', fontFamily: 'monospace' }}>
                    {row.reportedBy.join(', ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

// ─── Unavailable metrics ─────────────────────────────────────────────────────

const UnavailableMetrics: React.FC<{ overview: ValidatorOverview }> = ({ overview }) => {
  if (overview.unavailableMetrics.length === 0) return null;
  return (
    <div style={{ ...PANEL, padding: 24, marginTop: 24 }} data-testid="validator-unavailable-metrics">
      <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 4 }}>Not available from this RPC</h2>
      <p style={{ fontSize: 12, color: '#888', marginTop: 0, marginBottom: 16 }}>
        Requested by the wave-2a design but not exposed by the oxscada node. Shown here rather than
        rendered as an empty chart, which would read as &ldquo;zero&rdquo;.
      </p>
      <ul style={{ margin: 0, paddingLeft: 20, color: '#d4d4d4', fontSize: 13, lineHeight: 1.6 }}>
        {overview.unavailableMetrics.map((item) => (
          <li key={item.metric} style={{ marginBottom: 8 }}>
            <code style={{ fontFamily: 'monospace', color: '#e5e5e5' }}>{item.metric}</code> —{' '}
            <span style={{ color: '#888' }}>{item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ─── Page ────────────────────────────────────────────────────────────────────

const ValidatorDashboard: React.FC = () => {
  const { overview, loading, error, errorStatus, receivedAt, refresh } = useValidatorOverview();

  // Age of the on-screen data on the CLIENT clock — the only clock this browser
  // can compare `Date.now()` against.
  const overviewAgeMs = receivedAt === null ? Number.POSITIVE_INFINITY : Date.now() - receivedAt;
  const reachable = overview ? overview.nodes.filter((n) => n.reachable).length : 0;
  const disputedCount = overview ? overview.validators.filter((v) => v.disputed).length : 0;
  const needsCredential = errorStatus === 401 || errorStatus === 403;

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 28 }}>Validator Dashboard</h1>
        <button
          type="button"
          onClick={refresh}
          style={{
            padding: '8px 16px',
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: 6,
            color: '#e5e5e5',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          Refresh
        </button>
      </div>
      <p style={{ color: '#888', fontSize: 14, margin: '0 0 20px' }}>
        Server-polled oxscada :9090 RPC via /api/validators
        {overview && ` — ${reachable}/${overview.nodes.length} nodes reachable`}
        {receivedAt !== null && (
          <span style={{ marginLeft: 8, color: '#666' }}>
            · updated {new Date(receivedAt).toLocaleTimeString()}
          </span>
        )}
      </p>

      {error && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            marginBottom: 20,
            borderRadius: 8,
            border: '1px solid #ef4444',
            backgroundColor: '#450a0a',
            color: '#fca5a5',
            fontSize: 13,
          }}
        >
          {error}
          {needsCredential && (
            <span style={{ display: 'block', marginTop: 6, color: '#fecaca' }}>
              Paste an API key granting <code style={{ fontFamily: 'monospace' }}>validators.read</code>{' '}
              into the header credential box.
            </span>
          )}
        </div>
      )}

      {loading && overview === null && (
        <div style={{ ...PANEL, padding: 24, textAlign: 'center', color: '#888' }}>
          Loading validator overview…
        </div>
      )}

      {overview && !overview.configured && (
        <div style={{ ...PANEL, padding: 24, color: '#f59e0b' }}>
          No validator nodes configured. Set{' '}
          <code style={{ fontFamily: 'monospace' }}>ANCHOR_NODE_URLS</code> in the server environment
          (csv of node base URLs). The server performs no outbound request until it is set.
        </div>
      )}

      {overview && overview.configured && (
        <>
          <ProvenanceBanner provenance={overview.provenance} disputedCount={disputedCount} />

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 16,
              marginBottom: 24,
            }}
          >
            <CoherenceIndicator overview={overview} />
            <NodeHealthPanel overview={overview} overviewAgeMs={overviewAgeMs} />
          </div>

          <ValidatorTable rows={overview.validators} generatedAt={overview.generatedAt} />
          <UnavailableMetrics overview={overview} />
        </>
      )}
    </div>
  );
};

export default ValidatorDashboard;
