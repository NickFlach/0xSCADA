-- Migration: 0014_twin_persistence
-- Issue: #550 — [QE] persist digital-twin models and simulation checkpoints
--                across restart
-- Description: Durable storage for the digital-twin model registry and one
--   explicitly committed simulation checkpoint per model. Before this, both
--   lived only in process memory (server/services/twin/engine.ts), so a
--   restart lost the registry and every checkpoint.
--
-- ─── WHAT THESE TABLES DO AND DO NOT CONTAIN ────────────────────────────────
--
-- `twin_models` holds the authored `ProcessModel` definition exactly as it was
-- registered. `twin_checkpoints` holds the LAST COMMITTED simulation state for
-- that model: the tick counter, the simulated clock, and the per-component
-- parameter values. Nothing here is derived, estimated or back-filled — a row
-- exists only because a caller registered a model or committed a checkpoint.
--
-- There is deliberately NO `status` / `running` column. The runtime status is
-- not persisted, because a restored simulation always comes back IDLE: a
-- restart must never resume stepping, live-data assimilation or any other
-- activity that an authorized caller did not ask for. Stopped is the safe
-- state for an advisory twin (ADR-0009 — the twin is the sandbox, never the
-- actuator), and this schema cannot express "resume running on boot".
--
-- The twin is read-only toward the plant, so nothing in these tables is or can
-- become a control write.
--
-- ─── VERSIONING ─────────────────────────────────────────────────────────────
--
-- `schema_version` on both tables records the payload version the row was
-- written under (TWIN_MODEL_SCHEMA_VERSION / TWIN_CHECKPOINT_SCHEMA_VERSION in
-- shared/types/digital-twin.ts; both are 1 today). The loader refuses a row
-- whose version it does not know rather than decoding it under current
-- assumptions. Refusal is per model: one unreadable row never blocks the rest
-- of the registry from loading.
--
-- ─── ATOMICITY ──────────────────────────────────────────────────────────────
--
-- A model and its checkpoint are always written in one transaction, so a model
-- row without a checkpoint row is a torn write. The loader treats that as
-- corrupt and refuses the model rather than silently seeding it from authored
-- initial conditions, which would substitute invented state for real state.
-- The foreign key with ON DELETE CASCADE keeps deletion atomic even if a
-- future caller removes a model row directly.
-- Date: 2026-07-28

CREATE TABLE IF NOT EXISTS twin_models (
  -- The model id itself, which is also the in-memory registry key, so storage
  -- and runtime cannot disagree about which model a row describes.
  id VARCHAR(128) PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS twin_checkpoints (
  -- At most one committed checkpoint per model.
  model_id VARCHAR(128) PRIMARY KEY
    REFERENCES twin_models(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  tick BIGINT NOT NULL,
  -- Simulated clock in milliseconds. Double precision rather than bigint: the
  -- runtime carries it as a JS number and only requires it to stay finite.
  time_ms DOUBLE PRECISION NOT NULL,
  -- Record<componentId, Record<parameter, number>>, re-validated against the
  -- model's components before it is admitted back into the runtime.
  component_states JSONB NOT NULL,
  -- Epoch ms of the last live-tag assimilation folded into this checkpoint.
  last_sync_at BIGINT,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT twin_checkpoints_tick_check CHECK (tick >= 0)
);

-- Operators list checkpoints by recency when deciding what a restart would
-- restore.
CREATE INDEX IF NOT EXISTS idx_twin_checkpoints_committed_at
  ON twin_checkpoints(committed_at);
