/**
 * Control Charts
 * 
 * Issue #353: Statistical Process Control
 * 
 * Implements X-bar, R, S, CUSUM, and EWMA control charts for
 * real-time process monitoring.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface ControlLimits {
  ucl: number;  // Upper control limit
  cl: number;   // Center line
  lcl: number;  // Lower control limit
}

export interface ChartPoint {
  value: number;
  timestamp: number;
  subgroupIndex: number;
  outsideControl: boolean;
}

export interface SubgroupData {
  values: number[];
  timestamp: number;
}

// ─── Constants (A2, D3, D4, c4 tables for subgroup sizes 2–10) ────────

const A2: Record<number, number> = { 2: 1.880, 3: 1.023, 4: 0.729, 5: 0.577, 6: 0.483, 7: 0.419, 8: 0.373, 9: 0.337, 10: 0.308 };
const D3: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0.076, 8: 0.136, 9: 0.184, 10: 0.223 };
const D4: Record<number, number> = { 2: 3.267, 3: 2.574, 4: 2.282, 5: 2.114, 6: 2.004, 7: 1.924, 8: 1.864, 9: 1.816, 10: 1.777 };
const c4: Record<number, number> = { 2: 0.7979, 3: 0.8862, 4: 0.9213, 5: 0.9400, 6: 0.9515, 7: 0.9594, 8: 0.9650, 9: 0.9693, 10: 0.9727 };
const B3: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0.030, 7: 0.118, 8: 0.185, 9: 0.239, 10: 0.284 };
const B4: Record<number, number> = { 2: 3.267, 3: 2.568, 4: 2.266, 5: 2.089, 6: 1.970, 7: 1.882, 8: 1.815, 9: 1.761, 10: 1.716 };

// ─── Helper ─────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function range(arr: number[]): number {
  return Math.max(...arr) - Math.min(...arr);
}

// ─── X-bar / R Chart ────────────────────────────────────────────────────

export class XBarRChart {
  private subgroups: SubgroupData[] = [];
  private xBarPoints: ChartPoint[] = [];
  private rPoints: ChartPoint[] = [];
  private xBarLimits: ControlLimits | null = null;
  private rLimits: ControlLimits | null = null;
  private subgroupSize: number;

  constructor(subgroupSize: number = 5) {
    this.subgroupSize = Math.max(2, Math.min(10, subgroupSize));
  }

  addSubgroup(data: SubgroupData): { xBar: ChartPoint; r: ChartPoint } {
    this.subgroups.push(data);
    const idx = this.subgroups.length - 1;

    const xBar = mean(data.values);
    const r = range(data.values);

    // Recompute limits periodically (every 25 subgroups or at start)
    if (this.subgroups.length >= 25 && this.subgroups.length % 25 === 0) {
      this.computeLimits();
    } else if (!this.xBarLimits && this.subgroups.length >= 10) {
      this.computeLimits();
    }

    const xBarPoint: ChartPoint = {
      value: xBar,
      timestamp: data.timestamp,
      subgroupIndex: idx,
      outsideControl: this.xBarLimits ? (xBar > this.xBarLimits.ucl || xBar < this.xBarLimits.lcl) : false,
    };
    const rPoint: ChartPoint = {
      value: r,
      timestamp: data.timestamp,
      subgroupIndex: idx,
      outsideControl: this.rLimits ? (r > this.rLimits.ucl || r < this.rLimits.lcl) : false,
    };

    this.xBarPoints.push(xBarPoint);
    this.rPoints.push(rPoint);

    return { xBar: xBarPoint, r: rPoint };
  }

  private computeLimits(): void {
    const xBars = this.subgroups.map(s => mean(s.values));
    const ranges = this.subgroups.map(s => range(s.values));
    const xBarBar = mean(xBars);
    const rBar = mean(ranges);
    const n = this.subgroupSize;

    this.xBarLimits = {
      ucl: xBarBar + (A2[n] ?? 0.577) * rBar,
      cl: xBarBar,
      lcl: xBarBar - (A2[n] ?? 0.577) * rBar,
    };

    this.rLimits = {
      ucl: (D4[n] ?? 2.114) * rBar,
      cl: rBar,
      lcl: (D3[n] ?? 0) * rBar,
    };
  }

  getXBarLimits(): ControlLimits | null { return this.xBarLimits; }
  getRLimits(): ControlLimits | null { return this.rLimits; }
  getXBarPoints(): ChartPoint[] { return this.xBarPoints; }
  getRPoints(): ChartPoint[] { return this.rPoints; }
}

// ─── S Chart ────────────────────────────────────────────────────────────

export class SChart {
  private subgroups: SubgroupData[] = [];
  private points: ChartPoint[] = [];
  private limits: ControlLimits | null = null;
  private subgroupSize: number;

  constructor(subgroupSize: number = 5) {
    this.subgroupSize = Math.max(2, Math.min(10, subgroupSize));
  }

  addSubgroup(data: SubgroupData): ChartPoint {
    this.subgroups.push(data);
    const s = stdDev(data.values);
    const idx = this.subgroups.length - 1;

    if (!this.limits && this.subgroups.length >= 10) this.computeLimits();
    else if (this.subgroups.length >= 25 && this.subgroups.length % 25 === 0) this.computeLimits();

    const point: ChartPoint = {
      value: s,
      timestamp: data.timestamp,
      subgroupIndex: idx,
      outsideControl: this.limits ? (s > this.limits.ucl || s < this.limits.lcl) : false,
    };
    this.points.push(point);
    return point;
  }

  private computeLimits(): void {
    const sValues = this.subgroups.map(s => stdDev(s.values));
    const sBar = mean(sValues);
    const n = this.subgroupSize;

    this.limits = {
      ucl: (B4[n] ?? 2.089) * sBar,
      cl: sBar,
      lcl: (B3[n] ?? 0) * sBar,
    };
  }

  getLimits(): ControlLimits | null { return this.limits; }
  getPoints(): ChartPoint[] { return this.points; }
}

// ─── CUSUM Chart ────────────────────────────────────────────────────────

export interface CUSUMConfig {
  target: number;
  /** Allowance (slack) value, typically 0.5σ */
  k: number;
  /** Decision interval, typically 4–5σ */
  h: number;
}

export class CUSUMChart {
  private config: CUSUMConfig;
  private cPlus = 0;
  private cMinus = 0;
  private points: { cPlus: number; cMinus: number; timestamp: number; signal: boolean }[] = [];

  constructor(config: CUSUMConfig) {
    this.config = config;
  }

  addValue(value: number, timestamp: number): { cPlus: number; cMinus: number; signal: boolean } {
    const z = value - this.config.target;
    this.cPlus = Math.max(0, this.cPlus + z - this.config.k);
    this.cMinus = Math.max(0, this.cMinus - z - this.config.k);
    const signal = this.cPlus > this.config.h || this.cMinus > this.config.h;
    const point = { cPlus: this.cPlus, cMinus: this.cMinus, timestamp, signal };
    this.points.push(point);
    return point;
  }

  reset(): void {
    this.cPlus = 0;
    this.cMinus = 0;
  }

  getPoints() { return this.points; }
}

// ─── EWMA Chart ─────────────────────────────────────────────────────────

export interface EWMAConfig {
  target: number;
  /** Smoothing parameter (0 < λ ≤ 1), typically 0.1–0.3 */
  lambda: number;
  /** Process standard deviation */
  sigma: number;
  /** Control limit width in sigma units (typically 3) */
  L: number;
}

export class EWMAChart {
  private config: EWMAConfig;
  private ewma: number;
  private points: { value: number; ucl: number; lcl: number; timestamp: number; signal: boolean }[] = [];
  private sampleCount = 0;

  constructor(config: EWMAConfig) {
    this.config = config;
    this.ewma = config.target;
  }

  addValue(value: number, timestamp: number) {
    const { lambda, target, sigma, L } = this.config;
    this.sampleCount++;
    this.ewma = lambda * value + (1 - lambda) * this.ewma;

    // Time-varying control limits
    const factor = Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * this.sampleCount)));
    const ucl = target + L * sigma * factor;
    const lcl = target - L * sigma * factor;
    const signal = this.ewma > ucl || this.ewma < lcl;

    const point = { value: this.ewma, ucl, lcl, timestamp, signal };
    this.points.push(point);
    return point;
  }

  reset(): void {
    this.ewma = this.config.target;
    this.sampleCount = 0;
  }

  getPoints() { return this.points; }
}
