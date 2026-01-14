import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { aasSyncService } from "../services/aas-sync";
import { insertAASSchema, insertAASSubmodelSchema, insertAASSubmodelElementSchema } from "@shared/schema";

export const aasRouter = Router();

// ============================================================================
// Asset Administration Shell (AAS) Routes
// ============================================================================

aasRouter.get("/", async (req, res) => {
  try {
    const shells = await storage.getAASList();
    res.json(shells);
  } catch (error) {
    console.error("Error listing AAS:", error);
    res.status(500).json({ error: "Failed to list Asset Administration Shells" });
  }
});

aasRouter.get("/:aasId", async (req, res) => {
  try {
    const { aasId } = req.params;
    const aas = await storage.getAASById(aasId);
    
    if (!aas) {
      return res.status(404).json({ error: "Asset Administration Shell not found" });
    }
    
    const submodels = await storage.getSubmodelsByAASId(aasId);
    
    res.json({ ...aas, submodels });
  } catch (error) {
    console.error("Error getting AAS:", error);
    res.status(500).json({ error: "Failed to get Asset Administration Shell" });
  }
});

aasRouter.post("/", async (req, res) => {
  try {
    const data = insertAASSchema.parse(req.body);
    const aas = await storage.createAAS(data);
    res.status(201).json(aas);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error creating AAS:", error);
    res.status(500).json({ error: "Failed to create Asset Administration Shell" });
  }
});

aasRouter.put("/:aasId", async (req, res) => {
  try {
    const { aasId } = req.params;
    const existing = await storage.getAASById(aasId);
    
    if (!existing) {
      return res.status(404).json({ error: "Asset Administration Shell not found" });
    }
    
    const data = insertAASSchema.partial().parse(req.body);
    const updated = await storage.updateAAS(aasId, data);
    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error updating AAS:", error);
    res.status(500).json({ error: "Failed to update Asset Administration Shell" });
  }
});

aasRouter.delete("/:aasId", async (req, res) => {
  try {
    const { aasId } = req.params;
    const existing = await storage.getAASById(aasId);
    
    if (!existing) {
      return res.status(404).json({ error: "Asset Administration Shell not found" });
    }
    
    await storage.deleteAAS(aasId);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting AAS:", error);
    res.status(500).json({ error: "Failed to delete Asset Administration Shell" });
  }
});

// ============================================================================
// Submodel Routes
// ============================================================================

aasRouter.get("/:aasId/submodels", async (req, res) => {
  try {
    const { aasId } = req.params;
    const aas = await storage.getAASById(aasId);
    
    if (!aas) {
      return res.status(404).json({ error: "Asset Administration Shell not found" });
    }
    
    const submodels = await storage.getSubmodelsByAASId(aasId);
    res.json(submodels);
  } catch (error) {
    console.error("Error listing submodels:", error);
    res.status(500).json({ error: "Failed to list submodels" });
  }
});

aasRouter.get("/:aasId/submodels/:smId", async (req, res) => {
  try {
    const { smId } = req.params;
    const submodel = await storage.getSubmodelById(smId);
    
    if (!submodel) {
      return res.status(404).json({ error: "Submodel not found" });
    }
    
    const elements = await storage.getSubmodelElements(smId);
    
    res.json({ ...submodel, elements });
  } catch (error) {
    console.error("Error getting submodel:", error);
    res.status(500).json({ error: "Failed to get submodel" });
  }
});

aasRouter.post("/:aasId/submodels", async (req, res) => {
  try {
    const { aasId } = req.params;
    const aas = await storage.getAASById(aasId);
    
    if (!aas) {
      return res.status(404).json({ error: "Asset Administration Shell not found" });
    }
    
    const data = insertAASSubmodelSchema.parse({ ...req.body, aasId });
    const submodel = await storage.createSubmodel(data);
    res.status(201).json(submodel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error creating submodel:", error);
    res.status(500).json({ error: "Failed to create submodel" });
  }
});

aasRouter.put("/:aasId/submodels/:smId", async (req, res) => {
  try {
    const { smId } = req.params;
    const existing = await storage.getSubmodelById(smId);
    
    if (!existing) {
      return res.status(404).json({ error: "Submodel not found" });
    }
    
    const data = insertAASSubmodelSchema.partial().parse(req.body);
    const updated = await storage.updateSubmodel(smId, data);
    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error updating submodel:", error);
    res.status(500).json({ error: "Failed to update submodel" });
  }
});

aasRouter.delete("/:aasId/submodels/:smId", async (req, res) => {
  try {
    const { smId } = req.params;
    const existing = await storage.getSubmodelById(smId);
    
    if (!existing) {
      return res.status(404).json({ error: "Submodel not found" });
    }
    
    await storage.deleteSubmodel(smId);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting submodel:", error);
    res.status(500).json({ error: "Failed to delete submodel" });
  }
});

// ============================================================================
// Submodel Element Routes
// ============================================================================

aasRouter.get("/:aasId/submodels/:smId/elements", async (req, res) => {
  try {
    const { smId } = req.params;
    const submodel = await storage.getSubmodelById(smId);
    
    if (!submodel) {
      return res.status(404).json({ error: "Submodel not found" });
    }
    
    const elements = await storage.getSubmodelElements(smId);
    res.json(elements);
  } catch (error) {
    console.error("Error listing submodel elements:", error);
    res.status(500).json({ error: "Failed to list submodel elements" });
  }
});

aasRouter.post("/:aasId/submodels/:smId/elements", async (req, res) => {
  try {
    const { smId } = req.params;
    const submodel = await storage.getSubmodelById(smId);
    
    if (!submodel) {
      return res.status(404).json({ error: "Submodel not found" });
    }
    
    const data = insertAASSubmodelElementSchema.parse({ ...req.body, submodelId: smId });
    const element = await storage.createSubmodelElement(data);
    res.status(201).json(element);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error creating submodel element:", error);
    res.status(500).json({ error: "Failed to create submodel element" });
  }
});

aasRouter.put("/:aasId/submodels/:smId/elements/:elId", async (req, res) => {
  try {
    const { elId } = req.params;
    const existing = await storage.getSubmodelElementById(elId);
    
    if (!existing) {
      return res.status(404).json({ error: "Submodel element not found" });
    }
    
    const data = insertAASSubmodelElementSchema.partial().parse(req.body);
    const updated = await storage.updateSubmodelElement(elId, data);
    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request body", details: error.errors });
    }
    console.error("Error updating submodel element:", error);
    res.status(500).json({ error: "Failed to update submodel element" });
  }
});

aasRouter.delete("/:aasId/submodels/:smId/elements/:elId", async (req, res) => {
  try {
    const { elId } = req.params;
    const existing = await storage.getSubmodelElementById(elId);
    
    if (!existing) {
      return res.status(404).json({ error: "Submodel element not found" });
    }
    
    await storage.deleteSubmodelElement(elId);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting submodel element:", error);
    res.status(500).json({ error: "Failed to delete submodel element" });
  }
});

// ============================================================================
// Sync Routes
// ============================================================================

aasRouter.post("/sync", async (req, res) => {
  try {
    const result = await aasSyncService.syncAll();
    res.json({
      message: "Sync completed successfully",
      synced: result
    });
  } catch (error) {
    console.error("Error syncing AAS:", error);
    res.status(500).json({ error: "Failed to sync Asset Administration Shells" });
  }
});

aasRouter.post("/sync/sites", async (req, res) => {
  try {
    const shells = await aasSyncService.syncAllSites();
    res.json({
      message: `Synced ${shells.length} sites`,
      shells
    });
  } catch (error) {
    console.error("Error syncing sites to AAS:", error);
    res.status(500).json({ error: "Failed to sync sites" });
  }
});

aasRouter.post("/sync/assets", async (req, res) => {
  try {
    const shells = await aasSyncService.syncAllAssets();
    res.json({
      message: `Synced ${shells.length} assets`,
      shells
    });
  } catch (error) {
    console.error("Error syncing assets to AAS:", error);
    res.status(500).json({ error: "Failed to sync assets" });
  }
});

// ============================================================================
// Submodel Templates Routes
// ============================================================================

aasRouter.get("/templates", async (req, res) => {
  try {
    const templates = await storage.getSubmodelTemplates();
    res.json(templates);
  } catch (error) {
    console.error("Error listing templates:", error);
    res.status(500).json({ error: "Failed to list submodel templates" });
  }
});

aasRouter.get("/templates/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const templates = await storage.getSubmodelTemplatesByType(type);
    res.json(templates);
  } catch (error) {
    console.error("Error listing templates by type:", error);
    res.status(500).json({ error: "Failed to list submodel templates" });
  }
});

export default aasRouter;
