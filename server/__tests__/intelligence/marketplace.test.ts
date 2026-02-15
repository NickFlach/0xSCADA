import { describe, it, expect, afterEach } from 'vitest';
import { AgentMarketplace } from '../../agents/marketplace';
import type { PluginManifest } from '../../../shared/types/marketplace';

const testManifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  description: 'A test plugin',
  author: 'test',
  category: 'intelligence',
  requiredCapabilities: ['read:tags'],
  entryPoint: 'index.ts',
  configSchema: {
    threshold: { type: 'number', description: 'Alert threshold', default: 50, required: false },
  },
  dependencies: {},
  minPlatformVersion: '1.0.0',
  tags: ['test', 'demo'],
};

describe('AgentMarketplace', () => {
  let marketplace: AgentMarketplace;

  afterEach(() => {
    marketplace?.destroyAll();
  });

  it('publishes and searches plugins', () => {
    marketplace = new AgentMarketplace();
    marketplace.publish(testManifest);

    const results = marketplace.search('test');
    expect(results.length).toBe(1);
    expect(results[0].manifest.id).toBe('test-plugin');
  });

  it('installs plugins', () => {
    marketplace = new AgentMarketplace();
    marketplace.publish(testManifest);

    const installed = marketplace.install('test-plugin');
    expect(installed).not.toBeNull();
    expect(installed!.status).toBe('installed');
  });

  it('starts and stops plugins', () => {
    marketplace = new AgentMarketplace();
    marketplace.publish(testManifest);
    marketplace.install('test-plugin');

    expect(marketplace.start('test-plugin')).toBe(true);
    expect(marketplace.getRunning().length).toBe(1);

    expect(marketplace.stop('test-plugin')).toBe(true);
    expect(marketplace.getRunning().length).toBe(0);
  });

  it('creates sandboxed execution context', () => {
    marketplace = new AgentMarketplace();
    marketplace.publish(testManifest);
    marketplace.install('test-plugin');

    const ctx = marketplace.getContext('test-plugin');
    expect(ctx).toBeDefined();
    expect(ctx!.capabilities).toContain('read:tags');
    expect(ctx!.sandbox.allowNetwork).toBe(false);
  });

  it('tracks errors and auto-stops on threshold', () => {
    marketplace = new AgentMarketplace();
    marketplace.publish(testManifest);
    marketplace.install('test-plugin');
    marketplace.start('test-plugin');

    for (let i = 0; i < 10; i++) {
      marketplace.reportError('test-plugin', 'crash');
    }

    const health = marketplace.getHealth('test-plugin');
    expect(health!.healthy).toBe(false);
  });

  it('rejects install with missing dependencies', () => {
    marketplace = new AgentMarketplace();
    const withDep = { ...testManifest, id: 'dep-plugin', dependencies: { 'missing-plugin': '1.0.0' } };
    marketplace.publish(withDep);

    expect(() => marketplace.install('dep-plugin')).toThrow('Missing dependency');
  });
});
