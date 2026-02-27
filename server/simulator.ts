import { storage } from "./storage";
import type { InsertSite, InsertAsset, InsertEventAnchor } from "@shared/schema";
import { log, logError, logWarn } from "./logger";
import { tagStreamServer } from "./websocket/tag-stream";
import { getFluxPublisher } from "./services/flux";

interface SimulatorConfig {
  enabled: boolean;
  eventIntervalMs: number;
}

class FieldSimulator {
  private config: SimulatorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private siteIds: string[] = [];
  private assetIds: string[] = [];
  private isInitialized = false;

  constructor() {
    this.config = {
      enabled: process.env.SIMULATOR_ENABLED !== "false",
      eventIntervalMs: parseInt(process.env.SIMULATOR_INTERVAL_MS || "10000"),
    };
  }

  async initialize() {
    if (!this.config.enabled) {
      log("⚠️  Field simulator disabled", "simulator");
      return;
    }

    log("🏭 Initializing field simulator...", "simulator");

    try {
      await this.seedData();
      this.isInitialized = true;
      log(`✅ Field simulator ready (${this.assetIds.length} assets monitored)`, "simulator");
      log(`   Event generation interval: ${this.config.eventIntervalMs}ms`, "simulator");
    } catch (error) {
      logError("❌ Failed to initialize simulator", error, "simulator");
    }
  }

  private async seedData() {
    const existingSites = await storage.getSites();
    
    if (existingSites.length === 0) {
      log("dY?- Seeding initial SCADA infrastructure...", "simulator");

      const sites: InsertSite[] = [
        { name: "Substation Alpha", location: "Sector 7G", owner: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", status: "ONLINE" },
        { name: "Solar Array B", location: "Mojave Sector", owner: "0x3D2c6C6f52b92B2E5f9f4C5d6B8F1E9D2A3B4C5D", status: "ONLINE" },
        { name: "Hydro Plant C", location: "River Valley", owner: "0x9F1E8D7C6B5A4F3E2D1C0B9A8F7E6D5C4B3A2E1F", status: "MAINTENANCE" },
      ];

      for (const siteData of sites) {
        const site = await storage.createSite(siteData);
        this.siteIds.push(site.id);
      }

      const assets: InsertAsset[] = [
        { 
          siteId: this.siteIds[0], 
          assetType: "TRANSFORMER", 
          nameOrTag: "TR-MAIN-01", 
          critical: true, 
          metadata: { kVA: 2500, voltage: "13.8kV/480V" },
          status: "OK"
        },
        { 
          siteId: this.siteIds[0], 
          assetType: "BREAKER", 
          nameOrTag: "BK-FEEDER-01", 
          critical: true, 
          metadata: { amp: 1200, type: "Vacuum" },
          status: "OK"
        },
        { 
          siteId: this.siteIds[1], 
          assetType: "INVERTER", 
          nameOrTag: "INV-01", 
          critical: false, 
          metadata: { capacity: "500kW" },
          status: "WARNING"
        },
        { 
          siteId: this.siteIds[2], 
          assetType: "MCC", 
          nameOrTag: "MCC-PUMP-01", 
          critical: true, 
          metadata: { buckets: 12 },
          status: "OK"
        },
      ];

      for (const assetData of assets) {
        const asset = await storage.createAsset(assetData);
        this.assetIds.push(asset.id);
      }

      log(`   Created ${sites.length} sites and ${assets.length} assets`, "simulator");
    } else {
      this.siteIds = existingSites.map(s => s.id);
      const existingAssets = await storage.getAssets();
      this.assetIds = existingAssets.map(a => a.id);
      log(`   Loaded ${this.siteIds.length} existing sites and ${this.assetIds.length} assets`, "simulator");
    }
  }

  start() {
    if (!this.config.enabled || !this.isInitialized) {
      return;
    }

    if (this.intervalId) {
      logWarn("Simulator already running", "simulator");
      return;
    }

    this.intervalId = setInterval(() => {
      this.generateEvent();
    }, this.config.eventIntervalMs);

    log("dY?- Field simulator started", "simulator");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log("⏸️  Field simulator stopped", "simulator");
    }
  }

  private async generateEvent() {
    if (this.assetIds.length === 0) {
      return;
    }

    const assetId = this.assetIds[Math.floor(Math.random() * this.assetIds.length)];
    const asset = await storage.getAssetById(assetId);
    
    if (!asset) {
      return;
    }

    const eventTypes = this.getEventTypesForAsset(asset.assetType);
    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    
    const payload = this.generatePayload(asset, eventType);
    const details = this.generateDetails(asset, eventType, payload);

    const eventData: Omit<InsertEventAnchor, 'id'> = {
      assetId: asset.id,
      eventType,
      payloadHash: "",
      timestamp: new Date(),
      recordedBy: "0xSimulator_Field",
      txHash: null,
      details,
      fullPayload: payload,
    };

    try {
      const port = process.env.PORT || "5000";
      const response = await fetch(`http://localhost:${port}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: eventData.assetId,
          eventType: eventData.eventType,
          recordedBy: eventData.recordedBy,
          details: eventData.details,
          payload: eventData.fullPayload,
        }),
      });

      if (response.ok) {
        log(`📡 [${asset.nameOrTag}] ${eventType} → Anchored`, "simulator");
        
        // Publish to Flux world state (ADR-0015)
        getFluxPublisher().publishAsset(asset.nameOrTag.toLowerCase(), {
          asset_type: asset.assetType,
          name: asset.nameOrTag,
          status: asset.status,
          critical: asset.critical,
          last_event_type: eventType,
          last_event_details: details,
          site_id: asset.siteId,
          ...(typeof payload === 'object' ? payload : { value: payload }),
        });

        // Broadcast tag update to live dashboard via WebSocket
        tagStreamServer.broadcastTagUpdate({
          tagName: `${asset.nameOrTag}.${eventType}`,
          value: typeof payload === 'object' && payload !== null
            ? (payload as any).value ?? JSON.stringify(payload)
            : payload,
          quality: "good",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logError("❌ Failed to submit event", error, "simulator");
    }
  }

  private getEventTypesForAsset(assetType: string): string[] {
    switch (assetType) {
      case "BREAKER":
        return ["BREAKER_TRIP", "BREAKER_CLOSE"];
      case "TRANSFORMER":
      case "INVERTER":
        return ["SETPOINT_CHANGE", "MAINTENANCE_PERFORMED"];
      case "MCC":
        return ["SETPOINT_CHANGE"];
      case "FEEDER":
        return ["BREAKER_TRIP", "BREAKER_CLOSE"];
      default:
        return ["SETPOINT_CHANGE"];
    }
  }

  private generatePayload(asset: any, eventType: string): any {
    const base = {
      assetId: asset.id,
      assetTag: asset.nameOrTag,
      timestamp: new Date().toISOString(),
      eventType,
    };

    switch (eventType) {
      case "BREAKER_TRIP":
        return {
          ...base,
          tripReason: this.randomChoice(["Overcurrent", "Ground Fault", "Manual Trip", "System Fault"]),
          current: Math.floor(Math.random() * 2000) + 800,
          phase: this.randomChoice(["A", "B", "C", "ABC"]),
        };
      case "BREAKER_CLOSE":
        return {
          ...base,
          operationType: this.randomChoice(["Manual", "Automatic", "Remote"]),
          preCloseChecks: true,
        };
      case "SETPOINT_CHANGE":
        return {
          ...base,
          parameter: this.randomChoice(["Max Power", "Target Voltage", "Frequency Setpoint"]),
          oldValue: Math.floor(Math.random() * 100),
          newValue: Math.floor(Math.random() * 100),
          changedBy: "Operator_" + Math.floor(Math.random() * 10),
        };
      case "MAINTENANCE_PERFORMED":
        return {
          ...base,
          maintenanceType: this.randomChoice(["IR Scan", "Visual Inspection", "Oil Analysis"]),
          findings: this.randomChoice(["Normal", "Minor hotspot detected", "No issues"]),
        };
      default:
        return base;
    }
  }

  private generateDetails(asset: any, eventType: string, payload: any): string {
    switch (eventType) {
      case "BREAKER_TRIP":
        return `${payload.tripReason} (Phase ${payload.phase}) > ${payload.current}A`;
      case "BREAKER_CLOSE":
        return `${payload.operationType} Close Operation`;
      case "SETPOINT_CHANGE":
        return `${payload.parameter}: ${payload.oldValue} → ${payload.newValue}`;
      case "MAINTENANCE_PERFORMED":
        return `${payload.maintenanceType} - ${payload.findings}`;
      default:
        return `Event recorded for ${asset.nameOrTag}`;
    }
  }

  private randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }
}

export const fieldSimulator = new FieldSimulator();

