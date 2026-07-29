import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { complianceReadinessRoutes } from '../compliance-readiness';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/governance', complianceReadinessRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/api/governance`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

describe('governance compliance routes', () => {
  it('exposes the versioned control catalog and typed evidence contract', async () => {
    const response = await fetch(`${baseUrl}/compliance/rules?framework=IEC-62443`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.catalogVersion).toBe('2026.1');
    expect(body.rules.length).toBeGreaterThanOrEqual(7);
    expect(body.rules.every((rule: { framework: string }) => rule.framework === 'IEC-62443'))
      .toBe(true);
    expect(body.evidenceRequirements['identity.adminMfa'].kind).toBe('true-attestation');
  });

  it('runs a real targeted evidence scan and generates its audit report', async () => {
    const response = await fetch(`${baseUrl}/compliance/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'targeted',
        frameworks: ['IEC-62443'],
        targetSecurityLevel: 1,
        controlIds: ['IEC62443-FR1-IAC-1'],
        evidence: [
          {
            key: 'identity.uniqueUsers',
            value: true,
            source: 'iam-export',
            collectedAt: '2026-07-28T12:00:00.000Z',
          },
          {
            key: 'identity.serviceAccountsInventoried',
            value: true,
            source: 'cmdb-export',
            collectedAt: '2026-07-28T12:00:00.000Z',
          },
        ],
      }),
    });
    const scan = await response.json();
    expect(response.status).toBe(200);
    expect(scan).toMatchObject({
      status: 'compliant',
      complianceScore: 100,
      summary: { total: 1, passed: 1, failed: 0, notAssessed: 0 },
    });
    expect(scan.iec62443.achievedSecurityLevel).toBe(0);

    const reportResponse = await fetch(`${baseUrl}/compliance/reports/${scan.scanId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization: 'Route Test Utility' }),
    });
    const report = await reportResponse.json();
    expect(reportResponse.status).toBe(200);
    expect(report.scanId).toBe(scan.scanId);
    expect(report.scope).toBe('Targeted controls: IEC62443-FR1-IAC-1');
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a scheduled request instead of pretending it was scheduled', async () => {
    const response = await fetch(`${baseUrl}/compliance/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: true }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/COMPLIANCE_SCAN_INTERVAL_MS/);
  });
});
