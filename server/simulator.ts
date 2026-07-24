import { log, logError, logWarn } from "./logger";
import { tagStreamServer } from "./websocket/tag-stream";
import { cachedEventBridge } from "./websocket/cached-event-bridge";
import { getFluxPublisher } from "./services/flux";
import { natsPublisher } from "./services/nats";
import { getAnchorPipeline } from "./bridge";

interface SimulatorConfig {
  enabled: boolean;
  eventIntervalMs: number;
}

interface SimAsset {
  id: string;
  siteId: string;
  siteName: string;
  assetType: string;
  nameOrTag: string;
  critical: boolean;
  status: string;
  metadata: Record<string, any>;
}

class FieldSimulator {
  private config: SimulatorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private assets: SimAsset[] = [];
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

    // In-memory demo assets — no database required
    this.assets = [
      { id: "asset-1", siteId: "site-1", siteName: "Substation Alpha", assetType: "TRANSFORMER", nameOrTag: "TR-MAIN-01", critical: true, status: "OK", metadata: { kVA: 2500, voltage: "13.8kV/480V" } },
      { id: "asset-2", siteId: "site-1", siteName: "Substation Alpha", assetType: "BREAKER", nameOrTag: "BK-FEEDER-01", critical: true, status: "OK", metadata: { amp: 1200, type: "Vacuum" } },
      { id: "asset-3", siteId: "site-2", siteName: "Solar Array B", assetType: "INVERTER", nameOrTag: "INV-01", critical: false, status: "WARNING", metadata: { capacity: "500kW" } },
      { id: "asset-4", siteId: "site-3", siteName: "Hydro Plant C", assetType: "MCC", nameOrTag: "MCC-PUMP-01", critical: true, status: "OK", metadata: { buckets: 12 } },
      { id: "asset-5", siteId: "site-1", siteName: "Substation Alpha", assetType: "BREAKER", nameOrTag: "BK-FEEDER-02", critical: true, status: "OK", metadata: { amp: 800, type: "SF6" } },
      { id: "asset-6", siteId: "site-2", siteName: "Solar Array B", assetType: "INVERTER", nameOrTag: "INV-02", critical: false, status: "OK", metadata: { capacity: "500kW" } },
    ];

    this.isInitialized = true;
    log(`✅ Field simulator ready (${this.assets.length} assets monitored)`, "simulator");
    log(`   Event generation interval: ${this.config.eventIntervalMs}ms`, "simulator");
  }

  start() {
    if (!this.config.enabled || !this.isInitialized) return;
    if (this.intervalId) {
      logWarn("Simulator already running", "simulator");
      return;
    }

    this.intervalId = setInterval(() => {
      this.generateEvent();
    }, this.config.eventIntervalMs);

    log("🏭 Field simulator started — publishing to Flux", "simulator");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log("⏸️  Field simulator stopped", "simulator");
    }
  }

  private async generateEvent() {
    if (this.assets.length === 0) return;

    const asset = this.assets[Math.floor(Math.random() * this.assets.length)];
    const eventTypes = this.getEventTypesForAsset(asset.assetType);
    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
    const payload = this.generatePayload(asset, eventType);
    const details = this.generateDetails(asset, eventType, payload);

    try {
      log(`📡 [${asset.nameOrTag}] ${eventType} → ${details}`, "simulator");

      // Publish to Flux world state
      getFluxPublisher().publishAsset(asset.nameOrTag.toLowerCase(), {
        asset_type: asset.assetType,
        name: asset.nameOrTag,
        status: asset.status,
        critical: asset.critical,
        site: asset.siteName,
        site_id: asset.siteId,
        last_event_type: eventType,
        last_event_details: details,
        last_event_time: new Date().toISOString(),
        ...(typeof payload === 'object' ? payload : { value: payload }),
      });

      // Broadcast tag update to live dashboard via WebSocket. Prefer any
      // numeric measurement in the payload (current, newValue, ...) so
      // numeric consumers like predictive maintenance receive real data
      // instead of a JSON blob string (#212).
      try {
        const numeric =
          typeof payload === 'object' && payload !== null
            ? [payload.value, payload.current, payload.newValue].find(
                (v: unknown) => typeof v === 'number' && Number.isFinite(v)
              )
            : undefined;
        tagStreamServer.broadcastTagUpdate({
          tagName: `${asset.nameOrTag}.${eventType}`,
          value:
            numeric ??
            (typeof payload === 'object' && payload !== null
              ? JSON.stringify(payload)
              : payload),
          quality: "good",
          timestamp: new Date().toISOString(),
        });
      } catch { /* WebSocket not connected — that's fine */ }

      // Raise a real alarm for trip events — feeds the correlation engine
      // and the alarm WebSocket channel, which had no producer (#213)
      if (eventType === "BREAKER_TRIP") {
        try {
          void cachedEventBridge.publishAlarm({
            id: `ALM-${asset.nameOrTag}-${Date.now()}`,
            name: `${asset.nameOrTag} ${eventType}`,
            tagId: `${asset.nameOrTag}.${eventType}`,
            equipmentId: asset.nameOrTag,
            siteId: asset.siteId,
            severity: asset.critical ? "critical" : "high",
            state: "active",
            message: details,
            timestamp: new Date().toISOString(),
            triggeredAt: new Date().toISOString(),
            value: (payload as any).current,
            source: "simulator",
          });
        } catch { /* alarm fan-out failure must not break event generation */ }
      }

      // Publish to NATS for blockchain anchoring (canonical wire schema, #440)
      try {
        natsPublisher.publishScadaEvent({
          asset: asset.nameOrTag,
          event_type: eventType,
          site_id: asset.siteId,
          site_name: asset.siteName,
          asset_type: asset.assetType,
          timestamp: new Date().toISOString(),
          payload: payload,
          details: details,
        });
      } catch { /* NATS not connected — that's fine */ }

      // Feed the real L2 anchor chain (#489), when active. getAnchorPipeline()
      // is null unless ANCHOR_BACKEND=l2|both, so this is a no-op on the default
      // node path. The pipeline hashes → batches → merkle → signs → anchors.
      try {
        const anchor = getAnchorPipeline();
        if (anchor) {
          await anchor.ingestEvent({
            id: `${asset.id}-${eventType}-${Date.now()}`,
            timestamp: Date.now(),
            type: eventType,
            source: asset.nameOrTag,
            data: { siteId: asset.siteId, assetType: asset.assetType, details, ...(typeof payload === 'object' && payload ? payload : { value: payload }) },
          });
        }
      } catch { /* anchor pipeline not started — that's fine */ }
    } catch (error) {
      logError("❌ Failed to generate event", error as any);
    }
  }

  private getEventTypesForAsset(assetType: string): string[] {
    switch (assetType) {
      case "BREAKER": return ["BREAKER_TRIP", "BREAKER_CLOSE"];
      case "TRANSFORMER": case "INVERTER": return ["SETPOINT_CHANGE", "MAINTENANCE_PERFORMED"];
      case "MCC": return ["SETPOINT_CHANGE"];
      default: return ["SETPOINT_CHANGE"];
    }
  }

  private generatePayload(asset: SimAsset, eventType: string): any {
    const base = { assetId: asset.id, assetTag: asset.nameOrTag, timestamp: new Date().toISOString(), eventType };

    switch (eventType) {
      case "BREAKER_TRIP":
        return { ...base, tripReason: this.pick(["Overcurrent", "Ground Fault", "Manual Trip", "System Fault"]), current: Math.floor(Math.random() * 2000) + 800, phase: this.pick(["A", "B", "C", "ABC"]) };
      case "BREAKER_CLOSE":
        return { ...base, operationType: this.pick(["Manual", "Automatic", "Remote"]), preCloseChecks: true };
      case "SETPOINT_CHANGE":
        return { ...base, parameter: this.pick(["Max Power", "Target Voltage", "Frequency Setpoint"]), oldValue: Math.floor(Math.random() * 100), newValue: Math.floor(Math.random() * 100), changedBy: "Operator_" + Math.floor(Math.random() * 10) };
      case "MAINTENANCE_PERFORMED":
        return { ...base, maintenanceType: this.pick(["IR Scan", "Visual Inspection", "Oil Analysis"]), findings: this.pick(["Normal", "Minor hotspot detected", "No issues"]) };
      default:
        return base;
    }
  }

  private generateDetails(asset: SimAsset, eventType: string, payload: any): string {
    switch (eventType) {
      case "BREAKER_TRIP": return `${payload.tripReason} (Phase ${payload.phase}) > ${payload.current}A`;
      case "BREAKER_CLOSE": return `${payload.operationType} Close Operation`;
      case "SETPOINT_CHANGE": return `${payload.parameter}: ${payload.oldValue} → ${payload.newValue}`;
      case "MAINTENANCE_PERFORMED": return `${payload.maintenanceType} - ${payload.findings}`;
      default: return `Event recorded for ${asset.nameOrTag}`;
    }
  }

  private pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
}

export const fieldSimulator = new FieldSimulator();
