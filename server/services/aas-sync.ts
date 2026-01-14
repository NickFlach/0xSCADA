import { storage } from "../storage";
import type { 
  AssetAdministrationShell, 
  InsertAAS, 
  InsertAASSubmodel,
  InsertAASSubmodelElement,
  Site, 
  Asset,
  ControlModuleInstance,
  UnitInstance 
} from "@shared/schema";
import crypto from "crypto";

const BASE_IRI = "https://0xscada.io/aas";

function generateGlobalId(type: string, id: string): string {
  return `${BASE_IRI}/${type}/${id}`;
}

function generateIdShort(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").substring(0, 128);
}

function computeContentHash(data: object): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export class AASSyncService {
  
  async syncSiteToAAS(site: Site): Promise<AssetAdministrationShell> {
    const globalId = generateGlobalId("site", site.id);
    const existing = await storage.getAASByGlobalId(globalId);
    const contentHash = computeContentHash(site);
    
    const aasData: InsertAAS = {
      idShort: generateIdShort(site.name),
      globalId,
      globalAssetId: `urn:0xscada:site:${site.id}`,
      assetKind: "Instance",
      assetType: "Site",
      displayName: site.name,
      description: `Digital twin for site: ${site.name} at ${site.location}`,
      siteId: site.id,
      version: "1.0.0",
      contentHash,
    };
    
    if (existing) {
      return storage.updateAAS(existing.id, aasData);
    }
    
    const aas = await storage.createAAS(aasData);
    await this.createStandardSubmodels(aas.id, "Site", site);
    return aas;
  }
  
  async syncAssetToAAS(asset: Asset): Promise<AssetAdministrationShell> {
    const globalId = generateGlobalId("asset", asset.id);
    const existing = await storage.getAASByGlobalId(globalId);
    const contentHash = computeContentHash(asset);
    
    const aasData: InsertAAS = {
      idShort: generateIdShort(asset.nameOrTag),
      globalId,
      globalAssetId: `urn:0xscada:asset:${asset.id}`,
      assetKind: "Instance",
      assetType: asset.assetType,
      displayName: asset.nameOrTag,
      description: `Digital twin for ${asset.assetType}: ${asset.nameOrTag}`,
      siteId: asset.siteId,
      assetId: asset.id,
      version: "1.0.0",
      contentHash,
    };
    
    if (existing) {
      return storage.updateAAS(existing.id, aasData);
    }
    
    const aas = await storage.createAAS(aasData);
    await this.createStandardSubmodels(aas.id, asset.assetType, asset);
    return aas;
  }
  
  async syncControlModuleToAAS(cm: ControlModuleInstance): Promise<AssetAdministrationShell> {
    const globalId = generateGlobalId("control-module", cm.id);
    const existing = await storage.getAASByGlobalId(globalId);
    const contentHash = computeContentHash(cm);
    
    const aasData: InsertAAS = {
      idShort: generateIdShort(cm.name),
      globalId,
      globalAssetId: `urn:0xscada:cm:${cm.id}`,
      assetKind: "Instance",
      assetType: "ControlModule",
      displayName: cm.name,
      description: `Digital twin for control module: ${cm.name}`,
      siteId: cm.siteId || undefined,
      assetId: cm.assetId || undefined,
      controlModuleInstanceId: cm.id,
      version: "1.0.0",
      contentHash,
    };
    
    if (existing) {
      return storage.updateAAS(existing.id, aasData);
    }
    
    const aas = await storage.createAAS(aasData);
    await this.createStandardSubmodels(aas.id, "ControlModule", cm);
    return aas;
  }
  
  async syncUnitToAAS(unit: UnitInstance): Promise<AssetAdministrationShell> {
    const globalId = generateGlobalId("unit", unit.id);
    const existing = await storage.getAASByGlobalId(globalId);
    const contentHash = computeContentHash(unit);
    
    const aasData: InsertAAS = {
      idShort: generateIdShort(unit.name),
      globalId,
      globalAssetId: `urn:0xscada:unit:${unit.id}`,
      assetKind: "Instance",
      assetType: "Unit",
      displayName: unit.name,
      description: `Digital twin for unit: ${unit.name}`,
      siteId: unit.siteId || undefined,
      unitInstanceId: unit.id,
      version: "1.0.0",
      contentHash,
    };
    
    if (existing) {
      return storage.updateAAS(existing.id, aasData);
    }
    
    const aas = await storage.createAAS(aasData);
    await this.createStandardSubmodels(aas.id, "Unit", unit);
    return aas;
  }
  
  async createStandardSubmodels(aasId: string, entityType: string, entity: any): Promise<void> {
    await this.createNameplateSubmodel(aasId, entity);
    await this.createTechnicalDataSubmodel(aasId, entity);
    await this.createBlockchainAnchorSubmodel(aasId, entity);
    
    if (entityType === "ControlModule" || entityType === "Unit") {
      await this.createOperationalDataSubmodel(aasId, entity);
      await this.createSimulationModelSubmodel(aasId, entity);
    }
  }
  
  private async createNameplateSubmodel(aasId: string, entity: any): Promise<void> {
    const submodel: InsertAASSubmodel = {
      aasId,
      idShort: "Nameplate",
      globalId: `${generateGlobalId("submodel", aasId)}/Nameplate`,
      submodelType: "Nameplate",
      semanticIdType: "GlobalReference",
      semanticIdValue: "https://admin-shell.io/zvei/nameplate/2/0/Nameplate",
      displayName: "Nameplate",
      description: "IEC 61406 identification data",
      kind: "Instance",
    };
    
    const created = await storage.createSubmodel(submodel);
    
    const elements: InsertAASSubmodelElement[] = [
      {
        submodelId: created.id,
        idShort: "ManufacturerName",
        elementType: "Property",
        valueType: "xs:string",
        value: "0xSCADA",
        displayName: "Manufacturer Name",
        orderIndex: 0,
      },
      {
        submodelId: created.id,
        idShort: "ProductDesignation",
        elementType: "Property",
        valueType: "xs:string",
        value: entity.name || entity.nameOrTag || "",
        displayName: "Product Designation",
        orderIndex: 1,
      },
      {
        submodelId: created.id,
        idShort: "SerialNumber",
        elementType: "Property",
        valueType: "xs:string",
        value: entity.id,
        displayName: "Serial Number",
        orderIndex: 2,
      },
    ];
    
    for (const el of elements) {
      await storage.createSubmodelElement(el);
    }
  }
  
  private async createTechnicalDataSubmodel(aasId: string, entity: any): Promise<void> {
    const submodel: InsertAASSubmodel = {
      aasId,
      idShort: "TechnicalData",
      globalId: `${generateGlobalId("submodel", aasId)}/TechnicalData`,
      submodelType: "TechnicalData",
      semanticIdType: "GlobalReference",
      semanticIdValue: "https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/2",
      displayName: "Technical Data",
      description: "Technical specifications and performance data",
      kind: "Instance",
    };
    
    const created = await storage.createSubmodel(submodel);
    
    const metadata = entity.metadata || {};
    const elements: InsertAASSubmodelElement[] = [
      {
        submodelId: created.id,
        idShort: "EntityType",
        elementType: "Property",
        valueType: "xs:string",
        value: entity.assetType || entity.processCell || "Unknown",
        displayName: "Entity Type",
        orderIndex: 0,
      },
      {
        submodelId: created.id,
        idShort: "Status",
        elementType: "Property",
        valueType: "xs:string",
        value: entity.status || "UNKNOWN",
        displayName: "Status",
        orderIndex: 1,
      },
    ];
    
    if (Object.keys(metadata).length > 0) {
      elements.push({
        submodelId: created.id,
        idShort: "Metadata",
        elementType: "Property",
        valueType: "xs:string",
        value: JSON.stringify(metadata),
        displayName: "Additional Metadata",
        orderIndex: 2,
      });
    }
    
    for (const el of elements) {
      await storage.createSubmodelElement(el);
    }
  }
  
  private async createOperationalDataSubmodel(aasId: string, entity: any): Promise<void> {
    const submodel: InsertAASSubmodel = {
      aasId,
      idShort: "OperationalData",
      globalId: `${generateGlobalId("submodel", aasId)}/OperationalData`,
      submodelType: "OperationalData",
      semanticIdType: "GlobalReference",
      semanticIdValue: "https://0xscada.io/submodel/OperationalData/1/0",
      displayName: "Operational Data",
      description: "Real-time telemetry and operational state",
      kind: "Instance",
    };
    
    const created = await storage.createSubmodel(submodel);
    
    const currentState = entity.currentState || {};
    const elements: InsertAASSubmodelElement[] = [
      {
        submodelId: created.id,
        idShort: "CurrentState",
        elementType: "Property",
        valueType: "xs:string",
        value: JSON.stringify(currentState),
        displayName: "Current State",
        dataBindingType: "websocket",
        dataBindingPath: `/api/aas/${aasId}/live`,
        dataBindingInterval: 1000,
        orderIndex: 0,
      },
    ];
    
    for (const el of elements) {
      await storage.createSubmodelElement(el);
    }
  }
  
  private async createSimulationModelSubmodel(aasId: string, entity: any): Promise<void> {
    const submodel: InsertAASSubmodel = {
      aasId,
      idShort: "SimulationModel",
      globalId: `${generateGlobalId("submodel", aasId)}/SimulationModel`,
      submodelType: "SimulationModel",
      semanticIdType: "GlobalReference",
      semanticIdValue: "https://0xscada.io/submodel/SimulationModel/1/0",
      displayName: "Simulation Model",
      description: "FMU reference for physics-based digital twin simulation",
      kind: "Instance",
    };
    
    const created = await storage.createSubmodel(submodel);
    
    const elements: InsertAASSubmodelElement[] = [
      {
        submodelId: created.id,
        idShort: "FMUReference",
        elementType: "ReferenceElement",
        displayName: "FMU Reference",
        description: "Reference to FMI 3.0 Functional Mock-up Unit",
        referenceType: "ModelReference",
        referenceKeys: [],
        orderIndex: 0,
      },
      {
        submodelId: created.id,
        idShort: "SimulationMode",
        elementType: "Property",
        valueType: "xs:string",
        value: "REAL-TIME",
        displayName: "Simulation Mode",
        description: "REAL-TIME, FAST-FORWARD, REPLAY, or WHAT-IF",
        orderIndex: 1,
      },
    ];
    
    for (const el of elements) {
      await storage.createSubmodelElement(el);
    }
  }
  
  private async createBlockchainAnchorSubmodel(aasId: string, entity: any): Promise<void> {
    const submodel: InsertAASSubmodel = {
      aasId,
      idShort: "BlockchainAnchor",
      globalId: `${generateGlobalId("submodel", aasId)}/BlockchainAnchor`,
      submodelType: "BlockchainAnchor",
      semanticIdType: "GlobalReference",
      semanticIdValue: "https://0xscada.io/submodel/BlockchainAnchor/1/0",
      displayName: "Blockchain Anchor",
      description: "0xSCADA on-chain proof references",
      kind: "Instance",
    };
    
    const created = await storage.createSubmodel(submodel);
    
    const contentHash = computeContentHash(entity);
    const elements: InsertAASSubmodelElement[] = [
      {
        submodelId: created.id,
        idShort: "ContentHash",
        elementType: "Property",
        valueType: "xs:string",
        value: contentHash,
        displayName: "Content Hash",
        description: "SHA-256 hash of entity data",
        orderIndex: 0,
      },
      {
        submodelId: created.id,
        idShort: "AnchorStatus",
        elementType: "Property",
        valueType: "xs:string",
        value: "PENDING",
        displayName: "Anchor Status",
        description: "PENDING, ANCHORED, or FAILED",
        orderIndex: 1,
      },
      {
        submodelId: created.id,
        idShort: "TransactionHash",
        elementType: "Property",
        valueType: "xs:string",
        value: "",
        displayName: "Transaction Hash",
        description: "Ethereum transaction hash",
        orderIndex: 2,
      },
    ];
    
    for (const el of elements) {
      await storage.createSubmodelElement(el);
    }
  }
  
  async syncAllSites(): Promise<AssetAdministrationShell[]> {
    const sites = await storage.getSites();
    const results: AssetAdministrationShell[] = [];
    
    for (const site of sites) {
      const aas = await this.syncSiteToAAS(site);
      results.push(aas);
    }
    
    return results;
  }
  
  async syncAllAssets(): Promise<AssetAdministrationShell[]> {
    const assets = await storage.getAssets();
    const results: AssetAdministrationShell[] = [];
    
    for (const asset of assets) {
      const aas = await this.syncAssetToAAS(asset);
      results.push(aas);
    }
    
    return results;
  }
  
  async syncAllControlModules(): Promise<AssetAdministrationShell[]> {
    const cms = await storage.getControlModuleInstances();
    const results: AssetAdministrationShell[] = [];
    
    for (const cm of cms) {
      const aas = await this.syncControlModuleToAAS(cm);
      results.push(aas);
    }
    
    return results;
  }
  
  async syncAllUnits(): Promise<AssetAdministrationShell[]> {
    const units = await storage.getUnitInstances();
    const results: AssetAdministrationShell[] = [];
    
    for (const unit of units) {
      const aas = await this.syncUnitToAAS(unit);
      results.push(aas);
    }
    
    return results;
  }
  
  async syncAll(): Promise<{ sites: number; assets: number; controlModules: number; units: number }> {
    const sites = await this.syncAllSites();
    const assets = await this.syncAllAssets();
    const controlModules = await this.syncAllControlModules();
    const units = await this.syncAllUnits();
    
    return {
      sites: sites.length,
      assets: assets.length,
      controlModules: controlModules.length,
      units: units.length,
    };
  }
}

export const aasSyncService = new AASSyncService();
