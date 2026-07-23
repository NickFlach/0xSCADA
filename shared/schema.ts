/**
 * 0xSCADA Database Schema — Drizzle ORM
 * 
 * Issue #205: Database Migrations & Schema (ADR-0012 Wave 1)
 * 
 * Tables:
 *   - sites, assets: Core SCADA entities
 *   - roles, permissions, role_permissions, users, user_roles: RBAC
 *   - audit_logs: Audit trail
 *   - recipes, recipe_versions: Recipe management
 *   - alarms, alarm_history: Alarm management
 *   - historian_data: Time-series historian
 *   - event_anchors: Blockchain-anchored events
 *   - maintenance_records: Maintenance tracking
 *   - certifications, certification_approvals: Certification workflow
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod"; // #459: safe-state config validation schemas

// ─── Enums ───────────────────────────────────────────────────────────────────

export const siteStatusEnum = pgEnum("site_status", ["ONLINE", "OFFLINE", "MAINTENANCE"]);
export const assetStatusEnum = pgEnum("asset_status", ["OK", "WARNING", "CRITICAL"]);
export const assetTypeEnum = pgEnum("asset_type", [
  "TRANSFORMER", "BREAKER", "MCC", "FEEDER", "INVERTER", "PLC", "SENSOR", "PUMP", "VALVE",
]);
export const alarmSeverityEnum = pgEnum("alarm_severity", ["INFO", "WARNING", "CRITICAL", "EMERGENCY"]);
export const alarmStateEnum = pgEnum("alarm_state", ["ACTIVE", "ACKNOWLEDGED", "CLEARED", "SHELVED"]);
export const certStatusEnum = pgEnum("cert_status", [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "MINTED", "EXPIRED", "SUPERSEDED",
]);
export const certTypeEnum = pgEnum("cert_type", [
  "MACHINE_STATE", "SAFETY_CONDITION", "AGENT_CAPABILITY", "COMPLIANCE_SNAPSHOT", "CALIBRATION_RECORD",
]);
export const auditActionEnum = pgEnum("audit_action", [
  "CREATE", "UPDATE", "DELETE", "LOGIN", "LOGOUT", "ACKNOWLEDGE", "OVERRIDE", "EXECUTE", "APPROVE", "REJECT",
]);

// ─── Sites ───────────────────────────────────────────────────────────────────

export const sites = pgTable("sites", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  location: varchar("location", { length: 255 }),
  owner: varchar("owner", { length: 255 }),
  status: siteStatusEnum("status").default("ONLINE").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Assets ──────────────────────────────────────────────────────────────────

export const assets = pgTable("assets", {
  id: varchar("id", { length: 64 }).primaryKey(),
  siteId: varchar("site_id", { length: 64 }).notNull().references(() => sites.id),
  assetType: assetTypeEnum("asset_type").notNull(),
  nameOrTag: varchar("name_or_tag", { length: 255 }).notNull(),
  critical: boolean("critical").default(false).notNull(),
  metadata: jsonb("metadata"),
  status: assetStatusEnum("status").default("OK").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteIdIdx: index("idx_assets_site_id").on(table.siteId),
}));

// ─── RBAC: Roles & Permissions ───────────────────────────────────────────────

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameIdx: uniqueIndex("idx_roles_name").on(table.name),
}));

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  resource: varchar("resource", { length: 100 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  resourceActionIdx: uniqueIndex("idx_permissions_resource_action").on(table.resource, table.action),
}));

export const rolePermissions = pgTable("role_permissions", {
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
}));

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: varchar("username", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }),
  passwordHash: varchar("password_hash", { length: 255 }),
  walletAddress: varchar("wallet_address", { length: 255 }),
  displayName: varchar("display_name", { length: 255 }),
  isActive: boolean("is_active").default(true).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  usernameIdx: uniqueIndex("idx_users_username").on(table.username),
  emailIdx: uniqueIndex("idx_users_email").on(table.email),
}));

export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.roleId] }),
}));

// ─── Audit Logs ──────────────────────────────────────────────────────────────

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  action: auditActionEnum("action").notNull(),
  resource: varchar("resource", { length: 100 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }),
  details: jsonb("details"),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index("idx_audit_logs_user_id").on(table.userId),
  actionIdx: index("idx_audit_logs_action").on(table.action),
  resourceIdx: index("idx_audit_logs_resource").on(table.resource, table.resourceId),
  createdAtIdx: index("idx_audit_logs_created_at").on(table.createdAt),
}));

// ─── Recipes ─────────────────────────────────────────────────────────────────

export const recipes = pgTable("recipes", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  assetId: varchar("asset_id", { length: 64 }).references(() => assets.id),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteIdIdx: index("idx_recipes_site_id").on(table.siteId),
}));

export const recipeVersions = pgTable("recipe_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  parameters: jsonb("parameters").notNull(),
  setpoints: jsonb("setpoints"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  comment: text("comment"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  recipeVersionIdx: uniqueIndex("idx_recipe_versions_recipe_version").on(table.recipeId, table.version),
}));

// ─── Alarms ──────────────────────────────────────────────────────────────────

export const alarms = pgTable("alarms", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  assetId: varchar("asset_id", { length: 64 }).references(() => assets.id),
  tagId: varchar("tag_id", { length: 255 }),
  severity: alarmSeverityEnum("severity").notNull(),
  condition: jsonb("condition").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  deadband: real("deadband"),
  delay: integer("delay_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteIdIdx: index("idx_alarms_site_id").on(table.siteId),
  assetIdIdx: index("idx_alarms_asset_id").on(table.assetId),
}));

export const alarmHistory = pgTable("alarm_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  alarmId: uuid("alarm_id").notNull().references(() => alarms.id),
  state: alarmStateEnum("state").notNull(),
  value: real("trigger_value"),
  message: text("message"),
  acknowledgedBy: uuid("acknowledged_by").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  alarmIdIdx: index("idx_alarm_history_alarm_id").on(table.alarmId),
  stateIdx: index("idx_alarm_history_state").on(table.state),
  createdAtIdx: index("idx_alarm_history_created_at").on(table.createdAt),
}));

// ─── Historian Data ──────────────────────────────────────────────────────────

export const historianData = pgTable("historian_data", {
  id: uuid("id").defaultRandom().primaryKey(),
  tagId: varchar("tag_id", { length: 255 }).notNull(),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  value: real("value"),
  stringValue: text("string_value"),
  quality: integer("quality").default(192),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tagTimestampIdx: index("idx_historian_tag_timestamp").on(table.tagId, table.timestamp),
  siteTimestampIdx: index("idx_historian_site_timestamp").on(table.siteId, table.timestamp),
}));

// ─── Event Anchors ───────────────────────────────────────────────────────────

export const eventAnchors = pgTable("event_anchors", {
  id: varchar("id", { length: 64 }).primaryKey(),
  assetId: varchar("asset_id", { length: 64 }).references(() => assets.id),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 255 }).notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  recordedBy: varchar("recorded_by", { length: 255 }),
  txHash: varchar("tx_hash", { length: 255 }),
  blockNumber: integer("block_number"),
  details: text("details"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  assetIdIdx: index("idx_event_anchors_asset_id").on(table.assetId),
  timestampIdx: index("idx_event_anchors_timestamp").on(table.timestamp),
  txHashIdx: index("idx_event_anchors_tx_hash").on(table.txHash),
}));

// ─── Maintenance Records ─────────────────────────────────────────────────────

export const maintenanceRecords = pgTable("maintenance_records", {
  id: varchar("id", { length: 64 }).primaryKey(),
  assetId: varchar("asset_id", { length: 64 }).notNull().references(() => assets.id),
  workOrderId: varchar("work_order_id", { length: 100 }),
  performedBy: varchar("performed_by", { length: 255 }),
  maintenanceType: varchar("maintenance_type", { length: 100 }).notNull(),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
  nextDueAt: timestamp("next_due_at", { withTimezone: true }),
  notes: text("notes"),
  attachmentHash: varchar("attachment_hash", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  assetIdIdx: index("idx_maintenance_asset_id").on(table.assetId),
}));

// ─── Certifications ──────────────────────────────────────────────────────────

export const certifications = pgTable("certifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  certType: certTypeEnum("cert_type").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  artifactHash: varchar("artifact_hash", { length: 255 }).notNull(),
  artifactUri: text("artifact_uri"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  assetId: varchar("asset_id", { length: 64 }).references(() => assets.id),
  metadata: jsonb("metadata"),
  status: certStatusEnum("status").default("DRAFT").notNull(),
  requiredApprovals: integer("required_approvals").default(1).notNull(),
  currentApprovals: integer("current_approvals").default(0).notNull(),
  requestedBy: varchar("requested_by", { length: 255 }).notNull(),
  supersedes: uuid("supersedes"),
  supersededBy: uuid("superseded_by"),
  tokenId: varchar("token_id", { length: 255 }),
  txHash: varchar("tx_hash", { length: 255 }),
  mintedAt: timestamp("minted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteIdIdx: index("idx_certifications_site_id").on(table.siteId),
  statusIdx: index("idx_certifications_status").on(table.status),
}));

export const certificationApprovals = pgTable("certification_approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  certificationId: uuid("certification_id").notNull().references(() => certifications.id, { onDelete: "cascade" }),
  approverId: varchar("approver_id", { length: 255 }).notNull(),
  approverRole: varchar("approver_role", { length: 100 }),
  status: varchar("status", { length: 20 }).default("PENDING").notNull(),
  comment: text("comment"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  signature: text("signature"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  certIdIdx: index("idx_cert_approvals_cert_id").on(table.certificationId),
}));

// ─── Blueprint Safe-State (#459) ─────────────────────────────────────────────
// Watchdog & Safe-State Fallback. A blueprint's control tick has a per-tick
// budget; if it is exceeded for N consecutive ticks the watchdog halts the
// blueprint and applies a pre-declared safe state, anchoring a CRITICAL
// `SafeStateEntered` event. Re-entry to RUNNING requires explicit operator
// action. These additions are append-only to avoid cross-issue merge conflicts.

/**
 * Pre-declared safe state a blueprint falls back to on a watchdog trip.
 *  - `hold-last`  : freeze all outputs at their last commanded value.
 *  - `force-zero` : drive all outputs to zero / de-energised.
 *  - { recipe }   : load a named, previously-validated safe recipe.
 */
export const safeStateActionSchema = z.union([
  z.literal("hold-last"),
  z.literal("force-zero"),
  z.object({ recipe: z.string().min(1) }),
]);
export type SafeStateAction = z.infer<typeof safeStateActionSchema>;

/** Per-blueprint watchdog / safe-state configuration. */
export const safeStateConfigSchema = z.object({
  /** Whether the watchdog is armed for this blueprint. */
  enabled: z.boolean().default(true),
  /** Per-tick wall-clock budget in milliseconds. */
  tickBudgetMs: z.number().int().positive(),
  /** Consecutive over-budget ticks tolerated before the safe state is applied. */
  consecutiveMissesBeforeSafeState: z.number().int().positive(),
  /** The pre-declared safe state to apply on a trip. */
  safeState: safeStateActionSchema,
});
export type SafeStateConfig = z.infer<typeof safeStateConfigSchema>;

// Persisted record of every safe-state entry / exit transition (audit trail).
export const blueprintSafeStateLog = pgTable("blueprint_safe_state_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  blueprintId: varchar("blueprint_id", { length: 64 }).notNull(),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  // ENTERED/EXIT_REQUESTED/EXITED plus compensating failure transitions.
  transition: varchar("transition", { length: 16 }).notNull(),
  // Serialized SafeStateAction that was applied.
  safeState: jsonb("safe_state").notNull(),
  tickBudgetMs: integer("tick_budget_ms").notNull(),
  consecutiveMisses: integer("consecutive_misses"),
  // Operator who acknowledged / resumed (null for an automatic ENTERED event).
  operator: varchar("operator", { length: 255 }),
  reason: text("reason").notNull(),
  // Hash anchored to the canonical anchor backend for this transition.
  anchorHash: varchar("anchor_hash", { length: 255 }).notNull(),
  anchorTxHash: varchar("anchor_tx_hash", { length: 255 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  blueprintIdIdx: index("idx_safe_state_log_blueprint_id").on(table.blueprintId),
  transitionIdx: index("idx_safe_state_log_transition").on(table.transition),
  createdAtIdx: index("idx_safe_state_log_created_at").on(table.createdAt),
  anchorHashIdx: uniqueIndex("idx_safe_state_log_anchor_hash").on(table.anchorHash),
}));

export type BlueprintSafeStateLog = typeof blueprintSafeStateLog.$inferSelect;
export type InsertBlueprintSafeStateLog = typeof blueprintSafeStateLog.$inferInsert;

// ─── Schema Exports ──────────────────────────────────────────────────────────

// Insert schemas for validation
export const insertSiteSchema = createInsertSchema(sites);
export const insertAssetSchema = createInsertSchema(assets);
export const insertEventAnchorSchema = createInsertSchema(eventAnchors);
export const insertMaintenanceRecordSchema = createInsertSchema(maintenanceRecords);

// Type exports
export type Site = typeof sites.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type EventAnchor = typeof eventAnchors.$inferSelect;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;
export type InsertAsset = typeof assets.$inferInsert;
export type InsertEventAnchor = typeof eventAnchors.$inferInsert;
