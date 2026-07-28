import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { _resetControlPlaneAuthCache } from '../../middleware/control-plane-auth';
import { remediationRuntime } from '../../services/sre';
import { productionReadinessRoutes } from '../production-readiness';

let server: Server;
let baseUrl: string;
let replicas = 1;
const persistRemediation = vi.fn(async () => undefined);
const originalApiKeys = process.env.API_KEYS;

beforeAll(async () => {
  process.env.API_KEYS = [
    'sre-key:on-call-operator:sre.remediate+operator',
    'read-key:read-only:read',
  ].join(',');
  _resetControlPlaneAuthCache();
  remediationRuntime.configure({
    scaleOut: {
      currentReplicas: async () => replicas,
      setReplicas: async (_component, value) => { replicas = value; },
      readyReplicas: async () => replicas,
    },
    auditSink: { append: persistRemediation },
    policy: { cooldownMs: 0 },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/governance', productionReadinessRoutes);
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
  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  _resetControlPlaneAuthCache();
});

describe('governance compliance routes', () => {
  it('exposes the versioned control catalog', async () => {
    const response = await fetch(`${baseUrl}/compliance/rules?framework=IEC-62443`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.catalogVersion).toBe('2026.1');
    expect(body.rules.length).toBeGreaterThanOrEqual(7);
    expect(body.rules.every((rule: { framework: string }) => rule.framework === 'IEC-62443'))
      .toBe(true);
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

    const reportResponse = await fetch(`${baseUrl}/compliance/reports/${scan.scanId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization: 'Route Test Utility' }),
    });
    const report = await reportResponse.json();
    expect(reportResponse.status).toBe(200);
    expect(report.scanId).toBe(scan.scanId);
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

describe('governance capacity routes', () => {
  it('returns a complete resource, forecast, provider-cost, and trade-off plan', async () => {
    const response = await fetch(`${baseUrl}/capacity/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workload: {
          tagCount: 100_000,
          sampleIntervalSeconds: 1,
          retentionDays: 90,
        },
        history: [
          { timestamp: '2026-01-01T00:00:00.000Z', tagCount: 70_000 },
          { timestamp: '2026-02-01T00:00:00.000Z', tagCount: 76_000 },
          { timestamp: '2026-03-01T00:00:00.000Z', tagCount: 82_000 },
          { timestamp: '2026-04-01T00:00:00.000Z', tagCount: 88_000 },
        ],
        horizonMonths: 6,
        providers: ['aws', 'azure', 'gcp'],
      }),
    });
    const plan = await response.json();

    expect(response.status).toBe(200);
    expect(plan.current.totals.cpuCores).toBeGreaterThan(0);
    expect(plan.current.totals.storageGiB).toBeGreaterThan(0);
    expect(plan.forecast.projectedTagCount).toBeGreaterThan(100_000);
    expect(plan.cloudCosts.map((item: { provider: string }) => item.provider))
      .toEqual(['aws', 'azure', 'gcp']);
    expect(plan.scaling.options).toHaveLength(3);
  });

  it('fails closed without a tag count and publishes its model assumptions', async () => {
    const invalid = await fetch(`${baseUrl}/capacity/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeHorizon: 'medium', scenario: 'growth', metrics: ['cpu'] }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/tagCount is required/);

    const model = await fetch(`${baseUrl}/capacity/model`);
    const body = await model.json();
    expect(model.status).toBe(200);
    expect(body.resourceCoefficients.cpuMillicoresPerTagAtOneSecond).toBe(0.05);
    expect(Object.keys(body.cloudRateCards).sort()).toEqual(['aws', 'azure', 'gcp']);
  });
});

describe('governance SLO routes', () => {
  it('lists critical-path definitions and evaluates observations', async () => {
    const catalogResponse = await fetch(`${baseUrl}/sre/slos`);
    const catalog = await catalogResponse.json();
    expect(catalogResponse.status).toBe(200);
    expect(catalog.slos.length).toBeGreaterThanOrEqual(7);

    const response = await fetch(`${baseUrl}/sre/slos/tag-ingest-freshness/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        observations: [{
          timestamp: new Date().toISOString(),
          goodEvents: 9_990,
          totalEvents: 10_000,
        }],
      }),
    });
    const evaluation = await response.json();
    expect(response.status).toBe(200);
    expect(evaluation).toMatchObject({
      sloId: 'tag-ingest-freshness',
      status: 'breached',
      goodEvents: 9_990,
      totalEvents: 10_000,
    });
  });
});

describe('governance SRE remediation routes', () => {
  const executeUrl = () => `${baseUrl}/sre/remediations/execute`;
  const request = (apiKey?: string, body: unknown = {}) => fetch(executeUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    },
    body: JSON.stringify(body),
  });

  it('authenticates and authorizes before parsing remediation input', async () => {
    expect((await request()).status).toBe(401);
    expect((await request('read-key')).status).toBe(403);
  });

  it('defaults to dry-run and executes only a bounded, durably audited apply request', async () => {
    const context = { component: 'api', desiredReplicas: 3, maximumReplicas: 4 };
    const dryRun = await request('sre-key', {
      actionId: 'scale-out',
      context,
      idempotencyKey: 'route-scale-plan',
      approvedBy: 'attacker-controlled',
    });
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({ status: 'planned', dryRun: true });
    expect(replicas).toBe(1);

    const apply = await request('sre-key', {
      actionId: 'scale-out',
      context,
      idempotencyKey: 'route-scale-apply',
      dryRun: false,
    });
    const result = await apply.json();
    expect(apply.status).toBe(200);
    expect(result).toMatchObject({ status: 'succeeded', dryRun: false, changed: true });
    expect(replicas).toBe(3);
    expect(persistRemediation).toHaveBeenCalledWith(expect.objectContaining({
      executionId: result.executionId,
      status: 'succeeded',
      approvedBy: 'on-call-operator',
    }));
  });
});
