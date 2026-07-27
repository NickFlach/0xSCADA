/**
 * Agent Marketplace engine tests.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  CapabilityDenialRecord,
  PluginCapability,
  PluginManifest,
} from '@shared/types/marketplace';
import { compareSemver, parseSemver, satisfiesRange } from '../semver';
import { AgentMarketplace, SYSTEM_PUBLISHER, type TagProvider } from '../engine';
import { MarketplaceError } from '../errors';
import { InMemoryMarketplaceStore } from '../store';
import {
  TAG_THRESHOLD_MONITOR_ID,
  tagThresholdMonitorHandler,
  tagThresholdMonitorManifest,
} from '../builtin';

const OWNER = 'publisher-a';
const OTHER = 'publisher-b';
const INSTALLER = 'operator-a';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'demo-plugin',
    name: 'Demo Plugin',
    version: '1.0.0',
    description: 'test plugin',
    author: 'tests',
    category: 'custom',
    requiredCapabilities: ['tags:read', 'log'],
    configSchema: {
      threshold: { type: 'number', description: 'limit', default: 50, required: false },
      mode: {
        type: 'select',
        description: 'mode',
        options: ['fast', 'slow'],
        default: 'fast',
        required: true,
      },
    },
    dependencies: {},
    tags: ['demo'],
    ...overrides,
  };
}

const tagProvider: TagProvider = {
  list: () => ['TANK-3.PRESSURE'],
  readLatest: (tagId) => (tagId === 'TANK-3.PRESSURE' ? { value: 42, timestamp: 1000 } : null),
};

async function market(options: { store?: InMemoryMarketplaceStore } = {}): Promise<AgentMarketplace> {
  const engine = new AgentMarketplace({
    tagProvider,
    store: options.store ?? new InMemoryMarketplaceStore(),
    invokeTimeoutMs: 200,
    autoDisableAfter: 3,
  });
  await engine.load();
  return engine;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<MarketplaceError> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(MarketplaceError);
  const marketplaceError = error as MarketplaceError;
  expect(marketplaceError.code).toBe(code);
  return marketplaceError;
}

// ── Semver ────────────────────────────────────────────────────────────────

describe('semver', () => {
  it('parses and compares', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2')).toBeNull();
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
  });

  it('evaluates ranges', () => {
    expect(satisfiesRange('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('0.3.5', '^0.3.1')).toBe(true);
    expect(satisfiesRange('0.4.0', '^0.3.1')).toBe(false);
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('9.9.9', '*')).toBe(true);
    expect(satisfiesRange('1.0.0', '1.0.0')).toBe(true);
  });
});

// ── Ownership: the manifest-hijack defence ────────────────────────────────

describe('plugin ownership', () => {
  it('refuses to publish or install before state is loaded', async () => {
    const engine = new AgentMarketplace({ store: new InMemoryMarketplaceStore() });
    await expectCode(engine.publish(manifest(), OWNER), 'store-unavailable');
    await expectCode(
      engine.install('demo-plugin', { installedBy: INSTALLER }),
      'store-unavailable',
    );
  });

  it('records the first publisher as the durable owner', async () => {
    const engine = await market();
    const entry = await engine.publish(manifest(), OWNER);
    expect(entry.publisher).toBe(OWNER);
    expect(engine.getPublisher('demo-plugin')).toBe(OWNER);
  });

  it('refuses a different principal republishing the id with a bumped version', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);

    const error = await expectCode(
      engine.publish(manifest({ version: '2.0.0' }), OTHER),
      'ownership-conflict',
    );
    expect(error.status).toBe(403);

    // The hijack left no trace: the registry still holds the owner's version.
    const entry = engine.getEntry('demo-plugin');
    expect(entry?.publisher).toBe(OWNER);
    expect(entry?.manifest.version).toBe('1.0.0');
  });

  it('requires a strictly newer version and preserves the install counter', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => 'ok');
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    expect(engine.getEntry('demo-plugin')?.installs).toBe(1);

    await expectCode(engine.publish(manifest({ version: '1.0.0' }), OWNER), 'version-conflict');
    await expectCode(engine.publish(manifest({ version: '0.9.0' }), OWNER), 'version-conflict');

    const republished = await engine.publish(manifest({ version: '1.1.0' }), OWNER);
    expect(republished.manifest.version).toBe('1.1.0');
    expect(republished.installs).toBe(1);
    expect(republished.publishedAt).toBe(engine.getEntry('demo-plugin')?.publishedAt);
  });

  it('reserves the built-in publisher namespace from the HTTP publish path', async () => {
    const engine = await market();
    await expectCode(
      engine.publish(manifest(), SYSTEM_PUBLISHER),
      'ownership-conflict',
    );
    await expectCode(engine.publish(manifest(), 'system:anything'), 'ownership-conflict');
    await expectCode(engine.publish(manifest(), '   '), 'ownership-conflict');
  });

  it('re-publishes an identical built-in version idempotently but refuses a downgrade', async () => {
    const store = new InMemoryMarketplaceStore();
    const engine = await market({ store });
    await engine.publishSystemManifest(tagThresholdMonitorManifest);
    await engine.publishSystemManifest(tagThresholdMonitorManifest);
    expect(engine.getPublisher(TAG_THRESHOLD_MONITOR_ID)).toBe(SYSTEM_PUBLISHER);

    await engine.publishSystemManifest({ ...tagThresholdMonitorManifest, version: '1.1.0' });
    await expectCode(
      engine.publishSystemManifest({ ...tagThresholdMonitorManifest, version: '1.0.0' }),
      'version-conflict',
    );
  });

  it('refuses to claim a built-in id already owned by an operator', async () => {
    const engine = await market();
    await engine.publish(
      manifest({ id: TAG_THRESHOLD_MONITOR_ID, requiredCapabilities: [], configSchema: {} }),
      OWNER,
    );
    await expectCode(
      engine.publishSystemManifest(tagThresholdMonitorManifest),
      'ownership-conflict',
    );
  });

  it('rejects a self-referential dependency and an invalid range', async () => {
    const engine = await market();
    await expectCode(
      engine.publish(manifest({ dependencies: { 'demo-plugin': '^1.0.0' } }), OWNER),
      'invalid-manifest',
    );
    await expectCode(
      engine.publish(manifest({ dependencies: { other: 'latest' } }), OWNER),
      'invalid-manifest',
    );
  });
});

// ── Registry & dependency ranges ──────────────────────────────────────────

describe('registry & versioning', () => {
  it('updates an installed plugin to the newer registry version', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => 'ok');
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    await engine.publish(manifest({ version: '1.2.0' }), OWNER);
    const updated = await engine.update('demo-plugin');
    expect(updated.manifest.version).toBe('1.2.0');
    expect(updated.status).toBe('running');
    await expectCode(engine.update('demo-plugin'), 'version-conflict');
  });

  it('narrows carried-over grants when a new version drops a capability', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER); // declares tags:read, log
    engine.registerImplementation('demo-plugin', () => 'ok');
    await engine.install('demo-plugin', {
      installedBy: INSTALLER,
      grants: ['tags:read', 'log'],
    });

    await engine.publish(
      manifest({ version: '2.0.0', requiredCapabilities: ['log'] }),
      OWNER,
    );
    const updated = await engine.update('demo-plugin');
    expect(updated.grantedCapabilities).toEqual(['log']);
  });

  it('does not widen grants when a new version declares more capabilities', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => 'ok');
    await engine.install('demo-plugin', { installedBy: INSTALLER, grants: ['log'] });

    await engine.publish(
      manifest({
        version: '2.0.0',
        requiredCapabilities: ['tags:read', 'log', 'events:emit'],
      }),
      OWNER,
    );
    const updated = await engine.update('demo-plugin');
    expect(updated.grantedCapabilities).toEqual(['log']);
  });

  it('enforces dependency semver ranges at install', async () => {
    const engine = await market();
    await engine.publish(
      manifest({ id: 'dep-plugin', requiredCapabilities: [], configSchema: {} }),
      OWNER,
    );
    await engine.publish(
      manifest({ id: 'consumer', dependencies: { 'dep-plugin': '^2.0.0' }, configSchema: {} }),
      OWNER,
    );

    await expectCode(
      engine.install('consumer', { installedBy: INSTALLER }),
      'dependency-missing',
    );
    await engine.install('dep-plugin', { installedBy: INSTALLER }); // v1.0.0
    await expectCode(
      engine.install('consumer', { installedBy: INSTALLER }),
      'dependency-unsatisfied',
    );
  });

  it('refuses to uninstall a plugin others depend on', async () => {
    const engine = await market();
    await engine.publish(
      manifest({ id: 'dep-plugin', requiredCapabilities: [], configSchema: {} }),
      OWNER,
    );
    await engine.publish(
      manifest({ id: 'consumer', dependencies: { 'dep-plugin': '^1.0.0' }, configSchema: {} }),
      OWNER,
    );
    await engine.install('dep-plugin', { installedBy: INSTALLER });
    await engine.install('consumer', { installedBy: INSTALLER });

    await expectCode(engine.uninstall('dep-plugin'), 'dependents-installed');
    await engine.uninstall('consumer');
    await engine.uninstall('dep-plugin');
    expect(engine.listInstalled()).toHaveLength(0);
  });
});

// ── Config validation ─────────────────────────────────────────────────────

describe('config validation', () => {
  it('applies defaults to optional fields too', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    const plugin = await engine.install('demo-plugin', { installedBy: INSTALLER });
    expect(plugin.config.threshold).toBe(50);
    expect(plugin.config.mode).toBe('fast');
    expect(plugin.installedBy).toBe(INSTALLER);
  });

  it('rejects unknown keys, wrong types, and invalid select values', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    await expectCode(
      engine.install('demo-plugin', { installedBy: INSTALLER, config: { bogus: 1 } }),
      'invalid-config',
    );
    await expectCode(
      engine.install('demo-plugin', { installedBy: INSTALLER, config: { threshold: 'high' } }),
      'invalid-config',
    );
    await expectCode(
      engine.install('demo-plugin', { installedBy: INSTALLER, config: { mode: 'turbo' } }),
      'invalid-config',
    );
  });

  it('does not mutate the caller-supplied config object', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    const supplied: Record<string, number> = {};
    await engine.install('demo-plugin', { installedBy: INSTALLER, config: supplied });
    expect(Object.keys(supplied)).toHaveLength(0);
  });
});

// ── Capability enforcement ────────────────────────────────────────────────

describe('capability enforcement', () => {
  it('throws and audits when a plugin reaches for an ungranted capability', async () => {
    const engine = await market();
    const denials: CapabilityDenialRecord[] = [];
    engine.on('plugin-capability-denied', (record: CapabilityDenialRecord) => {
      denials.push(record);
    });

    await engine.publish(manifest(), OWNER); // declares tags:read, log
    engine.registerImplementation('demo-plugin', (_input, host) => host.tags.list());
    // Grant only log — tags:read is declared but NOT granted.
    await engine.install('demo-plugin', { installedBy: INSTALLER, grants: ['log'] });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.code).toBe('capability-denied');
    expect(result.error).toMatch(/tags:read/);
    expect(denials).toEqual([
      expect.objectContaining({
        pluginId: 'demo-plugin',
        capability: 'tags:read',
        reason: 'ungranted',
      }),
    ]);
    expect(engine.getHealth('demo-plugin')?.capabilityDenials).toBe(1);
  });

  it('throws when a plugin reaches for a capability its manifest never declared', async () => {
    const engine = await market();
    const denials: CapabilityDenialRecord[] = [];
    engine.on('plugin-capability-denied', (record: CapabilityDenialRecord) => {
      denials.push(record);
    });

    await engine.publish(manifest({ requiredCapabilities: ['log'] }), OWNER);
    engine.registerImplementation('demo-plugin', (_input, host) => host.alarms.getActive());
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.code).toBe('capability-denied');
    expect(denials[0]).toMatchObject({ capability: 'alarms:read', reason: 'undeclared' });
  });

  it('reports granted capabilities so a plugin can feature-detect without throwing', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', (_input, host) => [...host.capabilities]);
    await engine.install('demo-plugin', { installedBy: INSTALLER, grants: ['log'] });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual(['log']);
  });

  it('lets a granted capability reach the live host service', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation(
      'demo-plugin',
      (_input, host) => host.tags.readLatest('TANK-3.PRESSURE'),
    );
    await engine.install('demo-plugin', { installedBy: INSTALLER }); // grants = declared
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ value: 42, timestamp: 1000 });
  });

  it('rejects grants beyond the manifest declaration', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER); // declares tags:read, log
    await expectCode(
      engine.install('demo-plugin', {
        installedBy: INSTALLER,
        grants: ['events:emit'] as PluginCapability[],
      }),
      'capability-not-declared',
    );
  });

  it('freezes the host config so a handler cannot rewrite its own installation', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', (_input, host) => {
      const mutable = host.config as Record<string, string | number | boolean>;
      mutable.threshold = 9999;
      return host.config.threshold;
    });
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(engine.getInstalled('demo-plugin')?.config.threshold).toBe(50);
  });
});

// ── Execution bounds ──────────────────────────────────────────────────────

describe('invocation bounds', () => {
  it('times out runaway invocations', async () => {
    const engine = await market(); // 200ms cap
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation(
      'demo-plugin',
      () => new Promise((resolve) => setTimeout(resolve, 5_000)),
    );
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.code).toBe('timeout');
  });

  it('will not let a handler mislabel its own failure as a host timeout', async () => {
    // The timeout code is derived from the host's own timer error type, not
    // from the error text, so a handler cannot forge it and make an ordinary
    // fault read as a host-imposed bound in the audit trail.
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => {
      throw new Error('Plugin "demo-plugin" invocation timed out after 1ms');
    });
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.code).toBe('handler-error');
  });

  it('bounds a handler that yields, and says so when one does not', async () => {
    // Honest boundary: the timer lives on the event loop. A handler that
    // awaits is cut off; a handler that blocks the loop synchronously cannot
    // be pre-empted without process/VM isolation, which this build lacks.
    const engine = await market(); // 200ms cap
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => {
      const until = Date.now() + 400;
      while (Date.now() < until) { /* owns the thread */ }
      return 'ran past the cap';
    });
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(200);
  });

  it('auto-disables after consecutive failures and recovers via enable', async () => {
    const engine = await market(); // autoDisableAfter 3
    const disabled = vi.fn();
    engine.on('plugin-auto-disabled', disabled);
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => {
      throw new Error('boom');
    });
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.start('demo-plugin');

    for (let attempt = 0; attempt < 3; attempt++) await engine.invoke('demo-plugin', {});
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(engine.getInstalled('demo-plugin')?.status).toBe('error');

    const blocked = await engine.invoke('demo-plugin', {});
    expect(blocked.code).toBe('not-running');

    await engine.enable('demo-plugin');
    await engine.start('demo-plugin');
    expect(engine.getHealth('demo-plugin')?.consecutiveFailures).toBe(0);
  });
});

// ── "No merchandise": installed but not implemented ───────────────────────

describe('installed-but-not-implemented is an explicit state', () => {
  it('reports the state, refuses to start, and returns a machine code on invoke', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    const plugin = await engine.install('demo-plugin', { installedBy: INSTALLER });

    expect(plugin.implementationState).toBe('unavailable');
    expect(engine.getHealth('demo-plugin')?.implementationState).toBe('unavailable');
    expect(engine.getStatus().unimplemented).toBe(1);

    const error = await expectCode(engine.start('demo-plugin'), 'not-implemented');
    expect(error.message).toMatch(/no implementation is registered/);

    const result = await engine.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.code).toBe('not-implemented');
  });

  it('flips to available as soon as an implementation is registered', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    engine.registerImplementation('demo-plugin', () => 'ok');

    expect(engine.getInstalled('demo-plugin')?.implementationState).toBe('available');
    const started = await engine.start('demo-plugin');
    expect(started.status).toBe('running');
    expect(engine.getStatus().unimplemented).toBe(0);
  });
});

// ── Lifecycle & health ────────────────────────────────────────────────────

describe('lifecycle & health', () => {
  it('reinstalling throws instead of silently replacing', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await expectCode(
      engine.install('demo-plugin', { installedBy: INSTALLER }),
      'already-installed',
    );
  });

  it('disable blocks start until enable', async () => {
    const engine = await market();
    await engine.publish(manifest(), OWNER);
    engine.registerImplementation('demo-plugin', () => 'ok');
    await engine.install('demo-plugin', { installedBy: INSTALLER });
    await engine.disable('demo-plugin');
    await expectCode(engine.start('demo-plugin'), 'invalid-state');
    await engine.enable('demo-plugin');
    expect((await engine.start('demo-plugin')).status).toBe('running');
  });

  it('tracks uptime from start (not install) and the windowed error rate', async () => {
    vi.useFakeTimers();
    try {
      const engine = await market();
      await engine.publish(manifest(), OWNER);
      let fail = false;
      engine.registerImplementation('demo-plugin', () => {
        if (fail) throw new Error('flaky');
        return 'ok';
      });
      await engine.install('demo-plugin', { installedBy: INSTALLER });
      vi.advanceTimersByTime(60_000);
      await engine.start('demo-plugin');
      vi.advanceTimersByTime(10_000);

      await engine.invoke('demo-plugin', {});
      fail = true;
      await engine.invoke('demo-plugin', {});

      const health = engine.getHealth('demo-plugin');
      expect(health?.uptimeSeconds).toBe(10);
      expect(health?.invocations).toBe(2);
      expect(health?.windowedErrorRate).toBe(0.5);
      expect(health?.lastError).toBe('flaky');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The built-in plugin, invoked for real ─────────────────────────────────

describe('built-in tag-threshold-monitor', () => {
  async function installBuiltin(
    provider: TagProvider,
    config: Record<string, string | number | boolean>,
  ): Promise<AgentMarketplace> {
    const engine = new AgentMarketplace({
      tagProvider: provider,
      store: new InMemoryMarketplaceStore(),
    });
    await engine.load();
    engine.registerImplementation(TAG_THRESHOLD_MONITOR_ID, tagThresholdMonitorHandler);
    await engine.publishSystemManifest(tagThresholdMonitorManifest);
    await engine.install(TAG_THRESHOLD_MONITOR_ID, { installedBy: INSTALLER, config });
    await engine.start(TAG_THRESHOLD_MONITOR_ID);
    return engine;
  }

  it('classifies a live tag and emits a host event when out of band', async () => {
    const now = 1_000_000;
    const engine = await installBuiltin(
      {
        list: () => ['PT-101'],
        readLatest: () => ({ value: 97, timestamp: now - 5_000 }),
      },
      { tagId: 'PT-101', highLimit: 90, lowLimit: 10 },
    );
    const events: Array<{ pluginId: string; type: string }> = [];
    engine.on('plugin-event', (event: { pluginId: string; type: string }) => events.push(event));

    const result = await engine.invoke(TAG_THRESHOLD_MONITOR_ID, { nowMs: now });
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      tagId: 'PT-101',
      state: 'high',
      value: 97,
      ageSeconds: 5,
      severity: 'warning',
    });
    expect(events).toEqual([
      expect.objectContaining({
        pluginId: TAG_THRESHOLD_MONITOR_ID,
        type: 'tag-threshold-breach',
      }),
    ]);
  });

  it('reports a normal reading without emitting an event', async () => {
    const now = 1_000_000;
    const engine = await installBuiltin(
      { list: () => ['PT-101'], readLatest: () => ({ value: 50, timestamp: now }) },
      { tagId: 'PT-101', highLimit: 90, lowLimit: 10 },
    );
    const events: unknown[] = [];
    engine.on('plugin-event', (event: unknown) => events.push(event));

    const result = await engine.invoke(TAG_THRESHOLD_MONITOR_ID, { nowMs: now });
    expect(result.output).toMatchObject({ state: 'normal' });
    expect(events).toHaveLength(0);
  });

  it('detects a stale sample and an unavailable tag', async () => {
    const now = 1_000_000;
    const engine = await installBuiltin(
      {
        list: () => ['PT-101'],
        readLatest: (tagId) => (tagId === 'PT-101' ? { value: 50, timestamp: now - 600_000 } : null),
      },
      { tagId: 'PT-101', highLimit: 90, lowLimit: 10, maxAgeSeconds: 30 },
    );

    const stale = await engine.invoke(TAG_THRESHOLD_MONITOR_ID, { nowMs: now });
    expect(stale.output).toMatchObject({ state: 'stale', ageSeconds: 600 });

    const missing = await engine.invoke(TAG_THRESHOLD_MONITOR_ID, {
      tagId: 'NOT-A-TAG',
      nowMs: now,
    });
    expect(missing.output).toMatchObject({ state: 'unavailable', value: null });
  });

  it('rejects an unknown invocation field instead of ignoring it', async () => {
    const engine = await installBuiltin(
      { list: () => ['PT-101'], readLatest: () => ({ value: 50, timestamp: Date.now() }) },
      { tagId: 'PT-101', highLimit: 90, lowLimit: 10 },
    );
    const result = await engine.invoke(TAG_THRESHOLD_MONITOR_ID, { unexpected: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe('handler-error');
  });
});
