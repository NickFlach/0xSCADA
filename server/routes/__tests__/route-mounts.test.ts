/**
 * Mount-path tests for the modules extracted from server/routes.ts (#446):
 * every public URL must survive the decomposition unchanged. The generator
 * endpoints whose implementations were deleted are restored and wired to the
 * server/blueprints modules (#479); only the DB-backed /seed remains a 501.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

vi.mock('../../storage', () => ({
  storage: {
    getControlModuleTypes: vi.fn(async () => [{ id: 'cm-1', name: 'Valve' }]),
    getControlModuleInstances: vi.fn(async () => [{ id: 'cmi-1' }]),
    getUnitTypes: vi.fn(async () => []),
    getUnitInstances: vi.fn(async () => []),
    getPhaseTypes: vi.fn(async () => []),
    getPhaseInstances: vi.fn(async () => []),
    getDesignSpecifications: vi.fn(async () => []),
    getVendors: vi.fn(async () => [{ id: 'v-1', name: 'siemens' }]),
    getVendorById: vi.fn(async (id: string) => (id === 'v-1' ? { id: 'v-1', name: 'siemens' } : undefined)),
    getTemplatePackages: vi.fn(async () => []),
    getControllers: vi.fn(async () => []),
    getControllersBySite: vi.fn(async () => [{ id: 'ctrl-1', siteId: 's1' }]),
    getGeneratedCode: vi.fn(async () => [{ id: 'gc-1', codeHash: 'abc', sourceType: 'phase', sourceId: 'p1', txHash: null }]),
    getAssets: vi.fn(async () => [{ id: 'asset-1', nameOrTag: 'TR-MAIN-01' }]),
    getAssetsBySiteId: vi.fn(async () => [{ id: 'asset-1' }]),
  },
}));

vi.mock('../../blockchain', () => ({
  blockchainService: {
    isEnabled: vi.fn(() => false),
    anchorEvent: vi.fn(async () => null),
    registerAsset: vi.fn(async () => undefined),
  },
}));

import { blueprintRoutes } from '../blueprints';
import { vendorRoutes } from '../vendors';
import { codegenRoutes } from '../codegen';
import { assetRoutes } from '../assets';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mirror the mounts in server/routes.ts registerRoutes
  app.use('/api/blueprints', blueprintRoutes);
  app.use('/api', vendorRoutes);
  app.use('/api', codegenRoutes);
  app.use('/api/assets', assetRoutes);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === 'object' && address) {
    base = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(() => {
  server?.close();
});

describe('blueprint routes keep their public paths', () => {
  it('GET /api/blueprints/cm-types', async () => {
    const res = await fetch(`${base}/api/blueprints/cm-types`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'cm-1', name: 'Valve' }]);
  });

  it('GET /api/blueprints/summary aggregates counts', async () => {
    const res = await fetch(`${base}/api/blueprints/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.controlModuleTypes).toBe(1);
    expect(body.vendors).toBe(1);
  });

  it('POST /api/blueprints/import runs the restored parser/validator (#479)', async () => {
    // Empty body carries neither cmTypePackage nor designSpec: the restored
    // handler rejects it with 400, proving it is no longer a 501 stub.
    const res = await fetch(`${base}/api/blueprints/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/blueprint package/i);
  });

  it('POST /api/blueprints/seed still answers 501 (needs the blueprint DB layer)', async () => {
    const res = await fetch(`${base}/api/blueprints/seed`, { method: 'POST' });
    expect(res.status).toBe(501);
  });
});

describe('vendor routes keep their public paths', () => {
  it('GET /api/vendors', async () => {
    const res = await fetch(`${base}/api/vendors`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'v-1', name: 'siemens' }]);
  });

  it('GET /api/vendors/:id 404s for unknown vendor', async () => {
    const res = await fetch(`${base}/api/vendors/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /api/templates', async () => {
    const res = await fetch(`${base}/api/templates`);
    expect(res.status).toBe(200);
  });

  it('GET /api/controllers/site/:siteId', async () => {
    const res = await fetch(`${base}/api/controllers/site/s1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'ctrl-1', siteId: 's1' }]);
  });
});

describe('codegen routes keep their public paths', () => {
  it('GET /api/generated-code (functional record CRUD)', async () => {
    const res = await fetch(`${base}/api/generated-code`);
    expect(res.status).toBe(200);
  });

  it('POST /api/generate/control-module/:id 400s without a definition (#479)', async () => {
    const res = await fetch(`${base}/api/generate/control-module/cm-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/definition/i);
  });

  it('POST /api/generate/control-module/:id generates Siemens SCL from a body definition (#479)', async () => {
    const res = await fetch(`${base}/api/generate/control-module/cm-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vendor: 'siemens',
        name: 'MotorValve',
        inputs: [{ name: 'OpenCmd', dataType: 'BOOL' }],
        outputs: [{ name: 'Opened', dataType: 'BOOL' }],
        inOuts: [],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.language).toBe('SCL');
    expect(body.code).toContain('FUNCTION_BLOCK');
    expect(body.code).toMatch(/OpenCmd\s*:\s*Bool/);
    expect(body.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /api/ladder-logic/instructions returns the restored instruction library (#479)', async () => {
    const res = await fetch(`${base}/api/ladder-logic/instructions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The full library is keyed by instruction mnemonic (a non-empty object).
    expect(typeof body).toBe('object');
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });
});

describe('asset routes (shadow-bug regression, #446)', () => {
  it('GET /api/assets returns real storage data, not the old placeholder', async () => {
    const res = await fetch(`${base}/api/assets`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The placeholder returned { message: "...", assets: [] }
    expect(body).toEqual([{ id: 'asset-1', nameOrTag: 'TR-MAIN-01' }]);
  });

  it('GET /api/assets/site/:siteId', async () => {
    const res = await fetch(`${base}/api/assets/site/s1`);
    expect(res.status).toBe(200);
  });
});
