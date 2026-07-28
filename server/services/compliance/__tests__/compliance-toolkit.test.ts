import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_CONTROL_CATALOG,
  ComplianceScanner,
  ComplianceService,
  ObjectEvidenceCollector,
  type ComplianceEvidence,
  type EvidenceCollector,
} from '../index';

const FIXED_DATE = new Date('2026-07-28T12:00:00.000Z');
const now = () => new Date(FIXED_DATE);

function evidenceForAll(value: boolean = true): ComplianceEvidence[] {
  const keys = new Set(COMPLIANCE_CONTROL_CATALOG.flatMap(control => control.evidenceKeys));
  return [...keys].sort().map(key => ({
    key,
    value,
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

  it('generates a certification-ready, content-addressed audit report', async () => {
    const scanner = new ComplianceScanner({ now });
    const scan = await scanner.runScan({
      frameworks: ['IEC-62443', 'NIST-CSF'],
      targetSecurityLevel: 2,
      evidence: evidenceForAll(),
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
    expect(service.generateAuditReport(second.scanId, { organization: 'Test Org' }).scanId)
      .toBe(second.scanId);
    service.shutdown();
  });
});
