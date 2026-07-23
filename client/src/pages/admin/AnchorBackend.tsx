/**
 * Admin: Anchor-Backend Switch (#455)
 *
 * Operator-facing tool to inspect and flip the active anchoring backend
 * (l2 | node | both) at runtime. Workflow:
 *   1. Operator picks a target backend and runs a DRY-RUN.
 *   2. The dry-run shows projected events/min per backend, confirmation
 *      latencies and daily anchor cost, and captures a backend revision.
 *   3. A sanity dialog forces the operator to explicitly confirm before the
 *      switch is committed against that exact reviewed revision.
 *   4. Past switches are listed from server-side history.
 *
 * Styling follows the inline-style convention used by the other wave pages.
 */

import React, { useCallback, useState } from 'react';

type Backend = 'l2' | 'node' | 'both';

interface BackendRouting {
  backend: 'l2' | 'node';
  eventsPerMinute: number;
  confirmationLatencyMs: number;
  dailyCostUsd: number;
}

interface SwitchProjection {
  backend: Backend;
  totalEventsPerMinute: number;
  routes: BackendRouting[];
  effectiveConfirmationLatencyMs: number;
  totalDailyCostUsd: number;
}

interface DryRunResponse {
  dryRun: true;
  currentBackend: Backend;
  backendRevision: number;
  proposedBackend: Backend;
  coordination: {
    ready: boolean;
    replicas: number;
    reason?: string;
  };
  runtimeReady: boolean;
  /** The commit endpoint can attempt hidden L2 initialization before mutation. */
  runtimePreparationSupported: boolean;
  projection: SwitchProjection;
}

interface SwitchHistoryEntry {
  id: string;
  at: string;
  previous: Backend;
  current: Backend;
  operator: string;
  auditQueueId: string;
  auditStatus: 'queued';
}

interface StatusResponse {
  backend: Backend;
  backendRevision: number;
  history: SwitchHistoryEntry[];
}

const API_BASE = '/api/admin/anchor-backend';

const BACKEND_LABELS: Record<Backend, string> = {
  l2: 'L2 Rollup',
  node: 'Node Chain (local)',
  both: 'Both (fan-out)',
};

const AnchorBackend: React.FC = () => {
  const [currentBackend, setCurrentBackend] = useState<Backend | null>(null);
  const [history, setHistory] = useState<SwitchHistoryEntry[]>([]);
  const [target, setTarget] = useState<Backend>('node');
  const [eventsPerMinute, setEventsPerMinute] = useState<number>(120);
  // Kept only in component memory. Never persisted to localStorage or a URL.
  const [apiKey, setApiKey] = useState<string>('');

  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!apiKey) {
      setError('Enter an operator API key first');
      return;
    }
    try {
      setError(null);
      const res = await fetch(API_BASE, {
        headers: { 'X-API-Key': apiKey },
      });
      if (!res.ok) throw new Error('Failed to load anchor backend status');
      const data: StatusResponse = await res.json();
      setCurrentBackend(data.backend);
      setHistory(data.history ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiKey]);

  const runDryRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setDryRun(null);
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ backend: target, dryRun: true, eventsPerMinute }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Dry-run failed');
      setDryRun(data as DryRunResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, eventsPerMinute, apiKey]);

  const commitSwitch = useCallback(async () => {
    if (!dryRun) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          backend: dryRun.proposedBackend,
          dryRun: false,
          confirm: true,
          expectedCurrentBackend: dryRun.currentBackend,
          expectedBackendRevision: dryRun.backendRevision,
          eventsPerMinute,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (
          data.code === 'anchor-backend-preview-stale' ||
          data.code === 'anchor-backend-state-changed'
        ) {
          setShowConfirm(false);
          setDryRun(null);
        }
        throw new Error(data.error ?? 'Switch failed');
      }
      setNotice(
        `Anchor backend switched to "${data.currentBackend}". ` +
          `Audit intent ${data.auditStatus}: ${data.auditQueueId}`,
      );
      setShowConfirm(false);
      setDryRun(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [dryRun, eventsPerMinute, apiKey, loadStatus]);

  const canAttemptCommit = !!dryRun &&
    dryRun.coordination.ready &&
    (dryRun.runtimeReady || dryRun.runtimePreparationSupported);

  return (
    <div style={{ padding: 24, backgroundColor: '#0a0a0a', color: '#e5e5e5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>⚓ Anchor-Backend Switch</h1>
        <p style={{ color: '#888', fontSize: 16, margin: 0 }}>
          Inspect and switch the active blockchain anchoring backend at runtime.
        </p>
      </div>

      <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, marginBottom: 24 }}>
        <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Operator authentication</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13, color: '#888', gap: 4 }}>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder="X-API-Key"
              onChange={(e) => setApiKey(e.target.value)}
              style={inputStyle}
            />
          </label>
          <button onClick={() => void loadStatus()} disabled={busy || !apiKey} style={primaryButtonStyle(busy || !apiKey)}>
            Authenticate
          </button>
          <span style={{ color: '#888', fontSize: 12 }}>
            Audit identity comes from the server-owned key record.
          </span>
        </div>
      </div>

      {/* Current backend */}
      <div style={{ padding: 20, backgroundColor: '#111827', borderRadius: 8, marginBottom: 24 }}>
        <div style={{ fontSize: 14, color: '#888', marginBottom: 8 }}>Current Active Backend</div>
        <div style={{ fontSize: 24, fontWeight: 'bold', color: '#60a5fa' }}>
          {currentBackend ? BACKEND_LABELS[currentBackend] : '…'}
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, backgroundColor: '#7f1d1d', borderRadius: 6, marginBottom: 16, color: '#fff' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ padding: 12, backgroundColor: '#14532d', borderRadius: 6, marginBottom: 16, color: '#fff' }}>
          {notice}
        </div>
      )}

      {/* Switch form */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>Propose a Switch</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13, color: '#888', gap: 4 }}>
            Target backend
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as Backend)}
              style={inputStyle}
            >
              <option value="l2">L2 Rollup</option>
              <option value="node">Node Chain (local)</option>
              <option value="both">Both (fan-out)</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 13, color: '#888', gap: 4 }}>
            Events / min
            <input
              type="number"
              min={0}
              value={eventsPerMinute}
              onChange={(e) => setEventsPerMinute(Number(e.target.value))}
              style={inputStyle}
            />
          </label>
          <button onClick={runDryRun} disabled={busy || !apiKey} style={primaryButtonStyle(busy || !apiKey)}>
            🔍 Run Dry-Run
          </button>
        </div>
      </div>

      {/* Dry-run projection */}
      {dryRun && (
        <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>
            Projection: {BACKEND_LABELS[dryRun.proposedBackend]}
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ color: '#888', textAlign: 'left' }}>
                <th style={thStyle}>Backend</th>
                <th style={thStyle}>Events / min</th>
                <th style={thStyle}>Confirm latency</th>
                <th style={thStyle}>Daily cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {dryRun.projection.routes.map((r) => (
                <tr key={r.backend} style={{ borderTop: '1px solid #333' }}>
                  <td style={tdStyle}>{BACKEND_LABELS[r.backend]}</td>
                  <td style={tdStyle}>{r.eventsPerMinute}</td>
                  <td style={tdStyle}>{(r.confirmationLatencyMs / 1000).toFixed(1)}s</td>
                  <td style={tdStyle}>${r.dailyCostUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 16, fontSize: 14, color: '#ccc' }}>
            Effective confirmation latency:{' '}
            <strong>{(dryRun.projection.effectiveConfirmationLatencyMs / 1000).toFixed(1)}s</strong>
            {'  ·  '}
            Total daily cost: <strong>${dryRun.projection.totalDailyCostUsd.toFixed(2)}</strong>
          </div>
          {!dryRun.coordination.ready && (
            <div style={{ marginTop: 16, padding: 12, backgroundColor: '#7f1d1d', borderRadius: 6 }}>
              {dryRun.coordination.reason ??
                'Live switching is unavailable for this deployment topology.'}
            </div>
          )}
          {dryRun.coordination.ready &&
            !dryRun.runtimeReady &&
            dryRun.runtimePreparationSupported && (
            <div style={{ marginTop: 16, padding: 12, backgroundColor: '#78350f', borderRadius: 6 }}>
              The target L2 runtime is not currently ready. Commit will attempt
              to initialize and verify it before changing routing. If readiness
              cannot be established, the current backend will remain active.
            </div>
          )}
          {dryRun.coordination.ready &&
            !dryRun.runtimeReady &&
            !dryRun.runtimePreparationSupported && (
            <div style={{ marginTop: 16, padding: 12, backgroundColor: '#7f1d1d', borderRadius: 6 }}>
              The target backend runtime is unavailable and cannot be prepared
              by this control plane.
            </div>
          )}
          <button
            onClick={() => setShowConfirm(true)}
            disabled={busy || !canAttemptCommit}
            style={{
              ...primaryButtonStyle(busy || !canAttemptCommit),
              marginTop: 20,
              backgroundColor: '#ef4444',
            }}
          >
            ⚠️ Commit Switch
          </button>
        </div>
      )}

      {/* Sanity dialog */}
      {showConfirm && dryRun && (
        <div style={overlayStyle} role="dialog" aria-modal="true">
          <div style={dialogStyle}>
            <h3 style={{ marginTop: 0, fontSize: 18 }}>Confirm Anchor-Backend Switch</h3>
            <p style={{ color: '#ccc', fontSize: 14, lineHeight: 1.6 }}>
              You are about to switch the active anchoring backend from{' '}
              <strong>{BACKEND_LABELS[dryRun.currentBackend]}</strong> to{' '}
              <strong style={{ color: '#f59e0b' }}>{BACKEND_LABELS[dryRun.proposedBackend]}</strong>.
              This changes where future events are routed after the selected
              backend queues the authorized switch intent.
            </p>
            <p style={{ color: '#888', fontSize: 12 }}>
              Your authenticated operator identity will be written to the audit event.
            </p>
            <div style={{ display: 'flex', gap: 12, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowConfirm(false)} disabled={busy} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                onClick={commitSwitch}
                disabled={busy}
                style={{ ...primaryButtonStyle(busy), backgroundColor: '#ef4444' }}
              >
                {busy ? 'Switching…' : 'Yes, switch backend'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      <div style={{ backgroundColor: '#111827', borderRadius: 8, padding: 24 }}>
        <h2 style={{ fontSize: 20, marginTop: 0, marginBottom: 16 }}>📖 Switch History</h2>
        {history.length === 0 ? (
          <p style={{ color: '#888', fontSize: 14 }}>No switches recorded yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#888', textAlign: 'left' }}>
                <th style={thStyle}>When</th>
                <th style={thStyle}>From → To</th>
                <th style={thStyle}>Operator</th>
                <th style={thStyle}>Audit queue</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} style={{ borderTop: '1px solid #333' }}>
                  <td style={tdStyle}>{new Date(h.at).toLocaleString()}</td>
                  <td style={tdStyle}>
                    {h.previous} → <strong>{h.current}</strong>
                  </td>
                  <td style={tdStyle}>{h.operator}</td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', color: '#60a5fa' }}>
                    {h.auditQueueId} ({h.auditStatus})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ── Inline styles (matching the other wave pages) ─────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  backgroundColor: '#0a0a0a',
  border: '1px solid #374151',
  borderRadius: 6,
  color: '#e5e5e5',
  fontSize: 14,
  minWidth: 160,
};

const thStyle: React.CSSProperties = { padding: '8px 12px', fontWeight: 'normal' };
const tdStyle: React.CSSProperties = { padding: '8px 12px' };

const primaryButtonStyle = (busy: boolean): React.CSSProperties => ({
  padding: '10px 24px',
  backgroundColor: '#3b82f6',
  border: 'none',
  borderRadius: 6,
  color: 'white',
  cursor: busy ? 'not-allowed' : 'pointer',
  opacity: busy ? 0.6 : 1,
  fontSize: 14,
  fontWeight: 'bold',
});

const secondaryButtonStyle: React.CSSProperties = {
  padding: '10px 24px',
  backgroundColor: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 6,
  color: '#e5e5e5',
  cursor: 'pointer',
  fontSize: 14,
};

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: '#111827',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: '90%',
};

export default AnchorBackend;
