import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =============================================================================
// SITES (PRD Section 7.1: Site Registry)
// =============================================================================
export const sites = pgTable("sites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  location: text("location").notNull(),
  owner: text("owner").notNull(),
  status: text("status").notNull().default("ONLINE"),
  
  // PRD: Ethereum identity
  ethereumAddress: text("ethereum_address"), // Owner's Ethereum address
  
  // PRD: Authorized gateways and signers (Section 7.1)
  authorizedGateways: jsonb("authorized_gateways").notNull().default(sql`'[]'::jsonb`),
  authorizedSigners: jsonb("authorized_signers").notNull().default(sql`'[]'::jsonb`),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSiteSchema = createInsertSchema(sites).omit({
  id: true,
  createdAt: true,
});

export type InsertSite = z.infer<typeof insertSiteSchema>;
export type Site = typeof sites.$inferSelect;

// Assets
export const assets = pgTable("assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  siteId: text("site_id").notNull().references(() => sites.id),
  assetType: text("asset_type").notNull(),
  nameOrTag: text("name_or_tag").notNull(),
  critical: boolean("critical").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("OK"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAssetSchema = createInsertSchema(assets).omit({
  id: true,
  createdAt: true,
});

export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assets.$inferSelect;

// =============================================================================
// EVENTS (PRD Section 6.1: Event Model)
// =============================================================================

// Event Types enum for database
export const EVENT_TYPES = [
  "TELEMETRY",
  "ALARM", 
  "COMMAND",
  "ACKNOWLEDGEMENT",
  "MAINTENANCE",
  "BLUEPRINT_CHANGE",
  "CODE_GENERATION",
  "DEPLOYMENT_INTENT",
] as const;

export const ORIGIN_TYPES = ["GATEWAY", "USER", "AGENT", "SYSTEM"] as const;
export const ANCHOR_STATUSES = ["PENDING", "BATCHED", "ANCHORED", "FAILED"] as const;

// EVENT BATCHES must be defined before events due to foreign key reference
export const eventBatches = pgTable("event_batches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Batch metadata
  siteId: text("site_id").references(() => sites.id),
  eventCount: integer("event_count").notNull(),
  
  // PRD: Merkle root for batch
  merkleRoot: text("merkle_root").notNull(),
  
  // Time range
  firstEventAt: timestamp("first_event_at").notNull(),
  lastEventAt: timestamp("last_event_at").notNull(),
  
  // PRD: Ethereum anchoring
  anchorStatus: text("anchor_status").notNull().default("PENDING"),
  txHash: text("tx_hash"),
  blockNumber: integer("block_number"),
  anchoredAt: timestamp("anchored_at"),
  
  // Metadata pointer (PRD: IPFS / content hash)
  metadataHash: text("metadata_hash"),
  metadataUri: text("metadata_uri"), // IPFS URI or other storage
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEventBatchSchema = createInsertSchema(eventBatches).omit({
  id: true,
  createdAt: true,
});

export type InsertEventBatch = z.infer<typeof insertEventBatchSchema>;
export type EventBatch = typeof eventBatches.$inferSelect;

export const events = pgTable("events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // PRD: Event type (typed, not just string)
  eventType: text("event_type").notNull(),
  
  // Location
  siteId: text("site_id").notNull().references(() => sites.id),
  assetId: text("asset_id").references(() => assets.id),
  
  // PRD: Timestamps (source + receipt)
  sourceTimestamp: timestamp("source_timestamp").notNull(),
  receiptTimestamp: timestamp("receipt_timestamp").notNull().defaultNow(),
  
  // PRD: Origin (signed by origin)
  originType: text("origin_type").notNull(), // GATEWAY, USER, AGENT, SYSTEM
  originId: text("origin_id").notNull(), // Gateway ID, User ID, or Agent ID
  
  // Payload
  payload: jsonb("payload").notNull(),
  details: text("details"), // Human-readable summary
  
  // PRD: Cryptographic fields (signed, hashable)
  signature: text("signature").notNull(), // Origin's signature
  hash: text("hash").notNull(), // SHA-256 of canonical event
  
  // PRD: Anchor reference
  anchorStatus: text("anchor_status").notNull().default("PENDING"),
  batchId: text("batch_id").references(() => eventBatches.id),
  merkleIndex: integer("merkle_index"),
  merkleProof: jsonb("merkle_proof"), // Array of proof hashes
  anchorTxHash: text("anchor_tx_hash"),
  anchoredAt: timestamp("anchored_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  createdAt: true,
  receiptTimestamp: true,
});

export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof events.$inferSelect;

// Legacy: Keep for backward compatibility during migration
export const eventAnchors = pgTable("event_anchors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assetId: text("asset_id").notNull().references(() => assets.id),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  recordedBy: text("recorded_by").notNull(),
  txHash: text("tx_hash"),
  details: text("details").notNull(),
  fullPayload: jsonb("full_payload").notNull(),
});

export const insertEventAnchorSchema = createInsertSchema(eventAnchors).omit({
  id: true,
});

export type InsertEventAnchor = z.infer<typeof insertEventAnchorSchema>;
export type EventAnchor = typeof eventAnchors.$inferSelect;

// Maintenance Records
export const maintenanceRecords = pgTable("maintenance_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  assetId: text("asset_id").notNull().references(() => assets.id),
  workOrderId: text("work_order_id").notNull(),
  performedBy: text("performed_by").notNull(),
  maintenanceType: text("maintenance_type").notNull(),
  performedAt: timestamp("performed_at").notNull(),
  nextDueAt: timestamp("next_due_at"),
  notes: text("notes"),
  attachmentHash: text("attachment_hash"),
});

export const insertMaintenanceRecordSchema = createInsertSchema(maintenanceRecords).omit({
  id: true,
});

export type InsertMaintenanceRecord = z.infer<typeof insertMaintenanceRecordSchema>;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Vendor Support
// ============================================================================

// Vendors (Siemens, Rockwell, ABB, Emerson, etc.)
export const vendors = pgTable("vendors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  // Platform identifiers (e.g., "TIA Portal", "Studio 5000", "DCS800")
  platforms: jsonb("platforms").notNull().default(sql`'[]'::jsonb`),
  // Supported programming languages (SCL, Ladder, ST, AOI, etc.)
  languages: jsonb("languages").notNull().default(sql`'[]'::jsonb`),
  // Vendor-specific configuration schema
  configSchema: jsonb("config_schema").notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

// Template Packages (SCL templates, AOI templates, etc.)
export const templatePackages = pgTable("template_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  version: text("version").notNull().default("1.0.0"),
  description: text("description"),
  // Template type: "control_module", "phase", "unit", "equipment_module"
  templateType: text("template_type").notNull(),
  // Programming language: "SCL", "ST", "Ladder", "FBD", "AOI"
  language: text("language").notNull(),
  // The actual template content with placeholders
  templateContent: text("template_content").notNull(),
  // Placeholder definitions and their mappings
  placeholders: jsonb("placeholders").notNull().default(sql`'[]'::jsonb`),
  // Required inputs for code generation
  requiredInputs: jsonb("required_inputs").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTemplatePackageSchema = createInsertSchema(templatePackages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTemplatePackage = z.infer<typeof insertTemplatePackageSchema>;
export type TemplatePackage = typeof templatePackages.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Control Module Types & Instances
// ============================================================================

// Control Module Types (PIDController, AnalogValve, VFD, etc.)
export const controlModuleTypes = pgTable("control_module_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  vendorId: text("vendor_id").references(() => vendors.id),
  // Version for tracking changes
  version: text("version").notNull().default("1.0.0"),
  description: text("description"),
  inputs: jsonb("inputs").notNull().default(sql`'[]'::jsonb`),
  outputs: jsonb("outputs").notNull().default(sql`'[]'::jsonb`),
  inOuts: jsonb("in_outs").notNull().default(sql`'[]'::jsonb`),
  // Vendor-specific data types mapping
  dataTypeMappings: jsonb("data_type_mappings").notNull().default(sql`'{}'::jsonb`),
  // Associated template package for code generation
  templatePackageId: text("template_package_id").references(() => templatePackages.id),
  sourcePackage: text("source_package"),
  // ISA-88 classification: "basic", "equipment_module", "control_module"
  classification: text("classification").default("control_module"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertControlModuleTypeSchema = createInsertSchema(controlModuleTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertControlModuleType = z.infer<typeof insertControlModuleTypeSchema>;
export type ControlModuleType = typeof controlModuleTypes.$inferSelect;

// Control Module Instances (actual instances like PICSA4712_02, TT4750_03)
export const controlModuleInstances = pgTable("control_module_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  controlModuleTypeId: text("control_module_type_id").notNull().references(() => controlModuleTypes.id),
  controllerId: text("controller_id"),
  unitInstanceId: text("unit_instance_id"),
  pidDrawing: text("pid_drawing"),
  comment: text("comment"),
  configuration: jsonb("configuration").notNull().default(sql`'{}'::jsonb`),
  currentState: jsonb("current_state").notNull().default(sql`'{}'::jsonb`),
  siteId: text("site_id").references(() => sites.id),
  assetId: text("asset_id").references(() => assets.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertControlModuleInstanceSchema = createInsertSchema(controlModuleInstances).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertControlModuleInstance = z.infer<typeof insertControlModuleInstanceSchema>;
export type ControlModuleInstance = typeof controlModuleInstances.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Unit Types & Instances
// ============================================================================

// Unit Types (Tank, Reactor, etc.)
export const unitTypes = pgTable("unit_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  vendorId: text("vendor_id").references(() => vendors.id),
  version: text("version").notNull().default("1.0.0"),
  description: text("description"),
  variables: jsonb("variables").notNull().default(sql`'[]'::jsonb`),
  // Equipment modules that belong to this unit type
  equipmentModules: jsonb("equipment_modules").notNull().default(sql`'[]'::jsonb`),
  // Associated template package for code generation
  templatePackageId: text("template_package_id").references(() => templatePackages.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUnitTypeSchema = createInsertSchema(unitTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUnitType = z.infer<typeof insertUnitTypeSchema>;
export type UnitType = typeof unitTypes.$inferSelect;

// Unit Instances (T4750, R4800, etc.)
export const unitInstances = pgTable("unit_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  unitTypeId: text("unit_type_id").notNull().references(() => unitTypes.id),
  controllerId: text("controller_id"),
  pidDrawing: text("pid_drawing"),
  processCell: text("process_cell"),
  area: text("area"),
  comment: text("comment"),
  siteId: text("site_id").references(() => sites.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUnitInstanceSchema = createInsertSchema(unitInstances).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUnitInstance = z.infer<typeof insertUnitInstanceSchema>;
export type UnitInstance = typeof unitInstances.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Phase Types & Instances
// ============================================================================

// Phase Types (DemoPhase, etc. - ISA-88 batch control)
export const phaseTypes = pgTable("phase_types", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  vendorId: text("vendor_id").references(() => vendors.id),
  version: text("version").notNull().default("1.0.0"),
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
  // Associated template package for code generation
  templatePackageId: text("template_package_id").references(() => templatePackages.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPhaseTypeSchema = createInsertSchema(phaseTypes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPhaseType = z.infer<typeof insertPhaseTypeSchema>;
export type PhaseType = typeof phaseTypes.$inferSelect;

// Phase Instances
export const phaseInstances = pgTable("phase_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  instanceNumber: integer("instance_number"),
  phaseTypeId: text("phase_type_id").notNull().references(() => phaseTypes.id),
  unitInstanceId: text("unit_instance_id").references(() => unitInstances.id),
  controllerId: text("controller_id"),
  currentState: text("current_state").default("IDLE"),
  currentStep: integer("current_step").default(0),
  linkedModuleInstances: jsonb("linked_module_instances").notNull().default(sql`'{}'::jsonb`),
  siteId: text("site_id").references(() => sites.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPhaseInstanceSchema = createInsertSchema(phaseInstances).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPhaseInstance = z.infer<typeof insertPhaseInstanceSchema>;
export type PhaseInstance = typeof phaseInstances.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Design Specifications
// ============================================================================

// Design Specifications (versioned FDS documents)
export const designSpecifications = pgTable("design_specifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  contentHash: text("content_hash").notNull(),
  txHash: text("tx_hash"),
  content: jsonb("content").notNull().default(sql`'{}'::jsonb`),
  siteId: text("site_id").references(() => sites.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  anchoredAt: timestamp("anchored_at"),
});

export const insertDesignSpecificationSchema = createInsertSchema(designSpecifications).omit({
  id: true,
  createdAt: true,
  anchoredAt: true,
});

export type InsertDesignSpecification = z.infer<typeof insertDesignSpecificationSchema>;
export type DesignSpecification = typeof designSpecifications.$inferSelect;

// ============================================================================
// BLUEPRINTS INTEGRATION - Code Generation
// ============================================================================

// Generated Code (output from code generation)
export const generatedCode = pgTable("generated_code", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Source entity type: "control_module", "phase", "unit"
  sourceType: text("source_type").notNull(),
  // Reference to the source entity (CM type, phase type, or unit type)
  sourceId: text("source_id").notNull(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  templatePackageId: text("template_package_id").references(() => templatePackages.id),
  // Programming language used
  language: text("language").notNull(),
  // The generated code content
  code: text("code").notNull(),
  // Hash of the generated code for integrity verification
  codeHash: text("code_hash").notNull(),
  // Blockchain transaction hash if anchored
  txHash: text("tx_hash"),
  // Generation metadata (inputs used, timestamp, etc.)
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  // Status: "draft", "reviewed", "approved", "deployed"
  status: text("status").notNull().default("draft"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  approvedAt: timestamp("approved_at"),
  approvedBy: text("approved_by"),
});

export const insertGeneratedCodeSchema = createInsertSchema(generatedCode).omit({
  id: true,
  generatedAt: true,
  approvedAt: true,
});

export type InsertGeneratedCode = z.infer<typeof insertGeneratedCodeSchema>;
export type GeneratedCode = typeof generatedCode.$inferSelect;

// Data Type Mappings (vendor-specific data type translations)
export const dataTypeMappings = pgTable("data_type_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  // Generic/canonical data type name
  canonicalType: text("canonical_type").notNull(),
  // Vendor-specific data type name
  vendorType: text("vendor_type").notNull(),
  // Size/precision info if applicable
  size: integer("size"),
  precision: integer("precision"),
  // Additional mapping metadata
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDataTypeMappingSchema = createInsertSchema(dataTypeMappings).omit({
  id: true,
  createdAt: true,
});

export type InsertDataTypeMapping = z.infer<typeof insertDataTypeMappingSchema>;
export type DataTypeMapping = typeof dataTypeMappings.$inferSelect;

// Controllers (PLC/DCS hardware definitions)
export const controllers = pgTable("controllers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  siteId: text("site_id").references(() => sites.id),
  // Controller model/type (e.g., "S7-1500", "ControlLogix 5580")
  model: text("model").notNull(),
  // Firmware version
  firmwareVersion: text("firmware_version"),
  // IP address or communication path
  address: text("address"),
  // Controller-specific configuration
  configuration: jsonb("configuration").notNull().default(sql`'{}'::jsonb`),
  // Status: "online", "offline", "maintenance"
  status: text("status").notNull().default("offline"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertControllerSchema = createInsertSchema(controllers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertController = z.infer<typeof insertControllerSchema>;
export type Controller = typeof controllers.$inferSelect;

// =============================================================================
// GATEWAYS (PRD Section 6.2: Edge Gateway)
// =============================================================================
export const gateways = pgTable("gateways", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  siteId: text("site_id").notNull().references(() => sites.id),
  
  // PRD: Device identity + key management
  publicKey: text("public_key").notNull(),
  keyAlgorithm: text("key_algorithm").notNull().default("ed25519"),
  ethereumAddress: text("ethereum_address"),
  
  // Protocol support (PRD: OPC UA + legacy)
  protocols: jsonb("protocols").notNull().default(sql`'["OPC_UA"]'::jsonb`),
  
  // Connection info
  endpoint: text("endpoint"),
  lastHeartbeat: timestamp("last_heartbeat"),
  
  // Status
  status: text("status").notNull().default("OFFLINE"), // ONLINE, OFFLINE, ERROR
  errorMessage: text("error_message"),
  
  // Metrics
  eventsProcessed: integer("events_processed").notNull().default(0),
  lastEventAt: timestamp("last_event_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGatewaySchema = createInsertSchema(gateways).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertGateway = z.infer<typeof insertGatewaySchema>;
export type Gateway = typeof gateways.$inferSelect;

// =============================================================================
// AGENTS (PRD Section 6.3: Agent Framework)
// =============================================================================
export const AGENT_TYPES = ["OPS", "CHANGE_CONTROL", "COMPLIANCE", "SAFETY_OBSERVER", "CODEGEN", "CUSTOM"] as const;
export const AGENT_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED", "ERROR"] as const;

export const agents = pgTable("agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Identity
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  agentType: text("agent_type").notNull(), // OPS, CHANGE_CONTROL, COMPLIANCE, etc.
  
  // PRD: Cryptographic identity
  publicKey: text("public_key").notNull(),
  keyAlgorithm: text("key_algorithm").notNull().default("ed25519"),
  ethereumAddress: text("ethereum_address"),
  
  // PRD: Capabilities and scope
  capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
  scope: jsonb("scope").notNull().default(sql`'{}'::jsonb`),
  
  // Status
  status: text("status").notNull().default("INACTIVE"),
  version: text("version").notNull().default("1.0.0"),
  
  // Runtime info
  lastActiveAt: timestamp("last_active_at"),
  errorCount: integer("error_count").notNull().default(0),
  lastError: text("last_error"),
  
  // Ownership
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;

// =============================================================================
// AGENT STATE (PRD: Scoped memory)
// =============================================================================
export const agentState = pgTable("agent_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: text("agent_id").notNull().references(() => agents.id),
  
  // Key-value storage
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  
  // Metadata
  expiresAt: timestamp("expires_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentStateSchema = createInsertSchema(agentState).omit({
  id: true,
  updatedAt: true,
});

export type InsertAgentState = z.infer<typeof insertAgentStateSchema>;
export type AgentState = typeof agentState.$inferSelect;

// =============================================================================
// AGENT OUTPUTS (PRD: Signed outputs)
// =============================================================================
export const AGENT_OUTPUT_TYPES = ["SUMMARY", "REPORT", "PROPOSAL", "ANALYSIS", "CODE", "ALERT"] as const;

export const agentOutputs = pgTable("agent_outputs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: text("agent_id").notNull().references(() => agents.id),
  
  // Output type and content
  outputType: text("output_type").notNull(),
  title: text("title").notNull(),
  content: jsonb("content").notNull(),
  
  // Context
  siteId: text("site_id").references(() => sites.id),
  assetIds: jsonb("asset_ids").default(sql`'[]'::jsonb`),
  eventIds: jsonb("event_ids").default(sql`'[]'::jsonb`),
  
  // PRD: Cryptographic (signed outputs)
  hash: text("hash").notNull(),
  signature: text("signature").notNull(),
  
  // Metadata
  confidence: integer("confidence"), // 0-100
  reasoning: text("reasoning"),
  
  // For proposals
  requiresApproval: boolean("requires_approval").notNull().default(false),
  approvalStatus: text("approval_status"), // PENDING, APPROVED, REJECTED
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentOutputSchema = createInsertSchema(agentOutputs).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentOutput = z.infer<typeof insertAgentOutputSchema>;
export type AgentOutput = typeof agentOutputs.$inferSelect;

// =============================================================================
// AGENT PROPOSALS (PRD: All proposals require human approval)
// =============================================================================
export const PROPOSAL_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED", "FAILED"] as const;
export const PROPOSAL_TYPES = ["COMMAND", "SETPOINT_CHANGE", "MODE_CHANGE", "BLUEPRINT_CHANGE", "DEPLOYMENT", "MAINTENANCE", "CONFIGURATION"] as const;
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const agentProposals = pgTable("agent_proposals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: text("agent_id").notNull().references(() => agents.id),
  
  // What is being proposed
  proposalType: text("proposal_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  
  // The proposed action
  action: jsonb("action").notNull(),
  
  // Context and reasoning
  reasoning: text("reasoning").notNull(),
  confidence: integer("confidence").notNull(), // 0-100
  supportingEventIds: jsonb("supporting_event_ids").default(sql`'[]'::jsonb`),
  
  // Risk assessment
  riskLevel: text("risk_level").notNull(),
  riskFactors: jsonb("risk_factors").default(sql`'[]'::jsonb`),
  
  // Cryptographic
  hash: text("hash").notNull(),
  signature: text("signature").notNull(),
  
  // Approval workflow
  status: text("status").notNull().default("DRAFT"),
  requiredApprovals: integer("required_approvals").notNull().default(1),
  approvals: jsonb("approvals").default(sql`'[]'::jsonb`),
  
  // Timing
  expiresAt: timestamp("expires_at"),
  executedAt: timestamp("executed_at"),
  
  // Result
  executionResult: jsonb("execution_result"),
  executionError: text("execution_error"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAgentProposalSchema = createInsertSchema(agentProposals).omit({
  id: true,
  createdAt: true,
});

export type InsertAgentProposal = z.infer<typeof insertAgentProposalSchema>;
export type AgentProposal = typeof agentProposals.$inferSelect;

// =============================================================================
// USERS (PRD Section 4.1: Primary Users with roles)
// =============================================================================
export const USER_ROLES = ["ENGINEER", "OPERATOR", "MAINTENANCE", "AUDITOR", "ADMIN"] as const;

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Identity
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  
  // Authentication
  passwordHash: text("password_hash").notNull(),
  
  // PRD: Cryptographic identity for signing
  publicKey: text("public_key"),
  keyAlgorithm: text("key_algorithm"),
  ethereumAddress: text("ethereum_address"),
  
  // Role-based access (PRD Section 4.1)
  role: text("role").notNull().default("OPERATOR"),
  permissions: jsonb("permissions").default(sql`'[]'::jsonb`),
  
  // Scope
  siteIds: jsonb("site_ids").default(sql`'[]'::jsonb`), // Sites user can access
  
  // Status
  active: boolean("active").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// =============================================================================
// CHANGE INTENTS (PRD Section 7.3: Change Intent Contract)
// =============================================================================
export const CHANGE_INTENT_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ANCHORED", "DEPLOYED", "ROLLED_BACK", "REJECTED"] as const;

export const changeIntents = pgTable("change_intents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // What is being changed
  blueprintId: text("blueprint_id").notNull(),
  blueprintName: text("blueprint_name").notNull(),
  blueprintHash: text("blueprint_hash").notNull(),
  
  // Generated code
  codegenId: text("codegen_id"),
  codeHash: text("code_hash"),
  
  // Target
  targetControllerId: text("target_controller_id").references(() => controllers.id),
  targetControllerName: text("target_controller_name"),
  
  // Change package (PRD: diffs, test plans, rollback steps)
  changePackage: jsonb("change_package").notNull().default(sql`'{}'::jsonb`),
  
  // Approval chain
  requiredApprovals: integer("required_approvals").notNull().default(1),
  approvals: jsonb("approvals").default(sql`'[]'::jsonb`),
  
  // Status
  status: text("status").notNull().default("DRAFT"),
  
  // PRD: Ethereum anchoring
  intentHash: text("intent_hash").notNull(), // Hash of entire intent
  anchorTxHash: text("anchor_tx_hash"),
  anchoredAt: timestamp("anchored_at"),
  
  // Deployment
  deployedAt: timestamp("deployed_at"),
  deployedBy: text("deployed_by"),
  
  // Rollback
  rolledBackAt: timestamp("rolled_back_at"),
  rolledBackBy: text("rolled_back_by"),
  rollbackReason: text("rollback_reason"),
  
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertChangeIntentSchema = createInsertSchema(changeIntents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChangeIntent = z.infer<typeof insertChangeIntentSchema>;
export type ChangeIntent = typeof changeIntents.$inferSelect;

// =============================================================================
// DIGITAL TWIN: ASSET ADMINISTRATION SHELL (IEC 63278)
// =============================================================================

// Asset kinds for AAS
export const ASSET_KINDS = ["Instance", "Type"] as const;

// Submodel types following Industry 4.0 standards
export const SUBMODEL_TYPES = [
  "Nameplate",           // IEC 61406 identification
  "TechnicalData",       // Performance specifications
  "OperationalData",     // Real-time telemetry binding
  "Documentation",       // Manuals, certs, P&IDs
  "SimulationModel",     // FMU reference for physics twin
  "AIModel",             // Surrogate model endpoint
  "BlockchainAnchor",    // 0xSCADA: on-chain proof refs
  "MaintenanceSchedule", // Predictive maintenance data
  "DigitalTwinCapabilities", // Twin capabilities descriptor
] as const;

// Submodel element types
export const SUBMODEL_ELEMENT_TYPES = [
  "Property",
  "MultiLanguageProperty",
  "Range",
  "Blob",
  "File",
  "ReferenceElement",
  "RelationshipElement",
  "AnnotatedRelationshipElement",
  "Capability",
  "SubmodelElementCollection",
  "SubmodelElementList",
  "Operation",
  "BasicEventElement",
  "Entity",
] as const;

// Asset Administration Shell (main entity)
export const assetAdministrationShells = pgTable("asset_administration_shells", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // IEC 63278: Shell identification
  idShort: text("id_short").notNull(), // e.g., "PID_Controller_001"
  globalId: text("global_id").notNull().unique(), // Globally unique IRI
  
  // Asset information
  globalAssetId: text("global_asset_id").notNull(), // Links to blockchain registry
  assetKind: text("asset_kind").notNull().default("Instance"), // Instance or Type
  assetType: text("asset_type"), // Optional: semantic type of the asset
  
  // Display information
  displayName: text("display_name"),
  description: text("description"),
  
  // 0xSCADA integration: Link to existing entities
  siteId: text("site_id").references(() => sites.id),
  assetId: text("asset_id").references(() => assets.id),
  controlModuleInstanceId: text("control_module_instance_id").references(() => controlModuleInstances.id),
  unitInstanceId: text("unit_instance_id").references(() => unitInstances.id),
  
  // Administration
  version: text("version").notNull().default("1.0.0"),
  revision: text("revision"),
  
  // Blockchain anchoring
  contentHash: text("content_hash"), // Hash of serialized AAS
  anchorTxHash: text("anchor_tx_hash"),
  anchoredAt: timestamp("anchored_at"),
  
  // External AAS federation
  federationEndpoint: text("federation_endpoint"), // URL for external AAS registry
  federatedAt: timestamp("federated_at"),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAASSchema = createInsertSchema(assetAdministrationShells).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAAS = z.infer<typeof insertAASSchema>;
export type AssetAdministrationShell = typeof assetAdministrationShells.$inferSelect;

// Submodels (modular capability descriptors)
export const aasSubmodels = pgTable("aas_submodels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Parent shell reference
  aasId: text("aas_id").notNull().references(() => assetAdministrationShells.id, { onDelete: "cascade" }),
  
  // IEC 63278: Submodel identification
  idShort: text("id_short").notNull(), // e.g., "TechnicalData"
  globalId: text("global_id").notNull().unique(), // Globally unique IRI
  
  // Semantic reference (ECLASS or IEC CDD)
  semanticIdType: text("semantic_id_type"), // e.g., "GlobalReference", "ModelReference"
  semanticIdValue: text("semantic_id_value"), // ECLASS or IEC CDD reference
  
  // Submodel type from standard library
  submodelType: text("submodel_type").notNull(), // One of SUBMODEL_TYPES
  
  // Display information
  displayName: text("display_name"),
  description: text("description"),
  
  // Administration
  version: text("version").notNull().default("1.0.0"),
  revision: text("revision"),
  
  // Content kind
  kind: text("kind").notNull().default("Instance"), // Instance or Template
  
  // Qualifiers (additional constraints/metadata)
  qualifiers: jsonb("qualifiers").default(sql`'[]'::jsonb`),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAASSubmodelSchema = createInsertSchema(aasSubmodels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAASSubmodel = z.infer<typeof insertAASSubmodelSchema>;
export type AASSubmodel = typeof aasSubmodels.$inferSelect;

// Submodel Elements (properties, operations, collections)
export const aasSubmodelElements = pgTable("aas_submodel_elements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Parent submodel reference
  submodelId: text("submodel_id").notNull().references(() => aasSubmodels.id, { onDelete: "cascade" }),
  
  // For nested elements (collections, lists)
  parentElementId: text("parent_element_id").references((): any => aasSubmodelElements.id, { onDelete: "cascade" }),
  
  // IEC 63278: Element identification
  idShort: text("id_short").notNull(), // e.g., "MaxTemperature"
  
  // Element type
  elementType: text("element_type").notNull(), // One of SUBMODEL_ELEMENT_TYPES
  
  // Semantic reference
  semanticIdType: text("semantic_id_type"),
  semanticIdValue: text("semantic_id_value"),
  
  // Display information
  displayName: text("display_name"),
  description: text("description"),
  
  // Value (for properties, ranges, etc.)
  valueType: text("value_type"), // xs:string, xs:integer, xs:double, etc.
  value: text("value"),
  
  // For Range type
  minValue: text("min_value"),
  maxValue: text("max_value"),
  
  // For File/Blob type
  contentType: text("content_type"),
  filePath: text("file_path"),
  
  // For Operation type
  inputVariables: jsonb("input_variables").default(sql`'[]'::jsonb`),
  outputVariables: jsonb("output_variables").default(sql`'[]'::jsonb`),
  inoutputVariables: jsonb("inoutput_variables").default(sql`'[]'::jsonb`),
  
  // For ReferenceElement
  referenceType: text("reference_type"),
  referenceKeys: jsonb("reference_keys").default(sql`'[]'::jsonb`),
  
  // Real-time data binding (0xSCADA specific)
  dataBindingType: text("data_binding_type"), // "tag", "websocket", "polling"
  dataBindingPath: text("data_binding_path"), // OPC-UA node, tag path, etc.
  dataBindingInterval: integer("data_binding_interval"), // ms
  
  // Ordering for collections/lists
  orderIndex: integer("order_index").default(0),
  
  // Qualifiers
  qualifiers: jsonb("qualifiers").default(sql`'[]'::jsonb`),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAASSubmodelElementSchema = createInsertSchema(aasSubmodelElements).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAASSubmodelElement = z.infer<typeof insertAASSubmodelElementSchema>;
export type AASSubmodelElement = typeof aasSubmodelElements.$inferSelect;

// Submodel Templates (reusable submodel definitions)
export const aasSubmodelTemplates = pgTable("aas_submodel_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Template identification
  name: text("name").notNull().unique(), // e.g., "Nameplate_IEC61406"
  submodelType: text("submodel_type").notNull(), // One of SUBMODEL_TYPES
  
  // Display information
  displayName: text("display_name"),
  description: text("description"),
  
  // Semantic reference
  semanticIdType: text("semantic_id_type"),
  semanticIdValue: text("semantic_id_value"),
  
  // Template definition (JSON schema for elements)
  elementDefinitions: jsonb("element_definitions").notNull().default(sql`'[]'::jsonb`),
  
  // Applicable asset types
  applicableAssetTypes: jsonb("applicable_asset_types").default(sql`'[]'::jsonb`),
  
  // Version
  version: text("version").notNull().default("1.0.0"),
  
  // Active flag
  isActive: boolean("is_active").notNull().default(true),
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAASSubmodelTemplateSchema = createInsertSchema(aasSubmodelTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAASSubmodelTemplate = z.infer<typeof insertAASSubmodelTemplateSchema>;
export type AASSubmodelTemplate = typeof aasSubmodelTemplates.$inferSelect;
