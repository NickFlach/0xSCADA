-- Migration: 0012_validator_liveness_observations
-- Issue: #456 — [wave:2a] Slashing & Liveness Visualizer
-- Description: Durable per-validator OBSERVED LIVENESS history: one row per
--   configured oxscada node per poll round of the collector in
--   server/blockchain/liveness-collector.ts. This is the "actual history" the
--   what-if slashing simulator replays a proposed rule against.
--
-- ─── WHAT THIS TABLE DOES AND DOES NOT CONTAIN ───────────────────────────────
--
-- It contains LIVENESS OBSERVATIONS. It does NOT contain consensus attestation
-- duty outcomes, because this build has no source for them: the oxscada node
-- `GET /status` surface reports node_id, height, role, order_parameter,
-- mean_phase, local_phase, peer_phases[], peers, mempool and uptime_ticks, and
-- none of those is a per-slot duty result. No column here may ever be populated
-- by computing, estimating, interpolating or randomising a duty outcome.
--
-- Each row asserts exactly one of:
--
--   miss — the collector polled `source_node_url` at `observed_at` and the node
--          did not answer: transport failure, timeout, non-2xx, a body over the
--          byte cap, or an unparseable /status shape. `detail` carries the
--          bounded reason string.
--   hit  — the node answered and `observed_height` was strictly greater than
--          `previous_height`, the height recorded by the previous observation
--          of the same validator.
--   late — the node answered but `observed_height` did not advance (it was
--          equal to, or below, `previous_height`), OR this is the first
--          observation for that validator so there is no previous height to
--          compare against. `detail` distinguishes the two cases.
--
-- Whether "did not advance" indicates a fault depends on the node's block
-- cadence versus the operator-configured poll cadence; the API descriptor says
-- so rather than implying a fault. When the node did not answer, every observed
-- column is NULL — values are never carried forward from an earlier round.
--
-- ─── ROUND IDENTIFIER ────────────────────────────────────────────────────────
--
-- `round_seq` is a monotonic ordinal of poll rounds that actually happened,
-- resumed from MAX(round_seq) at collector startup so it survives restarts. It
-- is used rather than the chain height because height is per-node (so it cannot
-- identify a fleet-wide round), is absent exactly when the node did not answer,
-- and can regress. The real height is kept in `observed_height`, so choosing an
-- ordinal loses nothing and keeps `miss` rows orderable.
--
-- SINGLE WRITER. The unique index assumes one collector process writes this
-- table; inserts use ON CONFLICT DO NOTHING so a second writer is dropped
-- rather than corrupting the ordering.
--
-- ─── RETENTION ───────────────────────────────────────────────────────────────
--
-- The collector prunes rows older than VALIDATOR_LIVENESS_RETENTION_MS (default
-- 7 days — the longest window the UI offers) after every round, so the table
-- cannot grow without bound. Nothing else writes it.
-- Date: 2026-07-27

CREATE TABLE IF NOT EXISTS validator_liveness_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `host[:port][/path]` of the configured node URL. Derived offline, without
  -- contacting the node, because the rows that matter most are the ones where
  -- the node did not answer and therefore reported no node_id of its own.
  validator_id VARCHAR(128) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  round_seq BIGINT NOT NULL,
  status VARCHAR(8) NOT NULL,
  source_node_url VARCHAR(512) NOT NULL,
  observed_height BIGINT,
  previous_height BIGINT,
  observed_uptime_ticks BIGINT,
  reported_node_id VARCHAR(128),
  local_phase DOUBLE PRECISION,
  mean_phase DOUBLE PRECISION,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT validator_liveness_observations_status_check
    CHECK (status IN ('hit', 'miss', 'late'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_validator_liveness_validator_round
  ON validator_liveness_observations(validator_id, round_seq);

-- Window queries (1h / 24h / 7d) and retention pruning both scan by time.
CREATE INDEX IF NOT EXISTS idx_validator_liveness_observed_at
  ON validator_liveness_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_validator_liveness_validator_observed_at
  ON validator_liveness_observations(validator_id, observed_at);
