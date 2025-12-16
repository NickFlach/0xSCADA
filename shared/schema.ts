import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Sites
export const sites = pgTable("sites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  location: text("location").notNull(),
  owner: text("owner").notNull(),
  status: text("status").notNull().default("ONLINE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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

// Event Anchors
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
