/**
 * Upgrade Manager — ADR-0014 [14.7]
 *
 * Rolling deployment orchestrator with pre-upgrade checks,
 * migration execution, rollback triggers, and canary stages.
 */

import { EventEmitter } from 'events';

export interface UpgradeSpec {
  id: string;
  fromVersion: string;
  toVersion: string;
  migrations: Migration[];
  preChecks: PreCheck[];
  canaryPercentage: number;
  rollbackOnFailure: boolean;
}

export interface Migration {
  id: string;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
  version: string;
}

export interface PreCheck {
  name: string;
  check: () => Promise<{ pass: boolean; message: string }>;
  required: boolean;
}

export type UpgradeStage = 'pending' | 'pre-check' | 'canary' | 'rolling' | 'complete' | 'rolling-back' | 'failed';

export interface UpgradeState {
  upgradeId: string;
  stage: UpgradeStage;
  progress: number; // 0-100
  nodesUpgraded: number;
  totalNodes: number;
  migrationsApplied: string[];
  startedAt: number;
  completedAt?: number;
  errors: string[];
}

export class UpgradeManager extends EventEmitter {
  private currentState: UpgradeState | null = null;
  private appliedMigrations: Set<string> = new Set();
  private compatibilityMatrix: Map<string, Set<string>> = new Map();

  constructor() {
    super();
  }

  async executeUpgrade(spec: UpgradeSpec, nodeCount: number): Promise<UpgradeState> {
    this.currentState = {
      upgradeId: spec.id,
      stage: 'pending',
      progress: 0,
      nodesUpgraded: 0,
      totalNodes: nodeCount,
      migrationsApplied: [],
      startedAt: Date.now(),
      errors: [],
    };

    try {
      // Pre-checks
      this.currentState.stage = 'pre-check';
      this.emit('stage-change', 'pre-check');
      await this.runPreChecks(spec.preChecks);
      this.currentState.progress = 10;

      // Compatibility check
      if (!this.checkCompatibility(spec.fromVersion, spec.toVersion)) {
        throw new Error(`Versions ${spec.fromVersion} → ${spec.toVersion} not compatible`);
      }

      // Run migrations
      this.currentState.stage = 'canary';
      this.emit('stage-change', 'canary');
      await this.runMigrations(spec.migrations);
      this.currentState.progress = 30;

      // Canary deployment
      const canaryNodes = Math.max(1, Math.floor(nodeCount * (spec.canaryPercentage / 100)));
      for (let i = 0; i < canaryNodes; i++) {
        await this.upgradeNode(i);
        this.currentState.nodesUpgraded++;
        this.currentState.progress = 30 + (20 * (i + 1)) / canaryNodes;
      }

      // Canary health check
      await this.canaryHealthCheck();

      // Rolling deployment
      this.currentState.stage = 'rolling';
      this.emit('stage-change', 'rolling');
      for (let i = canaryNodes; i < nodeCount; i++) {
        await this.upgradeNode(i);
        this.currentState.nodesUpgraded++;
        this.currentState.progress = 50 + (50 * (i - canaryNodes + 1)) / (nodeCount - canaryNodes);
      }

      this.currentState.stage = 'complete';
      this.currentState.completedAt = Date.now();
      this.currentState.progress = 100;
      this.emit('upgrade-complete', this.currentState);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.currentState.errors.push(msg);

      if (spec.rollbackOnFailure) {
        await this.rollback(spec);
      } else {
        this.currentState.stage = 'failed';
        this.emit('upgrade-failed', this.currentState);
      }
    }

    return this.currentState;
  }

  async rollback(spec: UpgradeSpec): Promise<void> {
    if (!this.currentState) return;

    this.currentState.stage = 'rolling-back';
    this.emit('stage-change', 'rolling-back');

    // Reverse migrations
    const applied = [...this.currentState.migrationsApplied].reverse();
    for (const migId of applied) {
      const migration = spec.migrations.find((m) => m.id === migId);
      if (migration) {
        try {
          await migration.down();
          this.appliedMigrations.delete(migId);
        } catch (error) {
          this.currentState.errors.push(
            `Rollback failed for ${migId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    this.currentState.stage = 'failed';
    this.emit('rollback-complete', this.currentState);
  }

  registerCompatibility(version: string, compatibleWith: string[]): void {
    this.compatibilityMatrix.set(version, new Set(compatibleWith));
  }

  checkCompatibility(from: string, to: string): boolean {
    const compatible = this.compatibilityMatrix.get(to);
    if (!compatible) return true; // No matrix = assume compatible
    return compatible.has(from);
  }

  getState(): UpgradeState | null {
    return this.currentState ? { ...this.currentState } : null;
  }

  private async runPreChecks(checks: PreCheck[]): Promise<void> {
    for (const check of checks) {
      const result = await check.check();
      if (!result.pass && check.required) {
        throw new Error(`Pre-check failed: ${check.name} — ${result.message}`);
      }
      this.emit('pre-check-result', { name: check.name, ...result });
    }
  }

  private async runMigrations(migrations: Migration[]): Promise<void> {
    for (const migration of migrations) {
      if (this.appliedMigrations.has(migration.id)) continue;

      await migration.up();
      this.appliedMigrations.add(migration.id);
      this.currentState!.migrationsApplied.push(migration.id);
      this.emit('migration-applied', migration.id);
    }
  }

  private async upgradeNode(nodeIndex: number): Promise<void> {
    // Simulate node upgrade
    this.emit('node-upgrading', nodeIndex);
    await new Promise((resolve) => setImmediate(resolve));
    this.emit('node-upgraded', nodeIndex);
  }

  private async canaryHealthCheck(): Promise<void> {
    // In production, this would verify canary nodes are healthy
    await new Promise((resolve) => setImmediate(resolve));
    this.emit('canary-healthy');
  }
}
