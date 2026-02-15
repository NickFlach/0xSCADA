import { describe, it, expect } from 'vitest';
import { ComplianceScanner } from '../../compliance/compliance-scanner';

describe('ComplianceScanner', () => {
  it('should list IEC 62443 controls', () => {
    const scanner = new ComplianceScanner();
    const controls = scanner.getControls('IEC-62443');
    expect(controls.length).toBeGreaterThan(0);
    expect(controls[0].framework).toBe('IEC-62443');
  });

  it('should list NIST CSF controls', () => {
    const scanner = new ComplianceScanner();
    const controls = scanner.getControls('NIST-CSF');
    expect(controls.length).toBeGreaterThan(0);
  });

  it('should run scan and produce report', async () => {
    const scanner = new ComplianceScanner();
    const report = await scanner.runScan('IEC-62443');

    expect(report.framework).toBe('IEC-62443');
    expect(report.totalControls).toBeGreaterThan(0);
    expect(report.checks).toHaveLength(report.totalControls);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
  });

  it('should register and run automated checks', async () => {
    const scanner = new ComplianceScanner();
    scanner.registerAutomatedCheck('IEC-1.1', async () => ({
      controlId: 'IEC-1.1',
      status: 'pass',
      evidence: ['Security policy document exists'],
      findings: [],
      timestamp: Date.now(),
    }));

    const report = await scanner.runScan('IEC-62443');
    const check = report.checks.find((c) => c.controlId === 'IEC-1.1');
    expect(check?.status).toBe('pass');
  });

  it('should identify gaps in report', async () => {
    const scanner = new ComplianceScanner();
    const report = await scanner.runScan();

    // All controls untested = all are gaps
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.gaps[0].priority).toBeDefined();
  });
});
