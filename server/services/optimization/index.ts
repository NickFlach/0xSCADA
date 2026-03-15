/**
 * Optimization Service — Self-Optimizing PID Loops & Decoherence Scheduler
 * 
 * Issue #351: Port Self-Optimizing Loops for PID auto-tuning
 * Issue #352: Implement Decoherence Scheduler for sensor drift modeling
 * 
 * Ported from QuantumSingularity optimization concepts into real SCADA PID tuning
 * and sensor coherence management.
 */

export * from './pid-controller';
export * from './pid-autotuner';
export * from './decoherence-scheduler';
export * from './correlation';

import { EventEmitter } from 'events';
import { PIDController, PIDControllerConfig } from './pid-controller';
import { PIDAutoTuner, AutoTuneMode } from './pid-autotuner';
import { DecoherenceScheduler } from './decoherence-scheduler';

export class OptimizationService extends EventEmitter {
  private controllers: Map<string, PIDController> = new Map();
  private autoTuners: Map<string, PIDAutoTuner> = new Map();
  private decoherenceScheduler: DecoherenceScheduler;
  private initialized = false;

  constructor() {
    super();
    this.decoherenceScheduler = new DecoherenceScheduler();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.decoherenceScheduler.on('calibration-due', (sensorId, coherence) => {
      this.emit('calibration-due', sensorId, coherence);
    });
    this.initialized = true;
  }

  createController(config: PIDControllerConfig): PIDController {
    const controller = new PIDController(config);
    this.controllers.set(config.id, controller);
    return controller;
  }

  getController(id: string): PIDController | undefined {
    return this.controllers.get(id);
  }

  createAutoTuner(controllerId: string, mode: AutoTuneMode = 'suggest'): PIDAutoTuner | undefined {
    const controller = this.controllers.get(controllerId);
    if (!controller) return undefined;
    const tuner = new PIDAutoTuner(controller, mode);
    this.autoTuners.set(controllerId, tuner);
    return tuner;
  }

  getDecoherenceScheduler(): DecoherenceScheduler {
    return this.decoherenceScheduler;
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `Optimization service running: ${this.controllers.size} controllers, ${this.decoherenceScheduler.getSensorCount()} sensors`
        : 'Optimization service not initialized'
    };
  }
}

export const optimizationService = new OptimizationService();
