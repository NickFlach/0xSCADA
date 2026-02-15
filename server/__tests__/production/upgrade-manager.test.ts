import { describe, it, expect } from 'vitest';
import { UpgradeManager } from '../../upgrades/upgrade-manager';
import { FeatureFlagManager } from '../../upgrades/feature-flags';

describe('UpgradeManager', () => {
  it('should execute a simple upgrade', async () => {
    const um = new UpgradeManager();
    um.registerCompatibility('2.0', ['1.0']);

    const state = await um.executeUpgrade({
      id: 'upgrade-1',
      fromVersion: '1.0',
      toVersion: '2.0',
      migrations: [{
        id: 'mig-1', name: 'Add column', version: '2.0',
        up: async () => {}, down: async () => {},
      }],
      preChecks: [{
        name: 'Disk space', required: true,
        check: async () => ({ pass: true, message: 'OK' }),
      }],
      canaryPercentage: 10,
      rollbackOnFailure: true,
    }, 5);

    expect(state.stage).toBe('complete');
    expect(state.nodesUpgraded).toBe(5);
    expect(state.migrationsApplied).toContain('mig-1');
  });

  it('should rollback on pre-check failure', async () => {
    const um = new UpgradeManager();
    const state = await um.executeUpgrade({
      id: 'upgrade-fail',
      fromVersion: '1.0',
      toVersion: '2.0',
      migrations: [],
      preChecks: [{
        name: 'Failing check', required: true,
        check: async () => ({ pass: false, message: 'No space' }),
      }],
      canaryPercentage: 10,
      rollbackOnFailure: true,
    }, 3);

    expect(state.stage).toBe('failed');
    expect(state.errors.length).toBeGreaterThan(0);
  });
});

describe('FeatureFlagManager', () => {
  it('should create and evaluate flags', () => {
    const fm = new FeatureFlagManager('production');
    fm.createFlag({
      id: 'new-ui', name: 'New UI', description: 'Redesigned dashboard',
      enabled: true, rolloutPercentage: 100, targetEnvironments: [],
      targetUsers: [], metadata: {},
    });

    expect(fm.isEnabled('new-ui')).toBe(true);
  });

  it('should respect rollout percentage', () => {
    const fm = new FeatureFlagManager();
    fm.createFlag({
      id: 'beta', name: 'Beta', description: '',
      enabled: true, rolloutPercentage: 50, targetEnvironments: [],
      targetUsers: [], metadata: {},
    });

    let enabled = 0;
    for (let i = 0; i < 100; i++) {
      if (fm.isEnabled('beta', `user-${i}`)) enabled++;
    }
    // Should be roughly 50% (with some variance)
    expect(enabled).toBeGreaterThan(20);
    expect(enabled).toBeLessThan(80);
  });

  it('should respect overrides', () => {
    const fm = new FeatureFlagManager();
    fm.createFlag({
      id: 'test', name: 'Test', description: '',
      enabled: false, rolloutPercentage: 0, targetEnvironments: [],
      targetUsers: [], metadata: {},
    });

    expect(fm.isEnabled('test')).toBe(false);
    fm.setOverride('test', true);
    expect(fm.isEnabled('test')).toBe(true);
    fm.clearOverride('test');
    expect(fm.isEnabled('test')).toBe(false);
  });

  it('should target specific users', () => {
    const fm = new FeatureFlagManager();
    fm.createFlag({
      id: 'vip', name: 'VIP', description: '',
      enabled: true, rolloutPercentage: 0, targetEnvironments: [],
      targetUsers: ['alice'], metadata: {},
    });

    expect(fm.isEnabled('vip', 'alice')).toBe(true);
    expect(fm.isEnabled('vip', 'bob')).toBe(false);
  });
});
