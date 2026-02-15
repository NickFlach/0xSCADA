/**
 * Asset API Routes
 * 
 * Issue #42: REST API Baseline (Read-Heavy)
 * 
 * CRUD + paginated listing, filtering by site, type, status, criticality.
 */

import { Router, type Request, type Response } from "express";
import { db } from "../db";
import { assets, insertAssetSchema } from "@shared/schema";
import { eq, and, like, sql, desc, asc, count } from "drizzle-orm";
import { parsePagination, paginatedResponse } from "../middleware/pagination";
import { fromZodError } from "zod-validation-error";

export const assetRoutes = Router();

// =============================================================================
// GET /api/assets — List assets with pagination & filtering
// =============================================================================
assetRoutes.get("/", parsePagination("createdAt"), async (req: Request, res: Response) => {
  try {
    const p = req.pagination!;
    const conditions = [];

    // Filters
    if (p.filters.site_id) conditions.push(eq(assets.siteId, p.filters.site_id));
    if (p.filters.asset_type) conditions.push(eq(assets.assetType, p.filters.asset_type));
    if (p.filters.status) conditions.push(eq(assets.status, p.filters.status));
    if (p.filters.critical) conditions.push(eq(assets.critical, p.filters.critical === "true"));
    if (p.filters.search) conditions.push(like(assets.nameOrTag, `%${p.filters.search}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort column mapping
    const sortCol = p.sortBy === "nameOrTag" ? assets.nameOrTag
      : p.sortBy === "assetType" ? assets.assetType
      : p.sortBy === "status" ? assets.status
      : assets.createdAt;
    const orderFn = p.sortOrder === "asc" ? asc : desc;

    const [data, [{ total }]] = await Promise.all([
      db.select().from(assets).where(where).orderBy(orderFn(sortCol)).limit(p.limit).offset(p.offset),
      db.select({ total: count() }).from(assets).where(where),
    ]);

    res.json(paginatedResponse(data, total, p, "/api/assets"));
  } catch (error) {
    console.error("Error fetching assets:", error);
    res.status(500).json({ error: "Failed to fetch assets" });
  }
});

// =============================================================================
// GET /api/assets/:id — Get single asset
// =============================================================================
assetRoutes.get("/:id", async (req: Request, res: Response) => {
  try {
    const [asset] = await db.select().from(assets).where(eq(assets.id, req.params.id));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json(asset);
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.status(500).json({ error: "Failed to fetch asset" });
  }
});

// =============================================================================
// POST /api/assets — Create asset
// =============================================================================
assetRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = insertAssetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: fromZodError(parsed.error).message });
      return;
    }
    const [created] = await db.insert(assets).values(parsed.data).returning();
    res.status(201).json(created);
  } catch (error) {
    console.error("Error creating asset:", error);
    res.status(500).json({ error: "Failed to create asset" });
  }
});

// =============================================================================
// PATCH /api/assets/:id — Update asset
// =============================================================================
assetRoutes.patch("/:id", async (req: Request, res: Response) => {
  try {
    const [updated] = await db
      .update(assets)
      .set(req.body)
      .where(eq(assets.id, req.params.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error("Error updating asset:", error);
    res.status(500).json({ error: "Failed to update asset" });
  }
});

// =============================================================================
// DELETE /api/assets/:id — Delete asset
// =============================================================================
assetRoutes.delete("/:id", async (req: Request, res: Response) => {
  try {
    const [deleted] = await db.delete(assets).where(eq(assets.id, req.params.id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting asset:", error);
    res.status(500).json({ error: "Failed to delete asset" });
  }
});
