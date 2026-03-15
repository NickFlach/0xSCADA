/**
 * FlowRenderer.ts — Particle flow animation along the 7 Fano lines.
 *
 *   - Line thickness proportional to information flow rate
 *   - Particle direction shows causality
 *   - Brightness from mutual information
 *   - Synchronized pulse when coherent, desynchronized when not
 */

import { FanoPoint, FANO_LINES, FanoLine } from './FanoGeometry';

export interface FlowParams {
  flowRate: number;
  mutualInfo: number;
  direction: 1 | -1;
  coherent: boolean;
}

export const DEFAULT_FLOW: FlowParams = {
  flowRate: 0.3, mutualInfo: 0.5, direction: 1, coherent: true,
};

interface Particle {
  lineIndex: number;
  segment: 0 | 1;
  t: number;
  speed: number;
}

export class FlowRenderer {
  private particles: Particle[] = [];
  private flowParams: FlowParams[] = [];
  private readonly maxPerLine = 6;

  constructor() {
    this.flowParams = Array.from({ length: 7 }, () => ({ ...DEFAULT_FLOW }));
    this.initParticles();
  }

  private initParticles(): void {
    this.particles = [];
    for (let li = 0; li < 7; li++) {
      for (let i = 0; i < 3; i++) {
        this.particles.push({
          lineIndex: li, segment: (i % 2) as 0 | 1,
          t: Math.random(), speed: 0.3 + Math.random() * 0.4,
        });
      }
    }
  }

  setLineFlow(lineIndex: number, params: Partial<FlowParams>): void {
    if (lineIndex >= 0 && lineIndex < 7) Object.assign(this.flowParams[lineIndex], params);
  }

  setAllFlows(params: FlowParams[]): void {
    for (let i = 0; i < Math.min(params.length, 7); i++) this.flowParams[i] = { ...params[i] };
  }

  update(dt: number): void {
    for (const p of this.particles) {
      const flow = this.flowParams[p.lineIndex];
      p.t += flow.direction * p.speed * dt * (0.5 + flow.flowRate);
      if (p.t > 1) { p.t -= 1; p.segment = p.segment === 0 ? 1 : 0; }
      else if (p.t < 0) { p.t += 1; p.segment = p.segment === 0 ? 1 : 0; }
    }
    // Dynamic particle count
    for (let li = 0; li < 7; li++) {
      const desired = Math.max(1, Math.round(this.flowParams[li].flowRate * this.maxPerLine));
      const current = this.particles.filter((p) => p.lineIndex === li).length;
      if (current < desired) {
        this.particles.push({
          lineIndex: li, segment: Math.random() > 0.5 ? 1 : 0,
          t: Math.random(), speed: 0.3 + Math.random() * 0.4,
        });
      } else if (current > desired) {
        const idx = this.particles.findIndex(p => p.lineIndex === li);
        if (idx >= 0) this.particles.splice(idx, 1);
      }
    }
  }

  render(
    ctx: CanvasRenderingContext2D, points: FanoPoint[],
    w: number, h: number, time: number
  ): void {
    // Lines
    for (let li = 0; li < 7; li++) {
      const line = FANO_LINES[li];
      const flow = this.flowParams[li];
      const [a, b, c] = line.points;
      const thickness = 0.5 + flow.flowRate * 3;
      const alpha = 0.15 + flow.mutualInfo * 0.5;
      const cPulse = flow.coherent ? 1 : 0.6 + 0.4 * Math.sin(time * 5 + li * 2.3);

      ctx.strokeStyle = `rgba(100,180,255,${(alpha * cPulse).toFixed(3)})`;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(points[a].x * w, points[a].y * h);
      ctx.lineTo(points[b].x * w, points[b].y * h);
      ctx.lineTo(points[c].x * w, points[c].y * h);
      ctx.stroke();
    }
    // Particles
    for (const p of this.particles) {
      const line = FANO_LINES[p.lineIndex];
      const flow = this.flowParams[p.lineIndex];
      const [a, b, c] = line.points;
      const from = points[p.segment === 0 ? a : b];
      const to = points[p.segment === 0 ? b : c];
      const x = (from.x + (to.x - from.x) * p.t) * w;
      const y = (from.y + (to.y - from.y) * p.t) * h;
      const pAlpha = 0.3 + flow.mutualInfo * 0.7;
      const r = 1.5 + flow.flowRate * 2;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(150,220,255,${pAlpha.toFixed(3)})`;
      ctx.fill();
    }
  }
}
