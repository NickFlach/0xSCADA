/**
 * 0xSCADA Ops Agent
 * 
 * PRD Section 6.4: Required Agent (P0)
 * - Summarizes plant state
 * - Shift handoff reports
 * - Anomaly explanations
 */

import { 
  BaseAgent, 
  AgentCapability, 
  AgentOutputType,
  type AgentConfig,
  type AgentScope,
  generateAgentKeys,
} from "./base";
import type { SignedEvent } from "../events";

// =============================================================================
// OPS AGENT CONFIGURATION
// =============================================================================

const OPS_AGENT_CAPABILITIES: AgentCapability[] = [
  AgentCapability.READ_EVENTS,
  AgentCapability.READ_TELEMETRY,
  AgentCapability.READ_ALARMS,
  AgentCapability.READ_ASSETS,
  AgentCapability.READ_SITES,
  AgentCapability.SUMMARIZE,
  AgentCapability.ANALYZE_ANOMALIES,
  AgentCapability.GENERATE_REPORTS,
];

// =============================================================================
// OPS AGENT STATE
// =============================================================================

interface ShiftSummary {
  shiftStart: Date;
  shiftEnd?: Date;
  eventCount: number;
  alarmCount: number;
  criticalAlarms: number;
  commandCount: number;
  anomalies: string[];
  highlights: string[];
}

interface SiteStatus {
  siteId: string;
  lastEventAt?: Date;
  activeAlarms: number;
  criticalAlarms: number;
  status: "NORMAL" | "WARNING" | "CRITICAL" | "UNKNOWN";
}

// =============================================================================
// OPS AGENT IMPLEMENTATION
// =============================================================================

export class OpsAgent extends BaseAgent {
  private currentShift: ShiftSummary | null = null;
  private siteStatuses: Map<string, SiteStatus> = new Map();
  private recentEvents: SignedEvent[] = [];
  private maxRecentEvents = 1000;

  constructor(config: Partial<AgentConfig> & { id: string; name: string }) {
    const keys = generateAgentKeys();
    
    super({
      id: config.id,
      name: config.name,
      displayName: config.displayName || "Ops Agent",
      agentType: "OPS",
      capabilities: OPS_AGENT_CAPABILITIES,
      scope: config.scope || {
        allSites: true,
        siteIds: [],
        allAssets: true,
        assetIds: [],
        assetTypes: [],
        allEventTypes: true,
        eventTypes: [],
      },
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  protected async onStart(): Promise<void> {
    // Initialize shift
    this.startNewShift();
    console.log(`   📊 Ops Agent ready - monitoring all sites`);
  }

  protected async onStop(): Promise<void> {
    // Generate final shift report
    if (this.currentShift) {
      this.currentShift.shiftEnd = new Date();
      await this.generateShiftReport();
    }
  }

  // ==========================================================================
  // EVENT HANDLING
  // ==========================================================================

  async handleEvent(event: SignedEvent): Promise<void> {
    // Store recent event
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.shift();
    }

    // Update shift stats
    if (this.currentShift) {
      this.currentShift.eventCount++;

      if (event.eventType === "ALARM") {
        this.currentShift.alarmCount++;
        const payload = event.payload as { severity?: string };
        if (payload.severity === "CRITICAL") {
          this.currentShift.criticalAlarms++;
        }
      }

      if (event.eventType === "COMMAND") {
        this.currentShift.commandCount++;
      }
    }

    // Update site status
    this.updateSiteStatus(event);

    // Check for anomalies
    await this.checkForAnomalies(event);
  }

  // ==========================================================================
  // SHIFT MANAGEMENT
  // ==========================================================================

  /**
   * Start a new shift
   */
  startNewShift(): void {
    if (this.currentShift && !this.currentShift.shiftEnd) {
      this.currentShift.shiftEnd = new Date();
    }

    this.currentShift = {
      shiftStart: new Date(),
      eventCount: 0,
      alarmCount: 0,
      criticalAlarms: 0,
      commandCount: 0,
      anomalies: [],
      highlights: [],
    };

    console.log(`   🔄 New shift started at ${this.currentShift.shiftStart.toISOString()}`);
  }

  /**
   * Generate shift handoff report
   */
  async generateShiftReport(): Promise<ReturnType<typeof this.createOutput>> {
    if (!this.currentShift) {
      throw new Error("No active shift");
    }

    const shift = this.currentShift;
    const duration = shift.shiftEnd 
      ? (shift.shiftEnd.getTime() - shift.shiftStart.getTime()) / 1000 / 60 / 60
      : (new Date().getTime() - shift.shiftStart.getTime()) / 1000 / 60 / 60;

    const siteStatusList = Array.from(this.siteStatuses.values());
    const criticalSites = siteStatusList.filter(s => s.status === "CRITICAL");
    const warningSites = siteStatusList.filter(s => s.status === "WARNING");

    const report = {
      shiftStart: shift.shiftStart.toISOString(),
      shiftEnd: shift.shiftEnd?.toISOString() || new Date().toISOString(),
      durationHours: Math.round(duration * 10) / 10,
      
      summary: {
        totalEvents: shift.eventCount,
        totalAlarms: shift.alarmCount,
        criticalAlarms: shift.criticalAlarms,
        totalCommands: shift.commandCount,
        anomaliesDetected: shift.anomalies.length,
      },

      siteStatus: {
        total: siteStatusList.length,
        critical: criticalSites.length,
        warning: warningSites.length,
        normal: siteStatusList.filter(s => s.status === "NORMAL").length,
      },

      criticalSites: criticalSites.map(s => s.siteId),
      warningSites: warningSites.map(s => s.siteId),

      anomalies: shift.anomalies,
      highlights: shift.highlights,

      recommendations: this.generateRecommendations(),
    };

    const output = this.createOutput({
      outputType: AgentOutputType.REPORT,
      title: `Shift Handoff Report - ${shift.shiftStart.toLocaleDateString()}`,
      content: report,
      confidence: 0.95,
      reasoning: "Automated shift summary based on event analysis",
    });

    console.log(`   📋 Shift report generated: ${shift.eventCount} events, ${shift.alarmCount} alarms`);

    return output;
  }

  // ==========================================================================
  // PLANT STATE SUMMARY
  // ==========================================================================

  /**
   * Generate current plant state summary
   */
  generatePlantSummary(): ReturnType<typeof this.createOutput> {
    const siteStatusList = Array.from(this.siteStatuses.values());
    
    const summary = {
      timestamp: new Date().toISOString(),
      
      overallStatus: this.calculateOverallStatus(siteStatusList),
      
      sites: siteStatusList.map(site => ({
        siteId: site.siteId,
        status: site.status,
        activeAlarms: site.activeAlarms,
        criticalAlarms: site.criticalAlarms,
        lastEventAt: site.lastEventAt?.toISOString(),
      })),

      recentActivity: {
        last5Minutes: this.countRecentEvents(5),
        last15Minutes: this.countRecentEvents(15),
        last60Minutes: this.countRecentEvents(60),
      },

      activeAlarms: this.getActiveAlarms(),
    };

    return this.createOutput({
      outputType: AgentOutputType.SUMMARY,
      title: "Plant State Summary",
      content: summary,
      confidence: 0.9,
      reasoning: "Real-time plant status based on event stream analysis",
    });
  }

  // ==========================================================================
  // ANOMALY DETECTION
  // ==========================================================================

  /**
   * Check for anomalies in an event
   */
  private async checkForAnomalies(event: SignedEvent): Promise<void> {
    // Simple anomaly detection - can be enhanced with ML
    
    // Check for rapid alarm rate
    const recentAlarms = this.recentEvents.filter(
      e => e.eventType === "ALARM" && 
           e.siteId === event.siteId &&
           new Date(e.sourceTimestamp).getTime() > Date.now() - 5 * 60 * 1000
    );

    if (recentAlarms.length > 10) {
      const anomaly = `High alarm rate detected at site ${event.siteId}: ${recentAlarms.length} alarms in 5 minutes`;
      if (this.currentShift && !this.currentShift.anomalies.includes(anomaly)) {
        this.currentShift.anomalies.push(anomaly);
        console.log(`   ⚠️ Anomaly detected: ${anomaly}`);
      }
    }

    // Check for critical alarm
    if (event.eventType === "ALARM") {
      const payload = event.payload as { severity?: string; message?: string };
      if (payload.severity === "CRITICAL") {
        const highlight = `Critical alarm at ${event.siteId}: ${payload.message || "Unknown"}`;
        if (this.currentShift) {
          this.currentShift.highlights.push(highlight);
        }
      }
    }
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  private updateSiteStatus(event: SignedEvent): void {
    let status = this.siteStatuses.get(event.siteId);
    
    if (!status) {
      status = {
        siteId: event.siteId,
        activeAlarms: 0,
        criticalAlarms: 0,
        status: "NORMAL",
      };
      this.siteStatuses.set(event.siteId, status);
    }

    status.lastEventAt = new Date(event.sourceTimestamp);

    if (event.eventType === "ALARM") {
      const payload = event.payload as { state?: string; severity?: string };
      
      if (payload.state === "ACTIVE") {
        status.activeAlarms++;
        if (payload.severity === "CRITICAL") {
          status.criticalAlarms++;
        }
      } else if (payload.state === "CLEARED" || payload.state === "ACKNOWLEDGED") {
        status.activeAlarms = Math.max(0, status.activeAlarms - 1);
        if (payload.severity === "CRITICAL") {
          status.criticalAlarms = Math.max(0, status.criticalAlarms - 1);
        }
      }
    }

    // Update overall site status
    if (status.criticalAlarms > 0) {
      status.status = "CRITICAL";
    } else if (status.activeAlarms > 5) {
      status.status = "WARNING";
    } else {
      status.status = "NORMAL";
    }
  }

  private calculateOverallStatus(sites: SiteStatus[]): string {
    if (sites.some(s => s.status === "CRITICAL")) {
      return "CRITICAL";
    }
    if (sites.some(s => s.status === "WARNING")) {
      return "WARNING";
    }
    if (sites.length === 0) {
      return "UNKNOWN";
    }
    return "NORMAL";
  }

  private countRecentEvents(minutes: number): number {
    const cutoff = Date.now() - minutes * 60 * 1000;
    return this.recentEvents.filter(
      e => new Date(e.sourceTimestamp).getTime() > cutoff
    ).length;
  }

  private getActiveAlarms(): Array<{ siteId: string; message: string; severity: string }> {
    return this.recentEvents
      .filter(e => {
        if (e.eventType !== "ALARM") return false;
        const payload = e.payload as { state?: string };
        return payload.state === "ACTIVE";
      })
      .slice(-20)
      .map(e => {
        const payload = e.payload as { message?: string; severity?: string };
        return {
          siteId: e.siteId,
          message: payload.message || "Unknown alarm",
          severity: payload.severity || "UNKNOWN",
        };
      });
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];

    if (this.currentShift) {
      if (this.currentShift.criticalAlarms > 0) {
        recommendations.push("Review and address all critical alarms before shift handoff");
      }

      if (this.currentShift.anomalies.length > 0) {
        recommendations.push("Investigate detected anomalies and document findings");
      }

      const criticalSites = Array.from(this.siteStatuses.values())
        .filter(s => s.status === "CRITICAL");
      
      if (criticalSites.length > 0) {
        recommendations.push(`Priority attention needed for sites: ${criticalSites.map(s => s.siteId).join(", ")}`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push("All systems operating normally - continue standard monitoring");
    }

    return recommendations;
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  getSiteStatus(siteId: string): SiteStatus | undefined {
    return this.siteStatuses.get(siteId);
  }

  getAllSiteStatuses(): SiteStatus[] {
    return Array.from(this.siteStatuses.values());
  }

  getCurrentShift(): ShiftSummary | null {
    return this.currentShift;
  }
}
