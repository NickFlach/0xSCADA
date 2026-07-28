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
 *   - plugin_registry, plugin_installations: Agent marketplace (#217)
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  real,
  doublePrecision,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod"; // #459: safe-state config validation schemas
import type { GainEnvelope, TuningGains } from "./types/tuning";

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

// ─── Blueprint Persistence ──────────────────────────────────────────────────

export const vendors = pgTable("vendors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  description: text("description"),
  platforms: jsonb("platforms").notNull().default(sql`'[]'::jsonb`),
  languages: jsonb("languages").notNull().default(sql`'[]'::jsonb`),
  configSchema: jsonb("config_schema").notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameIdx: uniqueIndex("idx_vendors_name").on(table.name),
}));

export const templatePackages = pgTable("template_packages", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  version: varchar("version", { length: 50 }).default("1.0.0").notNull(),
  description: text("description"),
  templateType: varchar("template_type", { length: 100 }).notNull(),
  language: varchar("language", { length: 50 }).notNull(),
  templateContent: text("template_content").notNull(),
  placeholders: jsonb("placeholders").notNull().default(sql`'[]'::jsonb`),
  requiredInputs: jsonb("required_inputs").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  vendorIdx: index("idx_template_packages_vendor").on(table.vendorId),
}));

export const controlModuleTypes = pgTable("control_module_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  version: varchar("version", { length: 50 }).default("1.0.0").notNull(),
  description: text("description"),
  inputs: jsonb("inputs").notNull().default(sql`'[]'::jsonb`),
  outputs: jsonb("outputs").notNull().default(sql`'[]'::jsonb`),
  inOuts: jsonb("in_outs").notNull().default(sql`'[]'::jsonb`),
  dataTypeMappings: jsonb("data_type_mappings").notNull().default(sql`'{}'::jsonb`),
  templatePackageId: uuid("template_package_id").references(() => templatePackages.id),
  sourcePackage: text("source_package"),
  classification: varchar("classification", { length: 100 }).default("control_module"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameIdx: uniqueIndex("idx_control_module_types_name").on(table.name),
}));

export const controlModuleInstances = pgTable("control_module_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  instanceNumber: integer("instance_number"),
  controlModuleTypeId: uuid("control_module_type_id").notNull().references(() => controlModuleTypes.id),
  controllerId: varchar("controller_id", { length: 255 }),
  unitInstanceId: uuid("unit_instance_id").references(() => unitInstances.id),
  pidDrawing: text("pid_drawing"),
  comment: text("comment"),
  configuration: jsonb("configuration").notNull().default(sql`'{}'::jsonb`),
  currentState: jsonb("current_state").notNull().default(sql`'{}'::jsonb`),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  assetId: varchar("asset_id", { length: 64 }).references(() => assets.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index("idx_control_module_instances_type").on(
    table.controlModuleTypeId,
  ),
  typeNameIdx: uniqueIndex("idx_control_module_instances_type_name").on(
    table.controlModuleTypeId,
    table.name,
  ),
}));

export const unitTypes = pgTable("unit_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  version: varchar("version", { length: 50 }).default("1.0.0").notNull(),
  description: text("description"),
  variables: jsonb("variables").notNull().default(sql`'[]'::jsonb`),
  equipmentModules: jsonb("equipment_modules").notNull().default(sql`'[]'::jsonb`),
  templatePackageId: uuid("template_package_id").references(() => templatePackages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameIdx: uniqueIndex("idx_unit_types_name").on(table.name),
}));

export const unitInstances = pgTable("unit_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  instanceNumber: integer("instance_number"),
  unitTypeId: uuid("unit_type_id").notNull().references(() => unitTypes.id),
  controllerId: varchar("controller_id", { length: 255 }),
  pidDrawing: text("pid_drawing"),
  processCell: text("process_cell"),
  area: text("area"),
  comment: text("comment"),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index("idx_unit_instances_type").on(table.unitTypeId),
  typeNameIdx: uniqueIndex("idx_unit_instances_type_name").on(
    table.unitTypeId,
    table.name,
  ),
}));

export const phaseTypes = pgTable("phase_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").references(() => vendors.id),
  version: varchar("version", { length: 50 }).default("1.0.0").notNull(),
  description: text("description"),
  linkedModules: jsonb("linked_modules").notNull().default(sql`'[]'::jsonb`),
  inputs: jsonb("inputs").notNull().default(sql`'[]'::jsonb`),
  outputs: jsonb("outputs").notNull().default(sql`'[]'::jsonb`),
  inOuts: jsonb("in_outs").notNull().default(sql`'[]'::jsonb`),
  internalValues: jsonb("internal_values").notNull().default(sql`'[]'::jsonb`),
  hmiParameters: jsonb("hmi_parameters").notNull().default(sql`'[]'::jsonb`),
  recipeParameters: jsonb("recipe_parameters").notNull().default(sql`'[]'::jsonb`),
  reportParameters: jsonb("report_parameters").notNull().default(sql`'[]'::jsonb`),
  sequences: jsonb("sequences").notNull().default(sql`'{}'::jsonb`),
  templatePackageId: uuid("template_package_id").references(() => templatePackages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameIdx: uniqueIndex("idx_phase_types_name").on(table.name),
}));

export const phaseInstances = pgTable("phase_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  instanceNumber: integer("instance_number"),
  phaseTypeId: uuid("phase_type_id").notNull().references(() => phaseTypes.id),
  unitInstanceId: uuid("unit_instance_id").references(() => unitInstances.id),
  controllerId: varchar("controller_id", { length: 255 }),
  currentState: varchar("current_state", { length: 100 }).default("IDLE"),
  currentStep: integer("current_step").default(0),
  linkedModuleInstances: jsonb("linked_module_instances").notNull().default(sql`'{}'::jsonb`),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  typeIdx: index("idx_phase_instances_type").on(table.phaseTypeId),
}));

export const designSpecifications = pgTable("design_specifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  version: varchar("version", { length: 50 }).notNull(),
  description: text("description"),
  contentHash: varchar("content_hash", { length: 255 }).notNull(),
  txHash: varchar("tx_hash", { length: 255 }),
  content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  anchoredAt: timestamp("anchored_at", { withTimezone: true }),
});

export const generatedCode = pgTable("generated_code", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceType: varchar("source_type", { length: 100 }).notNull(),
  sourceId: varchar("source_id", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  templatePackageId: uuid("template_package_id").references(() => templatePackages.id),
  language: varchar("language", { length: 50 }).notNull(),
  code: text("code").notNull(),
  codeHash: varchar("code_hash", { length: 255 }).notNull(),
  txHash: varchar("tx_hash", { length: 255 }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  status: varchar("status", { length: 50 }).default("draft").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: varchar("approved_by", { length: 255 }),
}, (table) => ({
  sourceIdx: index("idx_generated_code_source").on(
    table.sourceType,
    table.sourceId,
  ),
}));

export const dataTypeMappings = pgTable("data_type_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  canonicalType: varchar("canonical_type", { length: 100 }).notNull(),
  vendorType: varchar("vendor_type", { length: 100 }).notNull(),
  size: integer("size"),
  precision: integer("precision"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  vendorTypeIdx: uniqueIndex("idx_data_type_mappings_vendor_canonical").on(
    table.vendorId,
    table.canonicalType,
  ),
}));

export const controllers = pgTable("controllers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  siteId: varchar("site_id", { length: 64 }).references(() => sites.id),
  model: varchar("model", { length: 255 }).notNull(),
  firmwareVersion: varchar("firmware_version", { length: 100 }),
  address: varchar("address", { length: 255 }),
  configuration: jsonb("configuration").notNull().default(sql`'{}'::jsonb`),
  status: varchar("status", { length: 50 }).default("offline").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  vendorIdx: index("idx_controllers_vendor").on(table.vendorId),
}));

// ─── Validator Nodes & Pubkeys (#454: Cross-Node State Queries) ───────────────
// Additive — these tables back the per-validator /state/:key proxy so the server
// can resolve a validator's RPC endpoint and verify its signed responses against
// a registered public key before returning them to the operator.

export const validatorNodes = pgTable("validator_nodes", {
  // Human/operator-facing node id used in the URL (e.g. "validator-2").
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  // Base URL of the oxscada RPC endpoint, e.g. "http://10.0.0.12:9090"
  // (see docs/blockchain/validator-monitoring.md for the node RPC surface).
  rpcUrl: varchar("rpc_url", { length: 512 }).notNull(),
  // Owning operator, for inventory/reporting. NOT the rate-limit bucket: state
  // reads are bucketed by the caller's authenticated API-key identity, which is
  // a property of the requester rather than of the validator being queried.
  operatorId: varchar("operator_id", { length: 255 }),
  region: varchar("region", { length: 64 }),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  operatorIdIdx: index("idx_validator_nodes_operator_id").on(table.operatorId),
  enabledIdx: index("idx_validator_nodes_enabled").on(table.enabled),
}));

export const validatorPubkeys = pgTable("validator_pubkeys", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: varchar("node_id", { length: 64 }).notNull().references(() => validatorNodes.id, { onDelete: "cascade" }),
  // Signature scheme of the registered key. Default is ed25519 (node:crypto).
  algorithm: varchar("algorithm", { length: 32 }).default("ed25519").notNull(),
  // PEM-encoded SPKI public key (one row per active/rotated key).
  publicKeyPem: text("public_key_pem").notNull(),
  // Short fingerprint identifying which key the validator signed with. Required:
  // the proxy resolves the exact key named by the response so a rotated-out key
  // can never be substituted for the active one.
  keyId: varchar("key_id", { length: 128 }).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => ({
  nodeIdIdx: index("idx_validator_pubkeys_node_id").on(table.nodeId),
  nodeActiveIdx: index("idx_validator_pubkeys_node_active").on(table.nodeId, table.active),
  nodeKeyIdIdx: uniqueIndex("idx_validator_pubkeys_node_key_id").on(table.nodeId, table.keyId),
}));

/**
 * Per-(validator, state key) high-water mark of the highest block height the
 * server has ever accepted a signed answer for.
 *
 * This is the persisted half of the anti-rollback check in
 * `server/routes/nodes.ts`: a validator that answers a *fresh* challenge but
 * reports a block height below the mark is serving a rolled-back view of state,
 * and the proxy refuses to hand it to an operator. Persisting the mark (rather
 * than keeping it in process memory) is what makes the check survive restarts
 * and hold across server replicas sharing one database.
 */
export const validatorStateWatermarks = pgTable("validator_state_watermarks", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: varchar("node_id", { length: 64 }).notNull().references(() => validatorNodes.id, { onDelete: "cascade" }),
  // Named `state_key` rather than `key` to avoid quoting a SQL keyword.
  stateKey: varchar("state_key", { length: 512 }).notNull(),
  blockHeight: bigint("block_height", { mode: "number" }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nodeKeyIdx: uniqueIndex("idx_validator_state_watermarks_node_key").on(table.nodeId, table.stateKey),
}));

// ─── Observed Liveness Observations (#456) ───────────────────────────────────
//
// One row per configured node per poll round of the observed-liveness collector
// (`server/blockchain/liveness-collector.ts`). This is the durable history the
// Slashing & Liveness Visualizer's what-if simulator replays a proposed rule
// against.
//
// READ THE COLUMN NAMES LITERALLY. This table records LIVENESS OBSERVATIONS, not
// consensus attestation duty outcomes. The oxscada `/status` surface reports
// height / peers / mempool / Kuramoto phase / uptime_ticks and carries no
// per-slot duty outcome whatsoever, so no such outcome can be stored here. What
// each row asserts is exactly:
//
//   miss — the collector polled `source_node_url` at `observed_at` and the node
//          did not answer (transport failure, non-2xx, oversized body, or an
//          unparseable /status shape). `detail` carries the bounded reason.
//   hit  — the node answered and `observed_height` was strictly greater than
//          `previous_height` (the height stored by the previous observation).
//   late — the node answered but `observed_height` did not advance, OR this is
//          the first observation for the validator and there is no previous
//          height to compare against (`detail` distinguishes the two).
//
// Nothing is interpolated. When the node did not answer, `observed_height`,
// `observed_uptime_ticks`, `reported_node_id`, `local_phase` and `mean_phase`
// are NULL — never carried forward from an earlier round.
//
// SINGLE WRITER. `round_seq` is a per-collector monotonic ordinal (see the
// column comment) and the unique index below assumes one collector process
// writes this table. Running two would conflict on (validator_id, round_seq);
// inserts use ON CONFLICT DO NOTHING so the loser is dropped rather than
// corrupting the ordering.
export const validatorLivenessObservations = pgTable("validator_liveness_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Stable identity of the polled endpoint: `host[:port][/path]` of the
  // configured URL, derived WITHOUT contacting the node. It has to be derivable
  // offline because the most important rows are the ones where the node did not
  // answer and therefore reported no node_id of its own.
  validatorId: varchar("validator_id", { length: 128 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  // Monotonic ordinal of the poll round that produced this row. Deliberately
  // NOT the chain height: height is per-node (so it cannot identify a
  // fleet-wide round), it is absent exactly when the node did not answer (the
  // rows that matter most for slashing), and it can regress. `round_seq` counts
  // poll rounds that actually happened and is resumed from MAX(round_seq) at
  // startup so it stays monotonic across restarts. The real height is kept in
  // `observed_height` so no information is lost.
  roundSeq: bigint("round_seq", { mode: "number" }).notNull(),
  // 'hit' | 'miss' | 'late', with the meanings spelled out in the block above.
  status: varchar("status", { length: 8 }).notNull(),
  // Exact URL polled, for audit. Not returned to the browser.
  sourceNodeUrl: varchar("source_node_url", { length: 512 }).notNull(),
  observedHeight: bigint("observed_height", { mode: "number" }),
  previousHeight: bigint("previous_height", { mode: "number" }),
  observedUptimeTicks: bigint("observed_uptime_ticks", { mode: "number" }),
  reportedNodeId: varchar("reported_node_id", { length: 128 }),
  localPhase: doublePrecision("local_phase"),
  meanPhase: doublePrecision("mean_phase"),
  // Bounded, human-readable reason for the recorded status.
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  validatorRoundIdx: uniqueIndex("idx_validator_liveness_validator_round")
    .on(table.validatorId, table.roundSeq),
  // Window queries (1h / 24h / 7d) and retention pruning both scan by time.
  observedAtIdx: index("idx_validator_liveness_observed_at").on(table.observedAt),
  validatorObservedAtIdx: index("idx_validator_liveness_validator_observed_at")
    .on(table.validatorId, table.observedAt),
}));

// ─── Modbus Register Map (Issue #462: Modbus TCP Server Mode) ────────────────
//
// Per-site mapping of 0xSCADA tags to Modbus addresses so standard Modbus
// masters can poll 0xSCADA. One row per (site, area, address). `area` is one of
// coil | discreteInput | holdingRegister | inputRegister; `dataType` is one of
// bool | uint16 | int16 | uint32 | int32 | float32 (see
// server/protocols/modbus-server/register-map.ts for the runtime schema/codec).
//
// `writable` defaults to FALSE. Modbus TCP has no authentication, so mapping a
// tag only ever makes it readable; permitting a master to actuate it is a
// per-address opt-in that additionally requires the listener to have been
// started with MODBUS_SERVER_ALLOW_WRITES=true.

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
  writable: boolean("writable").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  siteAreaAddressIdx: uniqueIndex("idx_modbus_register_map_site_area_address").on(table.siteId, table.unitId, table.area, table.address),
  siteIdIdx: index("idx_modbus_register_map_site_id").on(table.siteId),
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

// ─── PID Tuning Audit (ADR-0013 [13.4], #215) ────────────────────────────────

/**
 * Append-only audit trail for every PID tuning decision that could move — or
 * was refused from moving — live controller gains.
 *
 * Immutability is enforced in the database, not only in application code:
 * migration 0010 installs BEFORE UPDATE / BEFORE DELETE triggers that raise.
 * There is deliberately no update or delete helper anywhere in the codebase.
 *
 * `proposedBy` / `decidedBy` are control-plane principal names taken from the
 * authenticated API key record — never from a request body.
 */
export const pidTuningAudit = pgTable("pid_tuning_audit", {
  id: uuid("id").defaultRandom().primaryKey(),
  proposalId: varchar("proposal_id", { length: 128 }).notNull(),
  controllerId: varchar("controller_id", { length: 128 }).notNull(),
  method: varchar("method", { length: 64 }).notNull(),
  decision: varchar("decision", { length: 32 }).notNull(),
  proposedBy: varchar("proposed_by", { length: 128 }).notNull(),
  decidedBy: varchar("decided_by", { length: 128 }),
  currentGains: jsonb("current_gains").$type<TuningGains>().notNull(),
  proposedGains: jsonb("proposed_gains").$type<TuningGains>().notNull(),
  appliedGains: jsonb("applied_gains").$type<TuningGains>(),
  envelope: jsonb("envelope").$type<GainEnvelope>().notNull(),
  envelopeDecision: varchar("envelope_decision", { length: 32 }).notNull(),
  reasonCode: varchar("reason_code", { length: 64 }),
  detail: text("detail"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  proposalIdx: index("idx_pid_tuning_audit_proposal").on(table.proposalId),
  controllerIdx: index("idx_pid_tuning_audit_controller").on(table.controllerId),
  recordedAtIdx: index("idx_pid_tuning_audit_recorded_at").on(table.recordedAt),
}));

// ─── Predictive Maintenance Durable State (ADR-0013 [13.1], #212/#493, #546) ─

/**
 * Operator-configured per-tag detection thresholds.
 *
 * This is durable *configuration*, not sampled data: it changes only when an
 * operator calls `PUT /api/predictive/thresholds/:tagId`, and it is what the
 * detectors are graded against. Holding it in a process-local Map meant a
 * restart silently reverted every tag to the built-in defaults — a tag that had
 * been deliberately desensitised would start alarming again, and a tag that had
 * been made more sensitive would stop. `updated_by` is the authenticated
 * control-plane principal (API key record name), never a request body field.
 *
 * Retention: none. Operator configuration is kept until the operator changes
 * it. Raw prediction history has a completely separate policy — it is an
 * in-process sliding window that is never written here (see
 * `server/services/predictive/engine.ts`).
 */
export const predictiveTagThresholds = pgTable("predictive_tag_thresholds", {
  tagId: varchar("tag_id", { length: 256 }).primaryKey(),
  minSamples: integer("min_samples").notNull(),
  zScoreThreshold: doublePrecision("z_score_threshold").notNull(),
  ewmaAlpha: doublePrecision("ewma_alpha").notNull(),
  ewmaL: doublePrecision("ewma_l").notNull(),
  iqrMultiplier: doublePrecision("iqr_multiplier").notNull(),
  ensembleWeights: jsonb("ensemble_weights").$type<Record<string, number>>().notNull(),
  severityThresholds: jsonb("severity_thresholds")
    .$type<{ warning: number; critical: number; emergency: number }>()
    .notNull(),
  failureLimits: jsonb("failure_limits").$type<{ low?: number; high?: number }>(),
  updatedBy: varchar("updated_by", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  updatedAtIdx: index("idx_predictive_thresholds_updated_at").on(table.updatedAt),
}));

/**
 * Generated predictive alerts and their acknowledgement state.
 *
 * `id` is content-derived (tag + severity + cooldown window), not a process
 * counter, so a restarted process or a second replica that observes the same
 * anomaly writes the same row instead of a duplicate. Inserts use
 * ON CONFLICT DO NOTHING, which makes the shared table — rather than a
 * process-local `lastAlertAt` Map — the alert-suppression authority.
 *
 * `acknowledged_by` / `acknowledged_at` are the audit half of the row: who
 * took ownership of the alert and when. Acknowledgement is a conditional
 * UPDATE (`WHERE acknowledged = false`), so the first acknowledgement wins
 * across replicas and a later one is reported as `already-acknowledged`
 * instead of overwriting the original attribution.
 *
 * Retention (distinct from operator configuration above, and applied by
 * `server/services/predictive/index.ts`):
 *   - acknowledged alerts are pruned after PREDICTIVE_ALERT_RETENTION_MS
 *   - any alert is pruned after PREDICTIVE_ALERT_MAX_AGE_MS
 *   - a row cap bounds the table; evictions are emitted, never silent
 */
export const predictiveAlerts = pgTable("predictive_alerts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  tagId: varchar("tag_id", { length: 256 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  score: doublePrecision("score").notNull(),
  message: text("message").notNull(),
  detectors: jsonb("detectors").$type<string[]>().notNull(),
  recommendation: text("recommendation").notNull(),
  /** Data-clock timestamp of the observation that triggered the alert. */
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  /** Wall-clock time the row was written. Retention and ordering key. */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  acknowledged: boolean("acknowledged").default(false).notNull(),
  acknowledgedBy: varchar("acknowledged_by", { length: 128 }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
}, (table) => ({
  tagIdx: index("idx_predictive_alerts_tag").on(table.tagId),
  severityIdx: index("idx_predictive_alerts_severity").on(table.severity),
  acknowledgedIdx: index("idx_predictive_alerts_acknowledged").on(table.acknowledged),
  createdAtIdx: index("idx_predictive_alerts_created_at").on(table.createdAt),
}));

// ─── Agent Marketplace (ADR-0013 [13.6], #217) ───────────────────────────────

/**
 * Published plugin manifests plus their durable ownership record.
 *
 * `publisher` is the authenticated control-plane principal that first
 * published the id. Publishing a later version of an existing id is refused
 * unless the requesting principal matches this row. There is deliberately NO
 * admin break-glass: an `admin`/`*` key reaches the publish route but is still
 * refused with `ownership-conflict` on someone else's id, because a takeover
 * that any privileged key can perform is not an ownership record. A transfer,
 * if ever wanted, belongs on its own explicitly-scoped endpoint.
 * The check is only a security control because the row is durable — an
 * ownership table that resets on restart would let a restart re-open the id.
 */
export const pluginRegistry = pgTable("plugin_registry", {
  id: varchar("id", { length: 64 }).primaryKey(),
  version: varchar("version", { length: 32 }).notNull(),
  manifest: jsonb("manifest").notNull(),
  publisher: varchar("publisher", { length: 255 }).notNull(),
  installs: integer("installs").default(0).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  publisherIdx: index("idx_plugin_registry_publisher").on(table.publisher),
}));

/**
 * One row per installed plugin: the manifest version pinned at install time,
 * the validated configuration, the capabilities actually granted, and the
 * lifecycle status. Grants are security state, so they are durable too.
 */
export const pluginInstallations = pgTable("plugin_installations", {
  id: varchar("id", { length: 64 }).primaryKey().references(() => pluginRegistry.id),
  version: varchar("version", { length: 32 }).notNull(),
  manifest: jsonb("manifest").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  grantedCapabilities: jsonb("granted_capabilities").notNull().default(sql`'[]'::jsonb`),
  installedBy: varchar("installed_by", { length: 255 }).notNull(),
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusIdx: index("idx_plugin_installations_status").on(table.status),
}));

// ─── Digital Twin Persistence (ADR-0013 [13.3], #550) ────────────────────────
//
// The twin runtime kept its model registry and simulation state in process
// memory, so a restart lost both. These two tables make the registry and one
// explicitly committed checkpoint per model durable.
//
// Physical DDL: migrations/0014_twin_persistence.sql (Postgres) and the
// SQLITE_DDL in server/services/twin/persistence.ts (dev/test fallback).
// Kept in sync by `shared/__tests__/schema-parity.test.ts`.

/**
 * One row per registered `ProcessModel`. `id` is the model id itself — the
 * same natural key the in-memory registry is keyed by, so storage and runtime
 * cannot disagree about which model a row describes.
 *
 * `schema_version` is the `TWIN_MODEL_SCHEMA_VERSION` the payload was written
 * under. A loader that does not know the version refuses the row rather than
 * decoding it under today's assumptions.
 */
export const twinModels = pgTable("twin_models", {
  id: varchar("id", { length: 128 }).primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  // The full ProcessModel as authored, re-validated by the runtime on load.
  definition: jsonb("definition").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Alarm Correlation Coordination (ADR-0026 / ADR-0013 [13.2], #573) ───────
//
// #213 shipped a process-local correlation engine whose suppression defaults
// OFF, because suppression that lives only in one process's heap silently
// changes what an operator sees and then loses that state on restart or when a
// second replica forms a different view. These six tables are the durable,
// replica-coordinated state ADR-0026 requires before suppression can be turned
// on in production.
//
// THE ORDERING MODEL. `alarm_correlation_journal` is a single, totally-ordered,
// append-only log of every correlation-affecting operation (alarm ingest,
// acknowledge, clear, rule/topology/policy change). The database allocates
// `seq`; appends are serialised (Postgres advisory lock, SQLite BEGIN
// IMMEDIATE) so commit order equals `seq` order and no reader can observe a
// gap that later fills in. Every replica consumes the same journal in `seq`
// order and applies each entry to its own deterministic engine, so all
// replicas converge on identical membership, root cause and suppression
// WITHOUT any replica needing to be leader. This is convergence by shared log,
// not order-independent merge: the log defines the order, and which replica an
// HTTP request happened to land on cannot change it.
//
// IDENTIFIERS. Group ids are derived from the journal `seq` that formed them
// (`ACG-<seq>` / `ACG-<seq>-<n>`), never from a per-process random source. Two
// replicas therefore cannot mint conflicting ids for the same group, cannot
// invent different ids for the same journal entry, and cannot reuse an id
// because `seq` is monotonic for the life of the table.
//
// IDEMPOTENCY. `idempotency_key` is UNIQUE. A retried or duplicated delivery
// re-appends the same key, hits the conflict, and returns the seq already
// assigned — it never produces a second entry and never double-counts.
//
// SAFETY. Nothing in these tables can hide an alarm. Suppression is only ever
// enabled while the durable projection reports healthy; on any storage or
// coordination failure the runtime disables suppression, restores every
// suppressed alarm and re-broadcasts it. That direction is deliberate and
// one-way: losing coordination can only ever reveal more alarms, never fewer.

/**
 * The shared, totally-ordered operation log. Append-only: there is no update
 * or delete helper. Retention prunes entries strictly below the materialised
 * watermark (`alarm_correlation_state.applied_seq`) — never above it, because
 * an entry that has not been projected yet is the only record of an operator's
 * acknowledge or clear.
 */
export const alarmCorrelationJournal = pgTable("alarm_correlation_journal", {
  // Monotonic total order. BIGSERIAL rather than a timestamp: wall clocks on
  // separate replicas disagree, and correlation needs a single agreed order.
  seq: bigint("seq", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  // Natural key of the operation — e.g. `ingest:<alarmId>`,
  // `ack:<alarmId>`, `policy:<hash>`. UNIQUE, so duplicate delivery of the
  // same logical operation collapses onto the entry already recorded.
  idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull().unique(),
  op: varchar("op", { length: 32 }).notNull(),
  payload: jsonb("payload").notNull(),
  // Authenticated control-plane principal that submitted the operation, taken
  // from the API key record — never from a request body. This is the lifecycle
  // attribution that has to survive a restart to remain an audit record.
  principal: varchar("principal", { length: 128 }).notNull(),
  // Which replica appended it. Diagnostic only: it must never affect ordering.
  originInstance: varchar("origin_instance", { length: 64 }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  recordedAtIdx: index("idx_alarm_corr_journal_recorded_at").on(table.recordedAt),
  opIdx: index("idx_alarm_corr_journal_op").on(table.op),
}));

/**
 * Materialised correlation groups. `updated_seq` records the journal entry
 * whose application produced this row, so a restarting replica knows exactly
 * how far the projection got.
 */
export const alarmCorrelationGroups = pgTable("alarm_correlation_groups", {
  id: varchar("id", { length: 64 }).primaryKey(),
  state: varchar("state", { length: 8 }).notNull(),
  rootCauseAlarmId: varchar("root_cause_alarm_id", { length: 128 }).notNull(),
  formedByRuleId: varchar("formed_by_rule_id", { length: 128 }).notNull(),
  // Which rule admitted each member, keyed by alarm id. Kept so a recovered
  // group can explain itself rather than merely existing.
  joinedVia: jsonb("joined_via").notNull().default(sql`'{}'::jsonb`),
  maxSeverity: varchar("max_severity", { length: 16 }).notNull(),
  // Event time, epoch ms — the clock correlation actually reasons about.
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
  lastAlarmAtMs: bigint("last_alarm_at_ms", { mode: "number" }).notNull(),
  closedAtMs: bigint("closed_at_ms", { mode: "number" }),
  closeReason: varchar("close_reason", { length: 32 }),
  updatedSeq: bigint("updated_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  stateIdx: index("idx_alarm_corr_groups_state").on(table.state),
  lastAlarmIdx: index("idx_alarm_corr_groups_last_alarm").on(table.lastAlarmAtMs),
}));

/**
 * Materialised alarm lifecycle. This is the row that makes suppression
 * recoverable: `suppressed` says the operator is not currently seeing this
 * alarm, and `group_id` + `severity` + `state` are everything needed to
 * restore it. If this row could not be written, suppression must not be on.
 *
 * `acknowledged_by` / `cleared_by` are control-plane principal names copied
 * from the journal entry, so attribution is immutable in the same sense the
 * journal is: the projection can be rebuilt from the log, and the log cannot
 * be rewritten through any route in this codebase.
 */
export const alarmCorrelationAlarms = pgTable("alarm_correlation_alarms", {
  id: varchar("id", { length: 128 }).primaryKey(),
  // NULL means tracked but ungrouped (the engine's "pending" set). Those rows
  // matter: they carry lifecycle and attribution for standalone alarms.
  groupId: varchar("group_id", { length: 64 }),
  name: varchar("name", { length: 256 }).notNull(),
  tagId: varchar("tag_id", { length: 256 }).notNull(),
  equipmentId: varchar("equipment_id", { length: 256 }),
  siteId: varchar("site_id", { length: 64 }),
  processArea: varchar("process_area", { length: 256 }),
  severity: varchar("severity", { length: 16 }).notNull(),
  state: varchar("state", { length: 16 }).notNull(),
  message: text("message").notNull(),
  eventTimeMs: bigint("event_time_ms", { mode: "number" }).notNull(),
  // number | string in the wire type, so JSON preserves which one it was.
  alarmValue: jsonb("alarm_value"),
  alarmLimit: jsonb("alarm_limit"),
  source: varchar("source", { length: 256 }),
  acknowledgedBy: varchar("acknowledged_by", { length: 128 }),
  clearedBy: varchar("cleared_by", { length: 128 }),
  suppressed: boolean("suppressed").default(false).notNull(),
  isRootCause: boolean("is_root_cause").default(false).notNull(),
  joinedViaRuleId: varchar("joined_via_rule_id", { length: 128 }),
  // Journal seq that first ingested this alarm, and the seq of the latest
  // state change. The latter is broadcast with every snapshot so a consumer
  // can drop an out-of-order or duplicated cross-instance echo.
  ingestSeq: bigint("ingest_seq", { mode: "number" }).notNull(),
  updatedSeq: bigint("updated_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  groupIdx: index("idx_alarm_corr_alarms_group").on(table.groupId),
  stateIdx: index("idx_alarm_corr_alarms_state").on(table.state),
  eventTimeIdx: index("idx_alarm_corr_alarms_event_time").on(table.eventTimeMs),
}));

/** Durable correlation rules — the configuration a restart must not forget. */
export const alarmCorrelationRules = pgTable("alarm_correlation_rules", {
  id: varchar("id", { length: 128 }).primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  type: varchar("type", { length: 16 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  priority: integer("priority").notNull(),
  config: jsonb("config").notNull(),
  updatedBy: varchar("updated_by", { length: 128 }).notNull(),
  updatedSeq: bigint("updated_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Durable equipment topology — hierarchy plus directed causal edges. */
export const alarmCorrelationEquipment = pgTable("alarm_correlation_equipment", {
  equipmentId: varchar("equipment_id", { length: 256 }).primaryKey(),
  name: varchar("name", { length: 256 }),
  parentId: varchar("parent_id", { length: 256 }),
  causalDownstream: jsonb("causal_downstream").notNull().default(sql`'[]'::jsonb`),
  siteId: varchar("site_id", { length: 64 }),
  processArea: varchar("process_area", { length: 256 }),
  updatedBy: varchar("updated_by", { length: 128 }).notNull(),
  updatedSeq: bigint("updated_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The LAST COMMITTED checkpoint for a model — at most one row per model,
 * written in the same transaction as the model it belongs to. A model row
 * without a checkpoint row is therefore a torn write, and the loader treats it
 * as corrupt rather than seeding the model from authored initial conditions
 * (which would silently substitute different state for real state).
 *
 * There is deliberately no `status` column: a restored simulation is always
 * idle and only starts when an authorized caller starts or steps it.
 */
export const twinCheckpoints = pgTable("twin_checkpoints", {
  modelId: varchar("model_id", { length: 128 })
    .primaryKey()
    .references(() => twinModels.id, { onDelete: "cascade" }),
  schemaVersion: integer("schema_version").notNull(),
  tick: bigint("tick", { mode: "number" }).notNull(),
  // Simulated clock in ms. Double precision rather than bigint because the
  // runtime carries it as a JS number and only requires it to stay finite.
  timeMs: doublePrecision("time_ms").notNull(),
  // Record<componentId, Record<parameter, number>>, re-validated against the
  // model's components before it is admitted into the runtime.
  componentStates: jsonb("component_states").notNull(),
  // Epoch ms of the last live-tag assimilation folded into this checkpoint.
  lastSyncAt: bigint("last_sync_at", { mode: "number" }),
  committedAt: timestamp("committed_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Single-row coordination state: the suppression policy plus the watermark of
 * the shared projection and its cumulative counters.
 *
 * `applied_seq` is advanced with a conditional UPDATE (`WHERE applied_seq <
 * :seq`) in the same transaction that writes the entry's row changes. A replica
 * that loses the race writes nothing, so the materialised rows are always the
 * result of applying journal entries strictly in `seq` order, whichever replica
 * happened to get there first.
 *
 * `enabled` defaults FALSE. Persisting an operator's intent to suppress is not
 * the same as suppressing: the runtime only honours it while coordination is
 * healthy, and forces it back off — restoring every suppressed alarm — the
 * moment it is not.
 */
export const alarmCorrelationState = pgTable("alarm_correlation_state", {
  id: varchar("id", { length: 16 }).primaryKey(),
  appliedSeq: bigint("applied_seq", { mode: "number" }).default(0).notNull(),
  suppressionEnabled: boolean("suppression_enabled").default(false).notNull(),
  neverSuppressAtOrAbove: varchar("never_suppress_at_or_above", { length: 16 })
    .default("critical").notNull(),
  // Always TRUE. Column exists so the persisted policy is complete and a
  // future value change is a visible migration, not a silent default.
  unsuppressOnRootClear: boolean("unsuppress_on_root_clear").default(true).notNull(),
  alarmsIngested: bigint("alarms_ingested", { mode: "number" }).default(0).notNull(),
  groupsCreated: bigint("groups_created", { mode: "number" }).default(0).notNull(),
  groupsClosed: bigint("groups_closed", { mode: "number" }).default(0).notNull(),
  alarmsSuppressed: bigint("alarms_suppressed", { mode: "number" }).default(0).notNull(),
  alarmsUnsuppressed: bigint("alarms_unsuppressed", { mode: "number" }).default(0).notNull(),
  updatedBy: varchar("updated_by", { length: 128 }).default("system").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Schema Exports ──────────────────────────────────────────────────────────

// Insert schemas for validation
export const insertSiteSchema = createInsertSchema(sites);
export const insertAssetSchema = createInsertSchema(assets);
export const insertEventAnchorSchema = createInsertSchema(eventAnchors);
export const insertMaintenanceRecordSchema = createInsertSchema(maintenanceRecords);
export const insertVendorSchema = createInsertSchema(vendors);
export const insertTemplatePackageSchema = createInsertSchema(templatePackages);
export const insertControlModuleTypeSchema = createInsertSchema(controlModuleTypes);
export const insertControlModuleInstanceSchema = createInsertSchema(controlModuleInstances);
export const insertUnitTypeSchema = createInsertSchema(unitTypes);
export const insertUnitInstanceSchema = createInsertSchema(unitInstances);
export const insertPhaseTypeSchema = createInsertSchema(phaseTypes);
export const insertPhaseInstanceSchema = createInsertSchema(phaseInstances);
export const insertDesignSpecificationSchema = createInsertSchema(designSpecifications);
export const insertGeneratedCodeSchema = createInsertSchema(generatedCode);
export const insertDataTypeMappingSchema = createInsertSchema(dataTypeMappings);
export const insertControllerSchema = createInsertSchema(controllers);
export const insertValidatorNodeSchema = createInsertSchema(validatorNodes);
export const insertValidatorPubkeySchema = createInsertSchema(validatorPubkeys);
export const insertValidatorStateWatermarkSchema = createInsertSchema(validatorStateWatermarks);
export const insertValidatorLivenessObservationSchema = createInsertSchema(validatorLivenessObservations);
export const insertModbusRegisterMapSchema = createInsertSchema(modbusRegisterMap);

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
export type ValidatorNode = typeof validatorNodes.$inferSelect;
export type ValidatorPubkey = typeof validatorPubkeys.$inferSelect;
export type ValidatorStateWatermark = typeof validatorStateWatermarks.$inferSelect;
export type InsertValidatorNode = typeof validatorNodes.$inferInsert;
export type InsertValidatorPubkey = typeof validatorPubkeys.$inferInsert;
export type InsertValidatorStateWatermark = typeof validatorStateWatermarks.$inferInsert;
export type ValidatorLivenessObservationRow = typeof validatorLivenessObservations.$inferSelect;
export type InsertValidatorLivenessObservationRow = typeof validatorLivenessObservations.$inferInsert;
export type ModbusRegisterMapRow = typeof modbusRegisterMap.$inferSelect;
export type InsertModbusRegisterMapRow = typeof modbusRegisterMap.$inferInsert;
export type PidTuningAuditRow = typeof pidTuningAudit.$inferSelect;
export type InsertPidTuningAuditRow = typeof pidTuningAudit.$inferInsert;
export type PredictiveTagThresholdRow = typeof predictiveTagThresholds.$inferSelect;
export type InsertPredictiveTagThresholdRow = typeof predictiveTagThresholds.$inferInsert;
export type PredictiveAlertRow = typeof predictiveAlerts.$inferSelect;
export type InsertPredictiveAlertRow = typeof predictiveAlerts.$inferInsert;
export type PluginRegistryRow = typeof pluginRegistry.$inferSelect;
export type InsertPluginRegistryRow = typeof pluginRegistry.$inferInsert;
export type PluginInstallationRow = typeof pluginInstallations.$inferSelect;
export type InsertPluginInstallationRow = typeof pluginInstallations.$inferInsert;
export type TwinModelRow = typeof twinModels.$inferSelect;
export type InsertTwinModelRow = typeof twinModels.$inferInsert;
export type TwinCheckpointRow = typeof twinCheckpoints.$inferSelect;
export type InsertTwinCheckpointRow = typeof twinCheckpoints.$inferInsert;
export type AlarmCorrelationJournalRow = typeof alarmCorrelationJournal.$inferSelect;
export type InsertAlarmCorrelationJournalRow = typeof alarmCorrelationJournal.$inferInsert;
export type AlarmCorrelationGroupRow = typeof alarmCorrelationGroups.$inferSelect;
export type InsertAlarmCorrelationGroupRow = typeof alarmCorrelationGroups.$inferInsert;
export type AlarmCorrelationAlarmRow = typeof alarmCorrelationAlarms.$inferSelect;
export type InsertAlarmCorrelationAlarmRow = typeof alarmCorrelationAlarms.$inferInsert;
export type AlarmCorrelationRuleRow = typeof alarmCorrelationRules.$inferSelect;
export type InsertAlarmCorrelationRuleRow = typeof alarmCorrelationRules.$inferInsert;
export type AlarmCorrelationEquipmentRow = typeof alarmCorrelationEquipment.$inferSelect;
export type InsertAlarmCorrelationEquipmentRow = typeof alarmCorrelationEquipment.$inferInsert;
export type AlarmCorrelationStateRow = typeof alarmCorrelationState.$inferSelect;
export type InsertAlarmCorrelationStateRow = typeof alarmCorrelationState.$inferInsert;
