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
  bigint,
  real,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
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
