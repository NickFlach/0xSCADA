import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_CONTROL_CATALOG,
  COMPLIANCE_EVIDENCE_REQUIREMENTS,
  ComplianceScanner,
  ComplianceService,
  JsonFileEvidenceCollector,
  ObjectEvidenceCollector,
  type ComplianceEvidence,
  type EvidenceCollector,
} from '../index';

const FIXED_DATE = new Date('2026-07-28T12:00:00.000Z');
const now = () => new Date(FIXED_DATE);

function passingValue(key: string): ComplianceEvidence['value'] {
  const requirement = COMPLIANCE_EVIDENCE_REQUIREMENTS[key];
  if (requirement.kind === 'positive-number') return 30;
  if (requirement.kind === 'non-empty-string') return 'security-operations';
  if (requirement.kind === 'non-empty-string-list') return ['zone-a', 'zone-b'];
  return true;
}

function evidenceForAll(value?: boolean): ComplianceEvidence[] {
  const keys = new Set(COMPLIANCE_CONTROL_CATALOG.flatMap(control => control.evidenceKeys));
  return [...keys].sort().map(key => ({
    key,
    value: value ?? passingValue(key),
    source: 'unit-test',
    collectedAt: FIXED_DATE.toISOString(),
  }));
}

describe('ComplianceScanner', () => {
  it('assesses IEC 62443 security levels from explicit evidence', async () => {
    const scanner = new ComplianceScanner({ now });
    const scan = await scanner.runScan({
      frameworks: ['IEC-62443'],
      targetSecurityLevel: 4,
      evidence: evidenceForAll(),
    });

    expect(scan.status).toBe('compliant');
    expect(scan.summary.failed).toBe(0);
    expect(scan.summary.notAssessed).toBe(0);
    expect(scan.complianceScore).toBe(100);
    expect(scan.iec62443?.achievedSecurityLevel).toBe(4);
    expect(scan.iec62443?.foundationalRequirements).toHaveLength(7);
    expect(scan.scanId).toMatch(/^scan-[0-9a-f]{16}$/);
  });

  it('distinguishes missing evidence from negative evidence in gap analysis', async () => {
    const scanner = new ComplianceScanner({ now });
    const evidence = evidenceForAll().filter(item => item.key !== 'access.defaultDeny');
    const mfa = evidence.find(item => item.key === 'identity.adminMfa');
    if (mfa) mfa.value = false;

    const scan = await scanner.runScan({
      frameworks: ['IEC-62443'],
      targetSecurityLevel: 2,
      evidence,
    });

    const accessGap = scan.gaps.find(gap => gap.controlId === 'IEC62443-FR2-UC-1');
    const mfaGap = scan.gaps.find(gap => gap.controlId === 'IEC62443-SL2-IAC-2');
    expect(accessGap).toMatchObject({
      status: 'not-assessed',
      missingEvidenceKeys: ['access.defaultDeny'],
    });
    expect(mfaGap).toMatchObject({
      status: 'fail',
      failedEvidenceKeys: ['identity.adminMfa'],
    });
    expect(scan.status).toBe('non-compliant');
    expect(scan.iec62443?.achievedSecurityLevel).toBe(0);
  });

  it('maps results across all six NIST CSF functions', async () => {
    const scanner = new ComplianceScanner({ now });
    const scan = await scanner.runScan('NIST-CSF', evidenceForAll());

    expect(scan.nistCsf?.functions.map(item => item.function)).toEqual([
      'Govern',
      'Identify',
      'Protect',
      'Detect',
      'Respond',
      'Recover',
    ]);
    expect(scan.nistCsf?.functions.every(item => item.score === 100)).toBe(true);
    expect(
      scan.controls.find(control => control.controlId === 'NIST-PR.AA-01')?.mappedControlIds,
    ).toContain('IEC62443-FR1-IAC-1');
  });

  it('collects and de-duplicates automated evidence deterministically', async () => {
    const collector = new ObjectEvidenceCollector(
      'deployment-config',
      { 'identity.uniqueUsers': true, 'identity.serviceAccountsInventoried': true },
      { now },
    );
    const scanner = new ComplianceScanner({ collectors: [collector], now });
    const scan = await scanner.runScan({
      frameworks: ['IEC-62443'],
      targetSecurityLevel: 1,
      controlIds: ['IEC62443-FR1-IAC-1'],
      evidence: [{
        key: 'identity.uniqueUsers',
        value: false,
        source: 'stale-snapshot',
        collectedAt: '2026-07-27T12:00:00.000Z',
      }],
    });

    expect(scan.status).toBe('compliant');
    expect(scan.evidence).toHaveLength(2);
    expect(scan.evidence.find(item => item.key === 'identity.uniqueUsers')?.source)
      .toBe('deployment-config');
  });

  it('fails closed when an evidence collector fails', async () => {
    const broken: EvidenceCollector = {
      id: 'broken',
      collect: async () => {
        throw new Error('collector offline');
      },
    };
    const scanner = new ComplianceScanner({ now });

    await expect(scanner.runScan({ collectors: [broken] }))
      .rejects.toThrow('Evidence collector broken failed: collector offline');
  });

  it('fails closed on false-like or wrongly typed evidence values', async () => {
    const scanner = new ComplianceScanner({ now });
    const scan = await scanner.runScan({
      frameworks: ['IEC-62443'],
      targetSecurityLevel: 2,
      controlIds: ['IEC62443-SL2-IAC-2'],
      evidence: [
        {
          key: 'identity.adminMfa',
          value: 'disabled',
          source: 'iam-export',
          collectedAt: FIXED_DATE.toISOString(),
        },
        {
          key: 'identity.remoteMfa',
          value: true,
          source: 'iam-export',
          collectedAt: FIXED_DATE.toISOString(),
        },
      ],
    });

    expect(scan.status).toBe('non-compliant');
    expect(scan.controls[0].invalidEvidence).toEqual([{
      key: 'identity.adminMfa',
      expected: 'true-attestation',
      reason: 'expected the boolean value true',
    }]);
  });

  it('does not overstate framework coverage for a passing targeted scan', async () => {
    const scanner = new ComplianceScanner({ now });
    const iec = await scanner.runScan({
      frameworks: ['IEC-62443'],
      targetSecurityLevel: 4,
      controlIds: ['IEC62443-FR1-IAC-1'],
      evidence: evidenceForAll(),
    });
    expect(iec.status).toBe('compliant');
    expect(iec.summary.total).toBe(1);
    expect(iec.iec62443?.achievedSecurityLevel).toBe(0);
    expect(iec.iec62443?.foundationalRequirements)
      .toContainEqual(expect.objectContaining({ family: 'FR 2 — Use control', status: 'not-assessed' }));
    expect(scanner.generateAuditReport(iec, { organization: 'Targeted Test' }).scope)
      .toBe('Targeted controls: IEC62443-FR1-IAC-1');

    const nist = await scanner.runScan({
      frameworks: ['NIST-CSF'],
      controlIds: ['NIST-PR.AA-01'],
      evidence: evidenceForAll(),
    });
    const protect = nist.nistCsf?.functions.find(item => item.function === 'Protect');
    expect(protect?.passed).toBe(1);
    expect(protect?.total).toBeGreaterThan(1);
    expect(protect?.score).toBeLessThan(100);
  });

  it('generates a certification-ready, content-addressed audit report', async () => {
    const scanner = new ComplianceScanner({ now });
    const evidence = evidenceForAll();
    evidence[0].source = 'unit-test | forged\n# row';
    const scan = await scanner.runScan({
      frameworks: ['IEC-62443', 'NIST-CSF'],
      targetSecurityLevel: 2,
      evidence,
    });
    const report = scanner.generateAuditReport(scan, {
      organization: 'Example Water Utility',
      auditor: 'Internal Audit',
      scope: 'Production control and historian services',
    });

    expect(report.reportId).toMatch(/^audit-[0-9a-f]{16}$/);
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.markdown).toContain('# IEC-62443 / NIST-CSF Compliance Audit Report');
    expect(report.markdown).toContain('## Evidence manifest');
    expect(report.markdown).toContain('does not replace, certification');
    expect(report.markdown).toContain('unit-test \\| forged \\# row');
    expect(report.markdown).not.toContain('\n# row');
    expect(report.markdown).toContain('- **Auditor:** Internal Audit');
    expect(report.evidenceManifest.length).toBeGreaterThan(10);
  });
});

describe('ComplianceService', () => {
  it('keeps bounded real scan history and resolves reports by scan id', async () => {
    const scanner = new ComplianceScanner({ now });
    const service = new ComplianceService({ scanner, maxHistory: 1 });
    await service.initialize();
    const first = await service.scan({
      frameworks: ['NIST-CSF'],
      evidence: evidenceForAll(),
    });
    const second = await service.scan({
      frameworks: ['IEC-62443'],
      evidence: evidenceForAll(false),
    });

    expect(service.getScans()).toHaveLength(1);
    expect(service.getScan(first.scanId)).toBeUndefined();
    expect(service.getScan(second.scanId)).toBeDefined();
    second.controls[0].status = 'pass';
    expect(service.getScan(second.scanId)?.controls[0].status).toBe('fail');
    expect(service.generateAuditReport(second.scanId, { organization: 'Test Org' }).scanId)
      .toBe(second.scanId);
    service.shutdown();
  });

  it('registers a concrete deployment evidence file and recurring scan at initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), '0xscada-compliance-'));
    const evidenceFile = join(directory, 'evidence.json');
    const previousFile = process.env.COMPLIANCE_EVIDENCE_FILE;
    const previousInterval = process.env.COMPLIANCE_SCAN_INTERVAL_MS;
    await writeFile(evidenceFile, JSON.stringify({
      source: 'deployment-snapshot',
      collectedAt: FIXED_DATE.toISOString(),
      evidence: {
        'identity.uniqueUsers': true,
        'identity.serviceAccountsInventoried': true,
      },
    }));
    process.env.COMPLIANCE_EVIDENCE_FILE = evidenceFile;
    process.env.COMPLIANCE_SCAN_INTERVAL_MS = '60000';
    const service = new ComplianceService({
      scanner: new ComplianceScanner({ now }),
      maxHistory: 2,
    });
    try {
      await service.initialize();
      expect(service.getStatus()).toMatchObject({
        initialized: true,
        collectors: ['deployment-evidence-file'],
        recurringScanIntervalMs: 60_000,
      });
      const scan = await service.scan({
        frameworks: ['IEC-62443'],
        targetSecurityLevel: 1,
        controlIds: ['IEC62443-FR1-IAC-1'],
      });
      expect(scan.status).toBe('compliant');
      expect(scan.evidence.every(item => item.source === 'deployment-snapshot')).toBe(true);
    } finally {
      service.shutdown();
      if (previousFile === undefined) delete process.env.COMPLIANCE_EVIDENCE_FILE;
      else process.env.COMPLIANCE_EVIDENCE_FILE = previousFile;
      if (previousInterval === undefined) delete process.env.COMPLIANCE_SCAN_INTERVAL_MS;
      else process.env.COMPLIANCE_SCAN_INTERVAL_MS = previousInterval;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid evidence file values instead of coercing them', async () => {
    const directory = await mkdtemp(join(tmpdir(), '0xscada-compliance-invalid-'));
    const evidenceFile = join(directory, 'evidence.json');
    await writeFile(evidenceFile, JSON.stringify({
      evidence: { 'identity.adminMfa': { enabled: true } },
    }));
    try {
      const collector = new JsonFileEvidenceCollector(evidenceFile);
      await expect(collector.collect()).rejects.toThrow(/unsupported value type/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
