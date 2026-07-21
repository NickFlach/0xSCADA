/**
 * Predictive Maintenance Service
 * ADR-0013 [13.1] — Issue #212
 *
 * Wraps the PredictiveMaintenanceEngine as a singleton service: consumes
 * live tag updates (numeric values only), runs a periodic analysis sweep,
 * and re-emits engine alerts for downstream consumers (WebSocket, alarms).
 */

import { EventEmitter } from 'events';

export * from './detectors';
export * from './engine';

import { PredictiveMaintenanceEngine } from './engine';
import type { PredictiveAlert } from '@shared/types/predictive';

export interface TagUpdateInput {
  tagName: string;
  value: number | string | boolean;
  timestamp: string | number;
}

export class PredictiveMaintenanceService extends EventEmitter {
  readonly engine = new PredictiveMaintenanceEngine();

  private initialized = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepIntervalMs: number;

  constructor(sweepIntervalMs = 30_000) {
    super();
    this.sweepIntervalMs = sweepIntervalMs;
    this.engine.on('alert', (alert: PredictiveAlert) => this.emit('alert', alert));
    this.engine.on('detector-error', (err) => this.emit('detector-error', err));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.sweepTimer = setInterval(() => {
      void this.engine.analyzeAll().catch(() => {
        /* per-detector errors already surface via 'detector-error' */
      });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Feed a live tag update into the engine. Non-numeric values are ignored —
   * the statistical detectors only apply to analog signals.
   */
  ingestTagUpdate(update: TagUpdateInput): void {
    if (typeof update.value === 'boolean') return;
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
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const status = this.engine.getStatus();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Predictive maintenance running: ${status.trackedTags} tags, ${status.activeAlerts} active alerts`
        : 'Predictive maintenance service not initialized',
    };
  }
}

export const predictiveMaintenanceService = new PredictiveMaintenanceService();
