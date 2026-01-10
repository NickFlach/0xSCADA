import { Router } from "express";
import { batchAnchoringService, type BatchConfig } from "../batch-anchoring";
import { blobAnchoringService } from "../blob-anchoring";
import { blockchainService } from "../blockchain";

export const batchRoutes = Router();

batchRoutes.get("/stats", async (req, res) => {
  try {
    const stats = batchAnchoringService.getStats();
    const config = batchAnchoringService.getConfig();
    const blobConfig = blobAnchoringService.getConfig();
    const gasPrice = await blockchainService.getGasPrice();

    res.json({
      stats,
      config,
      blobConfig,
      blockchain: {
        enabled: blockchainService.isEnabled(),
        gasPrice: gasPrice?.formatted || "unknown",
      },
    });
  } catch (error) {
    console.error("Error fetching batch stats:", error);
    res.status(500).json({ error: "Failed to fetch batch stats" });
  }
});

batchRoutes.get("/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const history = batchAnchoringService.getBatchHistory().slice(-limit);
    res.json(history);
  } catch (error) {
    console.error("Error fetching batch history:", error);
    res.status(500).json({ error: "Failed to fetch batch history" });
  }
});

batchRoutes.get("/pending", async (req, res) => {
  try {
    const pending = batchAnchoringService.getPendingEvents();
    res.json({
      count: pending.length,
      events: pending,
    });
  } catch (error) {
    console.error("Error fetching pending events:", error);
    res.status(500).json({ error: "Failed to fetch pending events" });
  }
});

batchRoutes.post("/flush", async (req, res) => {
  try {
    const result = await batchAnchoringService.forceBatch();
    if (result) {
      res.json({
        success: true,
        batch: result,
      });
    } else {
      res.json({
        success: false,
        message: "No pending events to batch",
      });
    }
  } catch (error) {
    console.error("Error flushing batch:", error);
    res.status(500).json({ error: "Failed to flush batch" });
  }
});

batchRoutes.get("/:batchId/proof/:eventId", async (req, res) => {
  try {
    const { batchId, eventId } = req.params;
    const proof = batchAnchoringService.getProofForEvent(batchId, eventId);
    
    if (proof) {
      res.json(proof);
    } else {
      res.status(404).json({ error: "Event or batch not found" });
    }
  } catch (error) {
    console.error("Error getting proof:", error);
    res.status(500).json({ error: "Failed to get proof" });
  }
});

batchRoutes.put("/config", async (req, res) => {
  try {
    const { maxBatchSize, maxBatchAgeMs, enabled } = req.body;
    
    const updates: Partial<BatchConfig> = {};
    if (typeof maxBatchSize === "number") updates.maxBatchSize = maxBatchSize;
    if (typeof maxBatchAgeMs === "number") updates.maxBatchAgeMs = maxBatchAgeMs;
    if (typeof enabled === "boolean") updates.enabled = enabled;

    batchAnchoringService.updateConfig(updates);
    
    res.json({
      success: true,
      config: batchAnchoringService.getConfig(),
    });
  } catch (error) {
    console.error("Error updating config:", error);
    res.status(500).json({ error: "Failed to update config" });
  }
});

batchRoutes.get("/blob/config", async (req, res) => {
  try {
    res.json(blobAnchoringService.getConfig());
  } catch (error) {
    console.error("Error fetching blob config:", error);
    res.status(500).json({ error: "Failed to fetch blob config" });
  }
});

batchRoutes.put("/blob/config", async (req, res) => {
  try {
    const { enabled, compressionEnabled } = req.body;
    
    const updates: any = {};
    if (typeof enabled === "boolean") updates.enabled = enabled;
    if (typeof compressionEnabled === "boolean") updates.compressionEnabled = compressionEnabled;

    blobAnchoringService.updateConfig(updates);
    
    res.json({
      success: true,
      config: blobAnchoringService.getConfig(),
    });
  } catch (error) {
    console.error("Error updating blob config:", error);
    res.status(500).json({ error: "Failed to update blob config" });
  }
});

batchRoutes.post("/blob/estimate", async (req, res) => {
  try {
    const { eventCount } = req.body;
    if (typeof eventCount !== "number" || eventCount < 1) {
      return res.status(400).json({ error: "eventCount must be a positive number" });
    }

    const gasPrice = await blockchainService.getGasPrice();
    if (!gasPrice) {
      return res.status(503).json({ error: "Blockchain not connected" });
    }

    const estimate = blobAnchoringService.estimateBlobCost(eventCount, gasPrice.gasPrice);
    
    res.json({
      eventCount,
      gasPrice: gasPrice.formatted,
      blobCost: estimate.blobCost.toString(),
      calldataCost: estimate.calldataCost.toString(),
      savings: estimate.savings,
    });
  } catch (error) {
    console.error("Error estimating blob cost:", error);
    res.status(500).json({ error: "Failed to estimate blob cost" });
  }
});
