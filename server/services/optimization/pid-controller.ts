/**
 * PID Controller Model
 * 
 * Issue #351: Self-Optimizing PID Loops
 * 
 * Implements a discrete PID controller with anti-windup, output clamping,
 * and performance metrics tracking for SCADA process control.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface PIDGains {
  kp: number;  // Proportional gain
  ki: number;  // Integral gain
  kd: number;  // Derivative gain
}

export interface PIDControllerConfig {
  id: string;
  name: string;
  gains: PIDGains;
  setpoint: number;
  outputMin: number;
  outputMax: number;
  /** Maximum allowed rate of gain change per tuning step (fraction, e.g. 0.25 = 25%) */
  maxGainChangeFraction?: number;
  /** Anti-windup integral limit */
  integralLimit?: number;
  /** Sample time in seconds */
  sampleTime?: number;
  /** Derivative filter coefficient (0–1, lower = more filtering) */
  derivativeFilterAlpha?: number;
}

export interface PIDState {
  processVariable: number;
  error: number;
  integral: number;
  derivative: number;
  output: number;
  timestamp: number;
}

export interface PIDPerformanceMetrics {
  /** Integral of Squared Error */
  ise: number;
  /** Integral of Absolute Error */
  iae: number;
  /** Integral of Time-weighted Absolute Error */
  itae: number;
  /** Maximum overshoot (fraction of setpoint change) */
  overshoot: number;
  /** Settling time in seconds (within 2% of setpoint) */
  settlingTime: number | null;
  /** Whether oscillation is detected */
  oscillating: boolean;
  /** Number of zero-crossings of error in recent window */
  zeroCrossings: number;
  /** Samples processed */
  sampleCount: number;
}

// ─── Controller ─────────────────────────────────────────────────────────

export class PIDController {
  readonly id: string;
  readonly name: string;

  private gains: PIDGains;
  private setpoint: number;
  private outputMin: number;
  private outputMax: number;
  private maxGainChangeFraction: number;
  private integralLimit: number;
  private sampleTime: number;
  private derivativeFilterAlpha: number;

  // Internal state
  private integral = 0;
  private prevError = 0;
  private prevDerivative = 0;
  private prevOutput = 0;
  private startTime = 0;
  private settled = false;
  private settledTime: number | null = null;

  // History for metrics
  private errorHistory: { t: number; e: number }[] = [];
  private readonly maxHistory = 2000;

  // Performance accumulators
  private ise = 0;
  private iae = 0;
  private itae = 0;
  private peakPV = -Infinity;
  private sampleCount = 0;

  constructor(config: PIDControllerConfig) {
    this.id = config.id;
    this.name = config.name;
    this.gains = { ...config.gains };
    this.setpoint = config.setpoint;
    this.outputMin = config.outputMin;
    this.outputMax = config.outputMax;
    this.maxGainChangeFraction = config.maxGainChangeFraction ?? 0.25;
    this.integralLimit = config.integralLimit ?? 1000;
    this.sampleTime = config.sampleTime ?? 1;
    this.derivativeFilterAlpha = config.derivativeFilterAlpha ?? 0.1;
    this.startTime = Date.now() / 1000;
  }

  /** Process one sample and return the controller output */
  update(processVariable: number, dt?: number): PIDState {
    const now = Date.now() / 1000;
    const deltaT = dt ?? this.sampleTime;
    const error = this.setpoint - processVariable;

    // Proportional
    const pTerm = this.gains.kp * error;

    // Integral with anti-windup
    this.integral += error * deltaT;
    this.integral = Math.max(-this.integralLimit, Math.min(this.integralLimit, this.integral));
    const iTerm = this.gains.ki * this.integral;

    // Derivative with low-pass filter
    const rawDerivative = deltaT > 0 ? (error - this.prevError) / deltaT : 0;
    const filteredDerivative =
      this.derivativeFilterAlpha * rawDerivative +
      (1 - this.derivativeFilterAlpha) * this.prevDerivative;
    const dTerm = this.gains.kd * filteredDerivative;

    // Output with clamping
    let output = pTerm + iTerm + dTerm;
    output = Math.max(this.outputMin, Math.min(this.outputMax, output));

    // Back-calculation anti-windup
    if (output !== pTerm + iTerm + dTerm) {
      this.integral -= error * deltaT;
    }

    // Track metrics
    const elapsed = now - this.startTime;
    this.ise += error * error * deltaT;
    this.iae += Math.abs(error) * deltaT;
    this.itae += elapsed * Math.abs(error) * deltaT;
    this.sampleCount++;

    // Overshoot tracking
    if (processVariable > this.peakPV) this.peakPV = processVariable;

    // Settling detection (within 2%)
    const band = Math.abs(this.setpoint) * 0.02 || 0.02;
    if (!this.settled && Math.abs(error) <= band) {
      this.settled = true;
      this.settledTime = elapsed;
    } else if (this.settled && Math.abs(error) > band) {
      this.settled = false;
      this.settledTime = null;
    }

    // Error history for oscillation detection
    this.errorHistory.push({ t: elapsed, e: error });
    if (this.errorHistory.length > this.maxHistory) {
      this.errorHistory.shift();
    }

    this.prevError = error;
    this.prevDerivative = filteredDerivative;
    this.prevOutput = output;

    return { processVariable, error, integral: this.integral, derivative: filteredDerivative, output, timestamp: now };
  }

  /** Get current performance metrics */
  getMetrics(): PIDPerformanceMetrics {
    const overshoot = this.setpoint !== 0
      ? Math.max(0, (this.peakPV - this.setpoint) / Math.abs(this.setpoint))
      : 0;

    // Count zero-crossings in recent history
    const recent = this.errorHistory.slice(-200);
    let zeroCrossings = 0;
    for (let i = 1; i < recent.length; i++) {
      if ((recent[i].e > 0 && recent[i - 1].e < 0) || (recent[i].e < 0 && recent[i - 1].e > 0)) {
        zeroCrossings++;
      }
    }

    return {
      ise: this.ise,
      iae: this.iae,
      itae: this.itae,
      overshoot,
      settlingTime: this.settledTime,
      oscillating: zeroCrossings > 6,
      zeroCrossings,
      sampleCount: this.sampleCount,
    };
  }

  /** Reset performance accumulators */
  resetMetrics(): void {
    this.ise = 0;
    this.iae = 0;
    this.itae = 0;
    this.peakPV = -Infinity;
    this.settled = false;
    this.settledTime = null;
    this.errorHistory = [];
    this.sampleCount = 0;
    this.startTime = Date.now() / 1000;
  }

  // ─── Getters / setters ────────────────────────────────────────────

  getGains(): PIDGains { return { ...this.gains }; }
  getSetpoint(): number { return this.setpoint; }
  getOutput(): number { return this.prevOutput; }

  setSetpoint(sp: number): void {
    this.setpoint = sp;
    this.resetMetrics();
  }

  /**
   * Apply new gains with safety bounds.
   * Returns true if gains were applied, false if rejected due to safety limits.
   */
  applyGains(newGains: PIDGains): boolean {
    const frac = this.maxGainChangeFraction;
    const check = (old: number, next: number) => {
      if (old === 0) return Math.abs(next) < 1;
      return Math.abs((next - old) / old) <= frac;
    };

    if (!check(this.gains.kp, newGains.kp) ||
        !check(this.gains.ki, newGains.ki) ||
        !check(this.gains.kd, newGains.kd)) {
      return false;
    }

    this.gains = { ...newGains };
    return true;
  }

  /** Force-apply gains ignoring safety bounds */
  forceGains(newGains: PIDGains): void {
    this.gains = { ...newGains };
  }
}
