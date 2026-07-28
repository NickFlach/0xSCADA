-- Migration: 0013_predictive_durable_state
-- Issue: #546 — [QE] persist predictive thresholds and alert acknowledgement
--         state across restart (ADR-0013 [13.1], features #212 / PR #493)
--
-- ─── WHY ─────────────────────────────────────────────────────────────────────
--
-- The predictive-maintenance engine kept operator thresholds, generated alerts
-- and acknowledgement state in process-local Maps. A restart or a replica
-- change therefore reverted every configured tag to the built-in defaults and
-- erased the record of who had taken ownership of which alert. That fails the
-- "Durable approvals/state" row of ADR-0026: an acknowledgement that does not
-- survive process replacement is not an audit record, and a threshold that does
-- not survive it is not a configuration.
--
-- ─── WHAT IS DURABLE HERE, AND WHAT IS DELIBERATELY NOT ──────────────────────
--
-- Durable (this migration): operator configuration and alert lifecycle/audit.
--
-- NOT durable, by design: the raw prediction history (the per-tag time-series
-- window the detectors run over). It is a recomputable sliding window fed
-- continuously by the live tag stream, it is bounded in-process
-- (PredictiveMaintenanceEngine.maxHistorySize / maxTrackedTags), and the
-- historian — not this feature — is the system of record for sampled process
-- data. Persisting every ingested point here would put a per-sample write on
-- the ingest path and duplicate the historian. Its retention is therefore
-- defined separately and independently from the retention of the two tables
-- below; see server/services/predictive/engine.ts.
--
-- ─── RETENTION ───────────────────────────────────────────────────────────────
--
-- predictive_tag_thresholds: none. Operator configuration is kept until an
--   operator changes it. Rows are only ever replaced, never aged out.
--
-- predictive_alerts: applied by server/services/predictive/index.ts, which runs
--   a retention sweep on an interval.
--     * acknowledged alerts older than PREDICTIVE_ALERT_RETENTION_MS
--       (default 90 days) are deleted — the operator has closed them out;
--     * ANY alert older than PREDICTIVE_ALERT_MAX_AGE_MS (default 365 days) is
--       deleted, acknowledged or not, so an abandoned alert cannot pin the
--       table open forever;
--     * a row cap (PredictiveMaintenanceEngine.maxAlerts) bounds the table if
--       alerts arrive faster than they age out. Acknowledged rows are evicted
--       before unacknowledged ones and every eviction is emitted as an
--       `alerts-pruned` event, so nothing is discarded silently.
--
-- ─── MULTI-REPLICA ───────────────────────────────────────────────────────────
--
-- Unlike migration 0012, this table has no single-writer assumption. Alert
-- `id` is content-derived (tag + severity + cooldown window) rather than a
-- per-process counter, so two replicas observing the same anomaly compute the
-- same primary key; the engine inserts with ON CONFLICT DO NOTHING, which makes
-- this table — not a process-local Map — the alert-suppression authority.
-- Acknowledgement is a conditional UPDATE guarded on `acknowledged = FALSE`, so
-- the first acknowledgement wins and a concurrent second one is reported back
-- as already-acknowledged instead of overwriting the original attribution.
--
-- Date: 2026-07-28

CREATE TABLE IF NOT EXISTS predictive_tag_thresholds (
  -- Tag identifier as supplied on the ingest/threshold routes (bounded to 256
  -- characters there by the Zod schema).
  tag_id VARCHAR(256) PRIMARY KEY,
  min_samples INTEGER NOT NULL,
  z_score_threshold DOUBLE PRECISION NOT NULL,
  ewma_alpha DOUBLE PRECISION NOT NULL,
  ewma_l DOUBLE PRECISION NOT NULL,
  iqr_multiplier DOUBLE PRECISION NOT NULL,
  -- Detector name -> weight. Validated against the registered detector set on
  -- the write path before it reaches this table.
  ensemble_weights JSONB NOT NULL,
  -- { warning, critical, emergency }, validated warning <= critical <= emergency.
  severity_thresholds JSONB NOT NULL,
  -- { low?, high? } engineering limits for time-to-limit estimation. NULL when
  -- the operator has not configured any.
  failure_limits JSONB,
  -- Control-plane principal name (API key record name) that last wrote this
  -- configuration. Never client-supplied.
  updated_by VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_predictive_thresholds_updated_at
  ON predictive_tag_thresholds(updated_at);

CREATE TABLE IF NOT EXISTS predictive_alerts (
  -- Content-derived identity: PMA-<sha256(tag | severity | cooldown window)>.
  -- Restart-stable and replica-stable on purpose — see the note above.
  id VARCHAR(64) PRIMARY KEY,
  tag_id VARCHAR(256) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  message TEXT NOT NULL,
  -- Names of the detectors that actually fired, as a JSON array of strings.
  detectors JSONB NOT NULL,
  recommendation TEXT NOT NULL,
  -- Data-clock timestamp of the observation that triggered the alert. This can
  -- lag or lead wall clock (replayed history, clock-skewed field devices), so
  -- it is deliberately NOT the retention key.
  observed_at TIMESTAMPTZ NOT NULL,
  -- Wall-clock time the row was written. Retention and ordering key.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  -- Control-plane principal name. Never taken from a request body.
  acknowledged_by VARCHAR(128),
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT predictive_alerts_severity_check
    CHECK (severity IN ('info', 'warning', 'critical', 'emergency')),
  -- Acknowledgement is all-or-nothing: an acknowledged alert always carries
  -- both an attributed principal and a time, and an unacknowledged one carries
  -- neither. This is what stops an "acknowledged" row from existing with no
  -- record of who acknowledged it.
  CONSTRAINT predictive_alerts_ack_attribution_check
    CHECK (
      (acknowledged = FALSE AND acknowledged_by IS NULL AND acknowledged_at IS NULL)
      OR (acknowledged = TRUE AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_predictive_alerts_tag
  ON predictive_alerts(tag_id);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_severity
  ON predictive_alerts(severity);
-- The operator's work queue (`GET /api/predictive/alerts?acknowledged=false`)
-- and the retention sweep both filter on this column.
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_acknowledged
  ON predictive_alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_created_at
  ON predictive_alerts(created_at);
