import { log, logError, logWarn } from "./logger";
import { tagStreamServer } from "./websocket/tag-stream";
import { cachedEventBridge } from "./websocket/cached-event-bridge";
import { getFluxPublisher } from "./services/flux";
import { natsPublisher } from "./services/nats";
import { getAnchorPipeline } from "./bridge";

interface SimulatorConfig {
  enabled: boolean;
  eventIntervalMs: number;
  analogIntervalMs: number;
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

/**
 * A continuous analog process channel (#5). The discrete event stream above
 * fires every ~10s and carries mostly categorical payloads; the analytics
 * services (predictive, twin, SPC) need a real numeric time series, so every
 * asset also emits 1–3 of these on a steady cadence.
 *
 * Signal shape is baseline + slow sinusoidal drift + bounded noise, clamped
 * into the physical band [min, max].
 */
export interface AnalogChannelSpec {
  /** Channel suffix — the tag is `${asset.nameOrTag}.${channel}` */
  channel: string;
  unit: string;
  /** Centre of the process band */
  baseline: number;
  /** Peak deviation of the slow drift */
  amplitude: number;
  /** Peak deviation of the per-sample noise */
  noise: number;
  /** Period of the slow drift, in ms */
  periodMs: number;
  /** Physical band — the sample is clamped into it */
  min: number;
  max: number;
}

/** Analog channels emitted per asset type. Unknown types emit nothing. */
export const ANALOG_CHANNELS: Readonly<Record<string, readonly AnalogChannelSpec[]>> = {
  TRANSFORMER: [
    { channel: "TEMPERATURE", unit: "degC", baseline: 65, amplitude: 8, noise: 1.5, periodMs: 900_000, min: 20, max: 110 },
    { channel: "LOAD_PERCENT", unit: "%", baseline: 72, amplitude: 15, noise: 2, periodMs: 600_000, min: 0, max: 100 },
  ],
  BREAKER: [
    { channel: "CURRENT", unit: "A", baseline: 620, amplitude: 90, noise: 12, periodMs: 480_000, min: 0, max: 1200 },
  ],
  INVERTER: [
    { channel: "DC_VOLTAGE", unit: "V", baseline: 720, amplitude: 40, noise: 6, periodMs: 720_000, min: 0, max: 1000 },
    { channel: "AC_POWER_KW", unit: "kW", baseline: 380, amplitude: 90, noise: 8, periodMs: 1_800_000, min: 0, max: 500 },
  ],
  MCC: [
    { channel: "MOTOR_CURRENT", unit: "A", baseline: 145, amplitude: 20, noise: 3, periodMs: 540_000, min: 0, max: 300 },
  ],
};

export function analogChannelsForAsset(assetType: string): readonly AnalogChannelSpec[] {
  return ANALOG_CHANNELS[assetType] ?? [];
}

/**
 * Deterministic per-tag seed (FNV-1a). Two assets sharing a channel spec still
 * get independent noise and drift phase, without any global mutable state.
 */
export function seedForTag(tagName: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tagName.length; i++) {
    h ^= tagName.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix a seed with a sample index so each sample draws an independent value. */
function mixSeed(seed: number, step: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ step ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — same generator the rest of the repo uses for seeded noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample one analog channel. Pure: the same (spec, elapsedMs, seed) always
 * yields the same finite number — no Math.random anywhere in the signal path,
 * so tests are deterministic.
 */
export function generateAnalogSample(spec: AnalogChannelSpec, elapsedMs: number, seed: number): number {
  const rng = mulberry32(mixSeed(seed, Math.round(elapsedMs)));
  // Per-tag phase offset so co-located assets don't drift in lockstep.
  const phase = (seed / 4294967296) * 2 * Math.PI;
  const drift = spec.amplitude * Math.sin((2 * Math.PI * elapsedMs) / spec.periodMs + phase);
  const noise = (rng() * 2 - 1) * spec.noise;
  return Math.min(spec.max, Math.max(spec.min, spec.baseline + drift + noise));
}

/** setInterval treats NaN/0 as "every tick" — fall back to the default. */
function positiveIntervalMs(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class FieldSimulator {
  private config: SimulatorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private analogIntervalId: NodeJS.Timeout | null = null;
  private analogTick = 0;
  private assets: SimAsset[] = [];
  private isInitialized = false;

  constructor() {
    this.config = {
      enabled: process.env.SIMULATOR_ENABLED !== "false",
      eventIntervalMs: parseInt(process.env.SIMULATOR_INTERVAL_MS || "10000"),
      analogIntervalMs: positiveIntervalMs(process.env.SIMULATOR_ANALOG_INTERVAL_MS, 2000),
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
    log(`   Analog sample interval: ${this.config.analogIntervalMs}ms`, "simulator");
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

    this.analogIntervalId = setInterval(() => {
      this.emitAnalogSamples();
    }, this.config.analogIntervalMs);

    log("🏭 Field simulator started — publishing to Flux", "simulator");
  }

  stop() {
    if (this.analogIntervalId) {
      clearInterval(this.analogIntervalId);
      this.analogIntervalId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log("⏸️  Field simulator stopped", "simulator");
    }
  }

  /**
   * Broadcast one sample of every analog channel (#5). Values are real finite
   * numbers — never a stringified payload — so predictive/twin/SPC get a
   * usable time series in dev. Elapsed time comes from the tick counter rather
   * than the wall clock, keeping the emitted series reproducible.
   */
  private emitAnalogSamples() {
    const elapsedMs = this.analogTick * this.config.analogIntervalMs;
    this.analogTick++;

    for (const asset of this.assets) {
      for (const spec of analogChannelsForAsset(asset.assetType)) {
        const tagName = `${asset.nameOrTag}.${spec.channel}`;
        const value = generateAnalogSample(spec, elapsedMs, seedForTag(tagName));
        try {
          tagStreamServer.broadcastTagUpdate({
            tagName,
            value,
            quality: "good",
            timestamp: new Date().toISOString(),
          });
        } catch { /* WebSocket not connected — that's fine */ }
      }
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
