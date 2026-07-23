/**
 * Digital Twin Service
 * ADR-0013 [13.3] — Issue #214
 *
 * Singleton wrapper: drives running models on their time step, feeds live
 * tag updates into the runtime (numeric, good-quality readings only), and
 * exposes health. Read-only toward the plant — predictions never become
 * control writes here.
 */

import { EventEmitter } from 'events';

export * from './solver';
export * from './engine';

import { TwinRuntime } from './engine';

export interface TwinTagUpdateInput {
  tagName: string;
  value: number | string | boolean;
  timestamp: string | number;
  quality?: 'good' | 'bad' | 'uncertain';
}

export class DigitalTwinService extends EventEmitter {
  readonly runtime = new TwinRuntime();

  private initialized = false;
  private stepTimer: NodeJS.Timeout | null = null;
  private readonly stepIntervalMs: number;

  constructor(stepIntervalMs = 100) {
    super();
    this.stepIntervalMs = stepIntervalMs;
    this.runtime.on('model-error', (e) => this.emit('model-error', e));
    this.runtime.on('model-warnings', (e) => this.emit('model-warnings', e));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.stepTimer = setInterval(() => {
      try {
        const now = Date.now();
        this.runtime.syncRunningFromLive(now);
        this.runtime.stepRunning(now);
      } catch {
        /* per-model errors surface via 'model-error' */
      }
    }, this.stepIntervalMs);
    this.stepTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.stepTimer) {
      clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
    this.initialized = false;
  }

  /** Feed a live tag update — non-numeric or non-good readings are ignored */
  ingestTagUpdate(update: TwinTagUpdateInput): void {
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
    this.runtime.ingestActual(update.tagName, value, timestamp);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    const status = this.runtime.getStatus();
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Digital twin running: ${status.models} models (${status.running} live), ${status.boundTags} bound tags`
        : 'Digital twin service not initialized',
    };
  }
}

export const digitalTwinService = new DigitalTwinService();
