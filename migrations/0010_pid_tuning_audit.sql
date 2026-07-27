-- Migration: 0010_pid_tuning_audit
-- Issue: #215 — [13.4] Auto-Tuning PID Controllers (ADR-0013 [13.4])
--
-- Durable, append-only audit trail for PID gain-change governance. Every
-- proposal, approval, denial, application and failure is recorded here before
-- any gain is written to a live controller, so the record of *who* authorised a
-- plant-affecting change survives a restart.
--
-- Append-only is enforced by the database, not only by application code: the
-- triggers below reject UPDATE and DELETE outright. Rows are therefore
-- corrigible only by appending a further record. `shared/schema.ts` exposes no
-- update or delete helper for this table.

CREATE TABLE IF NOT EXISTS pid_tuning_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Proposal identifier issued by the tuning service; not a foreign key, the
  -- audit trail must outlive the in-memory proposal it describes.
  proposal_id VARCHAR(128) NOT NULL,
  controller_id VARCHAR(128) NOT NULL,
  method VARCHAR(64) NOT NULL,
  -- proposed | envelope-rejected | approved | applied | rejected | denied |
  -- expired | failed
  decision VARCHAR(32) NOT NULL,
  -- Control-plane principal names (API key record names). Never client-supplied.
  proposed_by VARCHAR(128) NOT NULL,
  decided_by VARCHAR(128),
  current_gains JSONB NOT NULL,
  proposed_gains JSONB NOT NULL,
  applied_gains JSONB,
  envelope JSONB NOT NULL,
  -- within-envelope | outside-envelope (ADR-0009 safety envelope decision)
  envelope_decision VARCHAR(32) NOT NULL,
  reason_code VARCHAR(64),
  detail TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_proposal
  ON pid_tuning_audit(proposal_id);
CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_controller
  ON pid_tuning_audit(controller_id);
CREATE INDEX IF NOT EXISTS idx_pid_tuning_audit_recorded_at
  ON pid_tuning_audit(recorded_at);

CREATE OR REPLACE FUNCTION pid_tuning_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'pid_tuning_audit is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pid_tuning_audit_no_update ON pid_tuning_audit;
CREATE TRIGGER pid_tuning_audit_no_update
  BEFORE UPDATE ON pid_tuning_audit
  FOR EACH ROW EXECUTE FUNCTION pid_tuning_audit_append_only();

DROP TRIGGER IF EXISTS pid_tuning_audit_no_delete ON pid_tuning_audit;
CREATE TRIGGER pid_tuning_audit_no_delete
  BEFORE DELETE ON pid_tuning_audit
  FOR EACH ROW EXECUTE FUNCTION pid_tuning_audit_append_only();
