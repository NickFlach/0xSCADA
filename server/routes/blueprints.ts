/**
 * Blueprint CRUD (ISA-88 control module / unit / phase types and instances).
 * Extracted from server/routes.ts (issue #446). Mounted at /api/blueprints.
 *
 * `import` and `seed` return 501: they depend on the blueprint parser and
 * seeder deleted with server/blueprints/ in commit 6f9d9219c — see #479.
 */

import { Router, type Response } from "express";
import { storage } from "../storage";
import { logError } from "../logger";
import {
  importBlueprints,
  validateCMReferences,
  validateUnitReferences,
  validatePhaseReferences,
  type BlueprintFiles,
} from "../blueprints";

const router = Router();

function lostModule501(res: Response, capability: string): void {
  res.status(501).json({
    error: "Not Implemented",
    message: `${capability} depends on the server/blueprints modules deleted in commit 6f9d9219c. Tracked in issue #479.`,
  });
}

// Control Module Types
router.get("/cm-types", async (req, res) => {
  try {
    const cmTypes = await (storage as any).getControlModuleTypes();
    res.json(cmTypes);
  } catch (error) {
    logError(error, "Error fetching CM types:");
    res.status(500).json({ error: "Failed to fetch control module types" });
  }
});

router.get("/cm-types/:name", async (req, res) => {
  try {
    const cmType = await (storage as any).getControlModuleTypeByName(req.params.name);
    if (!cmType) {
      return res.status(404).json({ error: "Control module type not found" });
    }
    res.json(cmType);
  } catch (error) {
    logError(error, "Error fetching CM type:");
    res.status(500).json({ error: "Failed to fetch control module type" });
  }
});

router.post("/cm-types", async (req, res) => {
  try {
    const cmType = await (storage as any).createControlModuleType(req.body);
    res.status(201).json(cmType);
  } catch (error) {
    logError(error, "Error creating CM type:");
    res.status(500).json({ error: "Failed to create control module type" });
  }
});

// Control Module Instances
router.get("/cm-instances", async (req, res) => {
  try {
    const instances = await (storage as any).getControlModuleInstances();
    res.json(instances);
  } catch (error) {
    logError(error, "Error fetching CM instances:");
    res.status(500).json({ error: "Failed to fetch control module instances" });
  }
});

// Unit Types
router.get("/unit-types", async (req, res) => {
  try {
    const unitTypes = await (storage as any).getUnitTypes();
    res.json(unitTypes);
  } catch (error) {
    logError(error, "Error fetching unit types:");
    res.status(500).json({ error: "Failed to fetch unit types" });
  }
});

router.post("/unit-types", async (req, res) => {
  try {
    const unitType = await (storage as any).createUnitType(req.body);
    res.status(201).json(unitType);
  } catch (error) {
    logError(error, "Error creating unit type:");
    res.status(500).json({ error: "Failed to create unit type" });
  }
});

// Unit Instances
router.get("/unit-instances", async (req, res) => {
  try {
    const instances = await (storage as any).getUnitInstances();
    res.json(instances);
  } catch (error) {
    logError(error, "Error fetching unit instances:");
    res.status(500).json({ error: "Failed to fetch unit instances" });
  }
});

// Phase Types
router.get("/phase-types", async (req, res) => {
  try {
    const phaseTypes = await (storage as any).getPhaseTypes();
    res.json(phaseTypes);
  } catch (error) {
    logError(error, "Error fetching phase types:");
    res.status(500).json({ error: "Failed to fetch phase types" });
  }
});

router.post("/phase-types", async (req, res) => {
  try {
    const phaseType = await (storage as any).createPhaseType(req.body);
    res.status(201).json(phaseType);
  } catch (error) {
    logError(error, "Error creating phase type:");
    res.status(500).json({ error: "Failed to create phase type" });
  }
});

// Phase Instances
router.get("/phase-instances", async (req, res) => {
  try {
    const instances = await (storage as any).getPhaseInstances();
    res.json(instances);
  } catch (error) {
    logError(error, "Error fetching phase instances:");
    res.status(500).json({ error: "Failed to fetch phase instances" });
  }
});

// Design Specifications
router.get("/design-specs", async (req, res) => {
  try {
    const specs = await (storage as any).getDesignSpecifications();
    res.json(specs);
  } catch (error) {
    logError(error, "Error fetching design specs:");
    res.status(500).json({ error: "Failed to fetch design specifications" });
  }
});

// Parse + validate a blueprint package (#479). Restored parser + reference
// validators. This parses and validates only — persisting the parsed entities
// needs the blueprint DB layer, which was never restored (separate follow-up),
// so the parsed result is returned rather than stored.
router.post("/import", (req, res) => {
  try {
    const files = req.body as BlueprintFiles;
    if (!files || (!files.cmTypePackage && !files.designSpec)) {
      return res.status(400).json({
        error: "Invalid blueprint package. Expected cmTypePackage and/or designSpec.",
      });
    }
    const parsed = importBlueprints(files);
    if (!parsed.success) {
      return res.status(400).json({ error: "Failed to parse blueprints", errors: parsed.errors, warnings: parsed.warnings });
    }
    const refErrors = [
      ...validateCMReferences(parsed.cmTypes, parsed.cmInstances),
      ...validateUnitReferences(parsed.unitTypes, parsed.unitInstances),
      ...validatePhaseReferences(parsed.cmTypes, parsed.phaseTypes),
    ];
    if (refErrors.length > 0) {
      return res.status(400).json({ error: "Reference validation failed", errors: refErrors, warnings: parsed.warnings });
    }
    res.json({
      success: true,
      persisted: false,
      parsed: {
        cmTypes: parsed.cmTypes.length,
        cmInstances: parsed.cmInstances.length,
        unitTypes: parsed.unitTypes.length,
        unitInstances: parsed.unitInstances.length,
        phaseTypes: parsed.phaseTypes.length,
      },
      warnings: parsed.warnings,
    });
  } catch (error) {
    logError(error, "Error importing blueprints:");
    res.status(500).json({ error: "Failed to import blueprints" });
  }
});

// Seed database with default vendors — needs the blueprint DB layer (storage
// CRUD + tables) which was never restored; tracked as a #479 follow-up.
router.post("/seed", (req, res) => {
  lostModule501(res, "Blueprint database seeding (needs the blueprint DB layer)");
});

// Blueprints Summary
router.get("/summary", async (req, res) => {
  try {
    const [cmTypes, cmInstances, unitTypes, unitInstances, phaseTypes, phaseInstances, vendors] = await Promise.all([
      (storage as any).getControlModuleTypes(),
      (storage as any).getControlModuleInstances(),
      (storage as any).getUnitTypes(),
      (storage as any).getUnitInstances(),
      (storage as any).getPhaseTypes(),
      (storage as any).getPhaseInstances(),
      (storage as any).getVendors(),
    ]);

    res.json({
      controlModuleTypes: cmTypes.length,
      controlModuleInstances: cmInstances.length,
      unitTypes: unitTypes.length,
      unitInstances: unitInstances.length,
      phaseTypes: phaseTypes.length,
      phaseInstances: phaseInstances.length,
      vendors: vendors.length,
    });
  } catch (error) {
    logError(error, "Error fetching blueprints summary:");
    res.status(500).json({ error: "Failed to fetch blueprints summary" });
  }
});

export { router as blueprintRoutes };
