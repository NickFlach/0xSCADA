/**
 * Feature Flags — ADR-0014 [14.7]
 *
 * Gradual rollout system with percentage-based, user-based,
 * and environment-based targeting.
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

export interface FeatureFlag {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number; // 0-100
  targetEnvironments: string[];
  targetUsers: string[];
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface FlagEvaluation {
  flagId: string;
  enabled: boolean;
  reason: 'globally-disabled' | 'globally-enabled' | 'rollout-percentage' | 'user-targeted' | 'environment-targeted' | 'default';
  timestamp: number;
}

export class FeatureFlagManager extends EventEmitter {
  private flags: Map<string, FeatureFlag> = new Map();
  private overrides: Map<string, boolean> = new Map();
  private environment: string;

  constructor(environment = 'production') {
    super();
    this.environment = environment;
  }

  createFlag(flag: Omit<FeatureFlag, 'createdAt' | 'updatedAt'>): FeatureFlag {
    const full: FeatureFlag = {
      ...flag,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.flags.set(flag.id, full);
    this.emit('flag-created', full);
    return full;
  }

  updateFlag(id: string, updates: Partial<FeatureFlag>): FeatureFlag | null {
    const flag = this.flags.get(id);
    if (!flag) return null;

    Object.assign(flag, updates, { updatedAt: Date.now() });
    this.emit('flag-updated', flag);
    return flag;
  }

  deleteFlag(id: string): boolean {
    const deleted = this.flags.delete(id);
    if (deleted) this.emit('flag-deleted', id);
    return deleted;
  }

  evaluate(flagId: string, userId?: string): FlagEvaluation {
    const flag = this.flags.get(flagId);
    const base = { flagId, timestamp: Date.now() };

    // Check override
    const override = this.overrides.get(flagId);
    if (override !== undefined) {
      return { ...base, enabled: override, reason: override ? 'globally-enabled' : 'globally-disabled' };
    }

    if (!flag) {
      return { ...base, enabled: false, reason: 'default' };
    }

    if (!flag.enabled) {
      return { ...base, enabled: false, reason: 'globally-disabled' };
    }

    // Environment targeting
    if (flag.targetEnvironments.length > 0 && !flag.targetEnvironments.includes(this.environment)) {
      return { ...base, enabled: false, reason: 'environment-targeted' };
    }

    // User targeting
    if (userId && flag.targetUsers.length > 0) {
      if (flag.targetUsers.includes(userId)) {
        return { ...base, enabled: true, reason: 'user-targeted' };
      }
    }

    // Rollout percentage (deterministic based on userId or flagId)
    if (flag.rolloutPercentage < 100) {
      const key = userId ?? flagId;
      const hash = createHash('md5').update(`${flagId}:${key}`).digest();
      const bucket = hash.readUInt16BE(0) % 100;
      const enabled = bucket < flag.rolloutPercentage;
      return { ...base, enabled, reason: 'rollout-percentage' };
    }

    return { ...base, enabled: true, reason: 'globally-enabled' };
  }

  isEnabled(flagId: string, userId?: string): boolean {
    return this.evaluate(flagId, userId).enabled;
  }

  setOverride(flagId: string, enabled: boolean): void {
    this.overrides.set(flagId, enabled);
    this.emit('override-set', { flagId, enabled });
  }

  clearOverride(flagId: string): void {
    this.overrides.delete(flagId);
    this.emit('override-cleared', flagId);
  }

  getAllFlags(): FeatureFlag[] {
    return Array.from(this.flags.values());
  }

  getFlag(id: string): FeatureFlag | undefined {
    return this.flags.get(id);
  }
}
