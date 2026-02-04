/**
 * NERC CIP Compliance Types
 *
 * Type definitions for NERC Critical Infrastructure Protection
 * compliance mapping, evidence collection, and reporting.
 */

// Supported NERC CIP Standards
export type CIPStandard =
  | 'CIP-002' // BES Cyber System Categorization
  | 'CIP-003' // Security Management Controls
  | 'CIP-004' // Personnel & Training
  | 'CIP-005' // Electronic Security Perimeters
  | 'CIP-007' // System Security Management
  | 'CIP-010' // Configuration Change Management
  | 'CIP-011' // Information Protection
  | 'CIP-013' // Supply Chain Risk Management
  | 'CIP-014'; // Physical Security

// Compliance status levels
export type ComplianceStatus = 'compliant' | 'partial' | 'gap' | 'not-applicable' | 'pending-review';

// Evidence source types
export type EvidenceSourceType =
  | 'audit-log'
  | 'configuration'
  | 'access-control'
  | 'network-diagram'
  | 'policy-document'
  | 'training-record'
  | 'vulnerability-scan'
  | 'patch-record'
  | 'incident-report'
  | 'change-request'
  | 'asset-inventory'
  | 'manual-attestation';

// Impact rating for BES Cyber Systems
export type ImpactRating = 'high' | 'medium' | 'low';

// Requirement priority
export type RequirementPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Evidence source configuration
 */
export interface EvidenceSource {
  id: string;
  type: EvidenceSourceType;
  name: string;
  description: string;
  query?: string; // For automated collection
  location?: string; // File path or URL
  automatable: boolean;
  refreshInterval?: number; // Minutes between auto-refresh
}

/**
 * Collected evidence artifact
 */
export interface EvidenceArtifact {
  id: string;
  sourceId: string;
  controlId: string;
  collectedAt: Date;
  expiresAt?: Date;
  content: string | object;
  hash: string; // SHA-256 for integrity
  collector: 'automated' | 'manual';
  collectorId?: string; // User ID for manual collection
  metadata: Record<string, unknown>;
}

/**
 * CIP Requirement definition
 */
export interface CIPRequirement {
  id: string;
  standard: CIPStandard;
  section: string;
  title: string;
  description: string;
  applicability: {
    highImpact: boolean;
    mediumImpact: boolean;
    lowImpact: boolean;
  };
  priority: RequirementPriority;
  evidenceSources: string[]; // EvidenceSource IDs
  controlMappings: ControlMapping[];
  violationRisk: string;
  remediationGuidance: string;
}

/**
 * Mapping between 0xSCADA features and CIP requirements
 */
export interface ControlMapping {
  featureId: string;
  featureName: string;
  featureDescription: string;
  coverageLevel: 'full' | 'partial' | 'none';
  implementationNotes: string;
  configurationRequired?: Record<string, unknown>;
}

/**
 * Compliance control assessment result
 */
export interface ComplianceControl {
  id: string;
  requirementId: string;
  standard: CIPStandard;
  requirement: string;
  status: ComplianceStatus;
  evidenceArtifacts: EvidenceArtifact[];
  lastAssessed: Date;
  nextAssessmentDue: Date;
  assessedBy: 'automated' | string; // 'automated' or user ID
  findings: ComplianceFinding[];
  remediationPlan?: RemediationPlan;
}

/**
 * Finding from compliance assessment
 */
export interface ComplianceFinding {
  id: string;
  controlId: string;
  severity: 'critical' | 'major' | 'minor' | 'observation';
  title: string;
  description: string;
  evidenceReference?: string;
  detectedAt: Date;
  resolvedAt?: Date;
  resolution?: string;
}

/**
 * Plan to remediate compliance gaps
 */
export interface RemediationPlan {
  id: string;
  controlId: string;
  findingIds: string[];
  description: string;
  steps: RemediationStep[];
  owner: string;
  targetDate: Date;
  status: 'planned' | 'in-progress' | 'completed' | 'overdue';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Individual remediation step
 */
export interface RemediationStep {
  id: string;
  order: number;
  description: string;
  assignee?: string;
  dueDate?: Date;
  completedAt?: Date;
  notes?: string;
}

/**
 * BES Cyber System asset
 */
export interface BESCyberAsset {
  id: string;
  name: string;
  type: 'cyber-asset' | 'cyber-system' | 'electronic-access-point' | 'pca';
  impactRating: ImpactRating;
  description: string;
  location: string;
  owner: string;
  applicableStandards: CIPStandard[];
  lastInventoryDate: Date;
  metadata: Record<string, unknown>;
}

/**
 * Compliance dashboard metrics
 */
export interface ComplianceDashboard {
  overallScore: number; // 0-100
  byStandard: Record<CIPStandard, StandardMetrics>;
  totalControls: number;
  compliantControls: number;
  partialControls: number;
  gapControls: number;
  pendingControls: number;
  criticalFindings: number;
  majorFindings: number;
  upcomingAssessments: UpcomingAssessment[];
  recentChanges: ComplianceChange[];
  lastUpdated: Date;
}

/**
 * Metrics for a specific CIP standard
 */
export interface StandardMetrics {
  standard: CIPStandard;
  title: string;
  totalRequirements: number;
  compliant: number;
  partial: number;
  gaps: number;
  notApplicable: number;
  compliancePercentage: number;
  lastAssessed: Date;
}

/**
 * Upcoming assessment reminder
 */
export interface UpcomingAssessment {
  controlId: string;
  requirementId: string;
  standard: CIPStandard;
  dueDate: Date;
  daysUntilDue: number;
}

/**
 * Recent compliance status change
 */
export interface ComplianceChange {
  controlId: string;
  requirementId: string;
  previousStatus: ComplianceStatus;
  newStatus: ComplianceStatus;
  changedAt: Date;
  changedBy: string;
  reason: string;
}

/**
 * Audit report configuration
 */
export interface AuditReportConfig {
  title: string;
  standards?: CIPStandard[]; // Empty = all
  includeEvidence: boolean;
  includeFindings: boolean;
  includeRemediation: boolean;
  includeHistory: boolean;
  dateRange?: {
    start: Date;
    end: Date;
  };
  format: 'pdf' | 'excel' | 'json' | 'html';
  preparedFor?: string;
  preparedBy?: string;
}

/**
 * Generated audit report
 */
export interface AuditReport {
  id: string;
  config: AuditReportConfig;
  generatedAt: Date;
  generatedBy: string;
  content: Buffer | string;
  contentType: string;
  hash: string;
  metadata: {
    totalPages?: number;
    controlsAssessed: number;
    findingsIncluded: number;
  };
}

/**
 * Alert configuration for compliance drift
 */
export interface ComplianceAlert {
  id: string;
  type: 'status-change' | 'assessment-due' | 'finding-detected' | 'remediation-overdue';
  severity: 'critical' | 'warning' | 'info';
  controlId?: string;
  message: string;
  createdAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  metadata: Record<string, unknown>;
}

/**
 * Alert rule configuration
 */
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  type: ComplianceAlert['type'];
  conditions: AlertCondition[];
  actions: AlertAction[];
  cooldownMinutes: number;
  lastTriggered?: Date;
}

/**
 * Condition for triggering alert
 */
export interface AlertCondition {
  field: string;
  operator: 'equals' | 'not-equals' | 'contains' | 'greater-than' | 'less-than';
  value: unknown;
}

/**
 * Action to take when alert triggers
 */
export interface AlertAction {
  type: 'email' | 'webhook' | 'log' | 'slack';
  config: Record<string, unknown>;
}

/**
 * Compliance service configuration
 */
export interface ComplianceServiceConfig {
  assessmentIntervalDays: number;
  evidenceRetentionDays: number;
  autoCollectEvidence: boolean;
  alertsEnabled: boolean;
  defaultImpactRating: ImpactRating;
  reportStoragePath: string;
}
