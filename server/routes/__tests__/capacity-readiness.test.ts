import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { capacityReadinessRoutes } from '../capacity-readiness';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/governance', capacityReadinessRoutes);
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

  it('refuses to fabricate capacity trends without observations', async () => {
    const response = await fetch(`${baseUrl}/capacity/trends`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/POST \/capacity\/forecast/);
  });
});
