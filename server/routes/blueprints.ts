/**
 * Blueprint CRUD (ISA-88 control module / unit / phase types and instances).
 * Extracted from server/routes.ts (issue #446). Mounted at /api/blueprints.
 *
 * Imports and default seeding are persisted through the restored blueprint
 * storage layer (issue #511).
 */

import { Router } from "express";
import { storage } from "../storage";
import { logError } from "../logger";
import {
  importBlueprints,
  validateCMReferences,
  validateUnitReferences,
  validateInstanceBindings,
  validatePhaseReferences,
  type BlueprintFiles,
} from "../blueprints";
import { seedBlueprintDatabase } from "../blueprints/seed-database";

const router = Router();

async function persistBlueprintImport(
  parsed: ReturnType<typeof importBlueprints>,
): Promise<Record<string, number>> {
  const controlModuleTypeIds = new Map<string, string>();
  const unitTypeIds = new Map<string, string>();

  for (const cmType of parsed.cmTypes) {
    const stored = await storage.upsertControlModuleType({
      name: cmType.name,
      inputs: cmType.inputs,
      outputs: cmType.outputs,
      inOuts: cmType.inOuts,
      sourcePackage: cmType.sourceFile,
    });
    controlModuleTypeIds.set(cmType.name, stored.id);
  }

  for (const unitType of parsed.unitTypes) {
    const stored = await storage.upsertUnitType({
      name: unitType.name,
      description: unitType.description,
      variables: unitType.variables,
    });
    unitTypeIds.set(unitType.name, stored.id);
  }

  for (const phaseType of parsed.phaseTypes) {
    await storage.upsertPhaseType({
      name: phaseType.name,
      description: phaseType.description,
      linkedModules: phaseType.linkedModules,
      inputs: phaseType.inputs,
      outputs: phaseType.outputs,
      inOuts: phaseType.inOuts,
      internalValues: phaseType.internalValues,
      hmiParameters: phaseType.hmiParameters,
      recipeParameters: phaseType.recipeParameters,
      reportParameters: phaseType.reportParameters,
      sequences: phaseType.sequences,
    });
  }

  const unitInstanceIds = new Map<string, Set<string>>();
  let unitInstances = 0;
  for (const group of parsed.unitInstances) {
    for (const instance of group.instances) {
      const unitTypeName = instance.unitType || group.unitTypeName;
      const unitTypeId = unitTypeIds.get(unitTypeName);
      if (!unitTypeId) {
        throw new Error(
          `Unit instance ${instance.name} references unknown Unit type ${unitTypeName}`,
        );
      }
      const stored = await storage.upsertUnitInstance({
        name: instance.name,
        instanceNumber: instance.instanceNumber,
        unitTypeId,
        controllerId: instance.controller,
        pidDrawing: instance.pidDrawing,
        processCell: instance.processCell,
        area: instance.area,
        comment: instance.comment,
      });
      const matchingIds = unitInstanceIds.get(instance.name) ?? new Set<string>();
      matchingIds.add(stored.id);
      unitInstanceIds.set(instance.name, matchingIds);
      unitInstances += 1;
    }
  }

  let controlModuleInstances = 0;
  for (const group of parsed.cmInstances) {
    const controlModuleTypeId = controlModuleTypeIds.get(group.cmTypeName);
    if (!controlModuleTypeId) continue;
    for (const instance of group.instances) {
      const matchingUnitIds = instance.unitInstance
        ? unitInstanceIds.get(instance.unitInstance)
        : undefined;
      if (instance.unitInstance && matchingUnitIds?.size !== 1) {
        throw new Error(
          `CM instance ${instance.name} has an unresolved or ambiguous Unit instance ` +
          `reference: ${instance.unitInstance}`,
        );
      }
      await storage.upsertControlModuleInstance({
        name: instance.name,
        instanceNumber: instance.instanceNumber,
        controlModuleTypeId,
        controllerId: instance.controller,
        unitInstanceId: matchingUnitIds
          ? [...matchingUnitIds][0]
          : undefined,
        pidDrawing: instance.pidDrawing,
        comment: instance.comment,
        configuration: instance.configuration,
      });
      controlModuleInstances += 1;
    }
  }

  return {
    cmTypes: parsed.cmTypes.length,
    cmInstances: controlModuleInstances,
    unitTypes: parsed.unitTypes.length,
    unitInstances,
    phaseTypes: parsed.phaseTypes.length,
  };
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

router.post("/import", async (req, res) => {
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
      ...validateInstanceBindings(
        parsed.unitTypes,
        parsed.unitInstances,
        parsed.cmInstances,
      ),
      ...validatePhaseReferences(parsed.cmTypes, parsed.phaseTypes),
    ];
    if (refErrors.length > 0) {
      return res.status(400).json({ error: "Reference validation failed", errors: refErrors, warnings: parsed.warnings });
    }
    const persisted = await storage.transaction(() =>
      persistBlueprintImport(parsed),
    );
    res.json({
      success: true,
      persisted: true,
      parsed: persisted,
      warnings: parsed.warnings,
    });
  } catch (error) {
    logError(error, "Error importing blueprints:");
    res.status(500).json({ error: "Failed to import blueprints" });
  }
});

router.post("/seed", async (req, res) => {
  try {
    const seeded = await seedBlueprintDatabase();
    res.json({ success: true, seeded });
  } catch (error) {
    logError(error, "Error seeding blueprint database:");
    res.status(500).json({ error: "Failed to seed blueprint database" });
  }
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
