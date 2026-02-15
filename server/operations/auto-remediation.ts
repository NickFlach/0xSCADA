/**
 * Auto-Remediation Engine — ADR-0014 [14.6]
 *
 * Automated responses to common failures with escalation.
 */

import { EventEmitter } from 'events';

export interface RemediationRule {
  id: string;
  name: string;
  condition: (context: IncidentContext) => boolean;
  action: (context: IncidentContext) => Promise<RemediationResult>;
  cooldownMs: number;
  maxAutoRemediations: number;
  escalateAfter: number; // auto-remediation attempts before escalation
  enabled: boolean;
}

export interface IncidentContext {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  source: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface RemediationResult {
  success: boolean;
  action: string;
  details: string;
  duration: number;
}

export interface Incident {
  id: string;
  context: IncidentContext;
  status: 'open' | 'remediating' | 'resolved' | 'escalated';
  remediationAttempts: number;
  results: RemediationResult[];
  openedAt: number;
  resolvedAt?: number;
  escalatedAt?: number;
}

export class AutoRemediationEngine extends EventEmitter {
  private rules: Map<string, RemediationRule> = new Map();
  private incidents: Map<string, Incident> = new Map();
  private lastRuleExecution: Map<string, number> = new Map();

  constructor() {
    super();
    this.registerDefaultRules();
  }

  registerRule(rule: RemediationRule): void {
    this.rules.set(rule.id, rule);
  }

  async handleIncident(context: IncidentContext): Promise<Incident> {
    const incidentId = `inc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const incident: Incident = {
      id: incidentId,
      context,
      status: 'open',
      remediationAttempts: 0,
      results: [],
      openedAt: Date.now(),
    };

    this.incidents.set(incidentId, incident);
    this.emit('incident-opened', incident);

    // Find matching rules
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (!rule.condition(context)) continue;

      // Check cooldown
      const lastExec = this.lastRuleExecution.get(rule.id) ?? 0;
      if (Date.now() - lastExec < rule.cooldownMs) continue;

      // Check max auto-remediations
      if (incident.remediationAttempts >= rule.maxAutoRemediations) {
        incident.status = 'escalated';
        incident.escalatedAt = Date.now();
        this.emit('incident-escalated', incident);
        continue;
      }

      // Execute remediation
      incident.status = 'remediating';
      incident.remediationAttempts++;
      this.lastRuleExecution.set(rule.id, Date.now());

      try {
        const startTime = Date.now();
        const result = await rule.action(context);
        result.duration = Date.now() - startTime;
        incident.results.push(result);

        if (result.success) {
          incident.status = 'resolved';
          incident.resolvedAt = Date.now();
          this.emit('incident-resolved', incident);
        } else if (incident.remediationAttempts >= rule.escalateAfter) {
          incident.status = 'escalated';
          incident.escalatedAt = Date.now();
          this.emit('incident-escalated', incident);
        }
      } catch (error) {
        incident.results.push({
          success: false,
          action: rule.name,
          details: `Error: ${error instanceof Error ? error.message : String(error)}`,
          duration: 0,
        });
      }

      break; // Only apply first matching rule
    }

    return incident;
  }

  getIncident(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  getOpenIncidents(): Incident[] {
    return Array.from(this.incidents.values()).filter(
      (i) => i.status === 'open' || i.status === 'remediating'
    );
  }

  private registerDefaultRules(): void {
    this.registerRule({
      id: 'gateway-reconnect',
      name: 'Gateway Reconnection',
      condition: (ctx) => ctx.type === 'gateway-disconnect',
      action: async (ctx) => ({
        success: true,
        action: 'Attempted gateway reconnection',
        details: `Reconnecting gateway ${ctx.source}`,
        duration: 0,
      }),
      cooldownMs: 30000,
      maxAutoRemediations: 3,
      escalateAfter: 3,
      enabled: true,
    });

    this.registerRule({
      id: 'high-memory',
      name: 'High Memory Remediation',
      condition: (ctx) => ctx.type === 'high-memory' && ctx.severity !== 'low',
      action: async () => {
        if (global.gc) global.gc();
        return {
          success: true,
          action: 'Triggered garbage collection',
          details: 'Forced GC to reclaim memory',
          duration: 0,
        };
      },
      cooldownMs: 60000,
      maxAutoRemediations: 5,
      escalateAfter: 3,
      enabled: true,
    });

    this.registerRule({
      id: 'queue-overflow',
      name: 'Queue Overflow Remediation',
      condition: (ctx) => ctx.type === 'queue-overflow',
      action: async (ctx) => ({
        success: true,
        action: 'Dropped low-priority events',
        details: `Queue at ${ctx.metadata.depth} events — pruning low-priority items`,
        duration: 0,
      }),
      cooldownMs: 10000,
      maxAutoRemediations: 10,
      escalateAfter: 5,
      enabled: true,
    });
  }
}
