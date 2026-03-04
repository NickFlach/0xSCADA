/**
 * Compliance Service
 * 
 * Handles regulatory compliance and audit requirements for industrial systems.
 * Tracks compliance status, generates reports, and ensures adherence to standards.
 * 
 * Standards supported: IEC 62443, NIST, ISO 27001, SOX, GDPR
 */

import { EventEmitter } from 'events';
import { log, logError } from '../../logger';

export interface ComplianceRule {
  id: string;
  name: string;
  description: string;
  standard: string; // e.g., 'IEC62443', 'NIST', 'ISO27001'
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  lastCheck?: Date;
  status: 'compliant' | 'non-compliant' | 'unknown';
}

export interface ComplianceViolation {
  id: string;
  ruleId: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Date;
  resolved: boolean;
  resolvedAt?: Date;
  remediation?: string;
}

export interface ComplianceReport {
  id: string;
  period: { start: Date; end: Date };
  standard: string;
  overallStatus: 'compliant' | 'non-compliant' | 'partial';
  rulesChecked: number;
  violations: ComplianceViolation[];
  generatedAt: Date;
}

export class ComplianceService extends EventEmitter {
  private rules: Map<string, ComplianceRule> = new Map();
  private violations: ComplianceViolation[] = [];
  private isInitialized = false;
  private checkTimer?: NodeJS.Timeout;

  constructor() {
    super();
  }

  /**
   * Initialize the compliance service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    log('Initializing compliance service');
    
    // Load default compliance rules
    await this.loadDefaultRules();
    
    // Start periodic compliance checks
    this.startPeriodicChecks();
    
    this.isInitialized = true;
    this.emit('initialized');
    log('Compliance service initialized');
  }

  /**
   * Add a compliance rule
   */
  addRule(rule: ComplianceRule): void {
    this.rules.set(rule.id, rule);
    log(`Compliance rule added: ${rule.name} (${rule.standard})`);
  }

  /**
   * Check compliance for all active rules
   */
  async checkCompliance(): Promise<{ compliant: number; violations: number }> {
    if (!this.isInitialized) {
      throw new Error('Compliance service not initialized');
    }

    let compliant = 0;
    let violationCount = 0;

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      try {
        const isCompliant = await this.checkRule(rule);
        rule.lastCheck = new Date();
        rule.status = isCompliant ? 'compliant' : 'non-compliant';

        if (isCompliant) {
          compliant++;
        } else {
          violationCount++;
          await this.recordViolation(rule);
        }
      } catch (error) {
        logError(`Failed to check compliance rule ${rule.id}`, error as any);
        rule.status = 'unknown';
      }
    }

    log(`Compliance check completed: ${compliant} compliant, ${violationCount} violations`);
    this.emit('compliance-checked', { compliant, violations: violationCount });

    return { compliant, violations: violationCount };
  }

  /**
   * Generate compliance report for a period
   */
  async generateReport(
    standard: string, 
    period: { start: Date; end: Date }
  ): Promise<ComplianceReport> {
    const relevantRules = Array.from(this.rules.values())
      .filter(rule => rule.standard === standard);
    
    const periodViolations = this.violations.filter(
      v => v.timestamp >= period.start && v.timestamp <= period.end
    );

    const overallStatus = periodViolations.length === 0 ? 'compliant' : 
                         periodViolations.some(v => v.severity === 'critical') ? 'non-compliant' : 
                         'partial';

    const report: ComplianceReport = {
      id: `report-${Date.now()}`,
      period,
      standard,
      overallStatus,
      rulesChecked: relevantRules.length,
      violations: periodViolations,
      generatedAt: new Date()
    };

    log(`Generated compliance report for ${standard}: ${overallStatus}`);
    return report;
  }

  /**
   * Get current compliance status
   */
  getStatus(): {
    initialized: boolean;
    totalRules: number;
    activeRules: number;
    recentViolations: number;
    lastCheck?: Date;
  } {
    const activeRules = Array.from(this.rules.values()).filter(r => r.enabled);
    const recentViolations = this.violations
      .filter(v => v.timestamp > new Date(Date.now() - 24 * 60 * 60 * 1000)) // Last 24h
      .length;

    const lastCheck = Math.max(...activeRules.map(r => r.lastCheck?.getTime() || 0));

    return {
      initialized: this.isInitialized,
      totalRules: this.rules.size,
      activeRules: activeRules.length,
      recentViolations,
      lastCheck: lastCheck > 0 ? new Date(lastCheck) : undefined
    };
  }

  /**
   * Health check for compliance service
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        message: 'Compliance service not initialized'
      };
    }

    const status = this.getStatus();
    const criticalViolations = this.violations
      .filter(v => v.severity === 'critical' && !v.resolved)
      .length;

    if (criticalViolations > 0) {
      return {
        healthy: false,
        message: `Critical compliance violations: ${criticalViolations}`
      };
    }

    return {
      healthy: true,
      message: `Compliance service healthy: ${status.activeRules} rules monitored`
    };
  }

  // ── Private Methods ────────────────────────────────────────────────────────

  /**
   * Load default compliance rules
   */
  private async loadDefaultRules(): Promise<void> {
    // IEC 62443 - Industrial security
    this.addRule({
      id: 'iec62443-access-control',
      name: 'Access Control Implementation',
      description: 'Verify proper access control mechanisms are in place',
      standard: 'IEC62443',
      severity: 'critical',
      enabled: true,
      status: 'unknown'
    });

    // NIST - Cybersecurity framework
    this.addRule({
      id: 'nist-logging',
      name: 'Security Event Logging',
      description: 'Ensure all security events are properly logged',
      standard: 'NIST',
      severity: 'high',
      enabled: true,
      status: 'unknown'
    });

    log('Default compliance rules loaded');
  }

  /**
   * Check a specific compliance rule
   */
  private async checkRule(rule: ComplianceRule): Promise<boolean> {
    // Simulate rule checking
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // For demo, randomly pass/fail rules
    return Math.random() > 0.2; // 80% compliance rate
  }

  /**
   * Record a compliance violation
   */
  private async recordViolation(rule: ComplianceRule): Promise<void> {
    const violation: ComplianceViolation = {
      id: `violation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ruleId: rule.id,
      description: `Violation of ${rule.name}: ${rule.description}`,
      severity: rule.severity,
      timestamp: new Date(),
      resolved: false
    };

    this.violations.push(violation);
    this.emit('violation-detected', violation);
  }

  /**
   * Start periodic compliance checks
   */
  private startPeriodicChecks(): void {
    // Check compliance every hour
    this.checkTimer = setInterval(() => {
      this.checkCompliance().catch(error => {
        logError('Periodic compliance check failed', error as any);
      });
    }, 60 * 60 * 1000);

    // Initial check
    setTimeout(() => this.checkCompliance(), 5000);
  }
}

// Singleton instance
export const complianceService = new ComplianceService();