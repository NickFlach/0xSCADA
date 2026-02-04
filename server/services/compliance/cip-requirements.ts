/**
 * NERC CIP Requirements Database
 *
 * Complete mapping of NERC CIP standards to 0xSCADA features
 * with evidence sources and control mappings.
 */

import {
  CIPRequirement,
  CIPStandard,
  EvidenceSource,
  EvidenceSourceType,
} from './types';

/**
 * Evidence sources available in 0xSCADA
 */
export const EVIDENCE_SOURCES: EvidenceSource[] = [
  // Audit Logs
  {
    id: 'audit-log-auth',
    type: 'audit-log',
    name: 'Authentication Audit Log',
    description: 'Records of all authentication attempts and sessions',
    query: 'SELECT * FROM audit_logs WHERE category = \'authentication\'',
    automatable: true,
    refreshInterval: 60,
  },
  {
    id: 'audit-log-access',
    type: 'audit-log',
    name: 'Access Control Audit Log',
    description: 'Records of resource access and permission changes',
    query: 'SELECT * FROM audit_logs WHERE category = \'access_control\'',
    automatable: true,
    refreshInterval: 60,
  },
  {
    id: 'audit-log-config',
    type: 'audit-log',
    name: 'Configuration Change Log',
    description: 'Records of system configuration changes',
    query: 'SELECT * FROM audit_logs WHERE category = \'configuration\'',
    automatable: true,
    refreshInterval: 60,
  },
  {
    id: 'audit-log-security',
    type: 'audit-log',
    name: 'Security Event Log',
    description: 'Security-related events and incidents',
    query: 'SELECT * FROM audit_logs WHERE category = \'security\'',
    automatable: true,
    refreshInterval: 15,
  },

  // Configuration
  {
    id: 'config-network',
    type: 'configuration',
    name: 'Network Configuration',
    description: 'Network security and firewall configurations',
    location: '/etc/0xscada/network.conf',
    automatable: true,
    refreshInterval: 1440, // Daily
  },
  {
    id: 'config-access',
    type: 'configuration',
    name: 'Access Control Configuration',
    description: 'RBAC and permission configurations',
    query: 'SELECT * FROM access_policies',
    automatable: true,
    refreshInterval: 1440,
  },
  {
    id: 'config-crypto',
    type: 'configuration',
    name: 'Cryptographic Configuration',
    description: 'Encryption and key management settings',
    location: '/etc/0xscada/crypto.conf',
    automatable: true,
    refreshInterval: 1440,
  },

  // Access Control
  {
    id: 'access-users',
    type: 'access-control',
    name: 'User Access List',
    description: 'List of all users and their access levels',
    query: 'SELECT * FROM users JOIN user_roles ON users.id = user_roles.user_id',
    automatable: true,
    refreshInterval: 1440,
  },
  {
    id: 'access-roles',
    type: 'access-control',
    name: 'Role Definitions',
    description: 'Role-based access control definitions',
    query: 'SELECT * FROM roles JOIN role_permissions ON roles.id = role_permissions.role_id',
    automatable: true,
    refreshInterval: 1440,
  },

  // Asset Inventory
  {
    id: 'asset-inventory',
    type: 'asset-inventory',
    name: 'BES Cyber Asset Inventory',
    description: 'Inventory of all BES Cyber Systems and assets',
    query: 'SELECT * FROM bes_cyber_assets',
    automatable: true,
    refreshInterval: 1440,
  },

  // Security Scans
  {
    id: 'vuln-scan',
    type: 'vulnerability-scan',
    name: 'Vulnerability Scan Results',
    description: 'Results from automated vulnerability scanning',
    location: '/var/0xscada/scans/vulnerability/',
    automatable: true,
    refreshInterval: 10080, // Weekly
  },

  // Patch Records
  {
    id: 'patch-status',
    type: 'patch-record',
    name: 'Patch Management Status',
    description: 'Current patch levels and pending updates',
    query: 'SELECT * FROM patch_management',
    automatable: true,
    refreshInterval: 1440,
  },

  // Training Records
  {
    id: 'training-records',
    type: 'training-record',
    name: 'Security Training Records',
    description: 'Personnel security awareness training completion',
    query: 'SELECT * FROM training_records WHERE type = \'security\'',
    automatable: true,
    refreshInterval: 1440,
  },

  // Policy Documents
  {
    id: 'policy-security',
    type: 'policy-document',
    name: 'Security Policy Documents',
    description: 'Organizational security policies',
    location: '/docs/policies/security/',
    automatable: false,
  },
  {
    id: 'policy-incident',
    type: 'policy-document',
    name: 'Incident Response Plan',
    description: 'Cyber security incident response procedures',
    location: '/docs/policies/incident-response.pdf',
    automatable: false,
  },

  // Change Management
  {
    id: 'change-requests',
    type: 'change-request',
    name: 'Change Request Records',
    description: 'Configuration change management records',
    query: 'SELECT * FROM change_requests',
    automatable: true,
    refreshInterval: 60,
  },

  // Network Diagrams
  {
    id: 'network-diagram',
    type: 'network-diagram',
    name: 'Network Architecture Diagram',
    description: 'Current network topology and ESP boundaries',
    location: '/docs/architecture/network-diagram.pdf',
    automatable: false,
  },
];

/**
 * CIP-002: BES Cyber System Categorization
 */
const CIP_002_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-002-R1',
    standard: 'CIP-002',
    section: 'R1',
    title: 'BES Cyber System Identification',
    description: 'Identify and categorize BES Cyber Systems that perform or support reliability functions.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['asset-inventory', 'network-diagram'],
    controlMappings: [
      {
        featureId: 'asset-management',
        featureName: 'Asset Management Module',
        featureDescription: '0xSCADA asset tracking and categorization',
        coverageLevel: 'full',
        implementationNotes: 'Use asset management to maintain BES Cyber System inventory with impact ratings',
      },
    ],
    violationRisk: 'Unidentified BES Cyber Systems may lack required protections',
    remediationGuidance: 'Conduct comprehensive asset discovery and categorization assessment',
  },
  {
    id: 'CIP-002-R2',
    standard: 'CIP-002',
    section: 'R2',
    title: 'BES Cyber System Categorization Review',
    description: 'Review and approve the identification and categorization at least once every 15 months.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['asset-inventory', 'audit-log-config', 'change-requests'],
    controlMappings: [
      {
        featureId: 'compliance-scheduler',
        featureName: 'Compliance Assessment Scheduler',
        featureDescription: 'Automated scheduling of compliance reviews',
        coverageLevel: 'full',
        implementationNotes: 'Configure 15-month review cycle for BES categorization',
      },
    ],
    violationRisk: 'Outdated categorization may result in inadequate protection levels',
    remediationGuidance: 'Establish documented review process with management approval',
  },
];

/**
 * CIP-003: Security Management Controls
 */
const CIP_003_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-003-R1',
    standard: 'CIP-003',
    section: 'R1',
    title: 'Cyber Security Policy',
    description: 'Document and implement cyber security policies addressing CIP requirements.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['policy-security'],
    controlMappings: [
      {
        featureId: 'policy-management',
        featureName: 'Policy Document Management',
        featureDescription: 'Centralized policy storage and version control',
        coverageLevel: 'partial',
        implementationNotes: 'Policies must be created and maintained outside system; 0xSCADA provides storage and tracking',
      },
    ],
    violationRisk: 'Lack of documented policies may lead to inconsistent security practices',
    remediationGuidance: 'Develop comprehensive cyber security policy covering all CIP standards',
  },
  {
    id: 'CIP-003-R2',
    standard: 'CIP-003',
    section: 'R2',
    title: 'CIP Senior Manager',
    description: 'Designate a single senior manager responsible for CIP compliance.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['policy-security', 'access-users'],
    controlMappings: [
      {
        featureId: 'rbac',
        featureName: 'Role-Based Access Control',
        featureDescription: 'User role management with CIP Senior Manager role',
        coverageLevel: 'partial',
        implementationNotes: 'Create CIP Senior Manager role with appropriate permissions',
      },
    ],
    violationRisk: 'Unclear accountability for CIP compliance',
    remediationGuidance: 'Formally designate CIP Senior Manager with documented responsibilities',
  },
  {
    id: 'CIP-003-R3',
    standard: 'CIP-003',
    section: 'R3',
    title: 'Delegate Authority',
    description: 'Document any delegations of CIP Senior Manager authority.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'medium',
    evidenceSources: ['policy-security', 'access-users', 'access-roles'],
    controlMappings: [
      {
        featureId: 'rbac',
        featureName: 'Role-Based Access Control',
        featureDescription: 'Delegation tracking through role assignments',
        coverageLevel: 'full',
        implementationNotes: 'Track delegations through role hierarchy and audit logs',
      },
    ],
    violationRisk: 'Undocumented delegations may create compliance gaps',
    remediationGuidance: 'Document all delegations with scope and limitations',
  },
];

/**
 * CIP-004: Personnel & Training
 */
const CIP_004_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-004-R1',
    standard: 'CIP-004',
    section: 'R1',
    title: 'Security Awareness Program',
    description: 'Implement a security awareness program for personnel with access to BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['training-records', 'policy-security'],
    controlMappings: [
      {
        featureId: 'training-management',
        featureName: 'Training Management',
        featureDescription: 'Track security awareness training completion',
        coverageLevel: 'full',
        implementationNotes: 'Configure quarterly security awareness training requirements',
      },
    ],
    violationRisk: 'Untrained personnel may introduce security vulnerabilities',
    remediationGuidance: 'Establish quarterly security awareness reinforcement program',
  },
  {
    id: 'CIP-004-R2',
    standard: 'CIP-004',
    section: 'R2',
    title: 'Cyber Security Training',
    description: 'Provide role-specific cyber security training prior to granting access.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'high',
    evidenceSources: ['training-records', 'access-users', 'audit-log-access'],
    controlMappings: [
      {
        featureId: 'access-provisioning',
        featureName: 'Access Provisioning Workflow',
        featureDescription: 'Training verification before access grant',
        coverageLevel: 'full',
        implementationNotes: 'Block access provisioning until training completion verified',
      },
    ],
    violationRisk: 'Personnel may access systems without required competencies',
    remediationGuidance: 'Implement training gate in access provisioning workflow',
  },
  {
    id: 'CIP-004-R3',
    standard: 'CIP-004',
    section: 'R3',
    title: 'Personnel Risk Assessment',
    description: 'Conduct personnel risk assessment (PRA) for individuals with access.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'high',
    evidenceSources: ['access-users', 'audit-log-access'],
    controlMappings: [
      {
        featureId: 'pra-tracking',
        featureName: 'PRA Tracking',
        featureDescription: 'Track personnel risk assessment status',
        coverageLevel: 'partial',
        implementationNotes: 'Store PRA completion dates; actual PRA conducted externally',
      },
    ],
    violationRisk: 'Unsuitable personnel may have BES access',
    remediationGuidance: 'Implement PRA verification before access provisioning',
  },
  {
    id: 'CIP-004-R4',
    standard: 'CIP-004',
    section: 'R4',
    title: 'Access Management',
    description: 'Implement access management program for BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['access-users', 'access-roles', 'audit-log-access'],
    controlMappings: [
      {
        featureId: 'rbac',
        featureName: 'Role-Based Access Control',
        featureDescription: 'Comprehensive RBAC implementation',
        coverageLevel: 'full',
        implementationNotes: 'Configure RBAC with principle of least privilege',
      },
    ],
    violationRisk: 'Unauthorized access to BES Cyber Systems',
    remediationGuidance: 'Review and tighten access permissions quarterly',
  },
  {
    id: 'CIP-004-R5',
    standard: 'CIP-004',
    section: 'R5',
    title: 'Access Revocation',
    description: 'Revoke access within required timeframes upon personnel termination or reassignment.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['access-users', 'audit-log-access', 'audit-log-auth'],
    controlMappings: [
      {
        featureId: 'access-revocation',
        featureName: 'Automated Access Revocation',
        featureDescription: 'Immediate access revocation workflow',
        coverageLevel: 'full',
        implementationNotes: 'Configure immediate revocation triggers from HR system integration',
      },
    ],
    violationRisk: 'Former personnel may retain unauthorized access',
    remediationGuidance: 'Implement automated access revocation with HR system integration',
  },
];

/**
 * CIP-005: Electronic Security Perimeters
 */
const CIP_005_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-005-R1',
    standard: 'CIP-005',
    section: 'R1',
    title: 'Electronic Security Perimeter',
    description: 'Implement Electronic Security Perimeters (ESPs) to protect BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'critical',
    evidenceSources: ['network-diagram', 'config-network'],
    controlMappings: [
      {
        featureId: 'network-segmentation',
        featureName: 'Network Segmentation',
        featureDescription: 'ESP implementation through network architecture',
        coverageLevel: 'full',
        implementationNotes: 'Define ESP boundaries in network configuration',
      },
    ],
    violationRisk: 'BES Cyber Systems exposed to external threats',
    remediationGuidance: 'Implement and document ESP boundaries with firewall rules',
  },
  {
    id: 'CIP-005-R2',
    standard: 'CIP-005',
    section: 'R2',
    title: 'Interactive Remote Access Management',
    description: 'Implement controls for interactive remote access to BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'critical',
    evidenceSources: ['config-network', 'audit-log-auth', 'config-crypto'],
    controlMappings: [
      {
        featureId: 'remote-access',
        featureName: 'Secure Remote Access',
        featureDescription: 'Multi-factor authentication and encrypted sessions',
        coverageLevel: 'full',
        implementationNotes: 'Enforce MFA and encryption for all remote access',
      },
    ],
    violationRisk: 'Unauthorized remote access to BES systems',
    remediationGuidance: 'Implement intermediate system and multi-factor authentication',
  },
];

/**
 * CIP-007: System Security Management
 */
const CIP_007_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-007-R1',
    standard: 'CIP-007',
    section: 'R1',
    title: 'Ports and Services',
    description: 'Disable unnecessary ports and services on BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['config-network', 'vuln-scan'],
    controlMappings: [
      {
        featureId: 'hardening',
        featureName: 'System Hardening',
        featureDescription: 'Minimal ports and services configuration',
        coverageLevel: 'full',
        implementationNotes: 'Apply CIS benchmark hardening guidelines',
      },
    ],
    violationRisk: 'Unnecessary attack surface on BES systems',
    remediationGuidance: 'Conduct port scan and disable non-essential services',
  },
  {
    id: 'CIP-007-R2',
    standard: 'CIP-007',
    section: 'R2',
    title: 'Security Patch Management',
    description: 'Implement patch management process for BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['patch-status', 'change-requests', 'vuln-scan'],
    controlMappings: [
      {
        featureId: 'patch-management',
        featureName: 'Patch Management',
        featureDescription: 'Automated patch tracking and deployment',
        coverageLevel: 'full',
        implementationNotes: 'Configure 35-day patch evaluation cycle',
      },
    ],
    violationRisk: 'Unpatched vulnerabilities may be exploited',
    remediationGuidance: 'Implement patch evaluation within 35 days of release',
  },
  {
    id: 'CIP-007-R3',
    standard: 'CIP-007',
    section: 'R3',
    title: 'Malicious Code Prevention',
    description: 'Deploy methods to prevent malicious code execution.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['config-network', 'audit-log-security'],
    controlMappings: [
      {
        featureId: 'malware-prevention',
        featureName: 'Malware Prevention',
        featureDescription: 'Anti-malware and application whitelisting',
        coverageLevel: 'partial',
        implementationNotes: 'Application whitelisting on BES systems',
      },
    ],
    violationRisk: 'Malware infection of BES Cyber Systems',
    remediationGuidance: 'Deploy endpoint protection with signature updates',
  },
  {
    id: 'CIP-007-R4',
    standard: 'CIP-007',
    section: 'R4',
    title: 'Security Event Monitoring',
    description: 'Log and monitor security events on BES Cyber Systems.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['audit-log-security', 'audit-log-auth', 'audit-log-access'],
    controlMappings: [
      {
        featureId: 'siem',
        featureName: 'Security Event Monitoring',
        featureDescription: 'Centralized security event logging and alerting',
        coverageLevel: 'full',
        implementationNotes: 'Configure 90-day log retention and real-time alerting',
      },
    ],
    violationRisk: 'Security incidents may go undetected',
    remediationGuidance: 'Implement SIEM with real-time alerting',
  },
  {
    id: 'CIP-007-R5',
    standard: 'CIP-007',
    section: 'R5',
    title: 'System Access Controls',
    description: 'Implement authentication and access controls.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['config-access', 'audit-log-auth'],
    controlMappings: [
      {
        featureId: 'authentication',
        featureName: 'Strong Authentication',
        featureDescription: 'Password policies and multi-factor authentication',
        coverageLevel: 'full',
        implementationNotes: 'Enforce complex passwords and MFA for privileged access',
      },
    ],
    violationRisk: 'Weak authentication enables unauthorized access',
    remediationGuidance: 'Implement password complexity and account lockout policies',
  },
];

/**
 * CIP-010: Configuration Change Management
 */
const CIP_010_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-010-R1',
    standard: 'CIP-010',
    section: 'R1',
    title: 'Configuration Change Management',
    description: 'Implement configuration change management process.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'critical',
    evidenceSources: ['change-requests', 'audit-log-config', 'config-network'],
    controlMappings: [
      {
        featureId: 'change-management',
        featureName: 'Configuration Change Management',
        featureDescription: 'Tracked and approved configuration changes',
        coverageLevel: 'full',
        implementationNotes: 'All changes require approval workflow and documentation',
      },
    ],
    violationRisk: 'Unauthorized changes may introduce vulnerabilities',
    remediationGuidance: 'Implement formal change approval workflow',
  },
  {
    id: 'CIP-010-R2',
    standard: 'CIP-010',
    section: 'R2',
    title: 'Configuration Monitoring',
    description: 'Monitor for unauthorized configuration changes.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'high',
    evidenceSources: ['audit-log-config', 'audit-log-security'],
    controlMappings: [
      {
        featureId: 'config-monitoring',
        featureName: 'Configuration Monitoring',
        featureDescription: 'Real-time configuration change detection',
        coverageLevel: 'full',
        implementationNotes: 'Alert on unauthorized configuration modifications',
      },
    ],
    violationRisk: 'Unauthorized changes may go undetected',
    remediationGuidance: 'Implement file integrity monitoring',
  },
  {
    id: 'CIP-010-R3',
    standard: 'CIP-010',
    section: 'R3',
    title: 'Vulnerability Assessments',
    description: 'Conduct vulnerability assessments at least every 15 months.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: false },
    priority: 'high',
    evidenceSources: ['vuln-scan'],
    controlMappings: [
      {
        featureId: 'vuln-assessment',
        featureName: 'Vulnerability Assessment',
        featureDescription: 'Scheduled vulnerability scanning',
        coverageLevel: 'full',
        implementationNotes: 'Configure quarterly vulnerability scans',
      },
    ],
    violationRisk: 'Unknown vulnerabilities may be exploited',
    remediationGuidance: 'Schedule regular vulnerability assessments',
  },
];

/**
 * CIP-011: Information Protection
 */
const CIP_011_REQUIREMENTS: CIPRequirement[] = [
  {
    id: 'CIP-011-R1',
    standard: 'CIP-011',
    section: 'R1',
    title: 'Information Protection',
    description: 'Implement methods to protect BES Cyber System Information.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'high',
    evidenceSources: ['config-crypto', 'policy-security', 'audit-log-access'],
    controlMappings: [
      {
        featureId: 'data-protection',
        featureName: 'Data Protection',
        featureDescription: 'Encryption and access controls for sensitive data',
        coverageLevel: 'full',
        implementationNotes: 'Encrypt BES Cyber System Information at rest and in transit',
      },
    ],
    violationRisk: 'Sensitive information may be disclosed',
    remediationGuidance: 'Implement data classification and encryption policies',
  },
  {
    id: 'CIP-011-R2',
    standard: 'CIP-011',
    section: 'R2',
    title: 'BES Cyber Asset Reuse and Disposal',
    description: 'Prevent unauthorized retrieval of BES Cyber System Information from disposed assets.',
    applicability: { highImpact: true, mediumImpact: true, lowImpact: true },
    priority: 'medium',
    evidenceSources: ['asset-inventory', 'audit-log-config'],
    controlMappings: [
      {
        featureId: 'asset-disposal',
        featureName: 'Secure Asset Disposal',
        featureDescription: 'Track and verify secure data destruction',
        coverageLevel: 'partial',
        implementationNotes: 'Track disposal certificates; physical destruction done externally',
      },
    ],
    violationRisk: 'Sensitive data may be recovered from disposed assets',
    remediationGuidance: 'Implement documented data sanitization procedures',
  },
];

/**
 * All CIP Requirements combined
 */
export const CIP_REQUIREMENTS: CIPRequirement[] = [
  ...CIP_002_REQUIREMENTS,
  ...CIP_003_REQUIREMENTS,
  ...CIP_004_REQUIREMENTS,
  ...CIP_005_REQUIREMENTS,
  ...CIP_007_REQUIREMENTS,
  ...CIP_010_REQUIREMENTS,
  ...CIP_011_REQUIREMENTS,
];

/**
 * Get requirements by standard
 */
export function getRequirementsByStandard(standard: CIPStandard): CIPRequirement[] {
  return CIP_REQUIREMENTS.filter((req) => req.standard === standard);
}

/**
 * Get requirement by ID
 */
export function getRequirementById(id: string): CIPRequirement | undefined {
  return CIP_REQUIREMENTS.find((req) => req.id === id);
}

/**
 * Get evidence source by ID
 */
export function getEvidenceSourceById(id: string): EvidenceSource | undefined {
  return EVIDENCE_SOURCES.find((source) => source.id === id);
}

/**
 * Get all applicable requirements for an impact rating
 */
export function getRequirementsByImpact(impact: 'high' | 'medium' | 'low'): CIPRequirement[] {
  return CIP_REQUIREMENTS.filter((req) => {
    switch (impact) {
      case 'high':
        return req.applicability.highImpact;
      case 'medium':
        return req.applicability.mediumImpact;
      case 'low':
        return req.applicability.lowImpact;
    }
  });
}

/**
 * Standard metadata
 */
export const CIP_STANDARDS: Record<CIPStandard, { title: string; description: string }> = {
  'CIP-002': {
    title: 'BES Cyber System Categorization',
    description: 'Identify and categorize BES Cyber Systems based on impact to the BES',
  },
  'CIP-003': {
    title: 'Security Management Controls',
    description: 'Specify consistent and sustainable security management controls',
  },
  'CIP-004': {
    title: 'Personnel & Training',
    description: 'Minimize risk of personnel actions compromising BES Cyber Systems',
  },
  'CIP-005': {
    title: 'Electronic Security Perimeters',
    description: 'Manage electronic access to BES Cyber Systems',
  },
  'CIP-007': {
    title: 'System Security Management',
    description: 'Manage system security with defined technical and procedural controls',
  },
  'CIP-010': {
    title: 'Configuration Change Management',
    description: 'Prevent and detect unauthorized changes to BES Cyber Systems',
  },
  'CIP-011': {
    title: 'Information Protection',
    description: 'Prevent unauthorized access to BES Cyber System Information',
  },
  'CIP-013': {
    title: 'Supply Chain Risk Management',
    description: 'Mitigate cyber security risks from supply chain',
  },
  'CIP-014': {
    title: 'Physical Security',
    description: 'Physical security of transmission stations and substations',
  },
};
