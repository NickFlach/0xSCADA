import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { _resetControlPlaneAuthCache } from '../../middleware/control-plane-auth';
import { remediationRuntime } from '../../services/sre';
import { sreReadinessRoutes } from '../sre-readiness';

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
  app.use('/api/governance', sreReadinessRoutes);
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
