import { and, eq, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import type {
  Site,
  InsertSite,
  Asset,
  InsertAsset,
  EventAnchor,
  InsertEventAnchor,
  MaintenanceRecord,
  InsertMaintenanceRecord,
  ControlModuleType,
  InsertControlModuleType,
  ControlModuleInstance,
  InsertControlModuleInstance,
  UnitType,
  InsertUnitType,
  UnitInstance,
  InsertUnitInstance,
  PhaseType,
  InsertPhaseType,
  PhaseInstance,
  InsertPhaseInstance,
  DesignSpecification,
  InsertDesignSpecification,
  Vendor,
  InsertVendor,
  TemplatePackage,
  InsertTemplatePackage,
  GeneratedCode,
  InsertGeneratedCode,
  DataTypeMapping,
  InsertDataTypeMapping,
  Controller,
  InsertController,
  AssetAdministrationShell,
  InsertAAS,
  AASSubmodel,
  InsertAASSubmodel,
  AASSubmodelElement,
  InsertAASSubmodelElement,
  AASSubmodelTemplate,
  InsertAASSubmodelTemplate,
} from "@shared/schema";

const { Pool } = pg;

export interface IStorage {
  // Sites
  createSite(site: InsertSite): Promise<Site>;
  getSites(): Promise<Site[]>;
  getSiteById(id: string): Promise<Site | undefined>;

  // Assets
  createAsset(asset: InsertAsset): Promise<Asset>;
  getAssets(): Promise<Asset[]>;
  getAssetsBySiteId(siteId: string): Promise<Asset[]>;
  getAssetById(id: string): Promise<Asset | undefined>;

  // Event Anchors
  createEventAnchor(event: InsertEventAnchor): Promise<EventAnchor>;
  getEventAnchors(limit?: number): Promise<EventAnchor[]>;
  getEventAnchorsByAssetId(assetId: string): Promise<EventAnchor[]>;
  updateEventTxHash(id: string, txHash: string): Promise<void>;

  // Maintenance Records
  createMaintenanceRecord(record: InsertMaintenanceRecord): Promise<MaintenanceRecord>;
  getMaintenanceRecords(): Promise<MaintenanceRecord[]>;
  getMaintenanceRecordsByAssetId(assetId: string): Promise<MaintenanceRecord[]>;

  // Control Module Types
  createControlModuleType(cmType: InsertControlModuleType): Promise<ControlModuleType>;
  getControlModuleTypes(): Promise<ControlModuleType[]>;
  getControlModuleTypeByName(name: string): Promise<ControlModuleType | undefined>;
  upsertControlModuleType(cmType: InsertControlModuleType): Promise<ControlModuleType>;

  // Control Module Instances
  createControlModuleInstance(instance: InsertControlModuleInstance): Promise<ControlModuleInstance>;
  getControlModuleInstances(): Promise<ControlModuleInstance[]>;
  getControlModuleInstancesByTypeId(typeId: string): Promise<ControlModuleInstance[]>;

  // Unit Types
  createUnitType(unitType: InsertUnitType): Promise<UnitType>;
  getUnitTypes(): Promise<UnitType[]>;
  getUnitTypeByName(name: string): Promise<UnitType | undefined>;
  upsertUnitType(unitType: InsertUnitType): Promise<UnitType>;

  // Unit Instances
  createUnitInstance(instance: InsertUnitInstance): Promise<UnitInstance>;
  getUnitInstances(): Promise<UnitInstance[]>;
  getUnitInstancesByTypeId(typeId: string): Promise<UnitInstance[]>;

  // Phase Types
  createPhaseType(phaseType: InsertPhaseType): Promise<PhaseType>;
  getPhaseTypes(): Promise<PhaseType[]>;
  getPhaseTypeByName(name: string): Promise<PhaseType | undefined>;
  upsertPhaseType(phaseType: InsertPhaseType): Promise<PhaseType>;

  // Phase Instances
  createPhaseInstance(instance: InsertPhaseInstance): Promise<PhaseInstance>;
  getPhaseInstances(): Promise<PhaseInstance[]>;

  // Design Specifications
  createDesignSpecification(spec: InsertDesignSpecification): Promise<DesignSpecification>;
  getDesignSpecifications(): Promise<DesignSpecification[]>;

  // Vendors
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  getVendors(): Promise<Vendor[]>;
  getVendorByName(name: string): Promise<Vendor | undefined>;
  getVendorById(id: string): Promise<Vendor | undefined>;

  // Template Packages
  createTemplatePackage(template: InsertTemplatePackage): Promise<TemplatePackage>;
  getTemplatePackages(): Promise<TemplatePackage[]>;
  getTemplatePackagesByVendor(vendorId: string): Promise<TemplatePackage[]>;

  // Generated Code
  createGeneratedCode(code: InsertGeneratedCode): Promise<GeneratedCode>;
  getGeneratedCode(): Promise<GeneratedCode[]>;
  getGeneratedCodeBySource(sourceType: string, sourceId: string): Promise<GeneratedCode[]>;
  updateGeneratedCodeTxHash(id: string, txHash: string): Promise<void>;

  // Data Type Mappings
  createDataTypeMapping(mapping: InsertDataTypeMapping): Promise<DataTypeMapping>;
  getDataTypeMappingsByVendor(vendorId: string): Promise<DataTypeMapping[]>;

  // Controllers
  createController(controller: InsertController): Promise<Controller>;
  getControllers(): Promise<Controller[]>;
  getControllersByVendor(vendorId: string): Promise<Controller[]>;
  getControllersBySite(siteId: string): Promise<Controller[]>;

  // Asset Administration Shell (Digital Twin)
  createAAS(aas: InsertAAS): Promise<AssetAdministrationShell>;
  getAASList(): Promise<AssetAdministrationShell[]>;
  getAASById(id: string): Promise<AssetAdministrationShell | undefined>;
  getAASByGlobalId(globalId: string): Promise<AssetAdministrationShell | undefined>;
  getAASBySiteId(siteId: string): Promise<AssetAdministrationShell[]>;
  getAASByAssetId(assetId: string): Promise<AssetAdministrationShell | undefined>;
  updateAAS(id: string, data: Partial<InsertAAS>): Promise<AssetAdministrationShell>;
  deleteAAS(id: string): Promise<void>;

  // AAS Submodels
  createSubmodel(submodel: InsertAASSubmodel): Promise<AASSubmodel>;
  getSubmodelsByAASId(aasId: string): Promise<AASSubmodel[]>;
  getSubmodelById(id: string): Promise<AASSubmodel | undefined>;
  getSubmodelByGlobalId(globalId: string): Promise<AASSubmodel | undefined>;
  updateSubmodel(id: string, data: Partial<InsertAASSubmodel>): Promise<AASSubmodel>;
  deleteSubmodel(id: string): Promise<void>;

  // AAS Submodel Elements
  createSubmodelElement(element: InsertAASSubmodelElement): Promise<AASSubmodelElement>;
  getSubmodelElements(submodelId: string): Promise<AASSubmodelElement[]>;
  getSubmodelElementById(id: string): Promise<AASSubmodelElement | undefined>;
  updateSubmodelElement(id: string, data: Partial<InsertAASSubmodelElement>): Promise<AASSubmodelElement>;
  deleteSubmodelElement(id: string): Promise<void>;

  // AAS Submodel Templates
  createSubmodelTemplate(template: InsertAASSubmodelTemplate): Promise<AASSubmodelTemplate>;
  getSubmodelTemplates(): Promise<AASSubmodelTemplate[]>;
  getSubmodelTemplateByName(name: string): Promise<AASSubmodelTemplate | undefined>;
  getSubmodelTemplatesByType(submodelType: string): Promise<AASSubmodelTemplate[]>;
}

export class DatabaseStorage implements IStorage {
  private db: ReturnType<typeof drizzle>;

  constructor() {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    this.db = drizzle(pool, { schema });
  }

  // Sites
  async createSite(site: InsertSite): Promise<Site> {
    const [newSite] = await this.db.insert(schema.sites).values(site).returning();
    return newSite;
  }

  async getSites(): Promise<Site[]> {
    return await this.db.select().from(schema.sites);
  }

  async getSiteById(id: string): Promise<Site | undefined> {
    const [site] = await this.db.select().from(schema.sites).where(eq(schema.sites.id, id));
    return site;
  }

  // Assets
  async createAsset(asset: InsertAsset): Promise<Asset> {
    const [newAsset] = await this.db.insert(schema.assets).values(asset).returning();
    return newAsset;
  }

  async getAssets(): Promise<Asset[]> {
    return await this.db.select().from(schema.assets);
  }

  async getAssetsBySiteId(siteId: string): Promise<Asset[]> {
    return await this.db.select().from(schema.assets).where(eq(schema.assets.siteId, siteId));
  }

  async getAssetById(id: string): Promise<Asset | undefined> {
    const [asset] = await this.db.select().from(schema.assets).where(eq(schema.assets.id, id));
    return asset;
  }

  // Event Anchors
  async createEventAnchor(event: InsertEventAnchor): Promise<EventAnchor> {
    const [newEvent] = await this.db.insert(schema.eventAnchors).values(event).returning();
    return newEvent;
  }

  async getEventAnchors(limit: number = 100): Promise<EventAnchor[]> {
    return await this.db
      .select()
      .from(schema.eventAnchors)
      .orderBy(desc(schema.eventAnchors.timestamp))
      .limit(limit);
  }

  async getEventAnchorsByAssetId(assetId: string): Promise<EventAnchor[]> {
    return await this.db
      .select()
      .from(schema.eventAnchors)
      .where(eq(schema.eventAnchors.assetId, assetId))
      .orderBy(desc(schema.eventAnchors.timestamp));
  }

  async updateEventTxHash(id: string, txHash: string): Promise<void> {
    await this.db
      .update(schema.eventAnchors)
      .set({ txHash })
      .where(eq(schema.eventAnchors.id, id));
  }

  // Maintenance Records
  async createMaintenanceRecord(record: InsertMaintenanceRecord): Promise<MaintenanceRecord> {
    const [newRecord] = await this.db
      .insert(schema.maintenanceRecords)
      .values(record)
      .returning();
    return newRecord;
  }

  async getMaintenanceRecords(): Promise<MaintenanceRecord[]> {
    return await this.db
      .select()
      .from(schema.maintenanceRecords)
      .orderBy(desc(schema.maintenanceRecords.performedAt));
  }

  async getMaintenanceRecordsByAssetId(assetId: string): Promise<MaintenanceRecord[]> {
    return await this.db
      .select()
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.assetId, assetId))
      .orderBy(desc(schema.maintenanceRecords.performedAt));
  }

  // ============================================================================
  // BLUEPRINTS - Control Module Types
  // ============================================================================

  async createControlModuleType(cmType: InsertControlModuleType): Promise<ControlModuleType> {
    const [newType] = await this.db.insert(schema.controlModuleTypes).values(cmType).returning();
    return newType;
  }

  async getControlModuleTypes(): Promise<ControlModuleType[]> {
    return await this.db.select().from(schema.controlModuleTypes);
  }

  async getControlModuleTypeByName(name: string): Promise<ControlModuleType | undefined> {
    const [cmType] = await this.db
      .select()
      .from(schema.controlModuleTypes)
      .where(eq(schema.controlModuleTypes.name, name));
    return cmType;
  }

  async upsertControlModuleType(cmType: InsertControlModuleType): Promise<ControlModuleType> {
    const existing = await this.getControlModuleTypeByName(cmType.name);
    if (existing) {
      const [updated] = await this.db
        .update(schema.controlModuleTypes)
        .set({ ...cmType, updatedAt: new Date() })
        .where(eq(schema.controlModuleTypes.id, existing.id))
        .returning();
      return updated;
    }
    return this.createControlModuleType(cmType);
  }

  // ============================================================================
  // BLUEPRINTS - Control Module Instances
  // ============================================================================

  async createControlModuleInstance(instance: InsertControlModuleInstance): Promise<ControlModuleInstance> {
    const [newInstance] = await this.db.insert(schema.controlModuleInstances).values(instance).returning();
    return newInstance;
  }

  async getControlModuleInstances(): Promise<ControlModuleInstance[]> {
    return await this.db.select().from(schema.controlModuleInstances);
  }

  async getControlModuleInstancesByTypeId(typeId: string): Promise<ControlModuleInstance[]> {
    return await this.db
      .select()
      .from(schema.controlModuleInstances)
      .where(eq(schema.controlModuleInstances.controlModuleTypeId, typeId));
  }

  // ============================================================================
  // BLUEPRINTS - Unit Types
  // ============================================================================

  async createUnitType(unitType: InsertUnitType): Promise<UnitType> {
    const [newType] = await this.db.insert(schema.unitTypes).values(unitType).returning();
    return newType;
  }

  async getUnitTypes(): Promise<UnitType[]> {
    return await this.db.select().from(schema.unitTypes);
  }

  async getUnitTypeByName(name: string): Promise<UnitType | undefined> {
    const [unitType] = await this.db
      .select()
      .from(schema.unitTypes)
      .where(eq(schema.unitTypes.name, name));
    return unitType;
  }

  async upsertUnitType(unitType: InsertUnitType): Promise<UnitType> {
    const existing = await this.getUnitTypeByName(unitType.name);
    if (existing) {
      const [updated] = await this.db
        .update(schema.unitTypes)
        .set({ ...unitType, updatedAt: new Date() })
        .where(eq(schema.unitTypes.id, existing.id))
        .returning();
      return updated;
    }
    return this.createUnitType(unitType);
  }

  // ============================================================================
  // BLUEPRINTS - Unit Instances
  // ============================================================================

  async createUnitInstance(instance: InsertUnitInstance): Promise<UnitInstance> {
    const [newInstance] = await this.db.insert(schema.unitInstances).values(instance).returning();
    return newInstance;
  }

  async getUnitInstances(): Promise<UnitInstance[]> {
    return await this.db.select().from(schema.unitInstances);
  }

  async getUnitInstancesByTypeId(typeId: string): Promise<UnitInstance[]> {
    return await this.db
      .select()
      .from(schema.unitInstances)
      .where(eq(schema.unitInstances.unitTypeId, typeId));
  }

  // ============================================================================
  // BLUEPRINTS - Phase Types
  // ============================================================================

  async createPhaseType(phaseType: InsertPhaseType): Promise<PhaseType> {
    const [newType] = await this.db.insert(schema.phaseTypes).values(phaseType).returning();
    return newType;
  }

  async getPhaseTypes(): Promise<PhaseType[]> {
    return await this.db.select().from(schema.phaseTypes);
  }

  async getPhaseTypeByName(name: string): Promise<PhaseType | undefined> {
    const [phaseType] = await this.db
      .select()
      .from(schema.phaseTypes)
      .where(eq(schema.phaseTypes.name, name));
    return phaseType;
  }

  async upsertPhaseType(phaseType: InsertPhaseType): Promise<PhaseType> {
    const existing = await this.getPhaseTypeByName(phaseType.name);
    if (existing) {
      const [updated] = await this.db
        .update(schema.phaseTypes)
        .set({ ...phaseType, updatedAt: new Date() })
        .where(eq(schema.phaseTypes.id, existing.id))
        .returning();
      return updated;
    }
    return this.createPhaseType(phaseType);
  }

  // ============================================================================
  // BLUEPRINTS - Phase Instances
  // ============================================================================

  async createPhaseInstance(instance: InsertPhaseInstance): Promise<PhaseInstance> {
    const [newInstance] = await this.db.insert(schema.phaseInstances).values(instance).returning();
    return newInstance;
  }

  async getPhaseInstances(): Promise<PhaseInstance[]> {
    return await this.db.select().from(schema.phaseInstances);
  }

  // ============================================================================
  // BLUEPRINTS - Design Specifications
  // ============================================================================

  async createDesignSpecification(spec: InsertDesignSpecification): Promise<DesignSpecification> {
    const [newSpec] = await this.db.insert(schema.designSpecifications).values(spec).returning();
    return newSpec;
  }

  async getDesignSpecifications(): Promise<DesignSpecification[]> {
    return await this.db
      .select()
      .from(schema.designSpecifications)
      .orderBy(desc(schema.designSpecifications.createdAt));
  }

  // ============================================================================
  // BLUEPRINTS - Vendors
  // ============================================================================

  async createVendor(vendor: InsertVendor): Promise<Vendor> {
    const [newVendor] = await this.db.insert(schema.vendors).values(vendor).returning();
    return newVendor;
  }

  async getVendors(): Promise<Vendor[]> {
    return await this.db.select().from(schema.vendors).where(eq(schema.vendors.isActive, true));
  }

  async getVendorByName(name: string): Promise<Vendor | undefined> {
    const [vendor] = await this.db
      .select()
      .from(schema.vendors)
      .where(eq(schema.vendors.name, name));
    return vendor;
  }

  async getVendorById(id: string): Promise<Vendor | undefined> {
    const [vendor] = await this.db
      .select()
      .from(schema.vendors)
      .where(eq(schema.vendors.id, id));
    return vendor;
  }

  // ============================================================================
  // BLUEPRINTS - Template Packages
  // ============================================================================

  async createTemplatePackage(template: InsertTemplatePackage): Promise<TemplatePackage> {
    const [newTemplate] = await this.db.insert(schema.templatePackages).values(template).returning();
    return newTemplate;
  }

  async getTemplatePackages(): Promise<TemplatePackage[]> {
    return await this.db.select().from(schema.templatePackages);
  }

  async getTemplatePackagesByVendor(vendorId: string): Promise<TemplatePackage[]> {
    return await this.db
      .select()
      .from(schema.templatePackages)
      .where(eq(schema.templatePackages.vendorId, vendorId));
  }

  // ============================================================================
  // BLUEPRINTS - Generated Code
  // ============================================================================

  async createGeneratedCode(code: InsertGeneratedCode): Promise<GeneratedCode> {
    const [newCode] = await this.db.insert(schema.generatedCode).values(code).returning();
    return newCode;
  }

  async getGeneratedCode(): Promise<GeneratedCode[]> {
    return await this.db
      .select()
      .from(schema.generatedCode)
      .orderBy(desc(schema.generatedCode.generatedAt));
  }

  async getGeneratedCodeBySource(sourceType: string, sourceId: string): Promise<GeneratedCode[]> {
    return await this.db
      .select()
      .from(schema.generatedCode)
      .where(and(
        eq(schema.generatedCode.sourceType, sourceType),
        eq(schema.generatedCode.sourceId, sourceId)
      ))
      .orderBy(desc(schema.generatedCode.generatedAt));
  }

  async updateGeneratedCodeTxHash(id: string, txHash: string): Promise<void> {
    await this.db
      .update(schema.generatedCode)
      .set({ txHash })
      .where(eq(schema.generatedCode.id, id));
  }

  // ============================================================================
  // BLUEPRINTS - Data Type Mappings
  // ============================================================================

  async createDataTypeMapping(mapping: InsertDataTypeMapping): Promise<DataTypeMapping> {
    const [newMapping] = await this.db.insert(schema.dataTypeMappings).values(mapping).returning();
    return newMapping;
  }

  async getDataTypeMappingsByVendor(vendorId: string): Promise<DataTypeMapping[]> {
    return await this.db
      .select()
      .from(schema.dataTypeMappings)
      .where(eq(schema.dataTypeMappings.vendorId, vendorId));
  }

  // ============================================================================
  // BLUEPRINTS - Controllers
  // ============================================================================

  async createController(controller: InsertController): Promise<Controller> {
    const [newController] = await this.db.insert(schema.controllers).values(controller).returning();
    return newController;
  }

  async getControllers(): Promise<Controller[]> {
    return await this.db.select().from(schema.controllers);
  }

  async getControllersByVendor(vendorId: string): Promise<Controller[]> {
    return await this.db
      .select()
      .from(schema.controllers)
      .where(eq(schema.controllers.vendorId, vendorId));
  }

  async getControllersBySite(siteId: string): Promise<Controller[]> {
    return await this.db
      .select()
      .from(schema.controllers)
      .where(eq(schema.controllers.siteId, siteId));
  }

  // ============================================================================
  // DIGITAL TWIN - Asset Administration Shell
  // ============================================================================

  async createAAS(aas: InsertAAS): Promise<AssetAdministrationShell> {
    const [newAAS] = await this.db.insert(schema.assetAdministrationShells).values(aas).returning();
    return newAAS;
  }

  async getAASList(): Promise<AssetAdministrationShell[]> {
    return await this.db
      .select()
      .from(schema.assetAdministrationShells)
      .orderBy(desc(schema.assetAdministrationShells.createdAt));
  }

  async getAASById(id: string): Promise<AssetAdministrationShell | undefined> {
    const [aas] = await this.db
      .select()
      .from(schema.assetAdministrationShells)
      .where(eq(schema.assetAdministrationShells.id, id));
    return aas;
  }

  async getAASByGlobalId(globalId: string): Promise<AssetAdministrationShell | undefined> {
    const [aas] = await this.db
      .select()
      .from(schema.assetAdministrationShells)
      .where(eq(schema.assetAdministrationShells.globalId, globalId));
    return aas;
  }

  async getAASBySiteId(siteId: string): Promise<AssetAdministrationShell[]> {
    return await this.db
      .select()
      .from(schema.assetAdministrationShells)
      .where(eq(schema.assetAdministrationShells.siteId, siteId));
  }

  async getAASByAssetId(assetId: string): Promise<AssetAdministrationShell | undefined> {
    const [aas] = await this.db
      .select()
      .from(schema.assetAdministrationShells)
      .where(eq(schema.assetAdministrationShells.assetId, assetId));
    return aas;
  }

  async updateAAS(id: string, data: Partial<InsertAAS>): Promise<AssetAdministrationShell> {
    const [updated] = await this.db
      .update(schema.assetAdministrationShells)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.assetAdministrationShells.id, id))
      .returning();
    return updated;
  }

  async deleteAAS(id: string): Promise<void> {
    await this.db
      .delete(schema.assetAdministrationShells)
      .where(eq(schema.assetAdministrationShells.id, id));
  }

  // ============================================================================
  // DIGITAL TWIN - AAS Submodels
  // ============================================================================

  async createSubmodel(submodel: InsertAASSubmodel): Promise<AASSubmodel> {
    const [newSubmodel] = await this.db.insert(schema.aasSubmodels).values(submodel).returning();
    return newSubmodel;
  }

  async getSubmodelsByAASId(aasId: string): Promise<AASSubmodel[]> {
    return await this.db
      .select()
      .from(schema.aasSubmodels)
      .where(eq(schema.aasSubmodels.aasId, aasId));
  }

  async getSubmodelById(id: string): Promise<AASSubmodel | undefined> {
    const [submodel] = await this.db
      .select()
      .from(schema.aasSubmodels)
      .where(eq(schema.aasSubmodels.id, id));
    return submodel;
  }

  async getSubmodelByGlobalId(globalId: string): Promise<AASSubmodel | undefined> {
    const [submodel] = await this.db
      .select()
      .from(schema.aasSubmodels)
      .where(eq(schema.aasSubmodels.globalId, globalId));
    return submodel;
  }

  async updateSubmodel(id: string, data: Partial<InsertAASSubmodel>): Promise<AASSubmodel> {
    const [updated] = await this.db
      .update(schema.aasSubmodels)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.aasSubmodels.id, id))
      .returning();
    return updated;
  }

  async deleteSubmodel(id: string): Promise<void> {
    await this.db
      .delete(schema.aasSubmodels)
      .where(eq(schema.aasSubmodels.id, id));
  }

  // ============================================================================
  // DIGITAL TWIN - AAS Submodel Elements
  // ============================================================================

  async createSubmodelElement(element: InsertAASSubmodelElement): Promise<AASSubmodelElement> {
    const [newElement] = await this.db.insert(schema.aasSubmodelElements).values(element).returning();
    return newElement;
  }

  async getSubmodelElements(submodelId: string): Promise<AASSubmodelElement[]> {
    return await this.db
      .select()
      .from(schema.aasSubmodelElements)
      .where(eq(schema.aasSubmodelElements.submodelId, submodelId))
      .orderBy(schema.aasSubmodelElements.orderIndex);
  }

  async getSubmodelElementById(id: string): Promise<AASSubmodelElement | undefined> {
    const [element] = await this.db
      .select()
      .from(schema.aasSubmodelElements)
      .where(eq(schema.aasSubmodelElements.id, id));
    return element;
  }

  async updateSubmodelElement(id: string, data: Partial<InsertAASSubmodelElement>): Promise<AASSubmodelElement> {
    const [updated] = await this.db
      .update(schema.aasSubmodelElements)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.aasSubmodelElements.id, id))
      .returning();
    return updated;
  }

  async deleteSubmodelElement(id: string): Promise<void> {
    await this.db
      .delete(schema.aasSubmodelElements)
      .where(eq(schema.aasSubmodelElements.id, id));
  }

  // ============================================================================
  // DIGITAL TWIN - AAS Submodel Templates
  // ============================================================================

  async createSubmodelTemplate(template: InsertAASSubmodelTemplate): Promise<AASSubmodelTemplate> {
    const [newTemplate] = await this.db.insert(schema.aasSubmodelTemplates).values(template).returning();
    return newTemplate;
  }

  async getSubmodelTemplates(): Promise<AASSubmodelTemplate[]> {
    return await this.db
      .select()
      .from(schema.aasSubmodelTemplates)
      .where(eq(schema.aasSubmodelTemplates.isActive, true));
  }

  async getSubmodelTemplateByName(name: string): Promise<AASSubmodelTemplate | undefined> {
    const [template] = await this.db
      .select()
      .from(schema.aasSubmodelTemplates)
      .where(eq(schema.aasSubmodelTemplates.name, name));
    return template;
  }

  async getSubmodelTemplatesByType(submodelType: string): Promise<AASSubmodelTemplate[]> {
    return await this.db
      .select()
      .from(schema.aasSubmodelTemplates)
      .where(and(
        eq(schema.aasSubmodelTemplates.submodelType, submodelType),
        eq(schema.aasSubmodelTemplates.isActive, true)
      ));
  }
}

export const storage = new DatabaseStorage();
