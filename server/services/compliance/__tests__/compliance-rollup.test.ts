/**
 * Pins the scan-level status rollup, and specifically the `incomplete` branch.
 *
 * `runScan` resolves a scan to:
 *
 *   failed > 0        -> 'non-compliant'
 *   notAssessed > 0   -> 'incomplete'
 *   otherwise         -> 'compliant'
 *
 * The existing suite asserts `compliant` and `non-compliant`, and asserts
 * `summary.notAssessed` counts and per-control `not-assessed` statuses — but
 * never the scan-level `incomplete`. Mutation testing confirmed the middle
 * branch could be deleted entirely (collapsing unassessed scans to
 * `compliant`) with all 14 tests still green.
 *
 * That is the one regression which reproduces the exact defect this module was
 * written to remove: #605/#638 flagged the old service for fabricating results
 * with `Math.random()`, and the fix was to distinguish "assessed and passing"
 * from "never assessed". A rollup that reports `compliant` for controls it
 * never looked at asserts compliance nobody measured — and on an IEC 62443 /
 * NIST CSF surface that assertion ends up in an audit packet.
 *
 * Each case isolates one branch so a failure names which transition broke.
 */
import { describe, expect, it } from 'vitest';

import {
  COMPLIANCE_CONTROL_CATALOG,
  COMPLIANCE_EVIDENCE_REQUIREMENTS,
  ComplianceScanner,
  type ComplianceEvidence,
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

function evidenceFor(keys: readonly string[]): ComplianceEvidence[] {
  return [...keys].sort().map(key => ({
    key,
    value: passingValue(key),
    source: 'unit-test',
    collectedAt: FIXED_DATE.toISOString(),
  }));
}

function allEvidenceKeys(): string[] {
  return [...new Set(COMPLIANCE_CONTROL_CATALOG.flatMap(control => control.evidenceKeys))].sort();
}

describe('compliance scan status rollup', () => {
  it('reports incomplete — never compliant — when controls were not assessed', async () => {
    // No evidence at all: nothing can pass, but nothing failed either. The
    // scan must not present this as compliance.
    const scan = await new ComplianceScanner({ now }).runScan({
      frameworks: ['IEC-62443'],
      evidence: [],
    });

    expect(scan.summary.notAssessed).toBeGreaterThan(0);
    // Isolate the branch: with no failures, the only thing separating
    // 'incomplete' from 'compliant' is the notAssessed count.
    expect(scan.summary.failed).toBe(0);
    expect(scan.status).toBe('incomplete');
  });

  it('still reports incomplete when some controls pass and others are unassessed', async () => {
    // The partial case, which is what a real deployment looks like mid-rollout.
    // Supply every evidence key for exactly one control — enough for that
    // control to pass, leaving the rest unassessed. Passing controls must not
    // mask the gap.
    const iecControls = COMPLIANCE_CONTROL_CATALOG.filter(
      control => control.evidenceKeys.length > 0,
    );
    const oneControl = iecControls[0];
    const scan = await new ComplianceScanner({ now }).runScan({
      frameworks: ['IEC-62443'],
      evidence: evidenceFor(oneControl.evidenceKeys),
    });

    expect(scan.summary.passed).toBeGreaterThan(0);
    expect(scan.summary.notAssessed).toBeGreaterThan(0);
    expect(scan.summary.failed).toBe(0);
    expect(scan.status).toBe('incomplete');
  });

  it('reports compliant only when every control was assessed and passed', async () => {
    const scan = await new ComplianceScanner({ now }).runScan({
      frameworks: ['IEC-62443'],
      evidence: evidenceFor(allEvidenceKeys()),
    });

    expect(scan.summary.notAssessed).toBe(0);
    expect(scan.summary.failed).toBe(0);
    expect(scan.status).toBe('compliant');
  });

  it('a failure outranks an unassessed control', async () => {
    // Both branches active at once: failed > 0 must win, so an operator is
    // told about the failure rather than merely that the scan was partial.
    const keys = allEvidenceKeys();
    const failing: ComplianceEvidence[] = [
      {
        key: keys[0],
        value: false,
        source: 'unit-test',
        collectedAt: FIXED_DATE.toISOString(),
      },
    ];

    const scan = await new ComplianceScanner({ now }).runScan({
      frameworks: ['IEC-62443'],
      evidence: failing,
    });

    expect(scan.summary.failed).toBeGreaterThan(0);
    expect(scan.summary.notAssessed).toBeGreaterThan(0);
    expect(scan.status).toBe('non-compliant');
  });
});
