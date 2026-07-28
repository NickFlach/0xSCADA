/**
 * Compliance certification toolkit (ADR-0014, issue #225).
 *
 * The previous service returned random pass/fail results.  This implementation
 * evaluates an explicit evidence set against versioned IEC 62443 and NIST CSF
 * control catalogs.  A missing artifact is deliberately reported as
 * "not-assessed" rather than being treated as proof of compliance.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log, logError } from '../../logger';

export type ComplianceFramework = 'IEC-62443' | 'NIST-CSF';
export type ControlStatus = 'pass' | 'fail' | 'not-assessed';
export type ComplianceSeverity = 'low' | 'medium' | 'high' | 'critical';
export type EvidenceValue = boolean | number | string | readonly string[];

export interface ComplianceEvidence {
  /** Stable machine-readable evidence key, for example `identity.uniqueUsers`. */
  key: string;
  value: EvidenceValue;
  source: string;
  collectedAt: string;
  description?: string;
}

export interface EvidenceCollector {
  readonly id: string;
  collect(): Promise<readonly ComplianceEvidence[]>;
}

export interface ComplianceControl {
  id: string;
  framework: ComplianceFramework;
  family: string;
  title: string;
  description: string;
  severity: ComplianceSeverity;
  evidenceKeys: readonly string[];
  remediation: string;
  /** IEC 62443 target security level for which this control becomes mandatory. */
  securityLevel?: 1 | 2 | 3 | 4;
  /** Equivalent controls in the other catalog. */
  mappedControlIds: readonly string[];
}

export interface ControlEvaluation {
  controlId: string;
  framework: ComplianceFramework;
  family: string;
  title: string;
  severity: ComplianceSeverity;
  status: ControlStatus;
  evidenceKeys: readonly string[];
  satisfiedEvidenceKeys: readonly string[];
  missingEvidenceKeys: readonly string[];
  failedEvidenceKeys: readonly string[];
  invalidEvidence: ReadonlyArray<{
    key: string;
    expected: ComplianceEvidenceKind;
    reason: string;
  }>;
  rationale: string;
  remediation?: string;
  securityLevel?: 1 | 2 | 3 | 4;
  mappedControlIds: readonly string[];
}

export interface ComplianceGap {
  controlId: string;
  severity: ComplianceSeverity;
  status: Exclude<ControlStatus, 'pass'>;
  title: string;
  missingEvidenceKeys: readonly string[];
  failedEvidenceKeys: readonly string[];
  invalidEvidence: ReadonlyArray<{
    key: string;
    expected: ComplianceEvidenceKind;
    reason: string;
  }>;
  remediation: string;
}

export type ComplianceEvidenceKind =
  | 'true-attestation'
  | 'positive-number'
  | 'non-empty-string'
  | 'non-empty-string-list';

export interface ComplianceEvidenceRequirement {
  kind: ComplianceEvidenceKind;
  description: string;
}

export type ComplianceEvidenceRequirements =
  Readonly<Record<string, ComplianceEvidenceRequirement>>;

export interface Iec62443Assessment {
  targetSecurityLevel: 1 | 2 | 3 | 4;
  achievedSecurityLevel: 0 | 1 | 2 | 3 | 4;
  foundationalRequirements: ReadonlyArray<{
    family: string;
    passed: number;
    applicable: number;
    status: ControlStatus;
  }>;
}

export interface NistCsfMapping {
  functions: ReadonlyArray<{
    function: 'Govern' | 'Identify' | 'Protect' | 'Detect' | 'Respond' | 'Recover';
    passed: number;
    assessed: number;
    total: number;
    score: number;
  }>;
}

export interface ComplianceScanRequest {
  frameworks?: readonly ComplianceFramework[];
  evidence?: readonly ComplianceEvidence[];
  collectors?: readonly EvidenceCollector[];
  targetSecurityLevel?: 1 | 2 | 3 | 4;
  controlIds?: readonly string[];
}

export interface ComplianceScanResult {
  scanId: string;
  catalogVersion: string;
  startedAt: string;
  completedAt: string;
  frameworks: readonly ComplianceFramework[];
  targetSecurityLevel: 1 | 2 | 3 | 4;
  status: 'compliant' | 'non-compliant' | 'incomplete';
  complianceScore: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    notAssessed: number;
    criticalGaps: number;
  };
  controls: readonly ControlEvaluation[];
  gaps: readonly ComplianceGap[];
  evidence: readonly ComplianceEvidence[];
  iec62443?: Iec62443Assessment;
  nistCsf?: NistCsfMapping;
}

export interface ComplianceAuditReport {
  reportId: string;
  title: string;
  organization: string;
  auditor?: string;
  generatedAt: string;
  catalogVersion: string;
  scanId: string;
  frameworks: readonly ComplianceFramework[];
  overallStatus: ComplianceScanResult['status'];
  complianceScore: number;
  executiveSummary: string;
  scope: string;
  assessment: ComplianceScanResult['summary'];
  iec62443?: Iec62443Assessment;
  nistCsf?: NistCsfMapping;
  gaps: readonly ComplianceGap[];
  evidenceManifest: ReadonlyArray<Pick<ComplianceEvidence, 'key' | 'source' | 'collectedAt'>>;
  markdown: string;
  /** SHA-256 digest over the report fields, excluding this digest. */
  sha256: string;
}

export interface AuditReportOptions {
  organization: string;
  auditor?: string;
  scope?: string;
}

export const COMPLIANCE_CATALOG_VERSION = '2026.1';

const IEC_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'IEC62443-FR1-IAC-1',
    framework: 'IEC-62443',
    family: 'FR 1 — Identification and authentication control',
    title: 'Unique human and service identities',
    description: 'All users, services, and devices are uniquely identified before access.',
    severity: 'critical',
    securityLevel: 1,
    evidenceKeys: ['identity.uniqueUsers', 'identity.serviceAccountsInventoried'],
    remediation: 'Remove shared accounts and inventory service identities with accountable owners.',
    mappedControlIds: ['NIST-PR.AA-01'],
  },
  {
    id: 'IEC62443-FR2-UC-1',
    framework: 'IEC-62443',
    family: 'FR 2 — Use control',
    title: 'Least-privilege role enforcement',
    description: 'Authorization is role based and defaults to deny.',
    severity: 'critical',
    securityLevel: 1,
    evidenceKeys: ['access.rbacEnabled', 'access.defaultDeny'],
    remediation: 'Enable RBAC, remove wildcard privileges, and enforce deny-by-default authorization.',
    mappedControlIds: ['NIST-PR.AA-05'],
  },
  {
    id: 'IEC62443-FR3-SI-1',
    framework: 'IEC-62443',
    family: 'FR 3 — System integrity',
    title: 'Software and configuration integrity',
    description: 'Release artifacts and critical configuration are integrity verified.',
    severity: 'critical',
    securityLevel: 1,
    evidenceKeys: ['integrity.signedArtifacts', 'integrity.configurationAudit'],
    remediation: 'Sign release artifacts and enable immutable configuration change auditing.',
    mappedControlIds: ['NIST-PR.PS-06'],
  },
  {
    id: 'IEC62443-FR4-DC-1',
    framework: 'IEC-62443',
    family: 'FR 4 — Data confidentiality',
    title: 'Protected data in transit and at rest',
    description: 'Sensitive telemetry and credentials use approved cryptographic protection.',
    severity: 'high',
    securityLevel: 1,
    evidenceKeys: ['crypto.tlsEnabled', 'crypto.atRestEncryption'],
    remediation: 'Require authenticated TLS and encrypt sensitive persistence and backups.',
    mappedControlIds: ['NIST-PR.DS-01', 'NIST-PR.DS-02'],
  },
  {
    id: 'IEC62443-FR5-RDF-1',
    framework: 'IEC-62443',
    family: 'FR 5 — Restricted data flow',
    title: 'Zones, conduits, and network policy',
    description: 'OT assets are segmented into explicit zones with allowlisted conduits.',
    severity: 'high',
    securityLevel: 1,
    evidenceKeys: ['network.zoneInventory', 'network.defaultDenyPolicy'],
    remediation: 'Document security zones and enforce allowlisted network policy between conduits.',
    mappedControlIds: ['NIST-PR.IR-01'],
  },
  {
    id: 'IEC62443-FR6-TRE-1',
    framework: 'IEC-62443',
    family: 'FR 6 — Timely response to events',
    title: 'Security monitoring and response ownership',
    description: 'Security-relevant events are centrally observed and have an owned response path.',
    severity: 'high',
    securityLevel: 1,
    evidenceKeys: ['monitoring.securityEvents', 'response.onCallOwned'],
    remediation: 'Centralize security telemetry and assign a tested incident escalation path.',
    mappedControlIds: ['NIST-DE.CM-01', 'NIST-RS.MA-01'],
  },
  {
    id: 'IEC62443-FR7-RA-1',
    framework: 'IEC-62443',
    family: 'FR 7 — Resource availability',
    title: 'Verified recovery capability',
    description: 'Backups, failover, and resource exhaustion controls are tested.',
    severity: 'critical',
    securityLevel: 1,
    evidenceKeys: ['recovery.backupVerified', 'availability.capacityHeadroom'],
    remediation: 'Test restoration, retain immutable backups, and maintain documented capacity headroom.',
    mappedControlIds: ['NIST-RC.RP-01'],
  },
  {
    id: 'IEC62443-SL2-IAC-2',
    framework: 'IEC-62443',
    family: 'FR 1 — Identification and authentication control',
    title: 'Multi-factor administrative authentication',
    description: 'Privileged and remote access requires phishing-resistant multi-factor authentication.',
    severity: 'critical',
    securityLevel: 2,
    evidenceKeys: ['identity.adminMfa', 'identity.remoteMfa'],
    remediation: 'Require MFA for privileged and remote access and remove bypass paths.',
    mappedControlIds: ['NIST-PR.AA-03'],
  },
  {
    id: 'IEC62443-SL2-RDF-2',
    framework: 'IEC-62443',
    family: 'FR 5 — Restricted data flow',
    title: 'Independently tested zone boundaries',
    description: 'Network boundary policy is continuously tested for unintended paths.',
    severity: 'high',
    securityLevel: 2,
    evidenceKeys: ['network.policyTested'],
    remediation: 'Add automated network-policy tests and review all exceptions.',
    mappedControlIds: ['NIST-ID.RA-01'],
  },
  {
    id: 'IEC62443-SL3-SI-2',
    framework: 'IEC-62443',
    family: 'FR 3 — System integrity',
    title: 'Active vulnerability and supply-chain controls',
    description: 'Dependencies and deployed artifacts are scanned with enforced severity gates.',
    severity: 'critical',
    securityLevel: 3,
    evidenceKeys: ['integrity.dependencyScan', 'integrity.imageScan'],
    remediation: 'Scan dependencies and images on every release and block critical findings.',
    mappedControlIds: ['NIST-ID.RA-01', 'NIST-PR.PS-06'],
  },
  {
    id: 'IEC62443-SL3-DC-2',
    framework: 'IEC-62443',
    family: 'FR 4 — Data confidentiality',
    title: 'Managed certificate and key rotation',
    description: 'Certificates and cryptographic keys have enforced rotation and revocation.',
    severity: 'high',
    securityLevel: 3,
    evidenceKeys: ['crypto.rotationAutomated', 'crypto.revocationTested'],
    remediation: 'Automate certificate rotation and test emergency revocation.',
    mappedControlIds: ['NIST-PR.DS-01'],
  },
  {
    id: 'IEC62443-SL4-SI-3',
    framework: 'IEC-62443',
    family: 'FR 3 — System integrity',
    title: 'Hardware-backed critical keys',
    description: 'Root signing and anchoring keys are non-exportable and hardware protected.',
    severity: 'critical',
    securityLevel: 4,
    evidenceKeys: ['integrity.hardwareBackedKeys'],
    remediation: 'Move root keys into an HSM with non-exportable policy and dual control.',
    mappedControlIds: ['NIST-PR.PS-06'],
  },
] as const;

const NIST_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'NIST-GV.OC-01',
    framework: 'NIST-CSF',
    family: 'Govern',
    title: 'Cybersecurity mission and ownership',
    description: 'The organization defines OT cybersecurity responsibilities and risk ownership.',
    severity: 'high',
    evidenceKeys: ['governance.securityOwner', 'governance.securityPolicyApproved'],
    remediation: 'Assign security ownership and approve a maintained OT security policy.',
    mappedControlIds: [],
  },
  {
    id: 'NIST-ID.AM-01',
    framework: 'NIST-CSF',
    family: 'Identify',
    title: 'Asset inventory',
    description: 'Hardware, software, services, and tags are inventoried with ownership.',
    severity: 'high',
    evidenceKeys: ['assets.inventoryCurrent'],
    remediation: 'Create an automatically refreshed inventory with accountable owners.',
    mappedControlIds: ['IEC62443-FR1-IAC-1'],
  },
  {
    id: 'NIST-ID.RA-01',
    framework: 'NIST-CSF',
    family: 'Identify',
    title: 'Vulnerability identification',
    description: 'Vulnerabilities in dependencies, images, and network exposure are identified.',
    severity: 'critical',
    evidenceKeys: ['integrity.dependencyScan', 'integrity.imageScan'],
    remediation: 'Run authenticated vulnerability scans and enforce remediation SLAs.',
    mappedControlIds: ['IEC62443-SL3-SI-2'],
  },
  {
    id: 'NIST-PR.AA-01',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Identity management',
    description: 'Identities and credentials are managed throughout their lifecycle.',
    severity: 'critical',
    evidenceKeys: ['identity.uniqueUsers', 'identity.serviceAccountsInventoried'],
    remediation: 'Inventory identities, remove shared accounts, and automate deprovisioning.',
    mappedControlIds: ['IEC62443-FR1-IAC-1'],
  },
  {
    id: 'NIST-PR.AA-03',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Authentication',
    description: 'Privileged and remote users use strong multi-factor authentication.',
    severity: 'critical',
    evidenceKeys: ['identity.adminMfa', 'identity.remoteMfa'],
    remediation: 'Require MFA for all privileged and remote authentication.',
    mappedControlIds: ['IEC62443-SL2-IAC-2'],
  },
  {
    id: 'NIST-PR.AA-05',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Least privilege',
    description: 'Permissions are least-privilege and deny by default.',
    severity: 'critical',
    evidenceKeys: ['access.rbacEnabled', 'access.defaultDeny'],
    remediation: 'Implement RBAC and remove permissive default roles.',
    mappedControlIds: ['IEC62443-FR2-UC-1'],
  },
  {
    id: 'NIST-PR.DS-01',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Data at rest protection',
    description: 'Sensitive persisted data is encrypted and keys are managed.',
    severity: 'high',
    evidenceKeys: ['crypto.atRestEncryption'],
    remediation: 'Encrypt historian, audit, credential, and backup data at rest.',
    mappedControlIds: ['IEC62443-FR4-DC-1'],
  },
  {
    id: 'NIST-PR.DS-02',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Data in transit protection',
    description: 'Sensitive data in transit uses authenticated encryption.',
    severity: 'high',
    evidenceKeys: ['crypto.tlsEnabled'],
    remediation: 'Enforce authenticated TLS on external and inter-service communication.',
    mappedControlIds: ['IEC62443-FR4-DC-1'],
  },
  {
    id: 'NIST-PR.PS-06',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Software integrity',
    description: 'Software and configuration integrity is verified before deployment.',
    severity: 'critical',
    evidenceKeys: ['integrity.signedArtifacts', 'integrity.configurationAudit'],
    remediation: 'Verify signed provenance and audit configuration changes.',
    mappedControlIds: ['IEC62443-FR3-SI-1'],
  },
  {
    id: 'NIST-PR.IR-01',
    framework: 'NIST-CSF',
    family: 'Protect',
    title: 'Network resilience',
    description: 'Networks and environments are protected from unauthorized logical access.',
    severity: 'high',
    evidenceKeys: ['network.zoneInventory', 'network.defaultDenyPolicy'],
    remediation: 'Apply zones, conduits, and deny-by-default network policy.',
    mappedControlIds: ['IEC62443-FR5-RDF-1'],
  },
  {
    id: 'NIST-DE.CM-01',
    framework: 'NIST-CSF',
    family: 'Detect',
    title: 'Continuous monitoring',
    description: 'Security-relevant events are continuously monitored.',
    severity: 'high',
    evidenceKeys: ['monitoring.securityEvents'],
    remediation: 'Collect security telemetry centrally and alert on control failures.',
    mappedControlIds: ['IEC62443-FR6-TRE-1'],
  },
  {
    id: 'NIST-RS.MA-01',
    framework: 'NIST-CSF',
    family: 'Respond',
    title: 'Incident response execution',
    description: 'An owned and tested incident response process is available.',
    severity: 'high',
    evidenceKeys: ['response.onCallOwned', 'response.exerciseCompleted'],
    remediation: 'Assign on-call ownership and exercise incident procedures at least annually.',
    mappedControlIds: ['IEC62443-FR6-TRE-1'],
  },
  {
    id: 'NIST-RC.RP-01',
    framework: 'NIST-CSF',
    family: 'Recover',
    title: 'Recovery plan execution',
    description: 'Recovery plans and backups are tested against recovery objectives.',
    severity: 'critical',
    evidenceKeys: ['recovery.backupVerified', 'recovery.exerciseCompleted'],
    remediation: 'Run restore exercises and retain evidence of achieved recovery objectives.',
    mappedControlIds: ['IEC62443-FR7-RA-1'],
  },
] as const;

function frozenControlCatalog(
  controls: readonly ComplianceControl[],
): readonly ComplianceControl[] {
  return Object.freeze(controls.map(control => Object.freeze({
    ...control,
    evidenceKeys: Object.freeze([...control.evidenceKeys]),
    mappedControlIds: Object.freeze([...control.mappedControlIds]),
  })));
}

export const COMPLIANCE_CONTROL_CATALOG: readonly ComplianceControl[] = frozenControlCatalog([
  ...IEC_CONTROLS,
  ...NIST_CONTROLS,
]);

const TRUE_ATTESTATION = (description: string): ComplianceEvidenceRequirement => Object.freeze({
  kind: 'true-attestation',
  description,
});

function frozenEvidenceRequirements(
  requirements: ComplianceEvidenceRequirements,
): ComplianceEvidenceRequirements {
  return Object.freeze(Object.fromEntries(
    Object.entries(requirements).map(([key, requirement]) => [
      key,
      Object.freeze({ ...requirement }),
    ]),
  ));
}

/**
 * Evidence is evaluated by key-specific contracts, not generic JavaScript
 * truthiness. A non-empty value such as "disabled" must never prove a control.
 */
export const COMPLIANCE_EVIDENCE_REQUIREMENTS: ComplianceEvidenceRequirements = frozenEvidenceRequirements({
  'identity.uniqueUsers': TRUE_ATTESTATION('Unique human identities are enforced.'),
  'identity.serviceAccountsInventoried': TRUE_ATTESTATION('Service accounts have accountable inventory records.'),
  'access.rbacEnabled': TRUE_ATTESTATION('Role-based authorization is enabled.'),
  'access.defaultDeny': TRUE_ATTESTATION('Authorization defaults to deny.'),
  'integrity.signedArtifacts': TRUE_ATTESTATION('Release artifacts have verified signatures.'),
  'integrity.configurationAudit': TRUE_ATTESTATION('Critical configuration changes are immutably audited.'),
  'crypto.tlsEnabled': TRUE_ATTESTATION('Authenticated TLS is enforced.'),
  'crypto.atRestEncryption': TRUE_ATTESTATION('Sensitive persisted data is encrypted.'),
  'network.zoneInventory': {
    kind: 'non-empty-string-list',
    description: 'The assessed zone identifiers.',
  },
  'network.defaultDenyPolicy': TRUE_ATTESTATION('Inter-zone traffic defaults to deny.'),
  'monitoring.securityEvents': TRUE_ATTESTATION('Security-relevant events are centrally monitored.'),
  'response.onCallOwned': {
    kind: 'non-empty-string',
    description: 'The accountable incident-response owner or team identifier.',
  },
  'recovery.backupVerified': TRUE_ATTESTATION('A backup restoration has been verified.'),
  'availability.capacityHeadroom': {
    kind: 'positive-number',
    description: 'Measured available capacity headroom percentage.',
  },
  'identity.adminMfa': TRUE_ATTESTATION('Administrative access requires MFA.'),
  'identity.remoteMfa': TRUE_ATTESTATION('Remote access requires MFA.'),
  'network.policyTested': TRUE_ATTESTATION('Zone-boundary policy tests pass.'),
  'integrity.dependencyScan': TRUE_ATTESTATION('Dependency scanning completed within policy.'),
  'integrity.imageScan': TRUE_ATTESTATION('Deployed image scanning completed within policy.'),
  'crypto.rotationAutomated': TRUE_ATTESTATION('Certificate and key rotation is automated.'),
  'crypto.revocationTested': TRUE_ATTESTATION('Emergency revocation has been tested.'),
  'integrity.hardwareBackedKeys': TRUE_ATTESTATION('Critical root keys are hardware-backed and non-exportable.'),
  'governance.securityOwner': {
    kind: 'non-empty-string',
    description: 'The accountable OT security owner identifier.',
  },
  'governance.securityPolicyApproved': TRUE_ATTESTATION('The OT security policy is approved and current.'),
  'assets.inventoryCurrent': TRUE_ATTESTATION('The owned asset inventory is current.'),
  'response.exerciseCompleted': TRUE_ATTESTATION('An incident-response exercise completed within policy.'),
  'recovery.exerciseCompleted': TRUE_ATTESTATION('A recovery exercise completed within policy.'),
});

const NIST_FUNCTIONS = ['Govern', 'Identify', 'Protect', 'Detect', 'Respond', 'Recover'] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const NEGATIVE_STRING_VALUES = new Set([
  '0',
  'disabled',
  'false',
  'fail',
  'failed',
  'no',
  'none',
  'n/a',
  'na',
  'not-applicable',
  'not-configured',
  'off',
  'unknown',
  'unassigned',
]);

function nonEmptyPositiveString(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  return normalized.length > 0 && !NEGATIVE_STRING_VALUES.has(normalized);
}

function evidenceEvaluation(
  requirement: ComplianceEvidenceRequirement,
  value: EvidenceValue,
): { passed: boolean; reason: string } {
  if (requirement.kind === 'true-attestation') {
    return value === true
      ? { passed: true, reason: 'true attestation supplied' }
      : { passed: false, reason: 'expected the boolean value true' };
  }
  if (requirement.kind === 'positive-number') {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { passed: true, reason: 'positive measurement supplied' }
      : { passed: false, reason: 'expected a finite number greater than zero' };
  }
  if (requirement.kind === 'non-empty-string') {
    return typeof value === 'string' && nonEmptyPositiveString(value)
      ? { passed: true, reason: 'owned identifier supplied' }
      : { passed: false, reason: 'expected a non-empty, non-negative string identifier' };
  }
  const valid = Array.isArray(value)
    && value.length > 0
    && value.every(item => nonEmptyPositiveString(item));
  return valid
    ? { passed: true, reason: 'non-empty inventory supplied' }
    : { passed: false, reason: 'expected a non-empty list of valid string identifiers' };
}

function assertIsoDate(value: string, field: string): void {
  const timestampWithZone =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!timestampWithZone.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-8601 timestamp with a timezone`);
  }
}

function normalizeFramework(value: string): ComplianceFramework {
  const normalized = value.trim().toUpperCase().replace(/[_\s]/g, '-');
  if (normalized === 'IEC62443' || normalized === 'IEC-62443') return 'IEC-62443';
  if (normalized === 'NIST' || normalized === 'NIST-CSF') return 'NIST-CSF';
  throw new Error(`Unsupported compliance framework: ${value}`);
}

function score(controls: readonly ControlEvaluation[]): number {
  if (controls.length === 0) return 0;
  const earned = controls.reduce((sum, control) => {
    if (control.status === 'pass') return sum + 1;
    if (control.status === 'not-assessed') return sum + 0;
    return sum;
  }, 0);
  return Number(((earned / controls.length) * 100).toFixed(2));
}

export class ObjectEvidenceCollector implements EvidenceCollector {
  readonly id: string;
  private readonly evidence: Readonly<Record<string, EvidenceValue>>;
  private readonly source: string;
  private readonly now: () => Date;

  constructor(
    id: string,
    evidence: Readonly<Record<string, EvidenceValue>>,
    options: { source?: string; now?: () => Date } = {},
  ) {
    if (!id.trim()) throw new Error('collector id is required');
    this.id = id;
    this.evidence = evidence;
    this.source = options.source ?? id;
    this.now = options.now ?? (() => new Date());
  }

  async collect(): Promise<readonly ComplianceEvidence[]> {
    const collectedAt = this.now().toISOString();
    return Object.entries(this.evidence)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value, source: this.source, collectedAt }));
  }
}

function markdownText(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()#|>])/g, '\\$1');
}

export interface JsonEvidenceDocument {
  source?: string;
  collectedAt?: string;
  evidence: Readonly<Record<string, EvidenceValue>>;
}

function isEvidenceValue(value: unknown): value is EvidenceValue {
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'string'
    || (Array.isArray(value) && value.every(item => typeof item === 'string'));
}

/**
 * Concrete production collector for a periodically refreshed, read-only
 * evidence snapshot mounted by deployment automation.
 */
export class JsonFileEvidenceCollector implements EvidenceCollector {
  readonly id: string;
  readonly filePath: string;
  private readonly maxBytes: number;

  constructor(filePath: string, options: { id?: string; maxBytes?: number } = {}) {
    if (!filePath.trim()) throw new Error('evidence file path is required');
    this.filePath = resolve(filePath);
    this.id = options.id?.trim() || `json-file:${this.filePath}`;
    this.maxBytes = options.maxBytes ?? 1_048_576;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('maxBytes must be a positive integer');
    }
  }

  async collect(): Promise<readonly ComplianceEvidence[]> {
    const [contents, metadata] = await Promise.all([
      readFile(this.filePath),
      stat(this.filePath),
    ]);
    if (contents.byteLength > this.maxBytes) {
      throw new Error(`evidence file exceeds ${this.maxBytes} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString('utf8'));
    } catch (error) {
      throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('evidence file must contain an object document');
    }
    const document = parsed as Partial<JsonEvidenceDocument>;
    if (document.evidence === null
      || typeof document.evidence !== 'object'
      || Array.isArray(document.evidence)) {
      throw new Error('evidence file must contain an evidence object');
    }
    if (document.source !== undefined && typeof document.source !== 'string') {
      throw new Error('evidence file source must be a string');
    }
    if (document.collectedAt !== undefined && typeof document.collectedAt !== 'string') {
      throw new Error('evidence file collectedAt must be a string');
    }
    const source = document.source?.trim() || `file:${this.filePath}`;
    const collectedAt = document.collectedAt ?? metadata.mtime.toISOString();
    assertIsoDate(collectedAt, 'evidence file collectedAt');
    return Object.entries(document.evidence)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (!key.trim()) throw new Error('evidence file contains an empty key');
        if (!isEvidenceValue(value)) {
          throw new Error(`evidence ${key} has an unsupported value type`);
        }
        return { key, value, source, collectedAt };
      });
  }
}

export class ComplianceScanner {
  private readonly catalog: readonly ComplianceControl[];
  private readonly collectors: readonly EvidenceCollector[];
  private readonly evidenceRequirements: ComplianceEvidenceRequirements;
  private readonly now: () => Date;

  constructor(options: {
    catalog?: readonly ComplianceControl[];
    collectors?: readonly EvidenceCollector[];
    evidenceRequirements?: ComplianceEvidenceRequirements;
    now?: () => Date;
  } = {}) {
    this.catalog = frozenControlCatalog(options.catalog ?? COMPLIANCE_CONTROL_CATALOG);
    this.collectors = options.collectors ?? [];
    this.evidenceRequirements = frozenEvidenceRequirements({
      ...COMPLIANCE_EVIDENCE_REQUIREMENTS,
      ...(options.evidenceRequirements ?? {}),
    });
    this.now = options.now ?? (() => new Date());
    if (this.catalog.length === 0) throw new Error('Compliance control catalog cannot be empty');
    const ids = new Set<string>();
    for (const control of this.catalog) {
      if (ids.has(control.id)) throw new Error(`Duplicate compliance control id: ${control.id}`);
      ids.add(control.id);
      if (control.evidenceKeys.length === 0) {
        throw new Error(`Compliance control ${control.id} has no evidence requirements`);
      }
      for (const key of control.evidenceKeys) {
        if (!Object.hasOwn(this.evidenceRequirements, key)) {
          throw new Error(`Compliance control ${control.id} has no typed requirement for ${key}`);
        }
      }
    }
  }

  getControls(framework?: ComplianceFramework): readonly ComplianceControl[] {
    return this.catalog
      .filter(control => framework === undefined || control.framework === framework)
      .map(control => ({
        ...control,
        evidenceKeys: [...control.evidenceKeys],
        mappedControlIds: [...control.mappedControlIds],
      }));
  }

  getEvidenceRequirements(): ComplianceEvidenceRequirements {
    return structuredClone(this.evidenceRequirements);
  }

  async runScan(
    requestOrFramework: ComplianceScanRequest | ComplianceFramework | string = {},
    suppliedEvidence: readonly ComplianceEvidence[] = [],
  ): Promise<ComplianceScanResult> {
    const request: ComplianceScanRequest = typeof requestOrFramework === 'string'
      ? { frameworks: [normalizeFramework(requestOrFramework)], evidence: suppliedEvidence }
      : requestOrFramework;
    const frameworks: ComplianceFramework[] = [
      ...new Set((request.frameworks ?? ['IEC-62443', 'NIST-CSF'])
        .map(framework => normalizeFramework(framework))),
    ];
    if (frameworks.length === 0) throw new Error('At least one compliance framework is required');
    const targetSecurityLevel = request.targetSecurityLevel ?? 2;
    if (![1, 2, 3, 4].includes(targetSecurityLevel)) {
      throw new Error('targetSecurityLevel must be between 1 and 4');
    }

    const startedAt = this.now().toISOString();
    const collected = await this.collectEvidence([
      ...this.collectors,
      ...(request.collectors ?? []),
    ], request.evidence ?? []);
    const evidenceByKey = new Map(collected.map(item => [item.key, item]));
    const requestedIds = request.controlIds === undefined ? undefined : new Set(request.controlIds);
    if (requestedIds?.size === 0) throw new Error('controlIds cannot be empty when supplied');

    const applicable = this.catalog.filter(control =>
      frameworks.includes(control.framework)
      && (requestedIds === undefined || requestedIds.has(control.id))
      && (control.framework !== 'IEC-62443'
        || control.securityLevel === undefined
        || control.securityLevel <= targetSecurityLevel),
    );
    if (requestedIds !== undefined) {
      const found = new Set(applicable.map(control => control.id));
      const unknown = [...requestedIds].filter(id => !found.has(id));
      if (unknown.length > 0) throw new Error(`Unknown or out-of-scope control ids: ${unknown.join(', ')}`);
    }

    const controls = applicable.map(control => this.evaluate(control, evidenceByKey));
    const gaps = controls
      .filter((control): control is ControlEvaluation & { status: 'fail' | 'not-assessed' } =>
        control.status !== 'pass')
      .map(control => ({
        controlId: control.controlId,
        severity: control.severity,
        status: control.status,
        title: control.title,
        missingEvidenceKeys: control.missingEvidenceKeys,
        failedEvidenceKeys: control.failedEvidenceKeys,
        invalidEvidence: control.invalidEvidence,
        remediation: control.remediation ?? 'Collect evidence and remediate the failed control.',
      }));
    const passed = controls.filter(control => control.status === 'pass').length;
    const failed = controls.filter(control => control.status === 'fail').length;
    const notAssessed = controls.filter(control => control.status === 'not-assessed').length;
    const criticalGaps = gaps.filter(gap => gap.severity === 'critical').length;
    const completedAt = this.now().toISOString();
    const resultWithoutId = {
      catalogVersion: COMPLIANCE_CATALOG_VERSION,
      startedAt,
      completedAt,
      frameworks,
      targetSecurityLevel,
      status: (failed > 0 ? 'non-compliant' : notAssessed > 0 ? 'incomplete' : 'compliant') as
        ComplianceScanResult['status'],
      complianceScore: score(controls),
      summary: { total: controls.length, passed, failed, notAssessed, criticalGaps },
      controls,
      gaps,
      evidence: collected,
      iec62443: frameworks.includes('IEC-62443')
        ? this.buildIecAssessment(controls, targetSecurityLevel)
        : undefined,
      nistCsf: frameworks.includes('NIST-CSF') ? this.buildNistMapping(controls) : undefined,
    };
    return {
      scanId: `scan-${digest(resultWithoutId).slice(0, 16)}`,
      ...resultWithoutId,
    };
  }

  generateAuditReport(scan: ComplianceScanResult, options: AuditReportOptions): ComplianceAuditReport {
    if (!options.organization.trim()) throw new Error('organization is required');
    const generatedAt = this.now().toISOString();
    const allApplicableControls = this.catalog.filter(control =>
      scan.frameworks.includes(control.framework)
      && (control.framework !== 'IEC-62443'
        || control.securityLevel === undefined
        || control.securityLevel <= scan.targetSecurityLevel));
    const completeFrameworkScope = allApplicableControls.length === scan.controls.length
      && allApplicableControls.every(control =>
        scan.controls.some(evaluation => evaluation.controlId === control.id));
    const scope = options.scope?.trim() || (completeFrameworkScope
      ? `${scan.frameworks.join(' and ')} controls`
      : `Targeted controls: ${scan.controls.map(control => control.controlId).join(', ')}`);
    const executiveSummary = [
      `${options.organization} was assessed against ${scan.frameworks.join(' and ')} catalog version ${scan.catalogVersion}.`,
      `${scan.summary.passed} of ${scan.summary.total} applicable controls passed (${scan.complianceScore}%).`,
      scan.summary.notAssessed > 0
        ? `${scan.summary.notAssessed} controls lack sufficient evidence and must not be represented as compliant.`
        : 'All applicable controls had sufficient evidence.',
      `${scan.summary.failed} controls failed and ${scan.summary.criticalGaps} gaps are critical.`,
    ].join(' ');
    const base = {
      title: `${scan.frameworks.join(' / ')} Compliance Audit Report`,
      organization: options.organization.trim(),
      auditor: options.auditor?.trim() || undefined,
      generatedAt,
      catalogVersion: scan.catalogVersion,
      scanId: scan.scanId,
      frameworks: scan.frameworks,
      overallStatus: scan.status,
      complianceScore: scan.complianceScore,
      executiveSummary,
      scope,
      assessment: scan.summary,
      iec62443: scan.iec62443,
      nistCsf: scan.nistCsf,
      gaps: scan.gaps,
      evidenceManifest: scan.evidence.map(({ key, source, collectedAt }) => ({
        key,
        source,
        collectedAt,
      })),
    };
    const reportId = `audit-${digest(base).slice(0, 16)}`;
    const markdown = this.renderMarkdown(reportId, base);
    const reportWithoutDigest = { reportId, ...base, markdown };
    return { ...reportWithoutDigest, sha256: digest(reportWithoutDigest) };
  }

  private async collectEvidence(
    collectors: readonly EvidenceCollector[],
    supplied: readonly ComplianceEvidence[],
  ): Promise<readonly ComplianceEvidence[]> {
    const collected = [...supplied];
    const collectorIds = new Set<string>();
    for (const collector of collectors) {
      if (typeof collector.id !== 'string' || !collector.id.trim()) {
        throw new Error('evidence collector id is required');
      }
      if (collectorIds.has(collector.id)) {
        throw new Error(`Duplicate evidence collector id: ${collector.id}`);
      }
      collectorIds.add(collector.id);
    }
    for (const item of supplied) {
      if (!item.key.trim()) throw new Error('evidence key is required');
      if (!item.source.trim()) throw new Error(`evidence source is required for ${item.key}`);
      assertIsoDate(item.collectedAt, `evidence ${item.key}.collectedAt`);
    }
    const batches = await Promise.all(collectors.map(async collector => {
      try {
        return await collector.collect();
      } catch (error) {
        throw new Error(
          `Evidence collector ${collector.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }));
    for (const batch of batches) collected.push(...batch);

    // Last writer wins by key.  Supplied evidence is inserted first and
    // configured collectors can therefore refresh it with current observations.
    const deduplicated = new Map<string, ComplianceEvidence>();
    for (const item of collected) {
      if (!item.key.trim()) throw new Error('evidence key is required');
      if (typeof item.source !== 'string' || !item.source.trim()) {
        throw new Error(`evidence source is required for ${item.key}`);
      }
      if (!isEvidenceValue(item.value)) {
        throw new Error(`evidence ${item.key} has an unsupported value type`);
      }
      assertIsoDate(item.collectedAt, `evidence ${item.key}.collectedAt`);
      const previous = deduplicated.get(item.key);
      if (!previous || Date.parse(item.collectedAt) >= Date.parse(previous.collectedAt)) {
        deduplicated.set(item.key, {
          ...item,
          value: Array.isArray(item.value) ? [...item.value] : item.value,
        });
      }
    }
    return [...deduplicated.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  private evaluate(
    control: ComplianceControl,
    evidence: ReadonlyMap<string, ComplianceEvidence>,
  ): ControlEvaluation {
    const missingEvidenceKeys: string[] = [];
    const failedEvidenceKeys: string[] = [];
    const satisfiedEvidenceKeys: string[] = [];
    const invalidEvidence: Array<{
      key: string;
      expected: ComplianceEvidenceKind;
      reason: string;
    }> = [];
    for (const key of control.evidenceKeys) {
      const item = evidence.get(key);
      if (item === undefined) missingEvidenceKeys.push(key);
      else {
        const requirement = this.evidenceRequirements[key];
        const evaluation = evidenceEvaluation(requirement, item.value);
        if (evaluation.passed) satisfiedEvidenceKeys.push(key);
        else {
          failedEvidenceKeys.push(key);
          invalidEvidence.push({
            key,
            expected: requirement.kind,
            reason: evaluation.reason,
          });
        }
      }
    }
    const status: ControlStatus = failedEvidenceKeys.length > 0
      ? 'fail'
      : missingEvidenceKeys.length > 0
        ? 'not-assessed'
        : 'pass';
    const rationale = status === 'pass'
      ? `All ${control.evidenceKeys.length} required evidence items passed.`
      : status === 'fail'
        ? `Negative evidence: ${failedEvidenceKeys.join(', ')}.`
        : `Evidence not collected: ${missingEvidenceKeys.join(', ')}.`;
    return {
      controlId: control.id,
      framework: control.framework,
      family: control.family,
      title: control.title,
      severity: control.severity,
      status,
      evidenceKeys: [...control.evidenceKeys],
      satisfiedEvidenceKeys,
      missingEvidenceKeys,
      failedEvidenceKeys,
      invalidEvidence,
      rationale,
      remediation: status === 'pass' ? undefined : control.remediation,
      securityLevel: control.securityLevel,
      mappedControlIds: [...control.mappedControlIds],
    };
  }

  private buildIecAssessment(
    controls: readonly ControlEvaluation[],
    target: 1 | 2 | 3 | 4,
  ): Iec62443Assessment {
    const iecCatalog = this.catalog.filter(control =>
      control.framework === 'IEC-62443'
      && (control.securityLevel ?? 1) <= target);
    const evaluations = new Map(
      controls
        .filter(control => control.framework === 'IEC-62443')
        .map(control => [control.controlId, control]),
    );
    let achieved: 0 | 1 | 2 | 3 | 4 = 0;
    for (const level of [1, 2, 3, 4] as const) {
      if (level > target) break;
      const required = iecCatalog.filter(control => (control.securityLevel ?? 1) <= level);
      if (required.length > 0
        && required.every(control => evaluations.get(control.id)?.status === 'pass')) {
        achieved = level;
      }
      else break;
    }
    const families = [...new Set(iecCatalog.map(control => control.family))];
    return {
      targetSecurityLevel: target,
      achievedSecurityLevel: achieved,
      foundationalRequirements: families.map(family => {
        const familyControls = iecCatalog.filter(control => control.family === family);
        const statuses = familyControls.map(control => evaluations.get(control.id)?.status);
        const passed = statuses.filter(status => status === 'pass').length;
        const hasFailure = statuses.some(status => status === 'fail');
        const hasUnknown = statuses.some(status => status === undefined || status === 'not-assessed');
        return {
          family,
          passed,
          applicable: familyControls.length,
          status: hasFailure ? 'fail' : hasUnknown ? 'not-assessed' : 'pass',
        };
      }),
    };
  }

  private buildNistMapping(controls: readonly ControlEvaluation[]): NistCsfMapping {
    const nistCatalog = this.catalog.filter(control => control.framework === 'NIST-CSF');
    const evaluations = new Map(
      controls
        .filter(control => control.framework === 'NIST-CSF')
        .map(control => [control.controlId, control]),
    );
    return {
      functions: NIST_FUNCTIONS.map(name => {
        const functionControls = nistCatalog.filter(control => control.family === name);
        const statuses = functionControls.map(control => evaluations.get(control.id)?.status);
        const passed = statuses.filter(status => status === 'pass').length;
        const assessed = statuses.filter(status => status !== undefined && status !== 'not-assessed').length;
        return {
          function: name,
          passed,
          assessed,
          total: functionControls.length,
          score: functionControls.length === 0
            ? 0
            : Number(((passed / functionControls.length) * 100).toFixed(2)),
        };
      }),
    };
  }

  private renderMarkdown(
    reportId: string,
    report: Omit<ComplianceAuditReport, 'reportId' | 'markdown' | 'sha256'>,
  ): string {
    const gapRows = report.gaps.length === 0
      ? '| — | — | — | No gaps identified |'
      : report.gaps
        .map(gap => `| ${markdownText(gap.controlId)} | ${gap.severity} | ${gap.status} | ${
          markdownText(gap.remediation)
        } |`)
        .join('\n');
    const evidenceRows = report.evidenceManifest.length === 0
      ? '| — | — | — |'
      : report.evidenceManifest
        .map(item => `| ${markdownText(item.key)} | ${markdownText(item.source)} | ${
          markdownText(item.collectedAt)
        } |`)
        .join('\n');
    return [
      `# ${markdownText(report.title)}`,
      '',
      `- **Report ID:** ${reportId}`,
      `- **Organization:** ${markdownText(report.organization)}`,
      ...(report.auditor === undefined
        ? []
        : [`- **Auditor:** ${markdownText(report.auditor)}`]),
      `- **Generated:** ${report.generatedAt}`,
      `- **Catalog:** ${report.catalogVersion}`,
      `- **Scan:** ${report.scanId}`,
      `- **Status:** ${report.overallStatus}`,
      `- **Score:** ${report.complianceScore}%`,
      '',
      '## Executive summary',
      '',
      markdownText(report.executiveSummary),
      '',
      '## Scope',
      '',
      markdownText(report.scope),
      '',
      '## Gap analysis',
      '',
      '| Control | Severity | Status | Remediation |',
      '|---|---|---|---|',
      gapRows,
      '',
      '## Evidence manifest',
      '',
      '| Evidence key | Source | Collected at |',
      '|---|---|---|',
      evidenceRows,
      '',
      '> This automated assessment supports, but does not replace, certification by an accredited assessor.',
      '',
    ].join('\n');
  }
}

/**
 * Long-lived facade used by application routes and health reporting.  Scan
 * history is deliberately bounded to avoid an unbounded process-local cache.
 */
export class ComplianceService extends EventEmitter {
  private readonly scanner: ComplianceScanner;
  private readonly maxHistory: number;
  private readonly scanHistory = new Map<string, ComplianceScanResult>();
  private readonly collectors = new Map<string, EvidenceCollector>();
  private initialized = false;
  private checkTimer?: NodeJS.Timeout;
  private recurringScanIntervalMs?: number;

  constructor(options: {
    scanner?: ComplianceScanner;
    maxHistory?: number;
    collectors?: readonly EvidenceCollector[];
  } = {}) {
    super();
    this.scanner = options.scanner ?? new ComplianceScanner();
    this.maxHistory = options.maxHistory ?? 100;
    if (!Number.isInteger(this.maxHistory) || this.maxHistory < 1) {
      throw new Error('maxHistory must be a positive integer');
    }
    for (const collector of options.collectors ?? []) this.registerCollector(collector);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const evidenceFile = process.env.COMPLIANCE_EVIDENCE_FILE?.trim();
    if (evidenceFile && !this.collectors.has('deployment-evidence-file')) {
      this.registerCollector(new JsonFileEvidenceCollector(evidenceFile, {
        id: 'deployment-evidence-file',
      }));
    }
    const configuredInterval = Number(process.env.COMPLIANCE_SCAN_INTERVAL_MS ?? 0);
    if (Number.isFinite(configuredInterval) && configuredInterval >= 60_000) {
      this.recurringScanIntervalMs = configuredInterval;
      this.checkTimer = setInterval(() => {
        this.scan({}).catch(error => logError(error, 'Periodic compliance scan failed'));
      }, configuredInterval);
      this.checkTimer.unref();
    }
    this.emit('initialized');
    log('Compliance certification toolkit initialized');
  }

  shutdown(): void {
    if (this.checkTimer !== undefined) clearInterval(this.checkTimer);
    this.checkTimer = undefined;
    this.recurringScanIntervalMs = undefined;
    this.initialized = false;
  }

  registerCollector(collector: EvidenceCollector): () => void {
    if (!collector.id.trim()) throw new Error('collector id is required');
    if (this.collectors.has(collector.id)) {
      throw new Error(`Duplicate evidence collector id: ${collector.id}`);
    }
    this.collectors.set(collector.id, collector);
    return () => {
      this.collectors.delete(collector.id);
    };
  }

  getCollectors(): readonly string[] {
    return [...this.collectors.keys()].sort();
  }

  async scan(request: ComplianceScanRequest = {}): Promise<ComplianceScanResult> {
    if (!this.initialized) await this.initialize();
    const result = await this.scanner.runScan({
      ...request,
      collectors: [
        ...this.collectors.values(),
        ...(request.collectors ?? []),
      ],
    });
    const storedResult = structuredClone(result);
    this.scanHistory.delete(storedResult.scanId);
    this.scanHistory.set(storedResult.scanId, storedResult);
    while (this.scanHistory.size > this.maxHistory) {
      const oldest = this.scanHistory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.scanHistory.delete(oldest);
    }
    this.emit('compliance-checked', structuredClone(storedResult));
    if (storedResult.gaps.length > 0) {
      this.emit('violation-detected', structuredClone(storedResult.gaps));
    }
    return structuredClone(storedResult);
  }

  async checkCompliance(evidence: readonly ComplianceEvidence[] = []): Promise<{
    compliant: number;
    violations: number;
    notAssessed: number;
  }> {
    const scan = await this.scan({ evidence });
    return {
      compliant: scan.summary.passed,
      violations: scan.summary.failed,
      notAssessed: scan.summary.notAssessed,
    };
  }

  getControls(framework?: ComplianceFramework): readonly ComplianceControl[] {
    return this.scanner.getControls(framework);
  }

  getEvidenceRequirements(): ComplianceEvidenceRequirements {
    return this.scanner.getEvidenceRequirements();
  }

  getScan(scanId: string): ComplianceScanResult | undefined {
    const scan = this.scanHistory.get(scanId);
    return scan === undefined ? undefined : structuredClone(scan);
  }

  getScans(limit = 20): readonly ComplianceScanResult[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
    return structuredClone([...this.scanHistory.values()].slice(-limit).reverse());
  }

  generateAuditReport(scanId: string, options: AuditReportOptions): ComplianceAuditReport {
    const scan = this.scanHistory.get(scanId);
    if (scan === undefined) throw new Error(`Unknown compliance scan: ${scanId}`);
    return this.scanner.generateAuditReport(scan, options);
  }

  getStatus(): {
    initialized: boolean;
    catalogVersion: string;
    totalRules: number;
    collectors: readonly string[];
    recurringScanIntervalMs?: number;
    completedScans: number;
    lastCheck?: Date;
  } {
    const latest = [...this.scanHistory.values()].at(-1);
    return {
      initialized: this.initialized,
      catalogVersion: COMPLIANCE_CATALOG_VERSION,
      totalRules: this.scanner.getControls().length,
      collectors: this.getCollectors(),
      recurringScanIntervalMs: this.recurringScanIntervalMs,
      completedScans: this.scanHistory.size,
      lastCheck: latest === undefined ? undefined : new Date(latest.completedAt),
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (!this.initialized) {
      return { healthy: false, message: 'Compliance service not initialized' };
    }
    const latest = [...this.scanHistory.values()].at(-1);
    if (latest?.summary.criticalGaps) {
      return {
        healthy: false,
        message: `${latest.summary.criticalGaps} critical compliance gaps in latest scan`,
      };
    }
    return {
      healthy: true,
      message: `${this.scanner.getControls().length} controls available; ${this.scanHistory.size} scans retained`,
    };
  }
}

export const complianceService = new ComplianceService();
