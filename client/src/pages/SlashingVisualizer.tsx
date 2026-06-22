/**
 * Slashing & Liveness Visualizer (issue #456).
 *
 * Per-validator attestation participation timeline (hits / misses / late) over a
 * selectable window (1h / 24h / 7d), with consecutive-miss "liveness fault" runs
 * highlighted, plus a "what-if" slashing-rule simulator. The operator types a
 * proposed rule (e.g. "slash 1% per miss after 10 in 1h"); the UI projects the
 * hypothetical penalties against the ACTUAL history.
 *
 * This page performs READ + PROJECTION only — it never slashes and never mutates
 * server state. All penalty math is delegated to the pure simulator in
 * ../lib/slashing-simulator so it can be unit-tested independently of the UI.
 *
 * Data source: GET /api/nodes/history (server/routes/nodes.ts).
 */

import React from "react";
import {
  bucketTimeline,
  parseRulePhrase,
  simulateRule,
  type TimelineBucket,
} from "../lib/slashing-simulator";
import type {
  SimulationResult,
  SlashingRule,
  TimelineWindow,
  ValidatorHistory,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

// --- palette (matches the existing dark dashboard pages) ---
const C = {
  bg: "#0a0a0a",
  panel: "#111827",
  border: "#374151",
  text: "#e5e5e5",
  muted: "#888",
  hit: "#22c55e",
  late: "#f59e0b",
  miss: "#ef4444",
  accent: "#60a5fa",
};

interface HistoryResponse {
  window: TimelineWindow;
  anchorMs: number;
  seed: number;
  validators: ValidatorHistory[];
}

const WINDOWS: TimelineWindow[] = ["1h", "24h", "7d"];

/** Human-friendly rendering of a window duration in milliseconds. */
function formatDuration(ms: number): string {
  const h = ms / (60 * 60 * 1000);
  if (h >= 24 && h % 24 === 0) return `${h / 24}d`;
  if (h >= 1 && Number.isInteger(h)) return `${h}h`;
  const m = ms / (60 * 1000);
  return `${m.toFixed(0)}m`;
}

// --- small presentational helpers ---------------------------------------------

const StatusCell: React.FC<{ bucket: TimelineBucket }> = ({ bucket }) => {
  // Colour the cell by the worst status present (miss > late > hit > empty).
  let color = "#1f2937";
  if (bucket.total > 0) {
    if (bucket.misses > 0) color = C.miss;
    else if (bucket.late > 0) color = C.late;
    else color = C.hit;
  }
  const title =
    bucket.total === 0
      ? "no duties"
      : `${bucket.hits} hit / ${bucket.misses} miss / ${bucket.late} late`;
  return (
    <div
      title={title}
      style={{
        flex: 1,
        height: 28,
        minWidth: 4,
        backgroundColor: color,
        borderRadius: 2,
        opacity: bucket.total === 0 ? 0.35 : 1,
      }}
    />
  );
};

const Legend: React.FC = () => (
  <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.muted, alignItems: "center" }}>
    {[
      { label: "Hit", color: C.hit },
      { label: "Late", color: C.late },
      { label: "Miss", color: C.miss },
    ].map((l) => (
      <span key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 12, height: 12, backgroundColor: l.color, borderRadius: 2, display: "inline-block" }} />
        {l.label}
      </span>
    ))}
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 12, height: 12, border: `2px solid ${C.miss}`, borderRadius: 2, display: "inline-block" }} />
      Liveness fault run
    </span>
  </div>
);

// --- per-validator card --------------------------------------------------------

const ValidatorCard: React.FC<{
  history: ValidatorHistory;
  window: TimelineWindow;
  rule: SlashingRule;
  anchorMs: number;
}> = ({ history, window, rule, anchorMs }) => {
  // Restrict to the selected window, then project the rule (pure).
  const result: SimulationResult = React.useMemo(
    () => simulateRule(history, rule, window, anchorMs),
    [history, rule, window, anchorMs],
  );

  // Compact timeline buckets sized to the window.
  const bucketCount = window === "1h" ? 30 : window === "24h" ? 48 : 28;
  const buckets = React.useMemo(
    () => bucketTimeline(result.evaluated, window, bucketCount, anchorMs),
    [result.evaluated, window, bucketCount, anchorMs],
  );

  const { summary } = result;
  const ratePct = (summary.participationRate * 100).toFixed(1);
  const rateColor =
    summary.participationRate >= 0.99 ? C.hit : summary.participationRate >= 0.95 ? C.late : C.miss;

  return (
    <div style={{ backgroundColor: C.panel, borderRadius: 8, padding: 20, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 18, fontWeight: "bold" }}>{history.label}</span>
          <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{history.validatorId}</span>
        </div>
        <div style={{ fontSize: 13, color: C.muted }}>
          Stake: <strong style={{ color: C.text }}>{history.stake.toLocaleString()}</strong>
        </div>
      </div>

      {/* participation stats */}
      <div style={{ display: "flex", gap: 24, fontSize: 13, marginBottom: 12 }}>
        <span>Participation: <strong style={{ color: rateColor }}>{ratePct}%</strong></span>
        <span style={{ color: C.muted }}>Duties: {summary.total}</span>
        <span style={{ color: C.hit }}>Hits: {summary.hits}</span>
        <span style={{ color: C.late }}>Late: {summary.late}</span>
        <span style={{ color: C.miss }}>Misses: {summary.misses}</span>
        <span style={{ color: result.livenessFaults.length ? C.miss : C.muted }}>
          Liveness faults: {result.livenessFaults.length}
        </span>
      </div>

      {/* timeline */}
      <div style={{ display: "flex", gap: 2, marginBottom: 8 }}>
        {buckets.map((b) => (
          <StatusCell key={b.index} bucket={b} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 12 }}>
        <span>-{window}</span>
        <span>now</span>
      </div>

      {/* liveness fault runs */}
      {result.livenessFaults.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.miss, fontWeight: "bold", marginBottom: 6 }}>
            ⚠ Consecutive-miss runs (≥ {rule.livenessRunThreshold ?? 3})
          </div>
          {result.livenessFaults.map((run, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                color: C.text,
                border: `1px solid ${C.miss}`,
                borderRadius: 4,
                padding: "4px 8px",
                marginBottom: 4,
              }}
            >
              {run.length} consecutive misses — slots {run.startSlot}…{run.endSlot}
              {"  "}
              <span style={{ color: C.muted }}>
                ({new Date(run.startTimestamp).toLocaleTimeString()} → {new Date(run.endTimestamp).toLocaleTimeString()})
              </span>
            </div>
          ))}
        </div>
      )}

      {/* what-if penalty projection */}
      <div
        style={{
          backgroundColor: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          Hypothetical penalty under <em>{rule.name}</em>:
        </div>
        <div style={{ display: "flex", gap: 24, alignItems: "baseline" }}>
          <span style={{ fontSize: 28, fontWeight: "bold", color: result.totalPenaltyPct > 0 ? C.miss : C.hit }}>
            {result.totalPenaltyPct.toFixed(2)}%
          </span>
          <span style={{ fontSize: 14, color: C.muted }}>
            ≈ {result.totalPenaltyAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} stake
          </span>
          <span style={{ fontSize: 13, color: C.muted }}>
            {result.penalties.filter((p) => p.penaltyPct > 0).length} penalised miss(es)
          </span>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
          Projection only — no slashing is performed.
        </div>
      </div>
    </div>
  );
};

// --- main page -----------------------------------------------------------------

const SlashingVisualizer: React.FC = () => {
  const [window, setWindow] = React.useState<TimelineWindow>("24h");
  const [data, setData] = React.useState<HistoryResponse | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  // What-if rule inputs.
  const [phrase, setPhrase] = React.useState<string>("slash 1% per miss after 10 in 24h");
  const [livenessThreshold, setLivenessThreshold] = React.useState<number>(3);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/nodes/history?window=${window}`)
      .then((res) => {
        if (!res.ok) throw new Error(`history request failed: ${res.status}`);
        return res.json() as Promise<HistoryResponse>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  // Derive the active rule from the operator's phrase. Fall back to a default
  // window-scoped rule when the phrase cannot be parsed.
  const parsed = React.useMemo(() => parseRulePhrase(phrase), [phrase]);
  const rule: SlashingRule = React.useMemo(() => {
    const base: SlashingRule =
      parsed ?? {
        name: phrase || "unparsed rule",
        missThreshold: 10,
        windowMs: WINDOW_MS[window],
        penaltyPctPerMiss: 1,
      };
    return { ...base, name: phrase || base.name, livenessRunThreshold: livenessThreshold };
  }, [parsed, phrase, window, livenessThreshold]);

  const anchorMs = data?.anchorMs ?? Date.now();

  return (
    <div style={{ padding: 24, backgroundColor: C.bg, color: C.text, minHeight: "100vh" }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>⚖️ Slashing & Liveness Visualizer</h1>
        <p style={{ color: C.muted, fontSize: 15, margin: 0 }}>
          Per-validator attestation participation, liveness-fault detection, and a what-if
          slashing-rule simulator. Read-only — nothing is slashed.
        </p>
      </div>

      {/* controls */}
      <div
        style={{
          backgroundColor: C.panel,
          borderRadius: 8,
          padding: 16,
          marginBottom: 20,
          display: "flex",
          flexWrap: "wrap",
          gap: 24,
          alignItems: "flex-end",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Timeline window</div>
          <div style={{ display: "flex", gap: 8 }}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                style={{
                  padding: "8px 16px",
                  backgroundColor: window === w ? C.accent : "#1f2937",
                  border: `1px solid ${window === w ? C.accent : C.border}`,
                  borderRadius: 6,
                  color: window === w ? "#0a0a0a" : C.text,
                  cursor: "pointer",
                  fontWeight: window === w ? "bold" : "normal",
                }}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
            What-if slashing rule (e.g. &quot;slash 1% per miss after 10 in 24h&quot;)
          </div>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              padding: "8px 12px",
              backgroundColor: C.bg,
              border: `1px solid ${parsed ? C.border : C.late}`,
              borderRadius: 6,
              color: C.text,
              fontSize: 14,
              fontFamily: "monospace",
            }}
          />
          <div style={{ fontSize: 11, color: parsed ? C.muted : C.late, marginTop: 4 }}>
            {parsed
              ? `Parsed: ${parsed.penaltyPctPerMiss}% per miss after ${parsed.missThreshold} in ${formatDuration(parsed.windowMs)} window`
              : "Could not parse — using default (1% per miss after 10, window = selected timeline)."}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Liveness run threshold</div>
          <input
            type="number"
            min={1}
            value={livenessThreshold}
            onChange={(e) => setLivenessThreshold(Math.max(1, Number(e.target.value) || 1))}
            style={{
              width: 80,
              padding: "8px 12px",
              backgroundColor: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.text,
              fontSize: 14,
            }}
          />
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Legend />
      </div>

      {loading && <div style={{ color: C.muted }}>Loading attestation history…</div>}
      {error && (
        <div style={{ color: C.miss, backgroundColor: C.panel, padding: 16, borderRadius: 8 }}>
          Failed to load history: {error}
        </div>
      )}

      {!loading && !error && data && data.validators.length === 0 && (
        <div style={{ color: C.muted }}>No validators reported.</div>
      )}

      {!loading &&
        !error &&
        data &&
        data.validators.map((h) => (
          <ValidatorCard key={h.validatorId} history={h} window={window} rule={rule} anchorMs={anchorMs} />
        ))}
    </div>
  );
};

export default SlashingVisualizer;
