/**
 * Predictive Maintenance Service
 * ADR-0013 [13.1] — Issue #212, made durable by #546
 *
 * Wraps the PredictiveMaintenanceEngine as a singleton service: hydrates
 * durable state at startup, consumes live tag updates (numeric values only),
 * runs a periodic analysis sweep, applies the alert retention policy, and
 * re-emits engine alerts for downstream consumers (WebSocket, alarms).
 */

import { EventEmitter } from 'events';

export * from './detectors';
export * from './engine';
export * from './store';

import {
  DEFAULT_ALERT_MAX_AGE_MS,
  DEFAULT_ALERT_RETENTION_MS,
  PredictiveMaintenanceEngine,
  type EngineOptions,
} from './engine';
import type { PredictiveAlert, PredictiveHydrationSummary } from '@shared/types/predictive';

export interface TagUpdateInput {
  tagName: string;
  value: number | string | boolean;
  timestamp: string | number;
  /** OPC-style quality flag — only 'good' (or absent) readings are ingested */
  quality?: 'good' | 'bad' | 'uncertain';
}

/**
 * Retention for durable alert state, read from the environment.
 *
 * This is deliberately separate from the raw-history window
 * (`EngineOptions.maxHistorySize` / `maxTrackedTags`), which bounds sampled
 * data by sample count rather than by calendar age: operator/audit state and
 * process data have different reasons to be kept and different reasons to go.
 */
export function resolveAlertRetention(
  env: NodeJS.ProcessEnv = process.env,
): { alertRetentionMs: number; alertMaxAgeMs: number } {
  const retention = positiveMs(env.PREDICTIVE_ALERT_RETENTION_MS, DEFAULT_ALERT_RETENTION_MS);
  const maxAge = positiveMs(env.PREDICTIVE_ALERT_MAX_AGE_MS, DEFAULT_ALERT_MAX_AGE_MS);
  // The absolute cut-off must not be shorter than the acknowledged-alert
  // window, or an acknowledged alert would outlive an unacknowledged one.
  return { alertRetentionMs: retention, alertMaxAgeMs: Math.max(retention, maxAge) };
}

function positiveMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface PredictiveServiceOptions extends EngineOptions {
  sweepIntervalMs?: number;
  /** How often the alert retention policy is applied. */
  retentionIntervalMs?: number;
}

export class PredictiveMaintenanceService extends EventEmitter {
  readonly engine: PredictiveMaintenanceEngine;

  private initialized = false;
  private hydration: PredictiveHydrationSummary | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private sweepIntervalMs: number;
  private retentionIntervalMs: number;

  constructor(sweepIntervalMs = 30_000, options: PredictiveServiceOptions = {}) {
    super();
    this.sweepIntervalMs = options.sweepIntervalMs ?? sweepIntervalMs;
    this.retentionIntervalMs = options.retentionIntervalMs ?? 60 * 60 * 1000;
    const { alertRetentionMs, alertMaxAgeMs } = resolveAlertRetention();
    this.engine = new PredictiveMaintenanceEngine({
      alertRetentionMs,
      alertMaxAgeMs,
      ...options,
    });
    this.engine.on('alert', (alert: PredictiveAlert) => this.emit('alert', alert));
    this.engine.on('detector-error', (err) => this.emit('detector-error', err));
    this.engine.on('store-error', (err) => this.emit('store-error', err));
    this.engine.on('alerts-pruned', (result) => this.emit('alerts-pruned', result));
  }

  /**
   * Hydrate durable state, then start the sweeps.
   *
   * Hydration failure does NOT silently degrade into the old process-local
   * behaviour: it is logged, reported by `healthCheck()`, and retried on every
   * sweep. Until it succeeds every durable mutation (threshold write, alert
   * generation, acknowledgement) fails closed on its own, because each one
   * goes through the store rather than through a local cache.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.hydrateOnce();

    this.sweepTimer = setInterval(() => {
      void (async () => {
        if (!this.hydration) await this.hydrateOnce();
        await this.engine.analyzeAll().catch(() => {
          /* per-tag errors already surface via 'analyze-error' */
        });
      })();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();

    this.retentionTimer = setInterval(() => {
      void this.engine.pruneAlerts().catch((error: unknown) => {
        console.error(
          '[predictive] alert retention sweep failed:',
          error instanceof Error ? error.message : error,
        );
      });
    }, this.retentionIntervalMs);
    this.retentionTimer.unref?.();
  }

  /** What startup hydration found, or null if it has not succeeded yet. */
  getHydration(): PredictiveHydrationSummary | null {
    return this.hydration;
  }

  /**
   * Feed a live tag update into the engine. Non-numeric values are ignored —
   * the statistical detectors only apply to analog signals — and non-good
   * quality readings are excluded so failed sensors can't poison baselines.
   */
  ingestTagUpdate(update: TagUpdateInput): void {
    if (update.quality !== undefined && update.quality !== 'good') return;
    if (typeof update.value === 'boolean') return;
    if (typeof update.value === 'string' && update.value.trim() === '') return;
    const value = typeof update.value === 'number' ? update.value : Number(update.value);
    if (!Number.isFinite(value)) return;
    const timestamp =
      typeof update.timestamp === 'number'
        ? update.timestamp
        : new Date(update.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return;
    this.engine.ingestPoint(update.tagName, timestamp, value);
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    this.initialized = false;
    this.hydration = null;
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const status = this.engine.getStatus();
    if (!this.initialized) {
      return { healthy: false, message: 'Predictive maintenance service not initialized' };
    }
    try {
      const durable = await this.engine.getDurableStatus();
      return {
        healthy: true,
        message:
          `Predictive maintenance running: ${status.trackedTags} tags in window, `
          + `${durable.configuredTags} configured tag(s), `
          + `${durable.activeAlerts} unacknowledged of ${durable.totalAlerts} durable alert(s), `
          + `store backend ${durable.backend}`,
      };
    } catch (error) {
      // A reachable process with an unreachable store is NOT healthy: every
      // threshold write and acknowledgement is failing closed right now.
      return {
        healthy: false,
        message:
          'Predictive maintenance durable store unavailable: '
          + (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private async hydrateOnce(): Promise<void> {
    try {
      this.hydration = await this.engine.hydrate();
      console.log(
        `[predictive] hydrated durable state from ${this.hydration.backend}: `
        + `${this.hydration.configuredTags} configured tag(s), `
        + `${this.hydration.unacknowledgedAlerts} unacknowledged of `
        + `${this.hydration.totalAlerts} alert(s)`,
      );
    } catch (error) {
      this.hydration = null;
      console.error(
        '[predictive] durable state unavailable — threshold writes, alert generation and '
        + 'acknowledgements will be refused until it is reachable:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export const predictiveMaintenanceService = new PredictiveMaintenanceService();
