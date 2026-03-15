/**
 * Phi Alerting Service (#333)
 * 
 * Monitors process integration (Φ) and generates alarm events
 * when Φ drops below configurable thresholds.
 */

import { log, logWarn } from "../../logger";
import type { FluxPublisher } from "../flux/flux-publisher";
import type { PhiReport } from "./phi";

export interface PhiAlarm {
  id: string;
  type: "phi_low" | "phi_critical";
  phi: number;
  threshold: number;
  level: PhiReport["level"];
  disconnectedClasses: string[];
  timestamp: number;
  resolved: boolean;
}

export class PhiAlertingService {
  private checkTimer: NodeJS.Timeout | null = null;
  private activeAlarms: Map<string, PhiAlarm> = new Map();
  private alarmHistory: PhiAlarm[] = [];
  private listeners: ((alarm: PhiAlarm) => void)[] = [];

  /** Thresholds from env vars */
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;
  private readonly checkIntervalMs: number;

  constructor(private fluxPublisher: FluxPublisher) {
    this.warningThreshold = parseFloat(process.env.PHI_WARNING_THRESHOLD || "0.4");
    this.criticalThreshold = parseFloat(process.env.PHI_CRITICAL_THRESHOLD || "0.2");
    this.checkIntervalMs = parseInt(process.env.PHI_CHECK_INTERVAL_MS || "30000", 10);
  }

  /** Register a listener for new alarms */
  onAlarm(listener: (alarm: PhiAlarm) => void): void {
    this.listeners.push(listener);
  }

  /** Start periodic Phi monitoring */
  start(): void {
    log(`Φ alerting started (warn: ${this.warningThreshold}, critical: ${this.criticalThreshold}, interval: ${this.checkIntervalMs}ms)`, "phi-alert");
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop monitoring */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** Manual check */
  check(): PhiAlarm | null {
    const report = this.fluxPublisher.computePhi();

    // Find disconnected classes (quadrants with 0 cross-partition links)
    const disconnected: string[] = [];
    const { partitions } = report;
    if (partitions.quadrant.crossRatio === 0 && partitions.quadrant.classes > 1) {
      disconnected.push("quadrant-partitions isolated");
    }
    if (partitions.triality.crossRatio === 0 && partitions.triality.classes > 1) {
      disconnected.push("triality-partitions isolated");
    }
    if (report.fanoLinkCount === 0 && report.entityCount > 1) {
      disconnected.push("no Fano-geometric links");
    }

    // Check critical threshold
    if (report.phi < this.criticalThreshold && report.entityCount > 0) {
      return this.raiseAlarm("phi_critical", report, disconnected);
    }

    // Check warning threshold
    if (report.phi < this.warningThreshold && report.entityCount > 0) {
      return this.raiseAlarm("phi_low", report, disconnected);
    }

    // Resolve active alarms if phi recovered
    for (const [id, alarm] of this.activeAlarms) {
      if (!alarm.resolved && report.phi >= this.warningThreshold) {
        alarm.resolved = true;
        log(`Φ alarm resolved: ${id} (phi=${report.phi.toFixed(3)})`, "phi-alert");
      }
    }

    return null;
  }

  /** Get active (unresolved) alarms */
  getActiveAlarms(): PhiAlarm[] {
    return Array.from(this.activeAlarms.values()).filter((a) => !a.resolved);
  }

  /** Get alarm history */
  getHistory(): PhiAlarm[] {
    return this.alarmHistory;
  }

  /** Get current thresholds */
  getThresholds(): { warning: number; critical: number; checkIntervalMs: number } {
    return {
      warning: this.warningThreshold,
      critical: this.criticalThreshold,
      checkIntervalMs: this.checkIntervalMs,
    };
  }

  private raiseAlarm(type: PhiAlarm["type"], report: PhiReport, disconnected: string[]): PhiAlarm {
    const threshold = type === "phi_critical" ? this.criticalThreshold : this.warningThreshold;
    const id = `phi-${type}-${Date.now()}`;

    const alarm: PhiAlarm = {
      id,
      type,
      phi: report.phi,
      threshold,
      level: report.level,
      disconnectedClasses: disconnected,
      timestamp: Date.now(),
      resolved: false,
    };

    this.activeAlarms.set(id, alarm);
    this.alarmHistory.push(alarm);

    // Keep history bounded
    if (this.alarmHistory.length > 1000) {
      this.alarmHistory = this.alarmHistory.slice(-500);
    }

    logWarn(`Φ ${type} alarm: phi=${report.phi.toFixed(3)} < ${threshold} [${disconnected.join(", ")}]`, "phi-alert");

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(alarm); } catch {}
    }

    return alarm;
  }
}
