/**
 * Configuration Change Tracker
 *
 * Tracks all configuration changes with before/after snapshots.
 * Issues: #40
 */

import { AuditLogger, AuditCategory } from './audit-logger';

/** Configuration scope */
export enum ConfigScope {
  SYSTEM = 'SYSTEM',
  GATEWAY = 'GATEWAY',
  TAG = 'TAG',
  ALARM = 'ALARM',
  USER = 'USER',
  RECIPE = 'RECIPE',
  NETWORK = 'NETWORK',
  SECURITY = 'SECURITY',
}

/** Configuration change snapshot */
export interface ConfigSnapshot {
  id: string;
  scope: ConfigScope;
  key: string;
  previousValue: unknown;
  newValue: unknown;
  changedBy: string;
  username: string;
  changedAt: string;
  changeReason: string;
  auditEntryId: string;
}

/**
 * Configuration Change Tracker
 *
 * Records all configuration modifications with full before/after snapshots
 * and links to the immutable audit log.
 */
export class ConfigTracker {
  private snapshots: ConfigSnapshot[] = [];
  private currentConfig = new Map<string, unknown>();

  constructor(private auditLogger: AuditLogger) {}

  /**
   * Track a configuration change.
   */
  trackChange(params: {
    scope: ConfigScope;
    key: string;
    newValue: unknown;
    changedBy: string;
    username: string;
    changeReason: string;
  }): ConfigSnapshot {
    const configKey = `${params.scope}:${params.key}`;
    const previousValue = this.currentConfig.get(configKey) ?? null;

    const auditEntry = this.auditLogger.log({
      category: AuditCategory.CONFIGURATION_CHANGE,
      action: 'config.changed',
      resourceType: 'configuration',
      resourceId: configKey,
      userId: params.changedBy,
      username: params.username,
      previousValue,
      newValue: params.newValue,
      metadata: { scope: params.scope, key: params.key, changeReason: params.changeReason },
      signatureMeaning: 'Authored',
    });

    const snapshot: ConfigSnapshot = {
      id: auditEntry.id,
      scope: params.scope,
      key: params.key,
      previousValue,
      newValue: params.newValue,
      changedBy: params.changedBy,
      username: params.username,
      changedAt: auditEntry.timestamp,
      changeReason: params.changeReason,
      auditEntryId: auditEntry.id,
    };

    this.currentConfig.set(configKey, params.newValue);
    this.snapshots.push(snapshot);

    return snapshot;
  }

  /**
   * Get change history for a specific config key.
   */
  getHistory(scope: ConfigScope, key: string): ConfigSnapshot[] {
    return this.snapshots.filter((s) => s.scope === scope && s.key === key);
  }

  /**
   * Get all changes by a user.
   */
  getChangesByUser(userId: string): ConfigSnapshot[] {
    return this.snapshots.filter((s) => s.changedBy === userId);
  }

  /**
   * Get all changes within a scope.
   */
  getChangesByScope(scope: ConfigScope): ConfigSnapshot[] {
    return this.snapshots.filter((s) => s.scope === scope);
  }

  /**
   * Get the current value of a configuration key.
   */
  getCurrentValue(scope: ConfigScope, key: string): unknown {
    return this.currentConfig.get(`${scope}:${key}`) ?? null;
  }

  /**
   * Export all snapshots.
   */
  export(): ConfigSnapshot[] {
    return [...this.snapshots];
  }
}
