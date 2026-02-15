/**
 * Auto-Tuning PID Controllers
 * ADR-0013 [13.4] — RL-based PID auto-tuning within safety envelopes
 */

export interface PIDParameters {
  kp: number;
  ki: number;
  kd: number;
}

export interface PIDState {
  controllerId: string;
  current: PIDParameters;
  proposed: PIDParameters | null;
  approvalStatus: 'none' | 'pending' | 'approved' | 'rejected';
  safetyEnvelope: SafetyEnvelope;
  lastTuneTimestamp: number | null;
  tuneMethod: string | null;
}

export interface SafetyEnvelope {
  kpRange: [number, number];
  kiRange: [number, number];
  kdRange: [number, number];
  maxOvershootPercent: number;
  maxSettlingTimeMs: number;
  maxOutputChange: number; // per step
}

export interface ProcessResponse {
  timestamp: number;
  setpoint: number;
  processVariable: number;
  controlOutput: number;
  error: number;
}

export interface TuneResult {
  method: string;
  proposed: PIDParameters;
  withinEnvelope: boolean;
  estimatedOvershoot: number;
  estimatedSettlingTime: number;
  requiresApproval: boolean;
}

// ── Ziegler-Nichols Auto-Tune ─────────────────────────────────────

export function zieglerNicholsTune(
  ultimateGain: number,
  ultimatePeriod: number
): PIDParameters {
  return {
    kp: 0.6 * ultimateGain,
    ki: (1.2 * ultimateGain) / ultimatePeriod,
    kd: (0.075 * ultimateGain * ultimatePeriod),
  };
}

// ── Relay Feedback Method ─────────────────────────────────────────

export function relayFeedbackAnalysis(
  oscillations: ProcessResponse[],
  relayAmplitude: number
): { ultimateGain: number; ultimatePeriod: number } | null {
  if (oscillations.length < 4) return null;

  // Find peaks and valleys
  const peaks: number[] = [];
  const valleys: number[] = [];
  const peakTimes: number[] = [];

  for (let i = 1; i < oscillations.length - 1; i++) {
    const prev = oscillations[i - 1].processVariable;
    const curr = oscillations[i].processVariable;
    const next = oscillations[i + 1].processVariable;

    if (curr > prev && curr > next) {
      peaks.push(curr);
      peakTimes.push(oscillations[i].timestamp);
    }
    if (curr < prev && curr < next) {
      valleys.push(curr);
    }
  }

  if (peaks.length < 2 || valleys.length < 1) return null;

  // Amplitude of oscillation
  const avgPeak = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const avgValley = valleys.reduce((a, b) => a + b, 0) / valleys.length;
  const amplitude = (avgPeak - avgValley) / 2;

  // Period from peak-to-peak
  const periods: number[] = [];
  for (let i = 1; i < peakTimes.length; i++) {
    periods.push(peakTimes[i] - peakTimes[i - 1]);
  }
  const ultimatePeriod = periods.reduce((a, b) => a + b, 0) / periods.length;

  // Ultimate gain: Ku = 4d / (π * a) where d = relay amplitude, a = oscillation amplitude
  const ultimateGain = (4 * relayAmplitude) / (Math.PI * amplitude);

  return { ultimateGain, ultimatePeriod };
}

// ── PID Auto-Tuner ────────────────────────────────────────────────

export class PIDAutoTuner {
  private controllers: Map<string, PIDState> = new Map();
  private responseHistory: Map<string, ProcessResponse[]> = new Map();
  private approvalCallbacks: Map<string, (approved: boolean) => void> = new Map();
  private maxHistorySize: number;

  constructor(maxHistorySize = 500) {
    this.maxHistorySize = maxHistorySize;
  }

  registerController(
    controllerId: string,
    current: PIDParameters,
    envelope: SafetyEnvelope
  ): void {
    this.controllers.set(controllerId, {
      controllerId,
      current,
      proposed: null,
      approvalStatus: 'none',
      safetyEnvelope: envelope,
      lastTuneTimestamp: null,
      tuneMethod: null,
    });
  }

  getState(controllerId: string): PIDState | undefined {
    return this.controllers.get(controllerId);
  }

  recordResponse(controllerId: string, response: ProcessResponse): void {
    let history = this.responseHistory.get(controllerId);
    if (!history) {
      history = [];
      this.responseHistory.set(controllerId, history);
    }
    history.push(response);
    if (history.length > this.maxHistorySize) {
      history.splice(0, history.length - this.maxHistorySize);
    }
  }

  // ── Tuning Methods ────────────────────────────────────────────

  tuneZieglerNichols(
    controllerId: string,
    ultimateGain: number,
    ultimatePeriod: number
  ): TuneResult | null {
    const state = this.controllers.get(controllerId);
    if (!state) return null;

    const proposed = zieglerNicholsTune(ultimateGain, ultimatePeriod);
    return this.proposeTune(controllerId, proposed, 'ziegler-nichols');
  }

  tuneRelayFeedback(controllerId: string, relayAmplitude: number): TuneResult | null {
    const state = this.controllers.get(controllerId);
    if (!state) return null;

    const history = this.responseHistory.get(controllerId);
    if (!history || history.length < 20) return null;

    const analysis = relayFeedbackAnalysis(history, relayAmplitude);
    if (!analysis) return null;

    const proposed = zieglerNicholsTune(analysis.ultimateGain, analysis.ultimatePeriod);
    return this.proposeTune(controllerId, proposed, 'relay-feedback');
  }

  private proposeTune(
    controllerId: string,
    proposed: PIDParameters,
    method: string
  ): TuneResult | null {
    const state = this.controllers.get(controllerId);
    if (!state) return null;

    // Clamp to safety envelope
    const clamped = this.clampToEnvelope(proposed, state.safetyEnvelope);
    const withinEnvelope = this.isWithinEnvelope(proposed, state.safetyEnvelope);

    // Estimate performance
    const estimatedOvershoot = this.estimateOvershoot(clamped);
    const estimatedSettlingTime = this.estimateSettlingTime(clamped);

    const envelopeOk =
      estimatedOvershoot <= state.safetyEnvelope.maxOvershootPercent &&
      estimatedSettlingTime <= state.safetyEnvelope.maxSettlingTimeMs;

    state.proposed = clamped;
    state.approvalStatus = 'pending';
    state.tuneMethod = method;

    return {
      method,
      proposed: clamped,
      withinEnvelope: withinEnvelope && envelopeOk,
      estimatedOvershoot,
      estimatedSettlingTime,
      requiresApproval: true, // Always requires human approval (ADR-0013)
    };
  }

  // ── Approval Gate ─────────────────────────────────────────────

  approve(controllerId: string): PIDParameters | null {
    const state = this.controllers.get(controllerId);
    if (!state || state.approvalStatus !== 'pending' || !state.proposed) return null;

    state.current = { ...state.proposed };
    state.approvalStatus = 'approved';
    state.lastTuneTimestamp = Date.now();
    state.proposed = null;

    const cb = this.approvalCallbacks.get(controllerId);
    if (cb) cb(true);

    return { ...state.current };
  }

  reject(controllerId: string): void {
    const state = this.controllers.get(controllerId);
    if (!state) return;

    state.approvalStatus = 'rejected';
    state.proposed = null;

    const cb = this.approvalCallbacks.get(controllerId);
    if (cb) cb(false);
  }

  onApprovalDecision(controllerId: string, callback: (approved: boolean) => void): void {
    this.approvalCallbacks.set(controllerId, callback);
  }

  // ── Safety Envelope Helpers ───────────────────────────────────

  private clampToEnvelope(params: PIDParameters, envelope: SafetyEnvelope): PIDParameters {
    return {
      kp: Math.max(envelope.kpRange[0], Math.min(params.kp, envelope.kpRange[1])),
      ki: Math.max(envelope.kiRange[0], Math.min(params.ki, envelope.kiRange[1])),
      kd: Math.max(envelope.kdRange[0], Math.min(params.kd, envelope.kdRange[1])),
    };
  }

  isWithinEnvelope(params: PIDParameters, envelope: SafetyEnvelope): boolean {
    return (
      params.kp >= envelope.kpRange[0] && params.kp <= envelope.kpRange[1] &&
      params.ki >= envelope.kiRange[0] && params.ki <= envelope.kiRange[1] &&
      params.kd >= envelope.kdRange[0] && params.kd <= envelope.kdRange[1]
    );
  }

  private estimateOvershoot(params: PIDParameters): number {
    // Simplified estimate: higher kp relative to kd = more overshoot
    const ratio = params.kd > 0 ? params.kp / params.kd : params.kp * 10;
    return Math.min(100, ratio * 2);
  }

  private estimateSettlingTime(params: PIDParameters): number {
    // Simplified: more ki = faster settling but more oscillation
    const base = 5000;
    const kiFactor = params.ki > 0 ? 1 / params.ki : 10;
    return base * Math.min(kiFactor, 10);
  }

  getHistory(controllerId: string): ProcessResponse[] {
    return this.responseHistory.get(controllerId) ?? [];
  }
}
