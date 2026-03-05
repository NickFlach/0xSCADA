/**
 * BreathingController.ts — Phi-driven respiratory cycle for the Living Fano plane.
 *
 *   Φ > 0.7  → slow 4-second breath (plant is calm)
 *   Φ 0.4–0.7 → 2-second breath (elevated attention)
 *   Φ < 0.4  → rapid 1-second breath (plant is stressed)
 *
 * Smooth exponential interpolation between target periods.
 */

export class BreathingController {
  private currentPeriod = 4;
  private targetPeriod = 4;
  private phase = 0;
  private smoothing = 3;

  setPhi(phi: number): void {
    if (phi > 0.7) {
      this.targetPeriod = 4;
    } else if (phi > 0.4) {
      this.targetPeriod = 2;
    } else {
      this.targetPeriod = 1;
    }
  }

  update(dt: number): number {
    const alpha = 1 - Math.exp(-dt * this.smoothing);
    this.currentPeriod += (this.targetPeriod - this.currentPeriod) * alpha;
    const omega = (2 * Math.PI) / this.currentPeriod;
    this.phase += omega * dt;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return 0.5 + 0.5 * Math.sin(this.phase);
  }

  getPeriod(): number {
    return this.currentPeriod;
  }

  reset(): void {
    this.phase = 0;
    this.currentPeriod = 4;
    this.targetPeriod = 4;
  }
}
