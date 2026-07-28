/**
 * Slashing & Liveness Visualizer (issue #456).
 *
 * Per-validator participation timeline (hits / misses / late) over a selectable
 * window (1h / 24h / 7d) — of whatever the loaded source measured, which in this
 * build is observed liveness, not consensus attestation duties — with
 * consecutive-miss "liveness fault" runs
 * highlighted, plus a "what-if" slashing-rule simulator. The operator types a
 * proposed rule (e.g. "slash 1% per miss after 10 in 1h"); the UI projects the
 * hypothetical penalties against the loaded history.
 *
 * This page performs READ + PROJECTION only — it never slashes and never mutates
 * server state. All penalty math is delegated to the pure simulator in
 * ../lib/slashing-simulator so it can be unit-tested independently of the UI.
 *
 * PROVENANCE. The page starts by asking the LIVE endpoint, and when that fails
 * closed it says so plainly instead of drawing a chart. Synthetic demo data
 * must be requested deliberately, and whenever it is loaded the page is covered
 * in unmistakable "SYNTHETIC" markings: a sticky banner, a per-validator badge,
 * a watermarked timeline and a modified heading.
 *
 * SEMANTICS. Consensus attestation duty history is unavailable in this build.
 * The live source it can serve is OBSERVED LIVENESS — whether each configured
 * node answered a poll round and whether the height it reported advanced — so
 * every live response carries a descriptor and this page renders it above the
 * timelines. `hit` / `miss` / `late` are ambiguous words on their own, and an
 * operator must never read "the node did not answer this poll round" as a
 * missed consensus duty.
 */

import React from "react";
import {
  bucketTimeline,
  parseRulePhrase,
  simulateRule,
  type TimelineBucket,
} from "../lib/slashing-simulator";
import type {
  AttestationSourceDescriptor,
  AttestationSourceUnavailableResponse,
  LiveAttestationHistoryResponse,
  SimulationResult,
  SlashingRule,
  SyntheticAttestationHistoryResponse,
  TimelineWindow,
  ValidatorHistory,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";
import { apiFetch } from "../lib/api-credential";

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
  synthetic: "#a855f7",
};

const LIVE_HISTORY_PATH = "/api/nodes/attestation-history";
const DEMO_HISTORY_PATH = "/api/nodes/attestation-history/demo";

/** What the page currently holds, discriminated by provenance. */
type LoadedHistory =
  | {
      kind: "live";
      window: TimelineWindow;
      anchorMs: number;
      validators: ValidatorHistory[];
      source: string;
      observation: AttestationSourceDescriptor;
    }
  | {
      kind: "synthetic";
      window: TimelineWindow;
      anchorMs: number;
      validators: ValidatorHistory[];
      notice: string;
      generator: string;
      seed: number;
    };

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

/** Sticky, high-contrast provenance banner shown whenever demo data is loaded. */
const SyntheticBanner: React.FC<{ notice: string; generator: string; seed: number }> = ({
  notice,
  generator,
  seed,
}) => (
  <div
    role="alert"
    data-testid="synthetic-data-banner"
    style={{
      position: "sticky",
      top: 0,
      zIndex: 10,
      backgroundColor: "#3b0764",
      border: `2px solid ${C.synthetic}`,
      borderRadius: 8,
      padding: "12px 16px",
      marginBottom: 20,
      color: "#f5d0fe",
    }}
  >
    <div style={{ fontWeight: "bold", fontSize: 15, letterSpacing: 1, marginBottom: 4 }}>
      SYNTHETIC DEMO DATA — NOT REAL ATTESTATION HISTORY
    </div>
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{notice}</div>
    <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85 }}>
      Generator: <code>{generator}</code> · seed <code>{seed}</code> · served from{" "}
      <code>{DEMO_HISTORY_PATH}</code>
    </div>
  </div>
);

/** Human-friendly cadence/retention rendering, e.g. "60s" / "7d". */
function formatMs(ms: number | null): string {
  if (ms === null) return "event-driven";
  if (ms >= 24 * 60 * 60 * 1000) return `${(ms / (24 * 60 * 60 * 1000)).toFixed(0)}d`;
  if (ms >= 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toFixed(0)}h`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(0)}s`;
  return `${ms}ms`;
}

/**
 * What the live source actually measured, and what each status means for it.
 *
 * This panel is not decoration. `miss` from the observed-liveness source means
 * "the node did not answer this poll round" — it is NOT a missed consensus
 * attestation duty, and nothing else on the page would tell an operator that.
 */
const ObservationSemantics: React.FC<{ descriptor: AttestationSourceDescriptor }> = ({
  descriptor,
}) => {
  const isConsensus = descriptor.kind === "consensus-attestation";
  return (
    <div
      data-testid="observation-descriptor"
      style={{
        backgroundColor: C.panel,
        border: `1px solid ${isConsensus ? C.border : C.accent}`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: "bold", marginBottom: 6 }}>
        Data source: <code>{descriptor.sourceId}</code> — {descriptor.kind}
      </div>
      <p style={{ color: C.muted, fontSize: 13, margin: "0 0 10px", lineHeight: 1.6 }}>
        {descriptor.summary}
      </p>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
        Measured by <code>{descriptor.method.transport}</code>{" "}
        <code>{descriptor.method.endpoint}</code> every{" "}
        <strong style={{ color: C.text }}>{formatMs(descriptor.method.pollIntervalMs)}</strong>
        {" · "}fields <code>{descriptor.method.fields.join(", ")}</code>
        {" · "}retained {formatMs(descriptor.method.retentionMs)}
        {" · "}{descriptor.roundIdentifier.meaning}
      </div>
      <dl style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
        {(
          [
            ["Hit", descriptor.statusSemantics.hit, C.hit],
            ["Late", descriptor.statusSemantics.late, C.late],
            ["Miss", descriptor.statusSemantics.miss, C.miss],
          ] as const
        ).map(([term, definition, color]) => (
          <div key={term} style={{ display: "flex", gap: 10, marginBottom: 4 }}>
            <dt
              style={{
                color,
                fontWeight: "bold",
                minWidth: 44,
                flexShrink: 0,
              }}
            >
              {term}
            </dt>
            <dd style={{ margin: 0, color: C.muted }}>{definition}</dd>
          </div>
        ))}
      </dl>
      {!descriptor.consensusAttestation.available && (
        <div
          data-testid="no-consensus-attestation"
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${C.border}`,
            fontSize: 12,
            color: C.late,
            lineHeight: 1.6,
          }}
        >
          <strong>Consensus attestation duty history is not available.</strong>{" "}
          {descriptor.consensusAttestation.note}
        </div>
      )}
      {!descriptor.stake.available && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
          {descriptor.stake.note}
        </div>
      )}
    </div>
  );
};

// --- per-validator card --------------------------------------------------------

const ValidatorCard: React.FC<{
  history: ValidatorHistory;
  window: TimelineWindow;
  rule: SlashingRule;
  anchorMs: number;
  synthetic: boolean;
  /**
   * Whether `history.stake` is a measured value. The observed-liveness source
   * has no stake to read, so absolute penalty amounts are suppressed rather
   * than rendered as a confident "≈ 0 stake".
   */
  stakeAvailable: boolean;
  /**
   * True when the live source declared `kind: "observed-liveness"`.
   *
   * "Duties" and "slots" are CONSENSUS vocabulary. Applying them to poll
   * observations would re-introduce, one line below the descriptor panel, the
   * exact confusion that panel exists to prevent — so the card counts poll
   * rounds when that is what the records are.
   */
  observedLiveness: boolean;
}> = ({ history, window, rule, anchorMs, synthetic, stakeAvailable, observedLiveness }) => {
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
    <div
      style={{
        backgroundColor: C.panel,
        borderRadius: 8,
        padding: 20,
        marginBottom: 16,
        border: synthetic ? `1px dashed ${C.synthetic}` : `1px solid ${C.border}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 18, fontWeight: "bold" }}>{history.label}</span>
          <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{history.validatorId}</span>
          {synthetic && (
            <span
              data-testid="synthetic-badge"
              style={{
                marginLeft: 10,
                fontSize: 11,
                fontWeight: "bold",
                letterSpacing: 1,
                color: "#f5d0fe",
                backgroundColor: "#3b0764",
                border: `1px solid ${C.synthetic}`,
                borderRadius: 4,
                padding: "2px 6px",
              }}
            >
              SYNTHETIC
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.muted }}>
          {stakeAvailable ? (
            <>
              {synthetic ? "Notional stake" : "Stake"}:{" "}
              <strong style={{ color: C.text }}>{history.stake.toLocaleString()}</strong>
            </>
          ) : (
            <span data-testid="stake-not-observed">Stake: not observed</span>
          )}
        </div>
      </div>

      {/* participation stats */}
      <div style={{ display: "flex", gap: 24, fontSize: 13, marginBottom: 12 }}>
        <span>Participation: <strong style={{ color: rateColor }}>{ratePct}%</strong></span>
        <span style={{ color: C.muted }}>
          {observedLiveness ? "Poll rounds" : "Duties"}: {summary.total}
        </span>
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
        {synthetic && (
          <span style={{ color: C.synthetic, letterSpacing: 2, fontWeight: "bold" }}>
            SYNTHETIC
          </span>
        )}
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
              {run.length} consecutive misses — {observedLiveness ? "poll rounds" : "slots"}{" "}
              {run.startSlot}…{run.endSlot}
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
          {stakeAvailable ? (
            <span style={{ fontSize: 14, color: C.muted }}>
              ≈ {result.totalPenaltyAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} stake
            </span>
          ) : (
            <span style={{ fontSize: 13, color: C.muted, fontStyle: "italic" }}>
              absolute amount not computed — no stake was observed
            </span>
          )}
          <span style={{ fontSize: 13, color: C.muted }}>
            {result.penalties.filter((p) => p.penaltyPct > 0).length} penalised miss(es)
          </span>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
          {synthetic
            ? "Projection over synthetic data — meaningless operationally. No slashing is performed."
            : "Projection only — no slashing is performed."}
        </div>
      </div>
    </div>
  );
};

// --- main page -----------------------------------------------------------------

type Mode = "live" | "demo";

const SlashingVisualizer: React.FC = () => {
  const [window, setWindow] = React.useState<TimelineWindow>("24h");
  const [mode, setMode] = React.useState<Mode>("live");
  const [history, setHistory] = React.useState<LoadedHistory | null>(null);
  const [unavailable, setUnavailable] =
    React.useState<AttestationSourceUnavailableResponse | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  // What-if rule inputs.
  const [phrase, setPhrase] = React.useState<string>("slash 1% per miss after 10 in 24h");
  const [livenessThreshold, setLivenessThreshold] = React.useState<number>(3);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const path = mode === "demo" ? DEMO_HISTORY_PATH : LIVE_HISTORY_PATH;

    void (async () => {
      try {
        const res = await apiFetch(`${path}?window=${window}`);

        if (mode === "live" && res.status === 503) {
          const body = (await res.json()) as AttestationSourceUnavailableResponse;
          if (!cancelled) {
            setUnavailable(body);
            setHistory(null);
          }
          return;
        }
        if (res.status === 401) {
          throw new Error(
            "Authentication required — paste an operator API key into the header control.",
          );
        }
        if (!res.ok) {
          throw new Error(`history request failed: ${res.status}`);
        }

        if (mode === "demo") {
          const body = (await res.json()) as SyntheticAttestationHistoryResponse;
          if (cancelled) return;
          setUnavailable(null);
          setHistory({
            kind: "synthetic",
            window: body.window,
            anchorMs: body.anchorMs,
            validators: body.validators,
            notice: body.notice,
            generator: body.generator,
            seed: body.seed,
          });
          return;
        }

        const body = (await res.json()) as LiveAttestationHistoryResponse;
        if (cancelled) return;
        setUnavailable(null);
        setHistory({
          kind: "live",
          window: body.window,
          // Live records carry their own timestamps; anchor on the newest one.
          anchorMs: body.validators.reduce((acc, v) => {
            const last = v.records[v.records.length - 1];
            return last && last.timestamp > acc ? last.timestamp : acc;
          }, 0) || Date.now(),
          validators: body.validators,
          source: body.source,
          observation: body.observation,
        });
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "failed to load history");
          setHistory(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [window, mode]);

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

  const isSynthetic = history?.kind === "synthetic";
  const anchorMs = history?.anchorMs ?? Date.now();
  const descriptor = history?.kind === "live" ? history.observation : null;
  // Synthetic profiles carry a notional stake; a live source only has one if it
  // says so. Absent a claim, absolute amounts are not rendered.
  const stakeAvailable = isSynthetic || (descriptor?.stake.available ?? false);
  // Only an observed-liveness source counts poll rounds; a real duty feed (or
  // the synthetic profiles, which imitate one) keeps the consensus wording.
  const observedLiveness = descriptor?.kind === "observed-liveness";

  return (
    <div style={{ padding: 24, backgroundColor: C.bg, color: C.text, minHeight: "100vh" }}>
      {history?.kind === "synthetic" && (
        <SyntheticBanner
          notice={history.notice}
          generator={history.generator}
          seed={history.seed}
        />
      )}

      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 28, marginBottom: 8 }}>
          ⚖️ Slashing &amp; Liveness Visualizer
          {isSynthetic && (
            <span style={{ color: C.synthetic, fontSize: 18, marginLeft: 10 }}>
              — SYNTHETIC DEMO DATA
            </span>
          )}
        </h1>
        <p style={{ color: C.muted, fontSize: 15, margin: 0 }}>
          {descriptor && descriptor.kind === "observed-liveness"
            ? "Per-validator OBSERVED LIVENESS, liveness-fault detection, and a what-if slashing-rule simulator. These records are poll observations, not consensus attestation duties. Read-only — nothing is slashed."
            : "Per-validator attestation participation, liveness-fault detection, and a what-if slashing-rule simulator. Read-only — nothing is slashed."}
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

      {/* No live feed: say so, and never draw a chart from nothing. */}
      {!loading && !error && unavailable && (
        <div
          data-testid="no-live-source"
          style={{
            backgroundColor: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: "bold", marginBottom: 8 }}>
            No live attestation data source
          </div>
          <p style={{ color: C.muted, fontSize: 14, margin: "0 0 8px", lineHeight: 1.6 }}>
            {unavailable.message}
          </p>
          <p style={{ color: C.muted, fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
            {unavailable.reason}
          </p>
          {unavailable.demo.available ? (
            <>
              <button
                onClick={() => setMode("demo")}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#3b0764",
                  border: `1px solid ${C.synthetic}`,
                  borderRadius: 6,
                  color: "#f5d0fe",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Load synthetic demo data
              </button>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                Demo data is fabricated by a seeded PRNG. It exercises the simulator; it
                describes no validator.
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: C.muted }}>
              Synthetic demo data is disabled on this deployment. Enable it with{" "}
              <code>{unavailable.demo.enabledBy}</code> if you only need to exercise the
              simulator.
            </div>
          )}
        </div>
      )}

      {/* What the live source measured, and what each status means for it. */}
      {!loading && !error && descriptor && <ObservationSemantics descriptor={descriptor} />}

      {!loading && !error && history && history.validators.length === 0 && (
        <div style={{ color: C.muted }}>No validators reported.</div>
      )}

      {!loading &&
        !error &&
        history &&
        history.validators.map((h) => (
          <ValidatorCard
            key={h.validatorId}
            history={h}
            window={window}
            rule={rule}
            anchorMs={anchorMs}
            synthetic={isSynthetic}
            stakeAvailable={stakeAvailable}
            observedLiveness={observedLiveness}
          />
        ))}

      {!loading && !error && history?.kind === "synthetic" && (
        <button
          onClick={() => setMode("live")}
          style={{
            padding: "8px 16px",
            backgroundColor: "#1f2937",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            color: C.text,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Discard demo data and re-check the live source
        </button>
      )}
    </div>
  );
};

export default SlashingVisualizer;
