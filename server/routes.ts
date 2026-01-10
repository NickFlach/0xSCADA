import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { blockchainService } from "./blockchain";
import { insertSiteSchema, insertAssetSchema, insertEventAnchorSchema, insertMaintenanceRecordSchema } from "@shared/schema";
import { fromZodError } from "zod-validation-error";
import { 
  importBlueprints, 
  validateCMReferences, 
  validateUnitReferences, 
  validatePhaseReferences,
  codeGenerator,
  seedDatabase,
  isDatabaseSeeded,
  cmTypeToFB,
  generateSCLSource,
  cmTypeToAOI,
  generateL5X,
  ladderLogicAgent,
  INSTRUCTION_LIBRARY,
  getInstructionsByCategory,
  BatchRungGenerator,
  routineToLadderDiagram,
} from "./blueprints";
import type { BlueprintFiles } from "./blueprints";
import { agentRoutes } from "./routes/agents";
import { eventRoutes } from "./routes/events";
import { batchRoutes } from "./routes/batch";
import { batchAnchoringService } from "./batch-anchoring";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ==========================================================================
  // MODULAR ROUTES
  // ==========================================================================
  app.use("/api/agents", agentRoutes);
  app.use("/api/v2/events", eventRoutes);
  app.use("/api/batch", batchRoutes);
  
  // Convenience routes for agent outputs and proposals (redirect to agentRoutes)
  app.get("/api/agent-outputs", async (req, res, next) => {
    req.url = "/outputs";
    agentRoutes(req, res, next);
  });
  app.get("/api/agent-proposals", async (req, res, next) => {
    req.url = "/proposals";
    agentRoutes(req, res, next);
  });

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================
  app.get("/api/health", async (req, res) => {
    try {
      const startTime = Date.now();
      
      // Check database connectivity
      const sites = await storage.getSites();
      const dbLatency = Date.now() - startTime;
      
      // Check blockchain service
      const blockchainStatus = blockchainService.isEnabled() ? "connected" : "disconnected";
      
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        uptime: process.uptime(),
        checks: {
          database: {
            status: "healthy",
            latency: `${dbLatency}ms`,
          },
          blockchain: {
            status: blockchainStatus,
          },
        },
      });
    } catch (error) {
      console.error("Health check failed:", error);
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Sites
  app.get("/api/sites", async (req, res) => {
    try {
      const sites = await storage.getSites();
      res.json(sites);
    } catch (error) {
      console.error("Error fetching sites:", error);
      res.status(500).json({ error: "Failed to fetch sites" });
    }
  });

  app.post("/api/sites", async (req, res) => {
    try {
      const validation = insertSiteSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const site = await storage.createSite(validation.data);
      
      await blockchainService.registerSite(
        site.id,
        site.name,
        site.location,
        site.owner
      );

      res.status(201).json(site);
    } catch (error) {
      console.error("Error creating site:", error);
      res.status(500).json({ error: "Failed to create site" });
    }
  });

  // Assets
  app.get("/api/assets", async (req, res) => {
    try {
      const assets = await storage.getAssets();
      res.json(assets);
    } catch (error) {
      console.error("Error fetching assets:", error);
      res.status(500).json({ error: "Failed to fetch assets" });
    }
  });

  app.get("/api/assets/site/:siteId", async (req, res) => {
    try {
      const assets = await storage.getAssetsBySiteId(req.params.siteId);
      res.json(assets);
    } catch (error) {
      console.error("Error fetching assets:", error);
      res.status(500).json({ error: "Failed to fetch assets" });
    }
  });

  app.post("/api/assets", async (req, res) => {
    try {
      const validation = insertAssetSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const asset = await storage.createAsset(validation.data);
      
      await blockchainService.registerAsset(
        asset.id,
        asset.siteId,
        asset.assetType,
        asset.nameOrTag,
        asset.critical
      );

      res.status(201).json(asset);
    } catch (error) {
      console.error("Error creating asset:", error);
      res.status(500).json({ error: "Failed to create asset" });
    }
  });

  // Events
  app.get("/api/events", async (req, res) => {
    try {
      const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
      const events = await storage.getEventAnchors(limit);
      res.json(events);
    } catch (error) {
      console.error("Error fetching events:", error);
      res.status(500).json({ error: "Failed to fetch events" });
    }
  });

  app.post("/api/events", async (req, res) => {
    try {
      if (!req.body || req.body.payload === undefined) {
        return res.status(400).json({ error: "Missing payload" });
      }

      const payloadHash = blockchainService.hashPayload(req.body.payload);

      const eventData = {
        assetId: req.body.assetId,
        eventType: req.body.eventType,
        payloadHash,
        timestamp: new Date(),
        recordedBy: req.body.recordedBy || "0xGateway_System",
        txHash: null,
        details: req.body.details || "",
        fullPayload: req.body.payload,
      };

      const validation = insertEventAnchorSchema.safeParse(eventData);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const event = await storage.createEventAnchor(validation.data);

      const txHash = await blockchainService.anchorEvent(
        event.assetId,
        event.eventType,
        payloadHash
      );

      if (txHash) {
        await storage.updateEventTxHash(event.id, txHash);
        event.txHash = txHash;
      }

      res.status(201).json(event);
    } catch (error) {
      console.error("Error creating event:", error);
      res.status(500).json({ error: "Failed to create event" });
    }
  });

  // Maintenance Records
  app.get("/api/maintenance", async (req, res) => {
    try {
      const records = await storage.getMaintenanceRecords();
      res.json(records);
    } catch (error) {
      console.error("Error fetching maintenance records:", error);
      res.status(500).json({ error: "Failed to fetch maintenance records" });
    }
  });

  app.post("/api/maintenance", async (req, res) => {
    try {
      const validation = insertMaintenanceRecordSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: fromZodError(validation.error).toString() });
      }

      const record = await storage.createMaintenanceRecord(validation.data);

      await blockchainService.anchorMaintenance(
        record.assetId,
        record.workOrderId,
        record.maintenanceType,
        Math.floor(new Date(record.performedAt).getTime() / 1000)
      );

      res.status(201).json(record);
    } catch (error) {
      console.error("Error creating maintenance record:", error);
      res.status(500).json({ error: "Failed to create maintenance record" });
    }
  });

  // Blockchain status
  app.get("/api/blockchain/status", (req, res) => {
    res.json({
      enabled: blockchainService.isEnabled(),
    });
  });

  // ============================================================================
  // BLUEPRINTS API ENDPOINTS
  // ============================================================================

  // Control Module Types
  app.get("/api/blueprints/cm-types", async (req, res) => {
    try {
      const cmTypes = await storage.getControlModuleTypes();
      res.json(cmTypes);
    } catch (error) {
      console.error("Error fetching CM types:", error);
      res.status(500).json({ error: "Failed to fetch control module types" });
    }
  });

  app.get("/api/blueprints/cm-types/:name", async (req, res) => {
    try {
      const cmType = await storage.getControlModuleTypeByName(req.params.name);
      if (!cmType) {
        return res.status(404).json({ error: "Control module type not found" });
      }
      res.json(cmType);
    } catch (error) {
      console.error("Error fetching CM type:", error);
      res.status(500).json({ error: "Failed to fetch control module type" });
    }
  });

  app.post("/api/blueprints/cm-types", async (req, res) => {
    try {
      const cmType = await storage.createControlModuleType(req.body);
      res.status(201).json(cmType);
    } catch (error) {
      console.error("Error creating CM type:", error);
      res.status(500).json({ error: "Failed to create control module type" });
    }
  });

  // Control Module Instances
  app.get("/api/blueprints/cm-instances", async (req, res) => {
    try {
      const instances = await storage.getControlModuleInstances();
      res.json(instances);
    } catch (error) {
      console.error("Error fetching CM instances:", error);
      res.status(500).json({ error: "Failed to fetch control module instances" });
    }
  });

  // Unit Types
  app.get("/api/blueprints/unit-types", async (req, res) => {
    try {
      const unitTypes = await storage.getUnitTypes();
      res.json(unitTypes);
    } catch (error) {
      console.error("Error fetching unit types:", error);
      res.status(500).json({ error: "Failed to fetch unit types" });
    }
  });

  app.post("/api/blueprints/unit-types", async (req, res) => {
    try {
      const unitType = await storage.createUnitType(req.body);
      res.status(201).json(unitType);
    } catch (error) {
      console.error("Error creating unit type:", error);
      res.status(500).json({ error: "Failed to create unit type" });
    }
  });

  // Unit Instances
  app.get("/api/blueprints/unit-instances", async (req, res) => {
    try {
      const instances = await storage.getUnitInstances();
      res.json(instances);
    } catch (error) {
      console.error("Error fetching unit instances:", error);
      res.status(500).json({ error: "Failed to fetch unit instances" });
    }
  });

  // Phase Types
  app.get("/api/blueprints/phase-types", async (req, res) => {
    try {
      const phaseTypes = await storage.getPhaseTypes();
      res.json(phaseTypes);
    } catch (error) {
      console.error("Error fetching phase types:", error);
      res.status(500).json({ error: "Failed to fetch phase types" });
    }
  });

  app.post("/api/blueprints/phase-types", async (req, res) => {
    try {
      const phaseType = await storage.createPhaseType(req.body);
      res.status(201).json(phaseType);
    } catch (error) {
      console.error("Error creating phase type:", error);
      res.status(500).json({ error: "Failed to create phase type" });
    }
  });

  // Phase Instances
  app.get("/api/blueprints/phase-instances", async (req, res) => {
    try {
      const instances = await storage.getPhaseInstances();
      res.json(instances);
    } catch (error) {
      console.error("Error fetching phase instances:", error);
      res.status(500).json({ error: "Failed to fetch phase instances" });
    }
  });

  // Design Specifications
  app.get("/api/blueprints/design-specs", async (req, res) => {
    try {
      const specs = await storage.getDesignSpecifications();
      res.json(specs);
    } catch (error) {
      console.error("Error fetching design specs:", error);
      res.status(500).json({ error: "Failed to fetch design specifications" });
    }
  });

  // Import Blueprints Package
  app.post("/api/blueprints/import", async (req, res) => {
    try {
      const files: BlueprintFiles = req.body;
      
      if (!files.cmTypePackage || !files.designSpec) {
        return res.status(400).json({ 
          error: "Invalid blueprint package structure. Expected cmTypePackage and designSpec." 
        });
      }

      // Parse the blueprints
      const parseResult = importBlueprints(files);
      
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Failed to parse blueprints",
          errors: parseResult.errors,
          warnings: parseResult.warnings,
        });
      }

      // Validate references
      const cmRefErrors = validateCMReferences(parseResult.cmTypes, parseResult.cmInstances);
      const unitRefErrors = validateUnitReferences(parseResult.unitTypes, parseResult.unitInstances);
      const phaseRefErrors = validatePhaseReferences(parseResult.cmTypes, parseResult.phaseTypes);
      
      const allErrors = [...cmRefErrors, ...unitRefErrors, ...phaseRefErrors];
      if (allErrors.length > 0) {
        return res.status(400).json({
          error: "Validation failed",
          errors: allErrors,
          warnings: parseResult.warnings,
        });
      }

      // Store CM Types
      const storedCMTypes: Record<string, string> = {};
      for (const cmType of parseResult.cmTypes) {
        const stored = await storage.upsertControlModuleType({
          name: cmType.name,
          inputs: cmType.inputs,
          outputs: cmType.outputs,
          inOuts: cmType.inOuts,
          sourcePackage: cmType.sourceFile,
        });
        storedCMTypes[cmType.name] = stored.id;
      }

      // Store Unit Types
      const storedUnitTypes: Record<string, string> = {};
      for (const unitType of parseResult.unitTypes) {
        const stored = await storage.upsertUnitType({
          name: unitType.name,
          description: unitType.description,
          variables: unitType.variables,
        });
        storedUnitTypes[unitType.name] = stored.id;
      }

      // Store Phase Types
      const storedPhaseTypes: Record<string, string> = {};
      for (const phaseType of parseResult.phaseTypes) {
        const stored = await storage.upsertPhaseType({
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
        storedPhaseTypes[phaseType.name] = stored.id;
      }

      // Store Unit Instances
      const storedUnitInstances: Record<string, string> = {};
      for (const group of parseResult.unitInstances) {
        const typeId = storedUnitTypes[group.unitTypeName];
        if (!typeId) continue;
        
        for (const instance of group.instances) {
          const stored = await storage.createUnitInstance({
            name: instance.name,
            instanceNumber: instance.instanceNumber,
            unitTypeId: typeId,
            controllerId: instance.controller,
            pidDrawing: instance.pidDrawing,
            processCell: instance.processCell,
            area: instance.area,
            comment: instance.comment,
          });
          storedUnitInstances[instance.name] = stored.id;
        }
      }

      // Store CM Instances
      let cmInstanceCount = 0;
      for (const group of parseResult.cmInstances) {
        const typeId = storedCMTypes[group.cmTypeName];
        if (!typeId) continue;
        
        for (const instance of group.instances) {
          await storage.createControlModuleInstance({
            name: instance.name,
            instanceNumber: instance.instanceNumber,
            controlModuleTypeId: typeId,
            controllerId: instance.controller,
            unitInstanceId: instance.unitInstance ? storedUnitInstances[instance.unitInstance] : undefined,
            pidDrawing: instance.pidDrawing,
            comment: instance.comment,
            configuration: instance.configuration,
          });
          cmInstanceCount++;
        }
      }

      res.status(201).json({
        success: true,
        imported: {
          cmTypes: parseResult.cmTypes.length,
          cmInstances: cmInstanceCount,
          unitTypes: parseResult.unitTypes.length,
          unitInstances: Object.keys(storedUnitInstances).length,
          phaseTypes: parseResult.phaseTypes.length,
        },
        warnings: parseResult.warnings,
      });
    } catch (error) {
      console.error("Error importing blueprints:", error);
      res.status(500).json({ error: "Failed to import blueprints" });
    }
  });

  // Blueprints Summary
  app.get("/api/blueprints/summary", async (req, res) => {
    try {
      const [cmTypes, cmInstances, unitTypes, unitInstances, phaseTypes, phaseInstances, vendors] = await Promise.all([
        storage.getControlModuleTypes(),
        storage.getControlModuleInstances(),
        storage.getUnitTypes(),
        storage.getUnitInstances(),
        storage.getPhaseTypes(),
        storage.getPhaseInstances(),
        storage.getVendors(),
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
      console.error("Error fetching blueprints summary:", error);
      res.status(500).json({ error: "Failed to fetch blueprints summary" });
    }
  });

  // ============================================================================
  // VENDOR API ENDPOINTS
  // ============================================================================

  // Vendors
  app.get("/api/vendors", async (req, res) => {
    try {
      const vendors = await storage.getVendors();
      res.json(vendors);
    } catch (error) {
      console.error("Error fetching vendors:", error);
      res.status(500).json({ error: "Failed to fetch vendors" });
    }
  });

  app.get("/api/vendors/:id", async (req, res) => {
    try {
      const vendor = await storage.getVendorById(req.params.id);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error fetching vendor:", error);
      res.status(500).json({ error: "Failed to fetch vendor" });
    }
  });

  app.post("/api/vendors", async (req, res) => {
    try {
      const vendor = await storage.createVendor(req.body);
      res.status(201).json(vendor);
    } catch (error) {
      console.error("Error creating vendor:", error);
      res.status(500).json({ error: "Failed to create vendor" });
    }
  });

  // Template Packages
  app.get("/api/templates", async (req, res) => {
    try {
      const templates = await storage.getTemplatePackages();
      res.json(templates);
    } catch (error) {
      console.error("Error fetching templates:", error);
      res.status(500).json({ error: "Failed to fetch template packages" });
    }
  });

  app.get("/api/templates/vendor/:vendorId", async (req, res) => {
    try {
      const templates = await storage.getTemplatePackagesByVendor(req.params.vendorId);
      res.json(templates);
    } catch (error) {
      console.error("Error fetching templates:", error);
      res.status(500).json({ error: "Failed to fetch template packages" });
    }
  });

  app.post("/api/templates", async (req, res) => {
    try {
      const template = await storage.createTemplatePackage(req.body);
      res.status(201).json(template);
    } catch (error) {
      console.error("Error creating template:", error);
      res.status(500).json({ error: "Failed to create template package" });
    }
  });

  // Data Type Mappings
  app.get("/api/data-types/vendor/:vendorId", async (req, res) => {
    try {
      const mappings = await storage.getDataTypeMappingsByVendor(req.params.vendorId);
      res.json(mappings);
    } catch (error) {
      console.error("Error fetching data type mappings:", error);
      res.status(500).json({ error: "Failed to fetch data type mappings" });
    }
  });

  app.post("/api/data-types", async (req, res) => {
    try {
      const mapping = await storage.createDataTypeMapping(req.body);
      res.status(201).json(mapping);
    } catch (error) {
      console.error("Error creating data type mapping:", error);
      res.status(500).json({ error: "Failed to create data type mapping" });
    }
  });

  // Controllers
  app.get("/api/controllers", async (req, res) => {
    try {
      const controllers = await storage.getControllers();
      res.json(controllers);
    } catch (error) {
      console.error("Error fetching controllers:", error);
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.get("/api/controllers/vendor/:vendorId", async (req, res) => {
    try {
      const controllers = await storage.getControllersByVendor(req.params.vendorId);
      res.json(controllers);
    } catch (error) {
      console.error("Error fetching controllers:", error);
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.get("/api/controllers/site/:siteId", async (req, res) => {
    try {
      const controllers = await storage.getControllersBySite(req.params.siteId);
      res.json(controllers);
    } catch (error) {
      console.error("Error fetching controllers:", error);
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.post("/api/controllers", async (req, res) => {
    try {
      const controller = await storage.createController(req.body);
      res.status(201).json(controller);
    } catch (error) {
      console.error("Error creating controller:", error);
      res.status(500).json({ error: "Failed to create controller" });
    }
  });

  // Generated Code
  app.get("/api/generated-code", async (req, res) => {
    try {
      const code = await storage.getGeneratedCode();
      res.json(code);
    } catch (error) {
      console.error("Error fetching generated code:", error);
      res.status(500).json({ error: "Failed to fetch generated code" });
    }
  });

  app.get("/api/generated-code/:sourceType/:sourceId", async (req, res) => {
    try {
      const code = await storage.getGeneratedCodeBySource(req.params.sourceType, req.params.sourceId);
      res.json(code);
    } catch (error) {
      console.error("Error fetching generated code:", error);
      res.status(500).json({ error: "Failed to fetch generated code" });
    }
  });

  app.post("/api/generated-code", async (req, res) => {
    try {
      const code = await storage.createGeneratedCode(req.body);
      res.status(201).json(code);
    } catch (error) {
      console.error("Error creating generated code:", error);
      res.status(500).json({ error: "Failed to create generated code" });
    }
  });

  // ============================================================================
  // CODE GENERATION API ENDPOINTS
  // ============================================================================

  // Seed database with default vendors
  app.post("/api/blueprints/seed", async (req, res) => {
    try {
      const alreadySeeded = await isDatabaseSeeded();
      const forceParam = typeof req.query.force === "string" ? req.query.force.toLowerCase() : "";
      const force = forceParam === "true" || forceParam === "1";
      if (alreadySeeded && !force) {
        return res.json({ 
          success: true, 
          message: "Database already seeded. Use ?force=true to re-seed.",
          skipped: true 
        });
      }

      const result = await seedDatabase();
      res.json(result);
    } catch (error) {
      console.error("Error seeding database:", error);
      res.status(500).json({ error: "Failed to seed database" });
    }
  });

  // Generate code for a Control Module
  app.post("/api/generate/control-module/:cmTypeId", async (req, res) => {
    try {
      const { cmTypeId } = req.params;
      const { vendorId, format, instanceName } = req.body;

      // Get CM Type
      const cmTypes = await storage.getControlModuleTypes();
      const cmType = cmTypes.find(t => t.id === cmTypeId);
      if (!cmType) {
        return res.status(404).json({ error: "Control Module Type not found" });
      }

      // Get Vendor
      const vendor = await storage.getVendorById(vendorId);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Load data type mappings
      const mappings = await storage.getDataTypeMappingsByVendor(vendorId);
      codeGenerator.loadDataTypeMappings(vendorId, mappings);

      // Generate based on vendor
      let code: string;
      let language: string;

      if (vendor.name === "siemens") {
        const fb = cmTypeToFB({
          name: cmType.name,
          inputs: cmType.inputs as any[],
          outputs: cmType.outputs as any[],
          inOuts: cmType.inOuts as any[],
        });
        if (instanceName) fb.name = instanceName;
        
        if (format === "xml") {
          // Generate TIA Portal XML
          const { generateTIAXML } = await import("./blueprints/siemens-adapter");
          code = generateTIAXML(fb);
          language = "XML";
        } else {
          code = generateSCLSource(fb);
          language = "SCL";
        }
      } else if (vendor.name === "rockwell") {
        const aoi = cmTypeToAOI({
          name: instanceName || cmType.name,
          inputs: cmType.inputs as any[],
          outputs: cmType.outputs as any[],
          inOuts: cmType.inOuts as any[],
        });
        
        if (format === "l5x") {
          code = generateL5X(aoi);
          language = "L5X";
        } else {
          // Return AOI structure as JSON
          code = JSON.stringify(aoi, null, 2);
          language = "JSON";
        }
      } else {
        return res.status(400).json({ 
          error: `Code generation not yet supported for vendor: ${vendor.name}` 
        });
      }

      // Hash the code
      const codeHash = codeGenerator.hashCode(code);

      // Store the generated code
      const stored = await storage.createGeneratedCode({
        sourceType: "control_module",
        sourceId: cmTypeId,
        vendorId,
        language,
        code,
        codeHash,
        metadata: {
          instanceName,
          format,
          cmTypeName: cmType.name,
        },
        status: "draft",
      });

      res.json({
        success: true,
        id: stored.id,
        code,
        codeHash,
        language,
        vendor: vendor.displayName,
      });
    } catch (error) {
      console.error("Error generating code:", error);
      res.status(500).json({ error: "Failed to generate code" });
    }
  });

  // Generate code for a Phase
  app.post("/api/generate/phase/:phaseTypeId", async (req, res) => {
    try {
      const { phaseTypeId } = req.params;
      const { vendorId, format, instanceName } = req.body;

      // Get Phase Type
      const phaseTypes = await storage.getPhaseTypes();
      const phaseType = phaseTypes.find(t => t.id === phaseTypeId);
      if (!phaseType) {
        return res.status(404).json({ error: "Phase Type not found" });
      }

      // Get Vendor
      const vendor = await storage.getVendorById(vendorId);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Load data type mappings
      const mappings = await storage.getDataTypeMappingsByVendor(vendorId);
      codeGenerator.loadDataTypeMappings(vendorId, mappings);

      let code: string;
      let language: string;

      if (vendor.name === "siemens") {
        const { phaseTypeToFB, generateSCLSource: genSCL } = await import("./blueprints/siemens-adapter");
        const fb = phaseTypeToFB({
          name: instanceName || phaseType.name,
          inputs: phaseType.inputs as any[],
          outputs: phaseType.outputs as any[],
          inOuts: phaseType.inOuts as any[],
          internalValues: phaseType.internalValues as any[],
          linkedModules: phaseType.linkedModules as any[],
          hmiParameters: phaseType.hmiParameters as any[] || [],
          recipeParameters: phaseType.recipeParameters as any[] || [],
          reportParameters: phaseType.reportParameters as any[] || [],
          sequences: phaseType.sequences as Record<string, any>,
        });
        code = genSCL(fb);
        language = "SCL";
      } else {
        return res.status(400).json({ 
          error: `Phase code generation not yet supported for vendor: ${vendor.name}` 
        });
      }

      const codeHash = codeGenerator.hashCode(code);

      const stored = await storage.createGeneratedCode({
        sourceType: "phase",
        sourceId: phaseTypeId,
        vendorId,
        language,
        code,
        codeHash,
        metadata: {
          instanceName,
          format,
          phaseTypeName: phaseType.name,
        },
        status: "draft",
      });

      res.json({
        success: true,
        id: stored.id,
        code,
        codeHash,
        language,
        vendor: vendor.displayName,
      });
    } catch (error) {
      console.error("Error generating phase code:", error);
      res.status(500).json({ error: "Failed to generate phase code" });
    }
  });

  // Anchor generated code to blockchain
  app.post("/api/generated-code/:id/anchor", async (req, res) => {
    try {
      const codeRecords = await storage.getGeneratedCode();
      const record = codeRecords.find(r => r.id === req.params.id);
      
      if (!record) {
        return res.status(404).json({ error: "Generated code not found" });
      }

      if (record.txHash) {
        return res.json({ 
          success: true, 
          message: "Already anchored",
          txHash: record.txHash 
        });
      }

      // Anchor to blockchain
      const txHash = await blockchainService.anchorEvent(
        record.sourceId,
        `CODE_GENERATED_${record.sourceType.toUpperCase()}`,
        record.codeHash
      );

      if (txHash) {
        await storage.updateGeneratedCodeTxHash(record.id, txHash);
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
      console.error("Error anchoring code:", error);
      res.status(500).json({ error: "Failed to anchor code" });
    }
  });

  // ============================================================================
  // LADDER LOGIC AGENT API ENDPOINTS
  // ============================================================================

  // Get instruction library
  app.get("/api/ladder-logic/instructions", (req, res) => {
    try {
      const { category } = req.query;
      
      if (category && typeof category === "string") {
        const instructions = getInstructionsByCategory(category as any);
        res.json(instructions);
      } else {
        res.json(INSTRUCTION_LIBRARY);
      }
    } catch (error) {
      console.error("Error fetching instructions:", error);
      res.status(500).json({ error: "Failed to fetch instruction library" });
    }
  });

  // Generate ladder logic for a control module
  app.post("/api/generate/ladder-logic/control-module/:cmTypeId", async (req, res) => {
    try {
      const { cmTypeId } = req.params;
      const { includeComments, generateFaultHandling, generateInterlocks } = req.body;

      // Get CM Type
      const cmTypes = await storage.getControlModuleTypes();
      const cmType = cmTypes.find(t => t.id === cmTypeId);
      if (!cmType) {
        return res.status(404).json({ error: "Control Module Type not found" });
      }

      // Build context and generate ladder logic
      const context = ladderLogicAgent.buildContextFromCMType({
        name: cmType.name,
        inputs: cmType.inputs as any[],
        outputs: cmType.outputs as any[],
        inOuts: cmType.inOuts as any[],
      }, {
        includeComments: includeComments ?? true,
        generateFaultHandling: generateFaultHandling ?? true,
        generateInterlocks: generateInterlocks ?? true,
      });

      const result = ladderLogicAgent.generateControlModuleLogic(context);

      if (!result.success) {
        return res.status(400).json({ 
          error: "Failed to generate ladder logic",
          errors: result.errors 
        });
      }

      // Get Rockwell vendor for storing
      const vendors = await storage.getVendors();
      const rockwellVendor = vendors.find(v => v.name === "rockwell");

      // Hash and store the generated code
      const codeHash = codeGenerator.hashCode(result.neutralText);
      const stored = await storage.createGeneratedCode({
        sourceType: "control_module",
        sourceId: cmTypeId,
        vendorId: rockwellVendor?.id || "",
        language: "Ladder",
        code: result.neutralText,
        codeHash,
        metadata: {
          format: "neutral_text",
          cmTypeName: cmType.name,
          rungCount: result.metadata.rungCount,
          instructionCount: result.metadata.instructionCount,
        },
        status: "draft",
      });

      // Generate visual ladder diagram
      let visualDiagram = "";
      for (const routine of result.routines) {
        visualDiagram += routineToLadderDiagram({
          name: routine.name,
          type: "Ladder",
          rungs: routine.rungs,
        }) + "\n";
      }

      res.json({
        success: true,
        id: stored.id,
        code: result.neutralText,
        visualDiagram,
        codeHash,
        language: "Ladder",
        routines: result.routines,
        tags: result.tags,
        metadata: result.metadata,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error("Error generating ladder logic:", error);
      res.status(500).json({ error: "Failed to generate ladder logic" });
    }
  });

  // Generate ladder logic for a phase
  app.post("/api/generate/ladder-logic/phase/:phaseTypeId", async (req, res) => {
    try {
      const { phaseTypeId } = req.params;
      const { includeComments, generateFaultHandling, generateInterlocks } = req.body;

      // Get Phase Type
      const phaseTypes = await storage.getPhaseTypes();
      const phaseType = phaseTypes.find(t => t.id === phaseTypeId);
      if (!phaseType) {
        return res.status(404).json({ error: "Phase Type not found" });
      }

      // Build context and generate ladder logic
      const context = ladderLogicAgent.buildContextFromPhaseType({
        name: phaseType.name,
        description: phaseType.description || "",
        inputs: phaseType.inputs as any[],
        outputs: phaseType.outputs as any[],
        inOuts: phaseType.inOuts as any[],
        internalValues: phaseType.internalValues as any[],
        linkedModules: phaseType.linkedModules as any[],
        hmiParameters: phaseType.hmiParameters as any[] || [],
        recipeParameters: phaseType.recipeParameters as any[] || [],
        reportParameters: phaseType.reportParameters as any[] || [],
        sequences: phaseType.sequences as Record<string, any>,
      }, {
        includeComments: includeComments ?? true,
        generateFaultHandling: generateFaultHandling ?? true,
        generateInterlocks: generateInterlocks ?? true,
      });

      const result = ladderLogicAgent.generatePhaseLogic(context);

      if (!result.success) {
        return res.status(400).json({ 
          error: "Failed to generate phase ladder logic",
          errors: result.errors 
        });
      }

      // Get Rockwell vendor
      const vendors = await storage.getVendors();
      const rockwellVendor = vendors.find(v => v.name === "rockwell");

      // Hash and store
      const codeHash = codeGenerator.hashCode(result.neutralText);
      const stored = await storage.createGeneratedCode({
        sourceType: "phase",
        sourceId: phaseTypeId,
        vendorId: rockwellVendor?.id || "",
        language: "Ladder",
        code: result.neutralText,
        codeHash,
        metadata: {
          format: "neutral_text",
          phaseTypeName: phaseType.name,
          rungCount: result.metadata.rungCount,
          instructionCount: result.metadata.instructionCount,
          routineCount: result.routines.length,
        },
        status: "draft",
      });

      // Generate visual ladder diagram
      let visualDiagram = "";
      for (const routine of result.routines) {
        visualDiagram += routineToLadderDiagram({
          name: routine.name,
          type: "Ladder",
          rungs: routine.rungs,
        }) + "\n";
      }

      res.json({
        success: true,
        id: stored.id,
        code: result.neutralText,
        visualDiagram,
        codeHash,
        language: "Ladder",
        routines: result.routines,
        tags: result.tags,
        metadata: result.metadata,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error("Error generating phase ladder logic:", error);
      res.status(500).json({ error: "Failed to generate phase ladder logic" });
    }
  });

  // Batch rung generation from template
  app.post("/api/ladder-logic/batch", async (req, res) => {
    try {
      const { template, csvContent, startRungNumber } = req.body;

      if (!template) {
        return res.status(400).json({ error: "Template is required" });
      }

      const generator = new BatchRungGenerator();
      generator.loadTemplate(template);

      // Validate template
      const templateValidation = generator.validateTemplate();
      if (!templateValidation.valid) {
        return res.status(400).json({
          error: "Invalid template",
          errors: templateValidation.errors,
          warnings: templateValidation.warnings,
        });
      }

      let result;
      if (csvContent) {
        // Validate CSV against template
        const csvValidation = generator.validateCSV(csvContent);
        if (!csvValidation.valid) {
          return res.status(400).json({
            error: "CSV validation failed",
            errors: csvValidation.errors,
            warnings: csvValidation.warnings,
            missingVariables: csvValidation.missingVariables,
          });
        }

        // Generate from CSV
        result = generator.generateAll(csvContent);
      } else {
        // Just return template info
        res.json({
          success: true,
          template,
          variables: templateValidation.variables,
          warnings: templateValidation.warnings,
        });
        return;
      }

      res.json({
        success: result.success,
        neutralText: result.neutralText,
        rungCount: result.rungs.length,
        generatedTags: result.generatedTags,
        errors: result.errors,
        warnings: result.warnings,
      });
    } catch (error) {
      console.error("Error in batch rung generation:", error);
      res.status(500).json({ error: "Failed to generate batch rungs" });
    }
  });

  // Generate AI prompt context for external AI integration
  app.post("/api/ladder-logic/ai-context/:cmTypeId", async (req, res) => {
    try {
      const { cmTypeId } = req.params;

      // Get CM Type
      const cmTypes = await storage.getControlModuleTypes();
      const cmType = cmTypes.find(t => t.id === cmTypeId);
      if (!cmType) {
        return res.status(404).json({ error: "Control Module Type not found" });
      }

      // Build context
      const context = ladderLogicAgent.buildContextFromCMType({
        name: cmType.name,
        inputs: cmType.inputs as any[],
        outputs: cmType.outputs as any[],
        inOuts: cmType.inOuts as any[],
      });

      const aiPrompt = ladderLogicAgent.generateAIPromptContext(context);

      res.json({
        success: true,
        cmTypeName: cmType.name,
        aiPrompt,
        context: {
          sourceType: context.sourceType,
          sourceName: context.sourceName,
          inputCount: context.inputs.length,
          outputCount: context.outputs.length,
        },
      });
    } catch (error) {
      console.error("Error generating AI context:", error);
      res.status(500).json({ error: "Failed to generate AI context" });
    }
  });

  return httpServer;
}
