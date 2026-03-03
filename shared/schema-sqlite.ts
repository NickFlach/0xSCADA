/**
 * SQLite Schema for Development Mode
 * 
 * Simplified version of the main PostgreSQL schema for local development
 */

import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";

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

export const maintenanceRecords = sqliteTable("maintenance_records", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  recordType: text("record_type").notNull(),
  performedBy: text("performed_by").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  description: text("description").notNull(),
  notes: text("notes"),
  attachmentHash: text("attachment_hash"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
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

// Type exports
export type Site = typeof sites.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type EventAnchor = typeof eventAnchors.$inferSelect;
export type MaintenanceRecord = typeof maintenanceRecords.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;
export type InsertAsset = typeof assets.$inferInsert;
export type InsertEventAnchor = typeof eventAnchors.$inferInsert;