/**
 * Agent Marketplace tests
 * ADR-0013 [13.6] — Issue #217
 */

import { describe, it, expect, vi } from 'vitest';
import type { PluginManifest } from '@shared/types/marketplace';
import { compareSemver, parseSemver, satisfiesRange } from '../semver';
import { AgentMarketplace } from '../engine';

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

function marketWithTags(): AgentMarketplace {
  return new AgentMarketplace({
    tagProvider: {
      list: () => ['TANK-3.PRESSURE'],
      readLatest: () => ({ value: 42, timestamp: 1000 }),
    },
    invokeTimeoutMs: 200,
    autoDisableAfter: 3,
  });
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

// ── Registry & versioning ─────────────────────────────────────────────────

describe('registry & versioning', () => {
  it('republishing requires a strictly newer version and preserves installs', () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.install('demo-plugin');
    expect(market.getEntry('demo-plugin')!.installs).toBe(1);

    expect(() => market.publish(manifest({ version: '1.0.0' }))).toThrow(/not newer/);
    expect(() => market.publish(manifest({ version: '0.9.0' }))).toThrow(/not newer/);

    market.publish(manifest({ version: '1.1.0' }));
    expect(market.getEntry('demo-plugin')!.installs).toBe(1); // not reset
    expect(market.getEntry('demo-plugin')!.manifest.version).toBe('1.1.0');
  });

  it('updates an installed plugin to the newer registry version', () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.install('demo-plugin');
    market.start('demo-plugin');

    market.publish(manifest({ version: '1.2.0' }));
    const updated = market.update('demo-plugin');
    expect(updated.manifest.version).toBe('1.2.0');
    expect(updated.status).toBe('running'); // running state restored
    expect(() => market.update('demo-plugin')).toThrow(/already at/);
  });

  it('enforces dependency semver ranges at install', () => {
    const market = marketWithTags();
    market.publish(manifest({ id: 'dep-plugin', requiredCapabilities: [], configSchema: {} }));
    market.publish(
      manifest({ id: 'consumer', dependencies: { 'dep-plugin': '^2.0.0' }, configSchema: {} })
    );

    expect(() => market.install('consumer')).toThrow(/Missing dependency/);
    market.install('dep-plugin'); // v1.0.0
    expect(() => market.install('consumer')).toThrow(/does not satisfy/);
  });

  it('refuses to uninstall a plugin others depend on', () => {
    const market = marketWithTags();
    market.publish(manifest({ id: 'dep-plugin', requiredCapabilities: [], configSchema: {} }));
    market.publish(
      manifest({ id: 'consumer', dependencies: { 'dep-plugin': '^1.0.0' }, configSchema: {} })
    );
    market.install('dep-plugin');
    market.install('consumer');
    expect(() => market.uninstall('dep-plugin')).toThrow(/depends on it/);
    market.uninstall('consumer');
    market.uninstall('dep-plugin'); // now fine
  });
});

// ── Config validation ─────────────────────────────────────────────────────

describe('config validation', () => {
  it('applies defaults to optional fields too (Wave-2 regression)', () => {
    const market = marketWithTags();
    market.publish(manifest());
    const plugin = market.install('demo-plugin');
    expect(plugin.config.threshold).toBe(50); // optional-with-default applied
    expect(plugin.config.mode).toBe('fast');
  });

  it('rejects unknown keys, wrong types, and invalid select values', () => {
    const market = marketWithTags();
    market.publish(manifest());
    expect(() => market.install('demo-plugin', { bogus: 1 })).toThrow(/Unknown config/);
    expect(() => market.install('demo-plugin', { threshold: 'high' })).toThrow(/must be a number/);
    expect(() => market.install('demo-plugin', { mode: 'turbo' })).toThrow(/one of/);
  });

  it('does not mutate the caller-supplied config object', () => {
    const market = marketWithTags();
    market.publish(manifest());
    const supplied: Record<string, number> = {};
    market.install('demo-plugin', supplied);
    expect(Object.keys(supplied)).toHaveLength(0);
  });
});

// ── Capability scoping & execution ────────────────────────────────────────

describe('capability-scoped execution', () => {
  it('exposes only granted capability APIs to the handler', async () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.registerImplementation('demo-plugin', (_input, host) => ({
      hasTags: host.tags !== undefined,
      hasAlarms: host.alarms !== undefined,
      hasEmit: host.emitEvent !== undefined,
      hasLog: host.log !== undefined,
      tagValue: host.tags?.readLatest('TANK-3.PRESSURE')?.value ?? null,
    }));
    // Grant only log — tags:read declared but NOT granted
    market.install('demo-plugin', {}, ['log']);
    market.start('demo-plugin');

    const result = await market.invoke('demo-plugin', {});
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      hasTags: false,
      hasAlarms: false,
      hasEmit: false,
      hasLog: true,
      tagValue: null,
    });
  });

  it('rejects grants beyond the manifest declaration', () => {
    const market = marketWithTags();
    market.publish(manifest()); // declares tags:read, log
    expect(() => market.install('demo-plugin', {}, ['events:emit'])).toThrow(/not declared/);
  });

  it('granted tag access reads live values', async () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.registerImplementation('demo-plugin', (_i, host) =>
      host.tags!.readLatest('TANK-3.PRESSURE')
    );
    market.install('demo-plugin'); // default grants = declared
    market.start('demo-plugin');
    const result = await market.invoke('demo-plugin', {});
    expect(result.output).toEqual({ value: 42, timestamp: 1000 });
  });

  it('times out runaway invocations', async () => {
    const market = marketWithTags(); // 200ms timeout
    market.publish(manifest());
    market.registerImplementation(
      'demo-plugin',
      () => new Promise((resolve) => setTimeout(resolve, 5_000))
    );
    market.install('demo-plugin');
    market.start('demo-plugin');
    const result = await market.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });

  it('auto-disables after consecutive failures and recovers via enable', async () => {
    const market = marketWithTags(); // autoDisableAfter 3
    const disabled = vi.fn();
    market.on('plugin-auto-disabled', disabled);
    market.publish(manifest());
    market.registerImplementation('demo-plugin', () => {
      throw new Error('boom');
    });
    market.install('demo-plugin');
    market.start('demo-plugin');

    for (let i = 0; i < 3; i++) await market.invoke('demo-plugin', {});
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(market.getInstalled('demo-plugin')!.status).toBe('error');

    const blocked = await market.invoke('demo-plugin', {});
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/not running/);

    market.enable('demo-plugin');
    market.start('demo-plugin');
    expect(market.getHealth('demo-plugin')!.consecutiveFailures).toBe(0);
  });

  it('invoking without an implementation fails clearly', async () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.install('demo-plugin');
    market.start('demo-plugin');
    const result = await market.invoke('demo-plugin', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no registered implementation/);
    expect(market.getHealth('demo-plugin')!.hasImplementation).toBe(false);
  });
});

// ── Lifecycle & health ────────────────────────────────────────────────────

describe('lifecycle & health', () => {
  it('reinstalling throws instead of silently replacing (Wave-2 regression)', () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.install('demo-plugin');
    expect(() => market.install('demo-plugin')).toThrow(/already installed/);
  });

  it('disable blocks start until enable', () => {
    const market = marketWithTags();
    market.publish(manifest());
    market.install('demo-plugin');
    market.disable('demo-plugin');
    expect(() => market.start('demo-plugin')).toThrow(/disabled/);
    market.enable('demo-plugin');
    expect(market.start('demo-plugin').status).toBe('running');
  });

  it('tracks uptime from start (not install) and windowed error rate', async () => {
    vi.useFakeTimers();
    try {
      const market = marketWithTags();
      market.publish(manifest());
      let fail = false;
      market.registerImplementation('demo-plugin', () => {
        if (fail) throw new Error('flaky');
        return 'ok';
      });
      market.install('demo-plugin');
      vi.advanceTimersByTime(60_000); // time passes between install and start
      market.start('demo-plugin');
      vi.advanceTimersByTime(10_000);

      await market.invoke('demo-plugin', {});
      fail = true;
      await market.invoke('demo-plugin', {});

      const health = market.getHealth('demo-plugin')!;
      expect(health.uptimeSeconds).toBe(10); // from start, not install
      expect(health.invocations).toBe(2);
      expect(health.windowedErrorRate).toBe(0.5);
      expect(health.lastError).toBe('flaky');
    } finally {
      vi.useRealTimers();
    }
  });
});
