/**
 * Authorization contract for the Validator Dashboard proxy (issue #453).
 *
 * The route replaces browser-side node polling, so it is the only path an
 * operator has to the fleet's topology and health. It must fail closed for
 * anonymous callers and reject credentials that lack `validators.read` — the
 * review explicitly rejected an unauthenticated read surface.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

import { _resetControlPlaneAuthCache } from '../../middleware/control-plane-auth';
import { _resetValidatorDashboardCache } from '../../blockchain/validator-dashboard';
import { validatorRoutes } from '../validators';

let server: Server;
let baseUrl: string;

const originalApiKeys = process.env.API_KEYS;
const originalNodeUrls = process.env.ANCHOR_NODE_URLS;

beforeAll(async () => {
  process.env.API_KEYS = [
    'reader-key:validator-reader:validators.read',
    'other-key:other-service:twin.read',
    'admin-key:platform-admin:admin',
  ].join(',');
  // Unset so the route performs no outbound request during the auth tests.
  delete process.env.ANCHOR_NODE_URLS;
  _resetControlPlaneAuthCache();
  _resetValidatorDashboardCache();

  const app = express();
  app.use(express.json());
  app.use('/api/validators', validatorRoutes);

  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  if (originalNodeUrls === undefined) delete process.env.ANCHOR_NODE_URLS;
  else process.env.ANCHOR_NODE_URLS = originalNodeUrls;
  _resetControlPlaneAuthCache();
  _resetValidatorDashboardCache();
});

describe('GET /api/validators authorization', () => {
  it('fails closed for an anonymous caller', async () => {
    const res = await fetch(`${baseUrl}/api/validators`);
    expect(res.status).toBe(401);
  });

  it('rejects an unknown credential', async () => {
    const res = await fetch(`${baseUrl}/api/validators`, {
      headers: { 'x-api-key': 'not-a-key' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a credential passed in the query string', async () => {
    const res = await fetch(`${baseUrl}/api/validators?api_key=reader-key`);
    expect(res.status).toBe(401);
  });

  it('rejects a credential from an unrelated service', async () => {
    const res = await fetch(`${baseUrl}/api/validators`, {
      headers: { 'x-api-key': 'other-key' },
    });
    expect(res.status).toBe(403);
  });

  it('allows the validators.read scope', async () => {
    const res = await fetch(`${baseUrl}/api/validators`, {
      headers: { 'x-api-key': 'reader-key' },
    });
    expect(res.status).toBe(200);
  });

  it('allows an admin credential', async () => {
    const res = await fetch(`${baseUrl}/api/validators`, {
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/validators response contract', () => {
  it('reports unconfigured and unverified provenance with no nodes configured', async () => {
    _resetValidatorDashboardCache();
    const res = await fetch(`${baseUrl}/api/validators`, {
      headers: { 'x-api-key': 'reader-key' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      configured: boolean;
      nodes: unknown[];
      provenance: { verified: boolean; method: string };
      unavailableMetrics: unknown[];
    };

    expect(body.configured).toBe(false);
    expect(body.nodes).toEqual([]);
    // Provenance is always present, and never claims verification this build
    // does not perform.
    expect(body.provenance.verified).toBe(false);
    expect(body.provenance.method).toBe('none');
    expect(body.unavailableMetrics.length).toBeGreaterThan(0);
  });
});
