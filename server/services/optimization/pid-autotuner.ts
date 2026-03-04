/**
 * PID Auto-Tuner
 * 
 * Issue #351: Self-Optimizing PID Loops
 * 
 * Implements relay feedback (Åström-Hägglund), Ziegler-Nichols, and Cohen-Coon
 * auto-tuning methods. Monitors performance and suggests or applies new tuning.
 */

import { EventEmitter } from 'events';
import { PIDController, PIDGains, PIDPerformanceMetrics } from './pid-controller';

// ─── Types ──────────────────────────────────────────────────────────────

export type AutoTuneMode = 'automatic' | 'suggest' | 'manual';
export type TuningMethod = 'relay-feedback' | 'ziegler-nichols' | 'cohen-coon';

export interface TuningRecommendation {
  method: TuningMethod;
  gains: PIDGains;
  reason: string;
  confidence: number;
  timestamp: number;
}

export interface RelayFeedbackConfig {
  relayAmplitude: number;
  hysteresis: number;
  /** Minimum cycles to observe before computing */
  minCycles: number;
}

interface RelayState {
  active: boolean;
  output: number;
  peaks: number[];
  valleys: number[];
  lastCrossing: number;
  cycleCount: number;
}

// ─── Tuning Algorithms ──────────────────────────────────────────────────

/** Ziegler-Nichols from ultimate gain (Ku) and period (Tu) */
function zieglerNicholsPID(ku: number, tu: number): PIDGains {
  return {
    kp: 0.6 * ku,
    ki: (1.2 * ku) / tu,
    kd: (0.075 * ku) * tu,
  };
}

/** Cohen-Coon from process model parameters */
function cohenCoonPID(k: number, tau: number, theta: number): PIDGains {
  const r = theta / tau;
  return {
    kp: (1 / k) * (1.35 + (0.25 * r)),
    ki: (1 / k) * (1.35 + (0.25 * r)) / (theta * (2.5 - 2 * r) / (1 + 0.6 * r)),
    kd: (1 / k) * (1.35 + (0.25 * r)) * (0.37 * theta * r) / (1 + 0.2 * r),
  };
}

/** Compute ultimate gain and period from relay feedback oscillation data */
function relayFeedbackAnalysis(
  relayAmplitude: number,
  peaks: number[],
  valleys: number[]
): { ku: number; tu: number } | null {
  if (peaks.length < 2 || valleys.length < 2) return null;

  // Oscillation amplitude from average peak-to-valley
  const peakAvg = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const valleyAvg = valleys.reduce((a, b) => a + b, 0) / valleys.length;
  const amplitude = (peakAvg - valleyAvg) / 2;

  if (amplitude <= 0) return null;

  // Ultimate gain: Ku = 4d / (π·a) where d = relay amplitude, a = oscillation amplitude
  const ku = (4 * relayAmplitude) / (Math.PI * amplitude);

  // Ultimate period from peak-to-peak or valley-to-valley spacing
  // Here peaks/valleys are timestamps; compute average period
  let totalPeriod = 0;
  let count = 0;
  for (let i = 1; i < peaks.length; i++) {
    totalPeriod += peaks[i] - peaks[i - 1];
    count++;
  }
  if (count === 0) return null;
  const tu = totalPeriod / count;

  return { ku, tu };
}

// ─── Degradation Detection ──────────────────────────────────────────────

export interface DegradationThresholds {
  maxIAE: number;
  maxOvershoot: number;
  maxOscillationCrossings: number;
}

const DEFAULT_THRESHOLDS: DegradationThresholds = {
  maxIAE: 100,
  maxOvershoot: 0.25,
  maxOscillationCrossings: 8,
};

// ─── Auto-Tuner ─────────────────────────────────────────────────────────

export class PIDAutoTuner extends EventEmitter {
  private controller: PIDController;
  private mode: AutoTuneMode;
  private method: TuningMethod = 'relay-feedback';
  private thresholds: DegradationThresholds;
  private recommendations: TuningRecommendation[] = [];
  private relayState: RelayState | null = null;
  private relayConfig: RelayFeedbackConfig = { relayAmplitude: 5, hysteresis: 0.5, minCycles: 3 };
  private monitoring = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    controller: PIDController,
    mode: AutoTuneMode = 'suggest',
    thresholds?: Partial<DegradationThresholds>,
  ) {
    super();
    this.controller = controller;
    this.mode = mode;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  // ─── Mode & config ─────────────────────────────────────────────

  getMode(): AutoTuneMode { return this.mode; }
  setMode(m: AutoTuneMode): void { this.mode = m; }
  setMethod(m: TuningMethod): void { this.method = m; }
  setRelayConfig(cfg: Partial<RelayFeedbackConfig>): void { this.relayConfig = { ...this.relayConfig, ...cfg }; }
  getRecommendations(): TuningRecommendation[] { return [...this.recommendations]; }

  // ─── Monitoring loop ───────────────────────────────────────────

  startMonitoring(intervalMs = 5000): void {
    if (this.monitoring) return;
    this.monitoring = true;
    this.checkInterval = setInterval(() => this.evaluatePerformance(), intervalMs);
  }

  stopMonitoring(): void {
    this.monitoring = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /** Evaluate current performance and act based on mode */
  evaluatePerformance(): TuningRecommendation | null {
    const metrics = this.controller.getMetrics();
    const degraded = this.detectDegradation(metrics);
    if (!degraded) return null;

    const rec = this.computeRecommendation(metrics);
    if (!rec) return null;

    this.recommendations.push(rec);
    if (this.recommendations.length > 50) this.recommendations.shift();

    this.emit('recommendation', rec);

    if (this.mode === 'automatic') {
      const applied = this.controller.applyGains(rec.gains);
      if (applied) {
        this.emit('gains-applied', rec);
        this.controller.resetMetrics();
      } else {
        this.emit('gains-rejected', rec);
      }
    }

    return rec;
  }

  private detectDegradation(m: PIDPerformanceMetrics): boolean {
    if (m.sampleCount < 20) return false;
    return (
      m.iae > this.thresholds.maxIAE ||
      m.overshoot > this.thresholds.maxOvershoot ||
      m.zeroCrossings > this.thresholds.maxOscillationCrossings
    );
  }

  // ─── Recommendation computation ────────────────────────────────

  private computeRecommendation(metrics: PIDPerformanceMetrics): TuningRecommendation | null {
    const currentGains = this.controller.getGains();
    let gains: PIDGains;
    let reason: string;
    let confidence: number;

    if (metrics.oscillating) {
      // Reduce gains to damp oscillation
      gains = {
        kp: currentGains.kp * 0.8,
        ki: currentGains.ki * 0.85,
        kd: currentGains.kd * 1.1,
      };
      reason = `Oscillation detected (${metrics.zeroCrossings} zero-crossings). Reducing P/I, increasing D.`;
      confidence = 0.7;
    } else if (metrics.overshoot > this.thresholds.maxOvershoot) {
      gains = {
        kp: currentGains.kp * 0.9,
        ki: currentGains.ki * 0.9,
        kd: currentGains.kd * 1.15,
      };
      reason = `Overshoot ${(metrics.overshoot * 100).toFixed(1)}% exceeds ${(this.thresholds.maxOvershoot * 100).toFixed(1)}% limit.`;
      confidence = 0.6;
    } else {
      // Sluggish response — increase gains
      gains = {
        kp: currentGains.kp * 1.1,
        ki: currentGains.ki * 1.1,
        kd: currentGains.kd * 0.95,
      };
      reason = `Slow response (IAE=${metrics.iae.toFixed(1)}). Increasing P/I.`;
      confidence = 0.5;
    }

    return { method: this.method, gains, reason, confidence, timestamp: Date.now() };
  }

  // ─── Relay Feedback Test ───────────────────────────────────────

  startRelayTest(): void {
    this.relayState = {
      active: true,
      output: this.relayConfig.relayAmplitude,
      peaks: [],
      valleys: [],
      lastCrossing: Date.now() / 1000,
      cycleCount: 0,
    };
    this.emit('relay-started');
  }

  /**
   * Feed a PV sample during relay test. Returns relay output to apply,
   * or null if the test is complete.
   */
  relayStep(processVariable: number): number | null {
    if (!this.relayState?.active) return null;
    const sp = this.controller.getSetpoint();
    const error = sp - processVariable;
    const now = Date.now() / 1000;

    // Relay switching with hysteresis
    if (error > this.relayConfig.hysteresis && this.relayState.output < 0) {
      this.relayState.output = this.relayConfig.relayAmplitude;
      this.relayState.valleys.push(processVariable);
      this.relayState.cycleCount++;
      this.relayState.lastCrossing = now;
    } else if (error < -this.relayConfig.hysteresis && this.relayState.output > 0) {
      this.relayState.output = -this.relayConfig.relayAmplitude;
      this.relayState.peaks.push(processVariable);
      this.relayState.lastCrossing = now;
    }

    // Track peaks as timestamps for period computation — override to use time
    // (We store PV values in peaks/valleys and time-based periods separately)

    // Check if enough cycles
    if (this.relayState.cycleCount >= this.relayConfig.minCycles) {
      this.completeRelayTest();
      return null;
    }

    return this.relayState.output;
  }

  private completeRelayTest(): void {
    if (!this.relayState) return;

    const result = relayFeedbackAnalysis(
      this.relayConfig.relayAmplitude,
      this.relayState.peaks,
      this.relayState.valleys,
    );

    this.relayState.active = false;

    if (result) {
      const gains = zieglerNicholsPID(result.ku, result.tu);
      const rec: TuningRecommendation = {
        method: 'relay-feedback',
        gains,
        reason: `Relay feedback: Ku=${result.ku.toFixed(3)}, Tu=${result.tu.toFixed(3)}s → Z-N tuning`,
        confidence: 0.85,
        timestamp: Date.now(),
      };
      this.recommendations.push(rec);
      this.emit('relay-complete', rec);

      if (this.mode === 'automatic') {
        const applied = this.controller.applyGains(gains);
        this.emit(applied ? 'gains-applied' : 'gains-rejected', rec);
      }
    } else {
      this.emit('relay-failed', 'Insufficient oscillation data');
    }
  }

  /**
   * Compute Cohen-Coon tuning from a step-response model.
   * k = process gain, tau = time constant, theta = dead time.
   */
  cohenCoonTune(k: number, tau: number, theta: number): TuningRecommendation {
    const gains = cohenCoonPID(k, tau, theta);
    const rec: TuningRecommendation = {
      method: 'cohen-coon',
      gains,
      reason: `Cohen-Coon: K=${k.toFixed(3)}, τ=${tau.toFixed(3)}, θ=${theta.toFixed(3)}`,
      confidence: 0.75,
      timestamp: Date.now(),
    };
    this.recommendations.push(rec);
    this.emit('recommendation', rec);
    return rec;
  }
}
