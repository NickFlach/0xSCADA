/**
 * Statistical Process Control (SPC) Service
 * 
 * Issue #353: Statistical process control for anomaly detection
 * SpaceChildCollective integration
 * 
 * Provides real-time SPC with control charts, Western Electric rules,
 * Nelson rules, process capability indices, and anomaly scoring.
 */

import { EventEmitter } from 'events';

export * from './control-charts';
export * from './rules-engine';
export * from './capability';
export * from './spc-engine';

import { SPCEngine, SPCEngineConfig } from './spc-engine';

export class SPCService extends EventEmitter {
  private engines: Map<string, SPCEngine> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  createEngine(config: SPCEngineConfig): SPCEngine {
    const engine = new SPCEngine(config);
    this.engines.set(config.id, engine);

    engine.on('anomaly', (anomaly) => {
      this.emit('anomaly', config.id, anomaly);
    });
    engine.on('out-of-control', (signal) => {
      this.emit('out-of-control', config.id, signal);
    });

    return engine;
  }

  getEngine(id: string): SPCEngine | undefined {
    return this.engines.get(id);
  }

  removeEngine(id: string): boolean {
    const engine = this.engines.get(id);
    if (engine) engine.removeAllListeners();
    return this.engines.delete(id);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return {
      healthy: this.initialized,
      message: this.initialized
        ? `SPC service running: ${this.engines.size} engines`
        : 'SPC service not initialized',
    };
  }
}

export const spcService = new SPCService();
