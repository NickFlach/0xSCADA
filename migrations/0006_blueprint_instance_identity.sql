-- Migration: 0006_blueprint_instance_identity
-- Adds the conflict targets required by atomic blueprint instance upserts.
--
-- These indexes intentionally live in a new forward migration as well as the
-- fresh-install blueprint schema. Deployments that already recorded migration
-- 0003 will otherwise never receive constraints added to that old file.
--
-- Historical imports could create duplicate identities. Do not guess which
-- row is authoritative or delete rows that may be referenced by phase/control
-- instances. The preflight fails before creating either index and tells the
-- operator exactly which identity set must be reconciled. A safe remediation
-- must first repoint foreign keys to the chosen canonical id, then remove the
-- duplicates and rerun this migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM control_module_instances
    GROUP BY control_module_type_id, name
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0006 blocked: duplicate control_module_instances identities exist; reconcile rows and dependent references before retrying';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unit_instances
    GROUP BY unit_type_id, name
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0006 blocked: duplicate unit_instances identities exist; repoint dependent control/phase instances before retrying';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_control_module_instances_type_name
  ON control_module_instances(control_module_type_id, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_instances_type_name
  ON unit_instances(unit_type_id, name);
