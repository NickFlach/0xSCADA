/**
 * Generated-code records and vendor code generation (Siemens SCL/TIA-XML,
 * Rockwell L5X/AOI, ladder logic). Extracted from server/routes.ts (#446).
 * Mounted at /api.
 *
 * The /generate/* and /ladder-logic/* endpoints are wired to the restored
 * server/blueprints generators (#479). Because the blueprint DB tables were
 * never restored into the operative schema, these routes take the control
 * module / phase DEFINITION from the request body (ParsedCMType / ParsedPhaseType
 * shape) rather than fetching it by id from storage.
 *
 * The generated-code record CRUD and blockchain anchoring are storage-backed.
 */

import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { storage } from "../storage";
import { blockchainService } from "../blockchain";
import { logError } from "../logger";
import {
  cmTypeToFB,
  phaseTypeToFB,
  generateSCLSource,
  generateTIAXML,
  cmTypeToAOI,
  generateL5X,
  ladderLogicAgent,
  batchRungGenerator,
  routineToLadderDiagram,
  type ParsedCMType,
  type ParsedPhaseType,
  type InstructionCategory,
  type LadderRoutine,
} from "../blueprints";

const router = Router();

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Pull a ParsedCMType from the request body (accepts `cmType` or the body itself). */
function cmTypeFromBody(req: Request): ParsedCMType | null {
  const src = (req.body?.cmType ?? req.body) as Partial<ParsedCMType> | undefined;
  if (!src || typeof src.name !== "string") return null;
  return {
    name: src.name,
    inputs: Array.isArray(src.inputs) ? src.inputs : [],
    outputs: Array.isArray(src.outputs) ? src.outputs : [],
    inOuts: Array.isArray(src.inOuts) ? src.inOuts : [],
  };
}

function phaseTypeFromBody(req: Request): ParsedPhaseType | null {
  const src = (req.body?.phaseType ?? req.body) as Partial<ParsedPhaseType> | undefined;
  if (!src || typeof src.name !== "string") return null;
  return {
    name: src.name,
    description: src.description,
    linkedModules: src.linkedModules ?? [],
    inputs: src.inputs ?? [],
    outputs: src.outputs ?? [],
    inOuts: src.inOuts ?? [],
    internalValues: src.internalValues ?? [],
    hmiParameters: src.hmiParameters ?? [],
    recipeParameters: src.recipeParameters ?? [],
    reportParameters: src.reportParameters ?? [],
    sequences: src.sequences ?? {},
  };
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

// Vendor code generation (#479). Body carries the control-module / phase
// definition (ParsedCMType / ParsedPhaseType); :cmTypeId is kept for clients
// but resolution-by-id needs the blueprint DB layer (separate follow-up).
router.post("/generate/control-module/:cmTypeId", (req, res) => {
  try {
    const cmType = cmTypeFromBody(req);
    if (!cmType) {
      return res.status(400).json({ error: "Missing control-module definition (expected { name, inputs, outputs, inOuts })" });
    }
    const vendor = String(req.body?.vendor ?? "siemens").toLowerCase();
    const format = String(req.body?.format ?? "").toLowerCase();

    let code: string;
    let language: string;
    if (vendor === "siemens") {
      const fb = cmTypeToFB(cmType);
      if (format === "xml" || format === "tia") {
        code = generateTIAXML(fb);
        language = "XML";
      } else {
        code = generateSCLSource(fb);
        language = "SCL";
      }
    } else if (vendor === "rockwell" || vendor === "allen-bradley") {
      const aoi = cmTypeToAOI(cmType);
      if (format === "l5x" || format === "xml") {
        code = generateL5X(aoi);
        language = "L5X";
      } else {
        code = JSON.stringify(aoi, null, 2);
        language = "JSON";
      }
    } else {
      return res.status(400).json({ error: `Code generation not supported for vendor: ${vendor}` });
    }

    res.json({ success: true, code, codeHash: sha256(code), language, vendor, sourceName: cmType.name });
  } catch (error) {
    logError(error, "Error generating control-module code:");
    res.status(500).json({ error: "Failed to generate code" });
  }
});

router.post("/generate/phase/:phaseTypeId", (req, res) => {
  try {
    const phaseType = phaseTypeFromBody(req);
    if (!phaseType) {
      return res.status(400).json({ error: "Missing phase definition (expected { name, inputs, outputs, ... })" });
    }
    const vendor = String(req.body?.vendor ?? "siemens").toLowerCase();
    if (vendor !== "siemens") {
      return res.status(400).json({ error: `Phase code generation not supported for vendor: ${vendor}` });
    }
    const fb = phaseTypeToFB(phaseType);
    const code = generateSCLSource(fb);
    res.json({ success: true, code, codeHash: sha256(code), language: "SCL", vendor, sourceName: phaseType.name });
  } catch (error) {
    logError(error, "Error generating phase code:");
    res.status(500).json({ error: "Failed to generate phase code" });
  }
});

router.post("/generate/ladder-logic/control-module/:cmTypeId", (req, res) => {
  try {
    const cmType = cmTypeFromBody(req);
    if (!cmType) {
      return res.status(400).json({ error: "Missing control-module definition" });
    }
    const context = ladderLogicAgent.buildContextFromCMType(cmType, {
      includeComments: req.body?.includeComments ?? true,
      generateFaultHandling: req.body?.generateFaultHandling ?? true,
      generateInterlocks: req.body?.generateInterlocks ?? true,
    });
    const result = ladderLogicAgent.generateControlModuleLogic(context);
    if (!result.success) {
      return res.status(400).json({ error: "Failed to generate ladder logic", errors: result.errors });
    }
    const visualDiagram = result.routines
      .map(r => routineToLadderDiagram({ name: r.name, type: "Ladder", rungs: r.rungs }))
      .join("\n");
    res.json({
      success: true,
      code: result.neutralText,
      visualDiagram,
      codeHash: sha256(result.neutralText),
      language: "Ladder",
      routines: result.routines,
      tags: result.tags,
      metadata: result.metadata,
      warnings: result.warnings,
    });
  } catch (error) {
    logError(error, "Error generating ladder logic:");
    res.status(500).json({ error: "Failed to generate ladder logic" });
  }
});

router.post("/generate/ladder-logic/phase/:phaseTypeId", (req, res) => {
  try {
    const phaseType = phaseTypeFromBody(req);
    if (!phaseType) {
      return res.status(400).json({ error: "Missing phase definition" });
    }
    const context = ladderLogicAgent.buildContextFromPhaseType(phaseType, {
      includeComments: req.body?.includeComments ?? true,
      generateFaultHandling: req.body?.generateFaultHandling ?? true,
      generateInterlocks: req.body?.generateInterlocks ?? true,
    });
    const result = ladderLogicAgent.generatePhaseLogic(context);
    if (!result.success) {
      return res.status(400).json({ error: "Failed to generate phase ladder logic", errors: result.errors });
    }
    const visualDiagram = result.routines
      .map(r => routineToLadderDiagram({ name: r.name, type: "Ladder", rungs: r.rungs }))
      .join("\n");
    res.json({
      success: true,
      code: result.neutralText,
      visualDiagram,
      codeHash: sha256(result.neutralText),
      language: "Ladder",
      routines: result.routines,
      tags: result.tags,
      metadata: result.metadata,
      warnings: result.warnings,
    });
  } catch (error) {
    logError(error, "Error generating phase ladder logic:");
    res.status(500).json({ error: "Failed to generate phase ladder logic" });
  }
});

// Ladder-logic instruction library (#479)
router.get("/ladder-logic/instructions", (req, res) => {
  try {
    const category = req.query.category;
    if (category && typeof category === "string") {
      res.json(ladderLogicAgent.getInstructionsByCategory(category as InstructionCategory));
    } else {
      res.json(ladderLogicAgent.getInstructionLibrary());
    }
  } catch (error) {
    logError(error, "Error fetching instructions:");
    res.status(500).json({ error: "Failed to fetch instruction library" });
  }
});

router.post("/ladder-logic/batch", (req, res) => {
  try {
    const { template, csvContent } = req.body ?? {};
    if (!template) {
      return res.status(400).json({ error: "Template is required" });
    }
    batchRungGenerator.loadTemplate(template);
    const templateValidation = batchRungGenerator.validateTemplate();
    if (!templateValidation.valid) {
      return res.status(400).json({ error: "Invalid template", errors: templateValidation.errors, warnings: templateValidation.warnings });
    }
    if (!csvContent) {
      return res.json({ success: true, template, variables: templateValidation.variables, warnings: templateValidation.warnings });
    }
    const csvValidation = batchRungGenerator.validateCSV(csvContent);
    if (!csvValidation.valid) {
      return res.status(400).json({ error: "CSV validation failed", errors: csvValidation.errors, warnings: csvValidation.warnings, missingVariables: csvValidation.missingVariables });
    }
    const result = batchRungGenerator.generateAll(csvContent);
    res.json({
      success: result.success,
      neutralText: result.neutralText,
      rungCount: result.rungs.length,
      generatedTags: result.generatedTags,
      errors: result.errors,
      warnings: result.warnings,
    });
  } catch (error) {
    logError(error, "Error in batch rung generation:");
    res.status(500).json({ error: "Failed to generate batch rungs" });
  }
});

router.post("/ladder-logic/ai-context/:cmTypeId", (req, res) => {
  try {
    const cmType = cmTypeFromBody(req);
    if (!cmType) {
      return res.status(400).json({ error: "Missing control-module definition" });
    }
    const context = ladderLogicAgent.buildContextFromCMType(cmType);
    const aiPrompt = ladderLogicAgent.generateAIPromptContext(context);
    res.json({
      success: true,
      cmTypeName: cmType.name,
      aiPrompt,
      context: { sourceName: cmType.name, inputCount: cmType.inputs.length, outputCount: cmType.outputs.length },
    });
  } catch (error) {
    logError(error, "Error generating AI context:");
    res.status(500).json({ error: "Failed to generate AI context" });
  }
});

export { router as codegenRoutes };
