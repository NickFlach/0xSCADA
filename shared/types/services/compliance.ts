/**
 * Compliance Service Types
 * 
 * Types for regulatory compliance, audit trails, and standards adherence.
 */

import { EntityId, Timestamp } from '../core/common';

export interface ComplianceRule {
  id: EntityId;
  name: string;
  description: string;
  standard: string; // e.g., 'IEC62443', 'NIST', 'ISO27001'
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  lastCheck?: Timestamp;
  status: 'compliant' | 'non-compliant' | 'unknown';
}

export interface ComplianceViolation {
  id: EntityId;
  ruleId: EntityId;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: Timestamp;
  resolved: boolean;
  resolvedAt?: Timestamp;
  remediation?: string;
}