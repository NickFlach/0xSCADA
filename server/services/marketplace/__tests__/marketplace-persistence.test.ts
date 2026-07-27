/**
 * Marketplace durability tests.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * These run against a real file-backed database through the repository's own
 * storage module (the SQLite development back-end; Postgres gets the same
 * tables from migrations/0011_agent_marketplace.sql). Nothing is mocked: the
 * database is closed and reopened between assertions, which is what "survives
 * a restart" actually means. An ownership record that reset on restart would
 * not be a security control, so the hijack refusal is re-asserted on the
 * other side of the restart.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginManifest } from '@shared/types/marketplace';
import { AgentMarketplace } from '../engine';
import { MarketplaceError } from '../errors';
import type { MarketplaceStore } from '../store';

const OWNER = 'publisher-a';
const OTHER = 'publisher-b';
const INSTALLER = 'operator-a';

const persistedManifest: PluginManifest = {
  id: 'durable-plugin',
  name: 'Durable Plugin',
  version: '1.0.0',
  description: 'persisted across a restart',
  author: 'tests',
  category: 'custom',
  requiredCapabilities: ['tags:read', 'log'],
  configSchema: {
    tagId: { type: 'string', description: 'tag', required: true },
    limit: { type: 'number', description: 'limit', default: 10, required: false },
  },
  dependencies: {},
  tags: ['durable'],
};

describe.sequential('marketplace persistence across a restart (#217)', () => {
  let temporaryDirectory: string;
  let database: typeof import('../../../storage');
  let makeStore: () => MarketplaceStore;

  async function restart(): Promise<void> {
    await database.closeDatabase();
    await database.initializeDatabase();
  }

  async function loadedEngine(): Promise<AgentMarketplace> {
    const engine = new AgentMarketplace({
      tagProvider: { list: () => [], readLatest: () => null },
      store: makeStore(),
    });
    await engine.load();
    return engine;
  }

  beforeAll(async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'oxscada-marketplace-'));
    process.env.FORCE_POSTGRES = 'false';
    process.env.SQLITE_DATABASE_PATH = join(temporaryDirectory, 'marketplace.sqlite');

    database = await import('../../../storage');
    const { DatabaseMarketplaceStore } = await import('../database-store');
    makeStore = () => new DatabaseMarketplaceStore();
    await database.initializeDatabase();
  });

  afterAll(async () => {
    await database.closeDatabase();
    delete process.env.SQLITE_DATABASE_PATH;
    delete process.env.FORCE_POSTGRES;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('uses a durable store', async () => {
    const engine = await loadedEngine();
    expect(engine.storeKind).toBe('database');
    expect(engine.getStatus().durable).toBe(true);
  });

  it('restores the registry, ownership record and install grants', async () => {
    const before = await loadedEngine();
    await before.publish(persistedManifest, OWNER);
    before.registerImplementation('durable-plugin', () => 'ok');
    await before.install('durable-plugin', {
      installedBy: INSTALLER,
      config: { tagId: 'PT-101' },
      grants: ['log'],
    });
    await before.start('durable-plugin');

    await restart();

    const after = await loadedEngine();
    expect(after.getPublisher('durable-plugin')).toBe(OWNER);
    expect(after.getEntry('durable-plugin')).toMatchObject({
      publisher: OWNER,
      installs: 1,
      manifest: expect.objectContaining({ id: 'durable-plugin', version: '1.0.0' }),
    });

    const installed = after.getInstalled('durable-plugin');
    expect(installed).toMatchObject({
      installedBy: INSTALLER,
      grantedCapabilities: ['log'],
      config: { tagId: 'PT-101', limit: 10 },
    });
    // Nothing is running after a restart, so the record must not claim it is.
    expect(installed?.status).toBe('stopped');
    // No implementation is registered on this fresh engine.
    expect(installed?.implementationState).toBe('unavailable');
  });

  it('still refuses a manifest hijack after the restart', async () => {
    await restart();
    const engine = await loadedEngine();

    const rejected = await engine
      .publish({ ...persistedManifest, version: '9.9.9' }, OTHER)
      .then(() => null, (error: unknown) => error);

    expect(rejected).toBeInstanceOf(MarketplaceError);
    expect((rejected as MarketplaceError).code).toBe('ownership-conflict');
    expect(engine.getEntry('durable-plugin')?.manifest.version).toBe('1.0.0');

    // The legitimate owner can still move the version forward.
    await engine.publish({ ...persistedManifest, version: '1.1.0' }, OWNER);
    await restart();
    const reloaded = await loadedEngine();
    expect(reloaded.getEntry('durable-plugin')?.manifest.version).toBe('1.1.0');
    expect(reloaded.getEntry('durable-plugin')?.installs).toBe(1);
  });

  it('keeps a disabled plugin disabled across a restart', async () => {
    const before = await loadedEngine();
    await before.disable('durable-plugin');

    await restart();

    const after = await loadedEngine();
    expect(after.getInstalled('durable-plugin')?.status).toBe('disabled');
  });

  it('persists an uninstall', async () => {
    const before = await loadedEngine();
    await before.uninstall('durable-plugin');

    await restart();

    const after = await loadedEngine();
    expect(after.getInstalled('durable-plugin')).toBeUndefined();
    // The registry entry and its ownership record outlive the installation:
    // releasing the id on uninstall would re-open it to a hijack.
    expect(after.getPublisher('durable-plugin')).toBe(OWNER);
  });
});
