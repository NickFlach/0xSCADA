/**
 * Generated-code records and vendor code generation (Siemens SCL/TIA-XML,
 * Rockwell L5X/AOI, ladder logic). Extracted from server/routes.ts (#446).
 * Mounted at /api.
 *
 * The /generate/* and /ladder-logic/* endpoints return 501: the generator
 * modules (server/blueprints/) were deleted in commit 6f9d9219c and their
 * call sites stubbed with `(null as any)`, so these endpoints have thrown
 * at runtime ever since. 501 states that honestly. Tracked in #479.
 *
 * The generated-code record CRUD and blockchain anchoring below are
 * storage-backed and fully functional.
 */

import { Router, type Response } from "express";
import { storage } from "../storage";
import { blockchainService } from "../blockchain";
import { logError } from "../logger";

const router = Router();

function lostModule501(res: Response, capability: string): void {
  res.status(501).json({
    error: "Not Implemented",
    message: `${capability} depends on the server/blueprints code-generation modules deleted in commit 6f9d9219c. Tracked in issue #479.`,
  });
}

// Generated Code records (functional)
router.get("/generated-code", async (req, res) => {
  try {
    const code = await (storage as any).getGeneratedCode();
    res.json(code);
  } catch (error) {
    logError(error, "Error fetching generated code:");
    res.status(500).json({ error: "Failed to fetch generated code" });
  }
});

router.get("/generated-code/:sourceType/:sourceId", async (req, res) => {
  try {
    const code = await (storage as any).getGeneratedCodeBySource(req.params.sourceType, req.params.sourceId);
    res.json(code);
  } catch (error) {
    logError(error, "Error fetching generated code:");
    res.status(500).json({ error: "Failed to fetch generated code" });
  }
});

router.post("/generated-code", async (req, res) => {
  try {
    const code = await (storage as any).createGeneratedCode(req.body);
    res.status(201).json(code);
  } catch (error) {
    logError(error, "Error creating generated code:");
    res.status(500).json({ error: "Failed to create generated code" });
  }
});

// Anchor generated code to blockchain (functional)
router.post("/generated-code/:id/anchor", async (req, res) => {
  try {
    const codeRecords = await (storage as any).getGeneratedCode();
    const record = codeRecords.find((r: any) => r.id === req.params.id);

    if (!record) {
      return res.status(404).json({ error: "Generated code not found" });
    }

    if (record.txHash) {
      return res.json({
        success: true,
        message: "Already anchored",
        txHash: record.txHash,
      });
    }

    const txHash = await (blockchainService as any).anchorEvent(
      record.sourceId,
      `CODE_GENERATED_${record.sourceType.toUpperCase()}`,
      record.codeHash
    );

    if (txHash) {
      await (storage as any).updateGeneratedCodeTxHash(record.id, txHash);
      record.txHash = txHash;
      res.json({
        success: true,
        txHash,
        codeHash: record.codeHash,
      });
    } else {
      res.json({
        success: false,
        message: "Blockchain not enabled or anchoring failed",
      });
    }
  } catch (error) {
    logError(error, "Error anchoring code:");
    res.status(500).json({ error: "Failed to anchor code" });
  }
});

// Vendor code generation — generators deleted (#479)
router.post("/generate/control-module/:cmTypeId", (req, res) => {
  lostModule501(res, "Control-module code generation (Siemens SCL/TIA-XML, Rockwell L5X/AOI)");
});

router.post("/generate/phase/:phaseTypeId", (req, res) => {
  lostModule501(res, "Phase code generation (Siemens SCL)");
});

router.post("/generate/ladder-logic/control-module/:cmTypeId", (req, res) => {
  lostModule501(res, "Control-module ladder-logic generation");
});

router.post("/generate/ladder-logic/phase/:phaseTypeId", (req, res) => {
  lostModule501(res, "Phase ladder-logic generation");
});

// Ladder-logic agent — deleted (#479)
router.get("/ladder-logic/instructions", (req, res) => {
  lostModule501(res, "Ladder-logic instruction library");
});

router.post("/ladder-logic/batch", (req, res) => {
  lostModule501(res, "Batch rung generation from template");
});

router.post("/ladder-logic/ai-context/:cmTypeId", (req, res) => {
  lostModule501(res, "Ladder-logic AI prompt context generation");
});

export { router as codegenRoutes };
