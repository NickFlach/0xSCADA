/**
 * ValidatorDashboard — live operator surface for the oxscada validator set.
 *
 * Issue #453 — [wave:2a] Build Validator Dashboard (live :9090 RPC visualization).
 *
 * Consumes each configured oxscada node's :9090 RPC (/status + /events) and renders:
 *   - per-validator rows: phase, frequency, last-seen, attestation rate over last N rounds
 *   - anchor-batch throughput chart (txs/min, bytes/min, batch-size distribution)
 *   - a Kuramoto coherence indicator (mean phase coupling) that turns red below threshold
 *
 * Polling + transport lives in `useValidatorNodes` / `lib/oxscada-rpc`. All derived
 * numbers come from the pure `lib/validator-metrics` functions (unit-tested). This
 * component is intentionally presentational + composition only.
 *
 * INTEGRATION (#442): the node /status + /events payload shapes are defined locally
 * in `lib/oxscada-rpc.ts`; align them with #442's validator-monitor types when that
 * branch merges. See the integration note in that file.
 */

import React, { useMemo } from 'react';
import { useValidatorNodes } from '../hooks/use-validator-nodes';
import {
  STALE_THRESHOLD_MS,
  COHERENCE_RED_THRESHOLD,
  classifyNodeHealth,
  lastSeenMillis,
  formatAge,
  kuramotoCoherence,
  isCoherenceCritical,
  aggregateThroughput,
  buildValidatorRows,
  type NodeHealth,
} from '../lib/validator-metrics';
import type { NodeStatus, ValidatorEvent } from '../lib/oxscada-rpc';

/** Rounds of history used for the attestation-rate window. */
const ATTESTATION_WINDOW_ROUNDS = 32;

const HEALTH_COLORS: Record<NodeHealth, string> = {
  live: '#22c55e',
  stale: '#f59e0b',
  error: '#ef4444',
};

const StatusDot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', backgroundColor: color, marginRight: 6 }}
  />
);

/** Color ramp for attestation rate. */
function rateColor(rate: number | null): string {
  if (rate === null) return '#6b7280';
  if (rate >= 0.95) return '#22c55e';
  if (rate >= 0.8) return '#f59e0b';
  return '#ef4444';
}

// ─── Throughput chart (lightweight inline SVG; no chart dependency) ────────────

const ThroughputChart: React.FC<{ events: ValidatorEvent[]; now: number }> = ({ events, now }) => {
  const summary = useMemo(() => aggregateThroughput(events, now), [events, now]);
  const { series, txsPerMin, bytesPerMin, batchSizeDistribution } = summary;

  const W = 520;
  const H = 120;
  const pad = 4;
  const maxTxs = Math.max(1, ...series.map((p) => p.txs));
  const barW = series.length > 0 ? (W - pad * 2) / series.length : 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <Metric label="txs / min" value={txsPerMin.toFixed(1)} color="#60a5fa" />
        <Metric label="bytes / min" value={formatBytes(bytesPerMin)} color="#60a5fa" />
        <Metric label="batches" value={String(batchSizeDistribution.reduce((a, b) => a + b.count, 0))} color="#a78bfa" />
      </div>

      {series.length === 0 ? (
        <p style={{ color: '#666', fontSize: 13, padding: '12px 0' }}>No anchor batches in the last 10 minutes.</p>
      ) : (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Anchor throughput per minute" style={{ display: 'block' }}>
          {series.map((p, i) => {
            const h = (p.txs / maxTxs) * (H - pad * 2);
            return (
              <rect
                key={p.bucketStart}
                x={pad + i * barW + 1}
                y={H - pad - h}
                width={Math.max(1, barW - 2)}
                height={h}
                fill="#3b82f6"
                rx={1}
              >
                <title>{`${new Date(p.bucketStart).toLocaleTimeString()} — ${p.txs} txs, ${formatBytes(p.bytes)}`}</title>
              </rect>
            );
          })}
        </svg>
      )}

      {/* Batch-size distribution */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Batch-size distribution</div>
        {batchSizeDistribution.length === 0 ? (
          <span style={{ fontSize: 12, color: '#666' }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {batchSizeDistribution.map((d) => (
              <span
                key={d.size}
                style={{
                  fontSize: 12,
                  fontFamily: 'monospace',
                  padding: '2px 8px',
                  backgroundColor: '#0a0a0a',
                  border: '1px solid #333',
                  borderRadius: 4,
                }}
              >
                {d.size}×<span style={{ color: '#888' }}>{` (${d.count})`}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div>
    <div style={{ fontSize: 11, color: '#888' }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 'bold', color }}>{value}</div>
  </div>
);

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Coherence indicator ───────────────────────────────────────────────────────

const CoherenceIndicator: React.FC<{ r: number; count: number }> = ({ r, count }) => {
  const critical = isCoherenceCritical(r, COHERENCE_RED_THRESHOLD);
  const color = critical ? '#ef4444' : r >= 0.9 ? '#22c55e' : '#f59e0b';
  const pct = Math.round(r * 100);
  return (
    <div
      style={{
        padding: 20,
        backgroundColor: '#111827',
        borderRadius: 8,
        border: `1px solid ${critical ? '#ef4444' : '#374151'}`,
      }}
    >
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Kuramoto coherence (mean phase coupling)</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 40, fontWeight: 'bold', color }}>{r.toFixed(3)}</span>
        <span style={{ fontSize: 14, color: '#888' }}>r over {count} validators</span>
      </div>
      {/* Bar with threshold marker */}
      <div style={{ position: 'relative', height: 10, backgroundColor: '#0a0a0a', borderRadius: 5, marginTop: 12 }}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: color, borderRadius: 5 }} />
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
          ⚠ Coherence below {COHERENCE_RED_THRESHOLD} — validator set is desynchronizing.
        </div>
      )}
    </div>
  );
};

// ─── Main page ──────────────────────────────────────────────────────────────

const ValidatorDashboard: React.FC = () => {
  const { results, loading, lastPollAt, refresh } = useValidatorNodes();
  const now = lastPollAt ?? Date.now();

  // Merge data only from live/stale-with-data nodes; errored nodes contribute none.
  const liveStatuses: NodeStatus[] = useMemo(
    () => results.map((r) => r.status).filter((s): s is NodeStatus => s !== null),
    [results],
  );
  const allEvents: ValidatorEvent[] = useMemo(() => results.flatMap((r) => r.events), [results]);

  const rows = useMemo(
    () => buildValidatorRows(liveStatuses, allEvents, ATTESTATION_WINDOW_ROUNDS),
    [liveStatuses, allEvents],
  );

  // Coherence uses the most recent merged phases per validator (from rows).
  const coherence = useMemo(() => kuramotoCoherence(rows.map((row) => ({ phase: row.phase }))), [rows]);

  const reachable = results.filter((r) => classifyNodeHealth(r, now) === 'live').length;

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>🛰️ Validator Dashboard</h1>
        <button
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
          🔄 Refresh
        </button>
      </div>
      <p style={{ color: '#888', fontSize: 14, margin: '0 0 24px' }}>
        Live :9090 RPC — {reachable}/{results.length} nodes reachable
        {lastPollAt && <span style={{ marginLeft: 8, color: '#666' }}>· updated {new Date(lastPollAt).toLocaleTimeString()}</span>}
      </p>

      {/* Loading / empty states */}
      {loading && (
        <div style={{ padding: 24, backgroundColor: '#111827', borderRadius: 8, textAlign: 'center', color: '#888' }}>
          Connecting to configured nodes…
        </div>
      )}

      {!loading && results.length === 0 && (
        <div style={{ padding: 24, backgroundColor: '#111827', borderRadius: 8, color: '#f59e0b' }}>
          No nodes configured. Set <code style={{ fontFamily: 'monospace' }}>VITE_ANCHOR_NODE_URLS</code> (csv of base URLs).
        </div>
      )}

      {!loading && results.length > 0 && (
        <>
          {/* Top row: coherence + node health */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <CoherenceIndicator r={coherence.r} count={coherence.count} />

            <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Node health</div>
              {results.map((r) => {
                const health = classifyNodeHealth(r, now);
                const age = now - lastSeenMillis(r);
                return (
                  <div
                    key={r.nodeUrl}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: 13 }}
                  >
                    <span style={{ fontFamily: 'monospace' }}>
                      <StatusDot color={HEALTH_COLORS[health]} />
                      {r.nodeUrl}
                    </span>
                    <span style={{ color: HEALTH_COLORS[health] }}>
                      {health === 'error' ? (r.error ?? 'error') : `${health} · ${formatAge(age)}`}
                    </span>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, fontSize: 11, color: '#666' }}>
                Rows go stale after {(STALE_THRESHOLD_MS / 1000).toFixed(0)}s without a response.
              </div>
            </div>
          </div>

          {/* Validator set table */}
          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 16 }}>Validator set</h2>
            {rows.length === 0 ? (
              <p style={{ color: '#666', fontSize: 13 }}>No validators reported by any reachable node.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #333', textAlign: 'left', color: '#888' }}>
                    <th style={{ padding: '8px 4px' }}>Validator</th>
                    <th>Phase (rad)</th>
                    <th>Freq (Hz)</th>
                    <th>Last seen</th>
                    <th>Attestation ({ATTESTATION_WINDOW_ROUNDS} rounds)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const age = now - row.lastSeen;
                    const rowStale = age >= STALE_THRESHOLD_MS;
                    const rate = row.attestationRate;
                    return (
                      <tr key={row.id} style={{ borderBottom: '1px solid #222', opacity: rowStale ? 0.55 : 1 }}>
                        <td style={{ padding: '8px 4px', fontFamily: 'monospace' }}>
                          <StatusDot color={rowStale ? HEALTH_COLORS.stale : HEALTH_COLORS.live} />
                          {row.label}
                        </td>
                        <td style={{ fontFamily: 'monospace' }}>{row.phase.toFixed(3)}</td>
                        <td style={{ fontFamily: 'monospace' }}>{row.frequency.toFixed(3)}</td>
                        <td style={{ color: rowStale ? HEALTH_COLORS.stale : '#888' }}>
                          {formatAge(age)}
                          {rowStale && ' (stale)'}
                        </td>
                        <td style={{ fontFamily: 'monospace', color: rateColor(rate) }}>
                          {rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Anchor throughput */}
          <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
            <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 16 }}>Anchor-batch throughput</h2>
            <ThroughputChart events={allEvents} now={now} />
          </div>
        </>
      )}
    </div>
  );
};

export default ValidatorDashboard;
