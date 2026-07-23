/**
 * Vendor, template, data-type-mapping and controller lookups.
 * Extracted from server/routes.ts (issue #446). Mounted at /api.
 */

import { Router } from "express";
import { storage } from "../storage";
import { logError } from "../logger";

const router = Router();

// Vendors
router.get("/vendors", async (req, res) => {
  try {
    const vendors = await (storage as any).getVendors();
    res.json(vendors);
  } catch (error) {
    logError(error, "Error fetching vendors:");
    res.status(500).json({ error: "Failed to fetch vendors" });
  }
});

router.get("/vendors/:id", async (req, res) => {
  try {
    const vendor = await (storage as any).getVendorById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }
    res.json(vendor);
  } catch (error) {
    logError(error, "Error fetching vendor:");
    res.status(500).json({ error: "Failed to fetch vendor" });
  }
});

router.post("/vendors", async (req, res) => {
  try {
    const vendor = await (storage as any).createVendor(req.body);
    res.status(201).json(vendor);
  } catch (error) {
    logError(error, "Error creating vendor:");
    res.status(500).json({ error: "Failed to create vendor" });
  }
});

// Template Packages
router.get("/templates", async (req, res) => {
  try {
    const templates = await (storage as any).getTemplatePackages();
    res.json(templates);
  } catch (error) {
    logError(error, "Error fetching templates:");
    res.status(500).json({ error: "Failed to fetch template packages" });
  }
});

router.get("/templates/vendor/:vendorId", async (req, res) => {
  try {
    const templates = await (storage as any).getTemplatePackagesByVendor(req.params.vendorId);
    res.json(templates);
  } catch (error) {
    logError(error, "Error fetching templates:");
    res.status(500).json({ error: "Failed to fetch template packages" });
  }
});

router.post("/templates", async (req, res) => {
  try {
    const template = await (storage as any).createTemplatePackage(req.body);
    res.status(201).json(template);
  } catch (error) {
    logError(error, "Error creating template:");
    res.status(500).json({ error: "Failed to create template package" });
  }
});

// Data Type Mappings
router.get("/data-types/vendor/:vendorId", async (req, res) => {
  try {
    const mappings = await (storage as any).getDataTypeMappingsByVendor(req.params.vendorId);
    res.json(mappings);
  } catch (error) {
    logError(error, "Error fetching data type mappings:");
    res.status(500).json({ error: "Failed to fetch data type mappings" });
  }
});

router.post("/data-types", async (req, res) => {
  try {
    const mapping = await (storage as any).createDataTypeMapping(req.body);
    res.status(201).json(mapping);
  } catch (error) {
    logError(error, "Error creating data type mapping:");
    res.status(500).json({ error: "Failed to create data type mapping" });
  }
});

// Controllers
router.get("/controllers", async (req, res) => {
  try {
    const controllers = await (storage as any).getControllers();
    res.json(controllers);
  } catch (error) {
    logError(error, "Error fetching controllers:");
    res.status(500).json({ error: "Failed to fetch controllers" });
  }
});

router.get("/controllers/vendor/:vendorId", async (req, res) => {
  try {
    const controllers = await (storage as any).getControllersByVendor(req.params.vendorId);
    res.json(controllers);
  } catch (error) {
    logError(error, "Error fetching controllers:");
    res.status(500).json({ error: "Failed to fetch controllers" });
  }
});

router.get("/controllers/site/:siteId", async (req, res) => {
  try {
    const controllers = await (storage as any).getControllersBySite(req.params.siteId);
    res.json(controllers);
  } catch (error) {
    logError(error, "Error fetching controllers:");
    res.status(500).json({ error: "Failed to fetch controllers" });
  }
});

router.post("/controllers", async (req, res) => {
  try {
    const controller = await (storage as any).createController(req.body);
    res.status(201).json(controller);
  } catch (error) {
    logError(error, "Error creating controller:");
    res.status(500).json({ error: "Failed to create controller" });
  }
});

export { router as vendorRoutes };
