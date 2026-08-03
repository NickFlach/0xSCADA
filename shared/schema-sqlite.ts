/**
 * SQLite Schema for Development Mode
 * 
 * Simplified version of the main PostgreSQL schema for local development
 */

import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";
import type { GainEnvelope, TuningGains } from "./types/tuning";
import type { ProcessModel } from "./types/digital-twin";

// Simplified schemas for SQLite (development mode)
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  location: text("location"),
  owner: text("owner"),
  status: text("status").default("ONLINE").notNull(),
  metadata: text("metadata"), // JSON as text
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  assetType: text("asset_type").notNull(),
  nameOrTag: text("name_or_tag").notNull(),
  critical: integer("critical", { mode: "boolean" }).default(false).notNull(),
  metadata: text("metadata"), // JSON as text
  status: text("status").default("OK").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email"),
  passwordHash: text("password_hash"),
  walletAddress: text("wallet_address"),
  displayName: text("display_name"),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const eventAnchors = sqliteTable("event_anchors", {
  id: text("id").primaryKey(),
  assetId: text("asset_id"),
  eventType: text("event_type").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  payloadHash: text("payload_hash").notNull(),
  txHash: text("tx_hash"),
  blockNumber: integer("block_number"),
  recordedBy: text("recorded_by"),
  details: text("details"),
  metadata: text("metadata"), // JSON as text
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Reconciled to the Postgres shape (#55): this mirror had drifted to an older
// column set (record_type/started_at/...), which is exactly the divergence the
// parity suite exists to catch — server/storage.ts already creates the dev
// table with the Postgres columns via raw DDL.
export const maintenanceRecords = sqliteTable("maintenance_records", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  workOrderId: text("work_order_id"),
  performedBy: text("performed_by"),
  maintenanceType: text("maintenance_type").notNull(),
  performedAt: integer("performed_at", { mode: "timestamp" }).notNull(),
  nextDueAt: integer("next_due_at", { mode: "timestamp" }),
  notes: text("notes"),
  attachmentHash: text("attachment_hash"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Blueprint tables mirror the PostgreSQL schema. JSON values are stored as
// JSON-encoded TEXT so development mode has the same row shapes.
export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  platforms: text("platforms", { mode: "json" }).notNull().$defaultFn(() => []),
  languages: text("languages", { mode: "json" }).notNull().$defaultFn(() => []),
  configSchema: text("config_schema", { mode: "json" }).notNull().$defaultFn(() => ({})),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const templatePackages = sqliteTable("template_packages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  vendorId: text("vendor_id").notNull(),
  version: text("version").default("1.0.0").notNull(),
  description: text("description"),
  templateType: text("template_type").notNull(),
  language: text("language").notNull(),
  templateContent: text("template_content").notNull(),
  placeholders: text("placeholders", { mode: "json" }).notNull().$defaultFn(() => []),
  requiredInputs: text("required_inputs", { mode: "json" }).notNull().$defaultFn(() => []),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const controlModuleTypes = sqliteTable("control_module_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  vendorId: text("vendor_id"),
  version: text("version").default("1.0.0").notNull(),
  description: text("description"),
  inputs: text("inputs", { mode: "json" }).notNull().$defaultFn(() => []),
  outputs: text("outputs", { mode: "json" }).notNull().$defaultFn(() => []),
  inOuts: text("in_outs", { mode: "json" }).notNull().$defaultFn(() => []),
  dataTypeMappings: text("data_type_mappings", { mode: "json" }).notNull().$defaultFn(() => ({})),
  templatePackageId: text("template_package_id"),
  sourcePackage: text("source_package"),
  classification: text("classification").default("control_module"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const controlModuleInstances = sqliteTable("control_module_instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  controlModuleTypeId: text("control_module_type_id").notNull(),
  controllerId: text("controller_id"),
  unitInstanceId: text("unit_instance_id"),
  pidDrawing: text("pid_drawing"),
  comment: text("comment"),
  configuration: text("configuration", { mode: "json" }).notNull().$defaultFn(() => ({})),
  currentState: text("current_state", { mode: "json" }).notNull().$defaultFn(() => ({})),
  siteId: text("site_id"),
  assetId: text("asset_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const unitTypes = sqliteTable("unit_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  vendorId: text("vendor_id"),
  version: text("version").default("1.0.0").notNull(),
  description: text("description"),
  variables: text("variables", { mode: "json" }).notNull().$defaultFn(() => []),
  equipmentModules: text("equipment_modules", { mode: "json" }).notNull().$defaultFn(() => []),
  templatePackageId: text("template_package_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const unitInstances = sqliteTable("unit_instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  unitTypeId: text("unit_type_id").notNull(),
  controllerId: text("controller_id"),
  pidDrawing: text("pid_drawing"),
  processCell: text("process_cell"),
  area: text("area"),
  comment: text("comment"),
  siteId: text("site_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const phaseTypes = sqliteTable("phase_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  vendorId: text("vendor_id"),
  version: text("version").default("1.0.0").notNull(),
  description: text("description"),
  linkedModules: text("linked_modules", { mode: "json" }).notNull().$defaultFn(() => []),
  inputs: text("inputs", { mode: "json" }).notNull().$defaultFn(() => []),
  outputs: text("outputs", { mode: "json" }).notNull().$defaultFn(() => []),
  inOuts: text("in_outs", { mode: "json" }).notNull().$defaultFn(() => []),
  internalValues: text("internal_values", { mode: "json" }).notNull().$defaultFn(() => []),
  hmiParameters: text("hmi_parameters", { mode: "json" }).notNull().$defaultFn(() => []),
  recipeParameters: text("recipe_parameters", { mode: "json" }).notNull().$defaultFn(() => []),
  reportParameters: text("report_parameters", { mode: "json" }).notNull().$defaultFn(() => []),
  sequences: text("sequences", { mode: "json" }).notNull().$defaultFn(() => ({})),
  templatePackageId: text("template_package_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const phaseInstances = sqliteTable("phase_instances", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  phaseTypeId: text("phase_type_id").notNull(),
  unitInstanceId: text("unit_instance_id"),
  controllerId: text("controller_id"),
  currentState: text("current_state").default("IDLE"),
  currentStep: integer("current_step").default(0),
  linkedModuleInstances: text("linked_module_instances", { mode: "json" }).notNull().$defaultFn(() => ({})),
  siteId: text("site_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const designSpecifications = sqliteTable("design_specifications", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  contentHash: text("content_hash").notNull(),
  txHash: text("tx_hash"),
  content: text("content", { mode: "json" }).notNull().$defaultFn(() => ({})),
  siteId: text("site_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  anchoredAt: integer("anchored_at", { mode: "timestamp" }),
});

export const generatedCode = sqliteTable("generated_code", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  templatePackageId: text("template_package_id"),
  language: text("language").notNull(),
  code: text("code").notNull(),
  codeHash: text("code_hash").notNull(),
  txHash: text("tx_hash"),
  metadata: text("metadata", { mode: "json" }).notNull().$defaultFn(() => ({})),
  status: text("status").default("draft").notNull(),
  generatedAt: integer("generated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  approvedBy: text("approved_by"),
});

export const dataTypeMappings = sqliteTable("data_type_mappings", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull(),
  canonicalType: text("canonical_type").notNull(),
  vendorType: text("vendor_type").notNull(),
  size: integer("size"),
  precision: integer("precision"),
  metadata: text("metadata", { mode: "json" }).notNull().$defaultFn(() => ({})),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const controllers = sqliteTable("controllers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  vendorId: text("vendor_id").notNull(),
  siteId: text("site_id"),
  model: text("model").notNull(),
  firmwareVersion: text("firmware_version"),
  address: text("address"),
  configuration: text("configuration", { mode: "json" }).notNull().$defaultFn(() => ({})),
  status: text("status").default("offline").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Alarms ──────────────────────────────────────────────────────────────────
// Dev-mode parity with the Postgres schema (`shared/schema.ts`). Postgres enums
// (alarm_severity: INFO|WARNING|CRITICAL|EMERGENCY, alarm_state:
// ACTIVE|ACKNOWLEDGED|CLEARED|SHELVED) become plain text columns here — SQLite
// has no native enum type. jsonb → text(mode json), timestamptz → integer
// timestamp, following this file's existing conventions. Table names, column
// names, and column intent match schema.ts so code that touches alarms behaves
// the same in dev SQLite as in production Postgres. Kept in sync by
// `shared/__tests__/schema-parity.test.ts`.
export const alarms = sqliteTable("alarms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  siteId: text("site_id"),
  assetId: text("asset_id"),
  tagId: text("tag_id"),
  severity: text("severity").notNull(), // alarm_severity enum in Postgres
  condition: text("condition", { mode: "json" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  deadband: real("deadband"),
  delay: integer("delay_ms"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const alarmHistory = sqliteTable("alarm_history", {
  id: text("id").primaryKey(),
  alarmId: text("alarm_id").notNull(),
  state: text("state").notNull(), // alarm_state enum in Postgres
  value: real("trigger_value"),
  message: text("message"),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
  clearedAt: integer("cleared_at", { mode: "timestamp" }),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Validator Registry (#454) ───────────────────────────────────────────────
// Dev-mode parity with the Postgres schema (`shared/schema.ts`) for the
// cross-node `/state/:key` proxy. timestamptz → integer timestamp, boolean →
// integer(mode boolean), bigint → integer, following this file's conventions.
// The development database is created from the matching DDL in
// `server/storage.ts` (`validatorRegistrySqliteSchema`); these declarations pin
// the column contract against Postgres via
// `shared/__tests__/schema-parity.test.ts`, and every column is exercised
// against the live dev database by `server/__tests__/validator-registry.test.ts`.

export const validatorNodes = sqliteTable("validator_nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rpcUrl: text("rpc_url").notNull(),
  operatorId: text("operator_id"),
  region: text("region"),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const validatorPubkeys = sqliteTable("validator_pubkeys", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  algorithm: text("algorithm").default("ed25519").notNull(),
  publicKeyPem: text("public_key_pem").notNull(),
  keyId: text("key_id").notNull(),
  active: integer("active", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  retiredAt: integer("retired_at", { mode: "timestamp" }),
});

export const validatorStateWatermarks = sqliteTable("validator_state_watermarks", {
  id: text("id").primaryKey(),
  nodeId: text("node_id").notNull(),
  stateKey: text("state_key").notNull(),
  blockHeight: integer("block_height").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Observed Liveness Observations (#456) ───────────────────────────────────
// Dev-mode parity with the Postgres table in `shared/schema.ts`, created in
// production by migrations/0012_validator_liveness_observations.sql. The
// physical SQLite DDL lives in `validatorLivenessSqliteSchema` (server/storage.ts)
// and is applied on every open. Kept in sync by
// `shared/__tests__/schema-parity.test.ts`.
//
// This table records OBSERVED LIVENESS — whether each configured node answered
// a poll round and whether the chain height it reported advanced. It does NOT
// record consensus attestation duty outcomes; this build has no source for
// those. See the Postgres definition for the full per-status semantics.
//
// timestamptz → integer timestamp, bigint → integer, double precision → real.
export const validatorLivenessObservations = sqliteTable("validator_liveness_observations", {
  id: text("id").primaryKey(),
  validatorId: text("validator_id").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
  roundSeq: integer("round_seq").notNull(),
  status: text("status").notNull(),
  sourceNodeUrl: text("source_node_url").notNull(),
  observedHeight: integer("observed_height"),
  previousHeight: integer("previous_height"),
  observedUptimeTicks: integer("observed_uptime_ticks"),
  reportedNodeId: text("reported_node_id"),
  localPhase: real("local_phase"),
  meanPhase: real("mean_phase"),
  detail: text("detail"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── Blueprint Safe-State audit trail (#459) ─────────────────────────────────
// Dev-mode parity with the Postgres table in `shared/schema.ts`, which is
// created in production by migrations/0009_blueprint_safe_state_log.sql. The
// safe-state audit must be durable on BOTH dialects — a swallowed audit write
// would let the controller report a safe-state transition that was discarded.
// jsonb → text(mode json), timestamptz → integer timestamp, per this file's
// conventions. Kept in sync by `shared/__tests__/schema-parity.test.ts`; the
// physical SQLite DDL lives in `blueprintSqliteSchema` (server/storage.ts).
export const blueprintSafeStateLog = sqliteTable("blueprint_safe_state_log", {
  id: text("id").primaryKey(),
  blueprintId: text("blueprint_id").notNull(),
  siteId: text("site_id"),
  transition: text("transition").notNull(),
  safeState: text("safe_state", { mode: "json" }).notNull(),
  tickBudgetMs: integer("tick_budget_ms").notNull(),
  consecutiveMisses: integer("consecutive_misses"),
  operator: text("operator"),
  reason: text("reason").notNull(),
  anchorHash: text("anchor_hash").notNull(),
  anchorTxHash: text("anchor_tx_hash"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ─── PID Tuning Audit (ADR-0013 [13.4], #215) ────────────────────────────────
// Dev-mode parity with `shared/schema.ts`. jsonb → text(mode json), timestamptz
// → integer timestamp_ms (millisecond precision keeps audit rows totally
// ordered), uuid → text. Append-only is enforced by BEFORE UPDATE / BEFORE
// DELETE triggers created alongside the table (see
// server/services/tuning/audit-store.ts for the SQLite DDL and migration 0010
// for the Postgres equivalent). Kept in sync by
// `shared/__tests__/schema-parity.test.ts`.
export const pidTuningAudit = sqliteTable("pid_tuning_audit", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  controllerId: text("controller_id").notNull(),
  method: text("method").notNull(),
  decision: text("decision").notNull(),
  proposedBy: text("proposed_by").notNull(),
  decidedBy: text("decided_by"),
  currentGains: text("current_gains", { mode: "json" }).$type<TuningGains>().notNull(),
  proposedGains: text("proposed_gains", { mode: "json" }).$type<TuningGains>().notNull(),
  appliedGains: text("applied_gains", { mode: "json" }).$type<TuningGains>(),
  envelope: text("envelope", { mode: "json" }).$type<GainEnvelope>().notNull(),
  envelopeDecision: text("envelope_decision").notNull(),
  reasonCode: text("reason_code"),
  detail: text("detail"),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Digital Twin Persistence (ADR-0013 [13.3], #550) ────────────────────────
// Dev-mode parity with `shared/schema.ts`, created in production by
// migrations/0014_twin_persistence.sql. jsonb → text(mode json), timestamptz →
// integer timestamp_ms, bigint → integer, double precision → real. The twin's
// model registry must be durable on BOTH dialects: a registry that silently
// resets on restart is exactly the defect #550 exists to remove.
// Kept in sync by `shared/__tests__/schema-parity.test.ts`; the physical SQLite
// DDL lives in `server/services/twin/persistence.ts`.
export const twinModels = sqliteTable("twin_models", {
  id: text("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  definition: text("definition", { mode: "json" }).$type<ProcessModel>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Predictive Maintenance Durable State (#212/#493, #546) ──────────────────
// Dev-mode parity with `shared/schema.ts`. jsonb → text(mode json), timestamptz
// → integer timestamp_ms, double precision → real, varchar → text. The DDL that
// creates these tables for SQLite lives in
// `server/services/predictive/store.ts`; `migrations/0013_predictive_durable_state.sql`
// is the Postgres source of truth. Kept in sync by
// `shared/__tests__/schema-parity.test.ts`.
//
// Column ORDER matters here: `server/services/predictive/store.ts` reads rows
// back through drizzle's sqlite-proxy driver, which maps result columns
// positionally, so the DDL, this declaration and the Postgres table must all
// list columns in the same order.
export const predictiveTagThresholds = sqliteTable("predictive_tag_thresholds", {
  tagId: text("tag_id").primaryKey(),
  minSamples: integer("min_samples").notNull(),
  zScoreThreshold: real("z_score_threshold").notNull(),
  ewmaAlpha: real("ewma_alpha").notNull(),
  ewmaL: real("ewma_l").notNull(),
  iqrMultiplier: real("iqr_multiplier").notNull(),
  ensembleWeights: text("ensemble_weights", { mode: "json" })
    .$type<Record<string, number>>()
    .notNull(),
  severityThresholds: text("severity_thresholds", { mode: "json" })
    .$type<{ warning: number; critical: number; emergency: number }>()
    .notNull(),
  failureLimits: text("failure_limits", { mode: "json" }).$type<{
    low?: number;
    high?: number;
  }>(),
  updatedBy: text("updated_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ─── Alarm Correlation Coordination (ADR-0026 / ADR-0013 [13.2], #573) ───────
// Dev-mode parity with `shared/schema.ts`, whose block comment carries the full
// ordering / identifier / idempotency / fail-safe rationale. Production DDL is
// migrations/0015_alarm_correlation_coordination.sql; the physical SQLite DDL
// lives in server/services/alarm-correlation/store.ts. Dialect mappings follow
// this file's conventions: jsonb → text(mode json), timestamptz → integer
// timestamp_ms, bigint → integer, boolean → integer(mode boolean).
//
// These tables are safety state, not a dev convenience: on either dialect they
// are what makes a suppressed alarm restorable. Kept in sync by
// `shared/__tests__/schema-parity.test.ts`.

// `seq` is INTEGER PRIMARY KEY AUTOINCREMENT in the physical DDL, which is
// SQLite's monotonic-never-reused rowid — the same guarantee Postgres gives
// with BIGSERIAL, and the reason group ids derived from it can never collide.
export const alarmCorrelationJournal = sqliteTable("alarm_correlation_journal", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  op: text("op").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  principal: text("principal").notNull(),
  originInstance: text("origin_instance").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alarmCorrelationGroups = sqliteTable("alarm_correlation_groups", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  rootCauseAlarmId: text("root_cause_alarm_id").notNull(),
  formedByRuleId: text("formed_by_rule_id").notNull(),
  joinedVia: text("joined_via", { mode: "json" }).notNull(),
  maxSeverity: text("max_severity").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  lastAlarmAtMs: integer("last_alarm_at_ms").notNull(),
  closedAtMs: integer("closed_at_ms"),
  closeReason: text("close_reason"),
  updatedSeq: integer("updated_seq").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// No `status` column, matching Postgres: a restored simulation is always idle.
export const twinCheckpoints = sqliteTable("twin_checkpoints", {
  modelId: text("model_id")
    .primaryKey()
    .references(() => twinModels.id, { onDelete: "cascade" }),
  schemaVersion: integer("schema_version").notNull(),
  tick: integer("tick").notNull(),
  timeMs: real("time_ms").notNull(),
  componentStates: text("component_states", { mode: "json" })
    .$type<Record<string, Record<string, number>>>()
    .notNull(),
  lastSyncAt: integer("last_sync_at"),
  committedAt: integer("committed_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const predictiveAlerts = sqliteTable("predictive_alerts", {
  id: text("id").primaryKey(),
  tagId: text("tag_id").notNull(),
  severity: text("severity").notNull(),
  score: real("score").notNull(),
  message: text("message").notNull(),
  detectors: text("detectors", { mode: "json" }).$type<string[]>().notNull(),
  recommendation: text("recommendation").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  acknowledged: integer("acknowledged", { mode: "boolean" }).notNull().default(false),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
});

export const alarmCorrelationAlarms = sqliteTable("alarm_correlation_alarms", {
  id: text("id").primaryKey(),
  groupId: text("group_id"),
  name: text("name").notNull(),
  tagId: text("tag_id").notNull(),
  equipmentId: text("equipment_id"),
  siteId: text("site_id"),
  processArea: text("process_area"),
  severity: text("severity").notNull(),
  state: text("state").notNull(),
  message: text("message").notNull(),
  eventTimeMs: integer("event_time_ms").notNull(),
  alarmValue: text("alarm_value", { mode: "json" }),
  alarmLimit: text("alarm_limit", { mode: "json" }),
  source: text("source"),
  acknowledgedBy: text("acknowledged_by"),
  clearedBy: text("cleared_by"),
  suppressed: integer("suppressed", { mode: "boolean" }).default(false).notNull(),
  isRootCause: integer("is_root_cause", { mode: "boolean" }).default(false).notNull(),
  joinedViaRuleId: text("joined_via_rule_id"),
  ingestSeq: integer("ingest_seq").notNull(),
  updatedSeq: integer("updated_seq").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alarmCorrelationRules = sqliteTable("alarm_correlation_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  priority: integer("priority").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedSeq: integer("updated_seq").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alarmCorrelationEquipment = sqliteTable("alarm_correlation_equipment", {
  equipmentId: text("equipment_id").primaryKey(),
  name: text("name"),
  parentId: text("parent_id"),
  causalDownstream: text("causal_downstream", { mode: "json" }).notNull(),
  siteId: text("site_id"),
  processArea: text("process_area"),
  updatedBy: text("updated_by").notNull(),
  updatedSeq: integer("updated_seq").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const alarmCorrelationState = sqliteTable("alarm_correlation_state", {
  id: text("id").primaryKey(),
  appliedSeq: integer("applied_seq").default(0).notNull(),
  suppressionEnabled: integer("suppression_enabled", { mode: "boolean" })
    .default(false).notNull(),
  neverSuppressAtOrAbove: text("never_suppress_at_or_above")
    .default("critical").notNull(),
  unsuppressOnRootClear: integer("unsuppress_on_root_clear", { mode: "boolean" })
    .default(true).notNull(),
  alarmsIngested: integer("alarms_ingested").default(0).notNull(),
  groupsCreated: integer("groups_created").default(0).notNull(),
  groupsClosed: integer("groups_closed").default(0).notNull(),
  alarmsSuppressed: integer("alarms_suppressed").default(0).notNull(),
  alarmsUnsuppressed: integer("alarms_unsuppressed").default(0).notNull(),
  updatedBy: text("updated_by").default("system").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Basic exports for compatibility
export const insertSiteSchema = {
  parse: (data: any) => data // Simple pass-through for development
};

export const insertAssetSchema = {
  parse: (data: any) => data
};

export const insertEventAnchorSchema = {
  parse: (data: any) => data
};

export const insertMaintenanceRecordSchema = {
  parse: (data: any) => data
};

export const insertAlarmSchema = {
  parse: (data: InsertAlarm): InsertAlarm => data // Simple pass-through for development
};

export const insertAlarmHistorySchema = {
  parse: (data: InsertAlarmHistory): InsertAlarmHistory => data
};

// Type exports
export type Site = typeof sites.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type EventAnchor = typeof eventAnchors.$inferSelect;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;
export type InsertAsset = typeof assets.$inferInsert;
export type InsertEventAnchor = typeof eventAnchors.$inferInsert;
export type InsertMaintenanceRecord = typeof maintenanceRecords.$inferInsert;
export type Vendor = typeof vendors.$inferSelect;
export type InsertVendor = typeof vendors.$inferInsert;
export type TemplatePackage = typeof templatePackages.$inferSelect;
export type InsertTemplatePackage = typeof templatePackages.$inferInsert;
export type ControlModuleType = typeof controlModuleTypes.$inferSelect;
export type InsertControlModuleType = typeof controlModuleTypes.$inferInsert;
export type ControlModuleInstance = typeof controlModuleInstances.$inferSelect;
export type InsertControlModuleInstance = typeof controlModuleInstances.$inferInsert;
export type UnitType = typeof unitTypes.$inferSelect;
export type InsertUnitType = typeof unitTypes.$inferInsert;
export type UnitInstance = typeof unitInstances.$inferSelect;
export type InsertUnitInstance = typeof unitInstances.$inferInsert;
export type PhaseType = typeof phaseTypes.$inferSelect;
export type InsertPhaseType = typeof phaseTypes.$inferInsert;
export type PhaseInstance = typeof phaseInstances.$inferSelect;
export type InsertPhaseInstance = typeof phaseInstances.$inferInsert;
export type DesignSpecification = typeof designSpecifications.$inferSelect;
export type InsertDesignSpecification = typeof designSpecifications.$inferInsert;
export type GeneratedCode = typeof generatedCode.$inferSelect;
export type InsertGeneratedCode = typeof generatedCode.$inferInsert;
export type DataTypeMapping = typeof dataTypeMappings.$inferSelect;
export type InsertDataTypeMapping = typeof dataTypeMappings.$inferInsert;
export type Controller = typeof controllers.$inferSelect;
export type InsertController = typeof controllers.$inferInsert;
export type Alarm = typeof alarms.$inferSelect;
export type InsertAlarm = typeof alarms.$inferInsert;
export type AlarmHistory = typeof alarmHistory.$inferSelect;
export type InsertAlarmHistory = typeof alarmHistory.$inferInsert;

// ─── #55: tables previously missing from the dev-mode mirror ─────────────────
// Mirrored from shared/schema.ts under the established conventions:
// uuid/varchar → text, pgEnum → text, jsonb → text({mode:"json"}),
// timestamptz → integer({mode:"timestamp"}), boolean → integer({mode:"boolean"}).
// No FKs/indexes (simplified dev mirror). The parity suite enumerates ALL
// Postgres tables, so the next new table cannot skip this file silently.

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  isSystem: integer("is_system", { mode: "boolean" }).default(false).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const permissions = sqliteTable("permissions", {
  id: text("id").primaryKey(),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const rolePermissions = sqliteTable("role_permissions", {
  roleId: text("role_id").notNull(),
  permissionId: text("permission_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const userRoles = sqliteTable("user_roles", {
  userId: text("user_id").notNull(),
  roleId: text("role_id").notNull(),
  siteId: text("site_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  action: text("action").notNull(), // audit_action enum in Postgres
  resource: text("resource").notNull(),
  resourceId: text("resource_id"),
  details: text("details", { mode: "json" }),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  siteId: text("site_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const recipes = sqliteTable("recipes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  siteId: text("site_id"),
  assetId: text("asset_id"),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const recipeVersions = sqliteTable("recipe_versions", {
  id: text("id").primaryKey(),
  recipeId: text("recipe_id").notNull(),
  version: integer("version").notNull(),
  parameters: text("parameters", { mode: "json" }).notNull(),
  setpoints: text("setpoints", { mode: "json" }),
  approvedBy: text("approved_by"),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  comment: text("comment"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const historianData = sqliteTable("historian_data", {
  id: text("id").primaryKey(),
  tagId: text("tag_id").notNull(),
  siteId: text("site_id"),
  value: real("value"),
  stringValue: text("string_value"),
  quality: integer("quality").default(192),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const certifications = sqliteTable("certifications", {
  id: text("id").primaryKey(),
  certType: text("cert_type").notNull(), // cert_type enum in Postgres
  title: text("title").notNull(),
  description: text("description"),
  artifactHash: text("artifact_hash").notNull(),
  artifactUri: text("artifact_uri"),
  validFrom: integer("valid_from", { mode: "timestamp" }),
  validUntil: integer("valid_until", { mode: "timestamp" }),
  siteId: text("site_id"),
  assetId: text("asset_id"),
  metadata: text("metadata", { mode: "json" }),
  status: text("status").default("DRAFT").notNull(), // cert_status enum in Postgres
  requiredApprovals: integer("required_approvals").default(1).notNull(),
  currentApprovals: integer("current_approvals").default(0).notNull(),
  requestedBy: text("requested_by").notNull(),
  supersedes: text("supersedes"),
  supersededBy: text("superseded_by"),
  tokenId: text("token_id"),
  txHash: text("tx_hash"),
  mintedAt: integer("minted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const certificationApprovals = sqliteTable("certification_approvals", {
  id: text("id").primaryKey(),
  certificationId: text("certification_id").notNull(),
  approverId: text("approver_id").notNull(),
  approverRole: text("approver_role"),
  status: text("status").default("PENDING").notNull(),
  comment: text("comment"),
  decidedAt: integer("decided_at", { mode: "timestamp" }),
  signature: text("signature"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const modbusRegisterMap = sqliteTable("modbus_register_map", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  unitId: integer("unit_id").default(1).notNull(),
  area: text("area").notNull(),
  address: integer("address").notNull(),
  tagId: text("tag_id").notNull(),
  dataType: text("data_type").notNull(),
  scale: real("scale"),
  wordOrder: text("word_order"),
  writable: integer("writable", { mode: "boolean" }).default(false).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const pluginRegistry = sqliteTable("plugin_registry", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  manifest: text("manifest", { mode: "json" }).notNull(),
  publisher: text("publisher").notNull(),
  installs: integer("installs").default(0).notNull(),
  publishedAt: integer("published_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const pluginInstallations = sqliteTable("plugin_installations", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  manifest: text("manifest", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  config: text("config", { mode: "json" }).notNull().$defaultFn(() => ({})),
  grantedCapabilities: text("granted_capabilities", { mode: "json" }).notNull().$defaultFn(() => []),
  installedBy: text("installed_by").notNull(),
  installedAt: integer("installed_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
