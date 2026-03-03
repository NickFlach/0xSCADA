import type { Express } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { blockchainService } from "./blockchain";
import { logError } from "./logger";
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
import { aasRouter } from "./routes/aas";
import ubiquityRoutes from "./routes/ubiquity";
import { certificationRoutes } from "./routes/certifications";
import artifactRoutes from "./routes/ArtifactRoutes";
import { assetRoutes } from "./routes/assets";
import { alarmRoutes } from "./routes/alarms";
import pidRoutes from "./routes/pid";
import { fluxRoutes } from "./routes/flux";
import { gatewayRoutes } from "./routes/gateway";
import { eventStreamServer } from "./websocket";
import { tagStreamServer } from "./websocket/tag-stream";
import { unifiedStreamServer } from "./websocket/unified-stream";

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
  app.use("/api/aas", aasRouter);
  app.use("/api/ubiquity", ubiquityRoutes);
  app.use("/api/certifications", certificationRoutes);
  app.use("/api/artifacts", artifactRoutes);
  app.use("/api/assets", assetRoutes);
  app.use("/api/alarms", alarmRoutes);
  app.use("/api/pid", pidRoutes);
  app.use("/api/flux", fluxRoutes);
  app.use("/api/gateway", gatewayRoutes);
  
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
  // WEBSOCKET EVENT STREAM
  // ==========================================================================
  eventStreamServer.initialize(httpServer, "/ws/events");
  tagStreamServer.initialize(httpServer, "/ws/tags");
  unifiedStreamServer.initialize(httpServer, "/ws");  // unified endpoint (#255)

  // WebSocket metrics endpoint
  app.get("/api/ws/metrics", (req, res) => {
    res.json({
      eventStream: eventStreamServer.getMetrics(),
      tagStream: tagStreamServer.getMetrics(),
      unified: unifiedStreamServer.getMetrics(),
    });
  });

  app.get("/api/ws/clients", (req, res) => {
    res.json({
      eventStream: eventStreamServer.getConnectedClients(),
      unified: unifiedStreamServer.getConnectedClients(),
    });
  });

  // Tag stream metrics
  app.get("/api/ws/tags/metrics", (req, res) => {
    res.json(tagStreamServer.getMetrics());
  });

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================
  app.get("/api/health", async (req, res) => {
    try {
      // Check database connectivity with lightweight query
      const dbHealth = await storage.healthCheck();
      
      // Check blockchain service
      const blockchainConnected = blockchainService.isEnabled();
      
      // Determine overall health status
      const isHealthy = dbHealth.connected;
      
      const response = {
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        uptime: process.uptime(),
        components: {
          database: {
            status: dbHealth.connected ? "up" : "down",
            latencyMs: dbHealth.latencyMs,
          },
          blockchain: {
            status: blockchainConnected ? "up" : "down",
          },
        },
      };
      
      if (isHealthy) {
        res.status(200).json(response);
      } else {
        res.status(503).json(response);
      }
    } catch (error) {
      logError("Health check failed:", error, "routes");
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: "1.0.0",
        uptime: process.uptime(),
        components: {
          database: { status: "down" },
          blockchain: { status: "unknown" },
        },
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
      logError("Error fetching sites:", error, "routes");
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
      logError("Error creating site:", error, "routes");
      res.status(500).json({ error: "Failed to create site" });
    }
  });

  // Assets
  app.get("/api/assets", async (req, res) => {
    try {
      const assets = await storage.getAssets();
      res.json(assets);
    } catch (error) {
      logError("Error fetching assets:", error, "routes");
      res.status(500).json({ error: "Failed to fetch assets" });
    }
  });

  app.get("/api/assets/site/:siteId", async (req, res) => {
    try {
      const assets = await storage.getAssetsBySiteId(req.params.siteId);
      res.json(assets);
    } catch (error) {
      logError("Error fetching assets:", error, "routes");
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
      logError("Error creating asset:", error, "routes");
      res.status(500).json({ error: "Failed to create asset" });
    }
  });

  // Events
  app.get("/api/events", async (req, res) => {
    try {
      // Parse and validate pagination parameters
      const parsedPage = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      
      // Validate page (must be positive integer)
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      
      // Validate limit (must be between 1 and 100, default 50)
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 
        ? Math.min(parsedLimit, 100) 
        : 50;
      
      const { data, total } = await storage.getEventAnchorsPaginated(page, limit);
      
      // Calculate pagination metadata
      const totalPages = Math.ceil(total / limit);
      const hasNextPage = page < totalPages;
      const hasPrevPage = page > 1;
      
      res.json({
        data,
        total,
        page,
        limit,
        totalPages,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null,
      });
    } catch (error) {
      logError("Error fetching events:", error, "routes");
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
      logError("Error creating event:", error, "routes");
      res.status(500).json({ error: "Failed to create event" });
    }
  });

  // Maintenance Records
  app.get("/api/maintenance", async (req, res) => {
    try {
      const records = await storage.getMaintenanceRecords();
      res.json(records);
    } catch (error) {
      logError("Error fetching maintenance records:", error, "routes");
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
      logError("Error creating maintenance record:", error, "routes");
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
      logError("Error fetching CM types:", error, "routes");
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
      logError("Error fetching CM type:", error, "routes");
      res.status(500).json({ error: "Failed to fetch control module type" });
    }
  });

  app.post("/api/blueprints/cm-types", async (req, res) => {
    try {
      const cmType = await storage.createControlModuleType(req.body);
      res.status(201).json(cmType);
    } catch (error) {
      logError("Error creating CM type:", error, "routes");
      res.status(500).json({ error: "Failed to create control module type" });
    }
  });

  // Control Module Instances
  app.get("/api/blueprints/cm-instances", async (req, res) => {
    try {
      const instances = await storage.getControlModuleInstances();
      res.json(instances);
    } catch (error) {
      logError("Error fetching CM instances:", error, "routes");
      res.status(500).json({ error: "Failed to fetch control module instances" });
    }
  });

  // Unit Types
  app.get("/api/blueprints/unit-types", async (req, res) => {
    try {
      const unitTypes = await storage.getUnitTypes();
      res.json(unitTypes);
    } catch (error) {
      logError("Error fetching unit types:", error, "routes");
      res.status(500).json({ error: "Failed to fetch unit types" });
    }
  });

  app.post("/api/blueprints/unit-types", async (req, res) => {
    try {
      const unitType = await storage.createUnitType(req.body);
      res.status(201).json(unitType);
    } catch (error) {
      logError("Error creating unit type:", error, "routes");
      res.status(500).json({ error: "Failed to create unit type" });
    }
  });

  // Unit Instances
  app.get("/api/blueprints/unit-instances", async (req, res) => {
    try {
      const instances = await storage.getUnitInstances();
      res.json(instances);
    } catch (error) {
      logError("Error fetching unit instances:", error, "routes");
      res.status(500).json({ error: "Failed to fetch unit instances" });
    }
  });

  // Phase Types
  app.get("/api/blueprints/phase-types", async (req, res) => {
    try {
      const phaseTypes = await storage.getPhaseTypes();
      res.json(phaseTypes);
    } catch (error) {
      logError("Error fetching phase types:", error, "routes");
      res.status(500).json({ error: "Failed to fetch phase types" });
    }
  });

  app.post("/api/blueprints/phase-types", async (req, res) => {
    try {
      const phaseType = await storage.createPhaseType(req.body);
      res.status(201).json(phaseType);
    } catch (error) {
      logError("Error creating phase type:", error, "routes");
      res.status(500).json({ error: "Failed to create phase type" });
    }
  });

  // Phase Instances
  app.get("/api/blueprints/phase-instances", async (req, res) => {
    try {
      const instances = await storage.getPhaseInstances();
      res.json(instances);
    } catch (error) {
      logError("Error fetching phase instances:", error, "routes");
      res.status(500).json({ error: "Failed to fetch phase instances" });
    }
  });

  // Design Specifications
  app.get("/api/blueprints/design-specs", async (req, res) => {
    try {
      const specs = await storage.getDesignSpecifications();
      res.json(specs);
    } catch (error) {
      logError("Error fetching design specs:", error, "routes");
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
      logError("Error importing blueprints:", error, "routes");
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
      logError("Error fetching blueprints summary:", error, "routes");
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
      logError("Error fetching vendors:", error, "routes");
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
      logError("Error fetching vendor:", error, "routes");
      res.status(500).json({ error: "Failed to fetch vendor" });
    }
  });

  app.post("/api/vendors", async (req, res) => {
    try {
      const vendor = await storage.createVendor(req.body);
      res.status(201).json(vendor);
    } catch (error) {
      logError("Error creating vendor:", error, "routes");
      res.status(500).json({ error: "Failed to create vendor" });
    }
  });

  // Template Packages
  app.get("/api/templates", async (req, res) => {
    try {
      const templates = await storage.getTemplatePackages();
      res.json(templates);
    } catch (error) {
      logError("Error fetching templates:", error, "routes");
      res.status(500).json({ error: "Failed to fetch template packages" });
    }
  });

  app.get("/api/templates/vendor/:vendorId", async (req, res) => {
    try {
      const templates = await storage.getTemplatePackagesByVendor(req.params.vendorId);
      res.json(templates);
    } catch (error) {
      logError("Error fetching templates:", error, "routes");
      res.status(500).json({ error: "Failed to fetch template packages" });
    }
  });

  app.post("/api/templates", async (req, res) => {
    try {
      const template = await storage.createTemplatePackage(req.body);
      res.status(201).json(template);
    } catch (error) {
      logError("Error creating template:", error, "routes");
      res.status(500).json({ error: "Failed to create template package" });
    }
  });

  // Data Type Mappings
  app.get("/api/data-types/vendor/:vendorId", async (req, res) => {
    try {
      const mappings = await storage.getDataTypeMappingsByVendor(req.params.vendorId);
      res.json(mappings);
    } catch (error) {
      logError("Error fetching data type mappings:", error, "routes");
      res.status(500).json({ error: "Failed to fetch data type mappings" });
    }
  });

  app.post("/api/data-types", async (req, res) => {
    try {
      const mapping = await storage.createDataTypeMapping(req.body);
      res.status(201).json(mapping);
    } catch (error) {
      logError("Error creating data type mapping:", error, "routes");
      res.status(500).json({ error: "Failed to create data type mapping" });
    }
  });

  // Controllers
  app.get("/api/controllers", async (req, res) => {
    try {
      const controllers = await storage.getControllers();
      res.json(controllers);
    } catch (error) {
      logError("Error fetching controllers:", error, "routes");
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.get("/api/controllers/vendor/:vendorId", async (req, res) => {
    try {
      const controllers = await storage.getControllersByVendor(req.params.vendorId);
      res.json(controllers);
    } catch (error) {
      logError("Error fetching controllers:", error, "routes");
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.get("/api/controllers/site/:siteId", async (req, res) => {
    try {
      const controllers = await storage.getControllersBySite(req.params.siteId);
      res.json(controllers);
    } catch (error) {
      logError("Error fetching controllers:", error, "routes");
      res.status(500).json({ error: "Failed to fetch controllers" });
    }
  });

  app.post("/api/controllers", async (req, res) => {
    try {
      const controller = await storage.createController(req.body);
      res.status(201).json(controller);
    } catch (error) {
      logError("Error creating controller:", error, "routes");
      res.status(500).json({ error: "Failed to create controller" });
    }
  });

  // Generated Code
  app.get("/api/generated-code", async (req, res) => {
    try {
      const code = await storage.getGeneratedCode();
      res.json(code);
    } catch (error) {
      logError("Error fetching generated code:", error, "routes");
      res.status(500).json({ error: "Failed to fetch generated code" });
    }
  });

  app.get("/api/generated-code/:sourceType/:sourceId", async (req, res) => {
    try {
      const code = await storage.getGeneratedCodeBySource(req.params.sourceType, req.params.sourceId);
      res.json(code);
    } catch (error) {
      logError("Error fetching generated code:", error, "routes");
      res.status(500).json({ error: "Failed to fetch generated code" });
    }
  });

  app.post("/api/generated-code", async (req, res) => {
    try {
      const code = await storage.createGeneratedCode(req.body);
      res.status(201).json(code);
    } catch (error) {
      logError("Error creating generated code:", error, "routes");
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
      logError("Error seeding database:", error, "routes");
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
      logError("Error generating code:", error, "routes");
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
      logError("Error generating phase code:", error, "routes");
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
      logError("Error anchoring code:", error, "routes");
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
      logError("Error fetching instructions:", error, "routes");
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
      logError("Error generating ladder logic:", error, "routes");
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
      logError("Error generating phase ladder logic:", error, "routes");
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
      logError("Error in batch rung generation:", error, "routes");
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
      logError("Error generating AI context:", error, "routes");
      res.status(500).json({ error: "Failed to generate AI context" });
    }
  });

  return httpServer;
}
