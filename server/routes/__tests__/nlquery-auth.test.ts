/**
 * Authorization contract for the natural-language process query surface (#216).
 *
 * The maintainer review of the previous attempt found `requireAuth` was a
 * no-op on the new routes. Both routes now carry
 * `requireControlPlaneAccess({ scopes: ["nlquery.read"] })`, and this file is
 * the proof: the full matrix — anonymous, unknown credential, valid credential
 * with the wrong scope, correct scope, admin — is asserted per route.
 *
 * The scope is a READ scope by design. `POST /nlquery` is a POST only because
 * the question travels in the body; it mutates nothing. Two assertions below
 * pin that decision in both directions, so a later refactor cannot quietly
 * turn a read surface into a write-privileged one:
 *
 *   - a key holding ONLY `nlquery.read` succeeds (read access is sufficient);
 *   - a key holding `write` but not `nlquery.read` is rejected with 403
 *     (write access is neither required nor sufficient).
 *
 * Contract: docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

import { _resetControlPlaneAuthCache } from '../../middleware/control-plane-auth';
import {
  CONTROL_ROUTE_POLICIES,
  mutationPolicyFor,
} from '../../middleware/control-route-policy';
import { MAX_QUERY_LENGTH } from '../../services/nlquery';
import { intelligenceRoutes } from '../intelligence';

let server: Server;
let baseUrl: string;

const originalApiKeys = process.env.API_KEYS;

const QUERY_PATH = '/api/intelligence/nlquery';
const HISTORY_PATH = '/api/intelligence/nlquery/history';

function ask(headers: Record<string, string> = {}, query = 'What tags are available?') {
  return fetch(`${baseUrl}${QUERY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
}

function history(headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${HISTORY_PATH}`, { headers });
}

beforeAll(async () => {
  process.env.API_KEYS = [
    'nlquery-key:nlquery-reader:nlquery.read',
    // Holds a broad write grant but NOT nlquery.read — proves the read scope
    // is required and that `write` does not imply it.
    'writer-key:generic-writer:write',
    // A valid credential for an unrelated service.
    'other-key:other-service:twin.read',
    'admin-key:platform-admin:admin',
  ].join(',');
  _resetControlPlaneAuthCache();

  const app = express();
  app.use(express.json());
  app.use('/api/intelligence', intelligenceRoutes);

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
  _resetControlPlaneAuthCache();
});

describe('POST /api/intelligence/nlquery authorization', () => {
  it('fails closed for an anonymous caller', async () => {
    expect((await ask()).status).toBe(401);
  });

  it('rejects an unknown credential', async () => {
    expect((await ask({ 'x-api-key': 'not-a-key' })).status).toBe(401);
  });

  it('rejects a credential from an unrelated service', async () => {
    expect((await ask({ 'x-api-key': 'other-key' })).status).toBe(403);
  });

  it('rejects a generic write credential — write does not imply nlquery.read', async () => {
    expect((await ask({ 'x-api-key': 'writer-key' })).status).toBe(403);
  });

  it('allows the nlquery.read scope', async () => {
    expect((await ask({ 'x-api-key': 'nlquery-key' })).status).toBe(200);
  });

  it('allows an admin credential', async () => {
    expect((await ask({ 'x-api-key': 'admin-key' })).status).toBe(200);
  });

  it('rejects a credential passed in the query string', async () => {
    const res = await fetch(`${baseUrl}${QUERY_PATH}?api_key=nlquery-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What tags are available?' }),
    });
    expect(res.status).toBe(401);
  });

  it('authorizes before validating the body, so an unauthenticated caller learns nothing', async () => {
    // An over-long query is a 400 for an authorized caller; anonymous must
    // still be 401, i.e. the guard runs first.
    const res = await fetch(`${baseUrl}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(MAX_QUERY_LENGTH + 1) }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/intelligence/nlquery/history authorization', () => {
  it('fails closed for an anonymous caller', async () => {
    expect((await history()).status).toBe(401);
  });

  it('rejects an unknown credential', async () => {
    expect((await history({ 'x-api-key': 'not-a-key' })).status).toBe(401);
  });

  it('rejects a credential from an unrelated service', async () => {
    expect((await history({ 'x-api-key': 'other-key' })).status).toBe(403);
  });

  it('rejects a generic write credential', async () => {
    expect((await history({ 'x-api-key': 'writer-key' })).status).toBe(403);
  });

  it('allows the nlquery.read scope', async () => {
    expect((await history({ 'x-api-key': 'nlquery-key' })).status).toBe(200);
  });

  it('allows an admin credential', async () => {
    expect((await history({ 'x-api-key': 'admin-key' })).status).toBe(200);
  });
});

describe('gateway mutation policy for the nlquery prefix', () => {
  it('maps POST /nlquery to the nlquery.read scope, not the default write policy', () => {
    const policy = mutationPolicyFor('POST', QUERY_PATH);
    expect(policy?.id).toBe('nl-query-read');
    expect(policy?.scopes).toEqual(['nlquery.read']);
    // The point of the entry: without it the default policy would demand
    // `write` for a route that mutates nothing.
    expect(policy?.scopes).not.toContain('write');
  });

  it('registers the policy in the central inventory', () => {
    const entry = CONTROL_ROUTE_POLICIES.find((p) => p.id === 'nl-query-read');
    expect(entry).toBeDefined();
    expect(entry?.pathPrefix).toBe('/api/intelligence/nlquery');
  });

  it('leaves GET /nlquery/history outside the mutation policy entirely', () => {
    // It is a GET: the mutation inventory must not claim it, and the
    // route-local guard is what protects it (asserted above).
    expect(mutationPolicyFor('GET', HISTORY_PATH)).toBeUndefined();
  });
});
