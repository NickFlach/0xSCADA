/**
 * GR::LISTEN — Selective Attention Alert Filtering
 *
 * Implements the GR::LISTEN pattern from the consciousness stack:
 * intelligent alert filtering to combat alarm fatigue in SCADA environments.
 *
 * Features:
 *  - Priority classification (critical / high / medium / low / info)
 *  - Attention budget: caps alerts per time window per category
 *  - Fatigue detection: escalates or suppresses when unacked alerts pile up
 *  - Correlation: groups related alerts into incidents
 *  - Configurable rules per process area, time of day, operator role
 *
 * Issue: #350 — Implement GR::LISTEN alert filtering
 * ADR: ADR-0022
 */

import { log, logWarn } from "../../logger";
import type { Severity, AlarmPayload } from "../singularis-prime/schemas";

// ── Configuration ────────────────────────────────────────────────────────────

export interface AttentionBudget {
  /** Max alerts in the time window */
  maxAlerts: number;
  /** Window duration in ms */
  windowMs: number;
}

export interface TimeOfDayRule {
  /** 24h start (e.g. 22 for 10 PM) */
  startHour: number;
  /** 24h end (e.g. 6 for 6 AM) */
  endHour: number;
  /** Minimum severity to pass during this window */
  minSeverity: Severity;
}

export interface FilterRule {
  /** Rule identifier */
  id: string;
  /** Process areas this rule applies to (empty = all) */
  processAreas: string[];
  /** Operator roles this rule applies to (empty = all) */
  operatorRoles: string[];
  /** Time-of-day restrictions */
  timeOfDayRules: TimeOfDayRule[];
  /** Per-severity attention budgets */
  budgets: Partial<Record<Severity, AttentionBudget>>;
  /** Max unacknowledged alerts before fatigue triggers */
  fatigueThreshold: number;
  /** What to do when fatigued: suppress low-priority or escalate */
  fatigueAction: "suppress_low" | "escalate" | "both";
}

export interface GrListenConfig {
  enabled: boolean;
  /** Default budgets when no rule matches */
  defaultBudgets: Record<Severity, AttentionBudget>;
  /** Default fatigue threshold */
  defaultFatigueThreshold: number;
  /** Correlation window: alerts within this ms of each other on related tags group together */
  correlationWindowMs: number;
  /** Custom filter rules */
  rules: FilterRule[];
}

export function defaultGrListenConfig(): GrListenConfig {
  return {
    enabled: true,
    defaultBudgets: {
      critical: { maxAlerts: 50, windowMs: 60_000 },
      high: { maxAlerts: 30, windowMs: 60_000 },
      medium: { maxAlerts: 20, windowMs: 60_000 },
      low: { maxAlerts: 10, windowMs: 60_000 },
      info: { maxAlerts: 5, windowMs: 60_000 },
    },
    defaultFatigueThreshold: 15,
    correlationWindowMs: 30_000,
    rules: [],
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlertInput {
  alarmId: string;
  alarmName: string;
  sourceTagId: string;
  priority: Severity;
  message: string;
  processArea?: string;
  facility?: string;
  triggerValue?: number | string;
  limitValue?: number | string;
  timestamp: number;
}

export type FilterDecision = "pass" | "suppress" | "escalate" | "group";

export interface FilterResult {
  decision: FilterDecision;
  /** Original priority */
  originalPriority: Severity;
  /** Effective priority (may be escalated) */
  effectivePriority: Severity;
  /** If grouped, the incident ID */
  incidentId?: string;
  /** Reason for the decision */
  reason: string;
}

export interface Incident {
  id: string;
  alerts: string[];
  createdAt: number;
  lastUpdatedAt: number;
  processArea?: string;
  rootAlarmId: string;
}

// ── Severity ordering ────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function severityAtLeast(a: Severity, minSeverity: Severity): boolean {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[minSeverity];
}

function escalateSeverity(s: Severity): Severity {
  switch (s) {
    case "info":
      return "low";
    case "low":
      return "medium";
    case "medium":
      return "high";
    case "high":
      return "critical";
    case "critical":
      return "critical";
  }
}

// ── GR::LISTEN Engine ────────────────────────────────────────────────────────

export class GrListenFilter {
  private config: GrListenConfig;

  /** Sliding window counters: severity → timestamps[] */
  private budgetWindows: Map<Severity, number[]> = new Map();

  /** Unacknowledged alert count */
  private unackedCount = 0;

  /** Active incidents for correlation */
  private incidents: Map<string, Incident> = new Map();
  private static readonly MAX_INCIDENTS = 5000;
  private static readonly MAX_RECENT_ALERT_TAGS = 10000;

  /** Recent alerts for correlation: sourceTagId → {alarmId, timestamp}[] */
  private recentAlerts: Map<string, { alarmId: string; timestamp: number }[]> = new Map();

  /** Stats */
  private stats = {
    total: 0,
    passed: 0,
    suppressed: 0,
    escalated: 0,
    grouped: 0,
  };

  constructor(config?: Partial<GrListenConfig>) {
    this.config = { ...defaultGrListenConfig(), ...config };
  }

  // ── Core filter ──────────────────────────────────────────────────────────

  /**
   * Evaluate an incoming alert through GR::LISTEN.
   * Returns a FilterResult with the decision and effective priority.
   */
  evaluate(alert: AlertInput, operatorRole?: string): FilterResult {
    this.stats.total++;

    if (!this.config.enabled) {
      this.stats.passed++;
      return {
        decision: "pass",
        originalPriority: alert.priority,
        effectivePriority: alert.priority,
        reason: "GR::LISTEN disabled",
      };
    }

    // Find matching rule
    const rule = this.findMatchingRule(alert, operatorRole);

    // 1. Time-of-day check
    const todBlock = this.checkTimeOfDay(alert.priority, rule);
    if (todBlock) {
      this.stats.suppressed++;
      return {
        decision: "suppress",
        originalPriority: alert.priority,
        effectivePriority: alert.priority,
        reason: todBlock,
      };
    }

    // 2. Correlation — try to group into existing incident
    const incident = this.tryCorrelate(alert);
    if (incident) {
      this.stats.grouped++;
      return {
        decision: "group",
        originalPriority: alert.priority,
        effectivePriority: alert.priority,
        incidentId: incident.id,
        reason: `Grouped into incident ${incident.id} (${incident.alerts.length} alerts)`,
      };
    }

    // 3. Fatigue detection
    const fatigueThreshold = rule?.fatigueThreshold ?? this.config.defaultFatigueThreshold;
    if (this.unackedCount >= fatigueThreshold) {
      const fatigueAction = rule?.fatigueAction ?? "both";

      if (
        (fatigueAction === "suppress_low" || fatigueAction === "both") &&
        !severityAtLeast(alert.priority, "medium")
      ) {
        this.stats.suppressed++;
        return {
          decision: "suppress",
          originalPriority: alert.priority,
          effectivePriority: alert.priority,
          reason: `Fatigue suppression: ${this.unackedCount} unacked alerts exceed threshold ${fatigueThreshold}`,
        };
      }

      if (fatigueAction === "escalate" || fatigueAction === "both") {
        const escalated = escalateSeverity(alert.priority);
        if (escalated !== alert.priority) {
          this.stats.escalated++;
          this.recordAlert(alert);
          return {
            decision: "escalate",
            originalPriority: alert.priority,
            effectivePriority: escalated,
            reason: `Fatigue escalation: ${this.unackedCount} unacked, ${alert.priority} → ${escalated}`,
          };
        }
      }
    }

    // 4. Attention budget
    const budget = this.getBudget(alert.priority, rule);
    if (budget && this.isBudgetExhausted(alert.priority, budget)) {
      this.stats.suppressed++;
      return {
        decision: "suppress",
        originalPriority: alert.priority,
        effectivePriority: alert.priority,
        reason: `Attention budget exhausted for ${alert.priority} (${budget.maxAlerts}/${budget.windowMs}ms)`,
      };
    }

    // 5. Pass
    this.recordAlert(alert);
    this.consumeBudget(alert.priority);
    this.unackedCount++;
    this.stats.passed++;

    return {
      decision: "pass",
      originalPriority: alert.priority,
      effectivePriority: alert.priority,
      reason: "Passed all filters",
    };
  }

  /** Acknowledge an alert (reduces fatigue counter) */
  acknowledge(alarmId: string): void {
    if (this.unackedCount > 0) {
      this.unackedCount--;
    }
  }

  /** Bulk acknowledge */
  acknowledgeAll(): void {
    this.unackedCount = 0;
  }

  /** Get active incidents */
  getIncidents(): Incident[] {
    return Array.from(this.incidents.values());
  }

  /** Get filter stats */
  getStats() {
    return {
      ...this.stats,
      unackedCount: this.unackedCount,
      activeIncidents: this.incidents.size,
    };
  }

  /** Update config at runtime */
  updateConfig(config: Partial<GrListenConfig>): void {
    this.config = { ...this.config, ...config };
    log(`👁️ GR::LISTEN config updated`, "gr-listen");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private findMatchingRule(
    alert: AlertInput,
    operatorRole?: string,
  ): FilterRule | undefined {
    return this.config.rules.find((rule) => {
      if (
        rule.processAreas.length > 0 &&
        alert.processArea &&
        !rule.processAreas.includes(alert.processArea)
      ) {
        return false;
      }
      if (
        rule.operatorRoles.length > 0 &&
        operatorRole &&
        !rule.operatorRoles.includes(operatorRole)
      ) {
        return false;
      }
      return true;
    });
  }

  private checkTimeOfDay(priority: Severity, rule?: FilterRule): string | null {
    if (!rule || rule.timeOfDayRules.length === 0) return null;

    const hour = new Date().getHours();
    for (const tod of rule.timeOfDayRules) {
      const inWindow =
        tod.startHour <= tod.endHour
          ? hour >= tod.startHour && hour < tod.endHour
          : hour >= tod.startHour || hour < tod.endHour;

      if (inWindow && !severityAtLeast(priority, tod.minSeverity)) {
        return `Time-of-day rule: ${priority} below min ${tod.minSeverity} during ${tod.startHour}:00-${tod.endHour}:00`;
      }
    }
    return null;
  }

  private tryCorrelate(alert: AlertInput): Incident | null {
    const now = alert.timestamp;
    const recent = this.recentAlerts.get(alert.sourceTagId);

    if (recent) {
      // Check if there's a recent alert on the same tag within correlation window
      for (const prev of recent) {
        if (now - prev.timestamp <= this.config.correlationWindowMs) {
          // Find or create incident
          for (const [, incident] of this.incidents) {
            if (incident.alerts.includes(prev.alarmId)) {
              incident.alerts.push(alert.alarmId);
              incident.lastUpdatedAt = now;
              return incident;
            }
          }
          // Create new incident
          const incidentId = `INC-${Date.now().toString(36)}`;
          const incident: Incident = {
            id: incidentId,
            alerts: [prev.alarmId, alert.alarmId],
            createdAt: now,
            lastUpdatedAt: now,
            processArea: alert.processArea,
            rootAlarmId: prev.alarmId,
          };
          this.incidents.set(incidentId, incident);
          return incident;
        }
      }
    }

    return null;
  }

  private recordAlert(alert: AlertInput): void {
    const existing = this.recentAlerts.get(alert.sourceTagId) || [];
    existing.push({ alarmId: alert.alarmId, timestamp: alert.timestamp });
    // Keep only recent entries
    const cutoff = Date.now() - this.config.correlationWindowMs * 2;
    this.recentAlerts.set(
      alert.sourceTagId,
      existing.filter((a) => a.timestamp > cutoff),
    );
    // Evict oldest incidents if map is too large
    if (this.incidents.size > GrListenFilter.MAX_INCIDENTS) {
      const sorted = Array.from(this.incidents.entries())
        .sort((a, b) => a[1].lastUpdatedAt - b[1].lastUpdatedAt);
      const toRemove = sorted.slice(0, sorted.length - GrListenFilter.MAX_INCIDENTS);
      for (const [key] of toRemove) this.incidents.delete(key);
    }
    // Evict stale recentAlerts entries
    if (this.recentAlerts.size > GrListenFilter.MAX_RECENT_ALERT_TAGS) {
      const keys = Array.from(this.recentAlerts.keys());
      const toRemove = keys.slice(0, keys.length - GrListenFilter.MAX_RECENT_ALERT_TAGS);
      for (const key of toRemove) this.recentAlerts.delete(key);
    }
  }

  private getBudget(
    priority: Severity,
    rule?: FilterRule,
  ): AttentionBudget | undefined {
    return rule?.budgets[priority] ?? this.config.defaultBudgets[priority];
  }

  private isBudgetExhausted(priority: Severity, budget: AttentionBudget): boolean {
    const now = Date.now();
    let timestamps = this.budgetWindows.get(priority) || [];
    timestamps = timestamps.filter((t) => now - t < budget.windowMs);
    this.budgetWindows.set(priority, timestamps);
    return timestamps.length >= budget.maxAlerts;
  }

  private consumeBudget(priority: Severity): void {
    const timestamps = this.budgetWindows.get(priority) || [];
    timestamps.push(Date.now());
    this.budgetWindows.set(priority, timestamps);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _instance: GrListenFilter | null = null;

export function getGrListenFilter(config?: Partial<GrListenConfig>): GrListenFilter {
  if (!_instance) {
    _instance = new GrListenFilter(config);
  }
  return _instance;
}
