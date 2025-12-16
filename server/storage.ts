import { eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import type {
  Site,
  InsertSite,
  Asset,
  InsertAsset,
  EventAnchor,
  InsertEventAnchor,
  MaintenanceRecord,
  InsertMaintenanceRecord,
} from "@shared/schema";

const { Pool } = pg;

export interface IStorage {
  // Sites
  createSite(site: InsertSite): Promise<Site>;
  getSites(): Promise<Site[]>;
  getSiteById(id: string): Promise<Site | undefined>;

  // Assets
  createAsset(asset: InsertAsset): Promise<Asset>;
  getAssets(): Promise<Asset[]>;
  getAssetsBySiteId(siteId: string): Promise<Asset[]>;
  getAssetById(id: string): Promise<Asset | undefined>;

  // Event Anchors
  createEventAnchor(event: InsertEventAnchor): Promise<EventAnchor>;
  getEventAnchors(limit?: number): Promise<EventAnchor[]>;
  getEventAnchorsByAssetId(assetId: string): Promise<EventAnchor[]>;
  updateEventTxHash(id: string, txHash: string): Promise<void>;

  // Maintenance Records
  createMaintenanceRecord(record: InsertMaintenanceRecord): Promise<MaintenanceRecord>;
  getMaintenanceRecords(): Promise<MaintenanceRecord[]>;
  getMaintenanceRecordsByAssetId(assetId: string): Promise<MaintenanceRecord[]>;
}

export class DatabaseStorage implements IStorage {
  private db: ReturnType<typeof drizzle>;

  constructor() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    this.db = drizzle(pool, { schema });
  }

  // Sites
  async createSite(site: InsertSite): Promise<Site> {
    const [newSite] = await this.db.insert(schema.sites).values(site).returning();
    return newSite;
  }

  async getSites(): Promise<Site[]> {
    return await this.db.select().from(schema.sites);
  }

  async getSiteById(id: string): Promise<Site | undefined> {
    const [site] = await this.db.select().from(schema.sites).where(eq(schema.sites.id, id));
    return site;
  }

  // Assets
  async createAsset(asset: InsertAsset): Promise<Asset> {
    const [newAsset] = await this.db.insert(schema.assets).values(asset).returning();
    return newAsset;
  }

  async getAssets(): Promise<Asset[]> {
    return await this.db.select().from(schema.assets);
  }

  async getAssetsBySiteId(siteId: string): Promise<Asset[]> {
    return await this.db.select().from(schema.assets).where(eq(schema.assets.siteId, siteId));
  }

  async getAssetById(id: string): Promise<Asset | undefined> {
    const [asset] = await this.db.select().from(schema.assets).where(eq(schema.assets.id, id));
    return asset;
  }

  // Event Anchors
  async createEventAnchor(event: InsertEventAnchor): Promise<EventAnchor> {
    const [newEvent] = await this.db.insert(schema.eventAnchors).values(event).returning();
    return newEvent;
  }

  async getEventAnchors(limit: number = 100): Promise<EventAnchor[]> {
    return await this.db
      .select()
      .from(schema.eventAnchors)
      .orderBy(desc(schema.eventAnchors.timestamp))
      .limit(limit);
  }

  async getEventAnchorsByAssetId(assetId: string): Promise<EventAnchor[]> {
    return await this.db
      .select()
      .from(schema.eventAnchors)
      .where(eq(schema.eventAnchors.assetId, assetId))
      .orderBy(desc(schema.eventAnchors.timestamp));
  }

  async updateEventTxHash(id: string, txHash: string): Promise<void> {
    await this.db
      .update(schema.eventAnchors)
      .set({ txHash })
      .where(eq(schema.eventAnchors.id, id));
  }

  // Maintenance Records
  async createMaintenanceRecord(record: InsertMaintenanceRecord): Promise<MaintenanceRecord> {
    const [newRecord] = await this.db
      .insert(schema.maintenanceRecords)
      .values(record)
      .returning();
    return newRecord;
  }

  async getMaintenanceRecords(): Promise<MaintenanceRecord[]> {
    return await this.db
      .select()
      .from(schema.maintenanceRecords)
      .orderBy(desc(schema.maintenanceRecords.performedAt));
  }

  async getMaintenanceRecordsByAssetId(assetId: string): Promise<MaintenanceRecord[]> {
    return await this.db
      .select()
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.assetId, assetId))
      .orderBy(desc(schema.maintenanceRecords.performedAt));
  }
}

export const storage = new DatabaseStorage();
