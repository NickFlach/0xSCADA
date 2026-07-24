/**
 * FanoDataBridge.ts — Maps real-time process data to visual parameters.
 *
 * Polls /api/geometry/phi and /api/geometry/classes, then maps metrics
 * to bloom, flow, breathing, and background parameters.
 */

import { BloomParams, BloomStyle, DEFAULT_BLOOM } from './BloomRenderer';
import { FlowParams, DEFAULT_FLOW } from './FlowRenderer';
import { FANO_LINES } from './FanoGeometry';
import { apiFetch } from '../../lib/api-credential';

export interface PhiApiResponse {
  phi: number;
  level: string;
  integration: number;
  differentiation: number;
  density: number;
  scale: number;
  partitions: {
    quadrant: { classes: number; crossRatio: number };
    triality: { classes: number; crossRatio: number };
    classIndex: { classes: number; crossRatio: number };
  };
  entities: number;
  links: number;
  fanoLinks: number;
  geometricBonus: number;
}

export interface ClassData {
  index: number;
  entityCount: number;
  updateRateHz: number;
  health: number;
  quality: number;
  alarmActive: boolean;
  stale: boolean;
}

export interface ClassApiResponse {
  classes: ClassData[];
}

export interface FanoVisualState {
  blooms: BloomParams[];
  flows: FlowParams[];
  phi: number;
  rotationSpeed: number;
  backgroundBrightness: number;
  hasAlarm: boolean;
}

export class FanoDataBridge {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastState: FanoVisualState;
  private onChange: ((state: FanoVisualState) => void) | null = null;

  constructor() {
    this.lastState = this.defaultState();
  }

  private defaultState(): FanoVisualState {
    return {
      blooms: Array.from({ length: 7 }, () => ({ ...DEFAULT_BLOOM })),
      flows: Array.from({ length: 7 }, () => ({ ...DEFAULT_FLOW })),
      phi: 0.5, rotationSpeed: 0.1, backgroundBrightness: 0.3, hasAlarm: false,
    };
  }

  start(intervalMs = 5000, callback?: (state: FanoVisualState) => void): void {
    this.onChange = callback ?? null;
    this.fetchAndUpdate();
    this.pollInterval = setInterval(() => this.fetchAndUpdate(), intervalMs);
  }

  stop(): void {
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
  }

  getState(): FanoVisualState { return this.lastState; }

  private async fetchAndUpdate(): Promise<void> {
    try {
      const [phiRes, classRes] = await Promise.allSettled([
        apiFetch('/api/geometry/phi').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<PhiApiResponse>; }),
        apiFetch('/api/geometry/classes').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<ClassApiResponse>; }),
      ]);
      const phiData = phiRes.status === 'fulfilled' ? phiRes.value : null;
      const classData = classRes.status === 'fulfilled' ? classRes.value : null;
      this.lastState = this.mapToVisualState(phiData, classData);
      this.onChange?.(this.lastState);
    } catch { /* keep last state */ }
  }

  private mapToVisualState(phi: PhiApiResponse | null, classes: ClassApiResponse | null): FanoVisualState {
    const state = this.defaultState();
    if (phi) {
      state.phi = phi.phi;
      state.rotationSpeed = phi.phi > 0.4 ? 0.05 + phi.phi * 0.1 : 0;
      state.backgroundBrightness = 0.05 + phi.phi * 0.4;
    }
    if (classes?.classes) {
      let hasAlarm = false;
      for (let i = 0; i < Math.min(classes.classes.length, 7); i++) {
        const c = classes.classes[i];
        state.blooms[i] = {
          size: Math.min(1, c.entityCount / 200),
          pulseHz: Math.min(3, 0.2 + c.updateRateHz * 0.3),
          health: c.health,
          glow: c.quality,
          style: this.toBloomStyle(c),
        };
        if (c.alarmActive) hasAlarm = true;
      }
      state.hasAlarm = hasAlarm;
      if (hasAlarm) state.rotationSpeed = 0;
      for (let li = 0; li < 7; li++) {
        const [a, b, c] = FANO_LINES[li].points;
        const ba = state.blooms[a], bb = state.blooms[b], bc = state.blooms[c];
        state.flows[li] = {
          flowRate: (ba.size + bb.size + bc.size) / 3,
          mutualInfo: (ba.health + bb.health + bc.health) / 3,
          direction: 1,
          coherent: Math.abs(ba.health - bb.health) < 0.3 && Math.abs(bb.health - bc.health) < 0.3,
        };
      }
    }
    return state;
  }

  private toBloomStyle(c: ClassData): BloomStyle {
    if (c.alarmActive) return 'starburst';
    if (c.stale) return 'ember';
    return 'spiral';
  }
}
