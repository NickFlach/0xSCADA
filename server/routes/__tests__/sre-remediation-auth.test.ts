/**
 * Pins the *composition* of the remediation guard.
 *
 * `requireRemediationOperator` requires BOTH:
 *
 *   requireControlPlaneAccess({ roles: ['operator'], scopes: ['sre.remediate'] })
 *
 * The existing suite proves a guard is present — removing it entirely fails
 * two tests — but only ever authenticates with `sre-key`, which holds the role
 * and the scope together. Mutation testing showed either half could be dropped
 * on its own with every test still green:
 *
 *   drop `scopes: ['sre.remediate']`, keep the role   -> 3 passed
 *   drop `roles: ['operator']`, keep the scope        -> 3 passed
 *
 * That matters on this route because it can fail over gateways and change
 * replica counts in production. The central `mutationAuthorizationMiddleware`
 * policy still backstops the scope, so a degraded route guard is not currently
 * exploitable — but a guard that silently decays to role-only is one refactor
 * from being the only thing standing there.
 *
 * These tests exercise each half in isolation, in both directions, mirroring
 * what #620 established for `nlquery.read`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import { _resetControlPlaneAuthCache } from '../../middleware/control-plane-auth';
import { remediationRuntime } from '../../services/sre';
import { sreReadinessRoutes } from '../sre-readiness';

let server: Server;
let baseUrl: string;
let replicas = 1;
const originalApiKeys = process.env.API_KEYS;

beforeAll(async () => {
  process.env.API_KEYS = [
    // Holds both halves — the control, and what the existing suite uses.
    'both-key:on-call-operator:sre.remediate+operator',
    // Holds the SCOPE but confers no operator role.
    'scope-only-key:scope-only:sre.remediate',
    // Confers the operator ROLE but lacks the remediation scope.
    'role-only-key:role-only:operator',
  ].join(',');
  _resetControlPlaneAuthCache();

  remediationRuntime.configure({
    scaleOut: {
      currentReplicas: async () => replicas,
      setReplicas: async (_component, value) => {
        replicas = value;
      },
      readyReplicas: async () => replicas,
    },
    auditSink: { append: vi.fn(async () => undefined) },
    policy: { cooldownMs: 0 },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/governance', sreReadinessRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Test server did not bind');
  }
  baseUrl = `http://127.0.0.1:${address.port}/api/governance`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
  if (originalApiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = originalApiKeys;
  _resetControlPlaneAuthCache();
});

/** A well-formed dry-run apply; authorization is decided before it is parsed. */
const body = {
  actionId: 'scale-out',
  context: { component: 'api', desiredReplicas: 2, maximumReplicas: 4 },
  idempotencyKey: 'auth-composition-probe',
  dryRun: true,
};

function execute(apiKey?: string) {
  return fetch(`${baseUrl}/sre/remediations/execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey === undefined ? {} : { 'x-api-key': apiKey }),
    },
    body: JSON.stringify(body),
  });
}

function status(apiKey?: string) {
  return fetch(`${baseUrl}/sre/remediations/status`, {
    headers: apiKey === undefined ? {} : { 'x-api-key': apiKey },
  });
}

describe('remediation guard requires the scope AND the operator role', () => {
  it('accepts a principal holding both', async () => {
    expect((await execute('both-key')).status).toBe(200);
    expect((await status('both-key')).status).toBe(200);
  });

  it('rejects a principal with sre.remediate but no operator role', async () => {
    // Pins `roles: ['operator']`. Without it this would be 200.
    expect((await execute('scope-only-key')).status).toBe(403);
    expect((await status('scope-only-key')).status).toBe(403);
  });

  it('rejects an operator without the sre.remediate scope', async () => {
    // Pins `scopes: ['sre.remediate']`. Without it this would be 200 — a
    // generic operator could fail over gateways.
    expect((await execute('role-only-key')).status).toBe(403);
    expect((await status('role-only-key')).status).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    expect((await execute()).status).toBe(401);
    expect((await status()).status).toBe(401);
  });

  it('rate-limits both authenticated remediation endpoints', async () => {
    const firstExecute = await execute('both-key');
    expect(firstExecute.status).toBe(200);
    expect(firstExecute.headers.get('x-ratelimit-limit')).toBe('10');

    let executeResponse = firstExecute;
    for (let request = 0; request < 10; request += 1) {
      executeResponse = await execute('both-key');
    }
    expect(executeResponse.status).toBe(429);

    const firstStatus = await status('both-key');
    expect(firstStatus.status).toBe(200);
    expect(firstStatus.headers.get('x-ratelimit-limit')).toBe('60');

    let statusResponse = firstStatus;
    for (let request = 0; request < 60; request += 1) {
      statusResponse = await status('both-key');
    }
    expect(statusResponse.status).toBe(429);
  });
});
