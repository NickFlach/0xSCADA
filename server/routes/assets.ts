/**
 * Asset CRUD. Real handlers moved here from server/routes.ts (issue #446) —
 * previously a placeholder router mounted ahead of them shadowed
 * GET /api/assets and returned an empty list unconditionally.
 */

import { Router } from "express";
import { storage } from "../storage";
import { blockchainService } from "../blockchain";
import { logError } from "../logger";
import { insertAssetSchema } from "@shared/schema";
import { fromZodError } from "zod-validation-error";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const assets = await (storage as any).getAssets();
    res.json(assets);
  } catch (error) {
    logError(error, "Error fetching assets:");
    res.status(500).json({ error: "Failed to fetch assets" });
  }
});

router.get("/site/:siteId", async (req, res) => {
  try {
    const assets = await (storage as any).getAssetsBySiteId(req.params.siteId);
    res.json(assets);
  } catch (error) {
    logError(error, "Error fetching assets:");
    res.status(500).json({ error: "Failed to fetch assets" });
  }
});

router.post("/", async (req, res) => {
  try {
    const validation = insertAssetSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: fromZodError(validation.error).toString() });
    }

    const asset = await (storage as any).createAsset(validation.data);

    await (blockchainService as any).registerAsset(
      asset.id,
      asset.siteId,
      asset.assetType,
      asset.nameOrTag,
      asset.critical
    );

    res.status(201).json(asset);
  } catch (error) {
    logError(error, "Error creating asset:");
    res.status(500).json({ error: "Failed to create asset" });
  }
});

export { router as assetRoutes };
