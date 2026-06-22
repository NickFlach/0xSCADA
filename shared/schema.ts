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

// ─── Modbus Register Map (Issue #462: Modbus TCP Server Mode) ────────────────
//
// Per-site mapping of 0xSCADA tags to Modbus addresses so standard Modbus
// masters can poll 0xSCADA. One row per (site, area, address). `area` is one of
// coil | discreteInput | holdingRegister | inputRegister; `dataType` is one of
// bool | uint16 | int16 | uint32 | int32 | float32 (see
// server/protocols/modbus-server/register-map.ts for the runtime schema/codec).

export const modbusRegisterMap = pgTable("modbus_register_map", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: varchar("site_id", { length: 64 }).notNull().references(() => sites.id, { onDelete: "cascade" }),
  unitId: integer("unit_id").default(1).notNull(),
  area: varchar("area", { length: 32 }).notNull(),
  address: integer("address").notNull(),
  tagId: varchar("tag_id", { length: 255 }).notNull(),
  dataType: varchar("data_type", { length: 16 }).notNull(),
  scale: real("scale"),
  wordOrder: varchar("word_order", { length: 8 }),
  readOnly: boolean("read_only").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteAreaAddressIdx: uniqueIndex("idx_modbus_register_map_site_area_address").on(table.siteId, table.unitId, table.area, table.address),
  siteIdIdx: index("idx_modbus_register_map_site_id").on(table.siteId),
}));

// ─── Schema Exports ──────────────────────────────────────────────────────────

// Insert schemas for validation
export const insertSiteSchema = createInsertSchema(sites);
export const insertAssetSchema = createInsertSchema(assets);
export const insertEventAnchorSchema = createInsertSchema(eventAnchors);
export const insertMaintenanceRecordSchema = createInsertSchema(maintenanceRecords);
export const insertModbusRegisterMapSchema = createInsertSchema(modbusRegisterMap);

// Type exports
export type Site = typeof sites.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type EventAnchor = typeof eventAnchors.$inferSelect;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;
export type InsertAsset = typeof assets.$inferInsert;
export type InsertEventAnchor = typeof eventAnchors.$inferInsert;
export type ModbusRegisterMapRow = typeof modbusRegisterMap.$inferSelect;
export type InsertModbusRegisterMapRow = typeof modbusRegisterMap.$inferInsert;
