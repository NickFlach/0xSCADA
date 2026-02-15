/**
 * GhostOS Integration Layer
 * ADR-0013 [13.7] — Consciousness stack concepts mapped to practical agent orchestration
 *
 * Signal    = Raw sensor data / events
 * Resonance = Correlated patterns across signals
 * Emergence = Autonomous decisions from pattern recognition
 *
 * Kuramoto coupling synchronizes multi-agent behavior
 */

export interface Signal {
  id: string;
  source: string; // tagId or agentId
  type: 'sensor' | 'alarm' | 'agent' | 'user';
  value: number;
  timestamp: number;
  metadata: Record<string, unknown>;
}

export interface ResonancePattern {
  id: string;
  signals: string[]; // signal IDs
  strength: number; // 0-1, correlation strength
  frequency: number; // Hz
  phase: number; // radians
  description: string;
  detectedAt: number;
}

export interface EmergentDecision {
  id: string;
  pattern: string; // resonance pattern ID
  action: string;
  confidence: number;
  agentId: string;
  requiresApproval: boolean;
  approved: boolean | null;
  timestamp: number;
}

export interface AgentOscillator {
  agentId: string;
  naturalFrequency: number; // ω_i — agent's natural operating frequency
  phase: number; // θ_i — current phase
  amplitude: number; // output strength
  couplingStrength: number; // K_i — how strongly coupled to others
  lastUpdate: number;
}

// ── Kuramoto Synchronization ──────────────────────────────────────

export function kuramotoStep(
  oscillators: AgentOscillator[],
  globalCoupling: number,
  dt: number
): AgentOscillator[] {
  const n = oscillators.length;
  if (n === 0) return oscillators;

  return oscillators.map((osc) => {
    // dθ_i/dt = ω_i + (K/N) * Σ sin(θ_j - θ_i)
    let coupling = 0;
    for (const other of oscillators) {
      if (other.agentId === osc.agentId) continue;
      coupling += Math.sin(other.phase - osc.phase);
    }
    coupling *= (globalCoupling * osc.couplingStrength) / n;

    const newPhase = osc.phase + (osc.naturalFrequency + coupling) * dt;

    return {
      ...osc,
      phase: newPhase % (2 * Math.PI),
      lastUpdate: Date.now(),
    };
  });
}

export function computeOrderParameter(oscillators: AgentOscillator[]): {
  r: number; // synchronization magnitude (0=incoherent, 1=fully synchronized)
  psi: number; // mean phase
} {
  if (oscillators.length === 0) return { r: 0, psi: 0 };

  let sumCos = 0;
  let sumSin = 0;
  for (const osc of oscillators) {
    sumCos += Math.cos(osc.phase);
    sumSin += Math.sin(osc.phase);
  }
  sumCos /= oscillators.length;
  sumSin /= oscillators.length;

  return {
    r: Math.sqrt(sumCos ** 2 + sumSin ** 2),
    psi: Math.atan2(sumSin, sumCos),
  };
}

// ── GhostOS Bridge ────────────────────────────────────────────────

export class GhostOSBridge {
  private signals: Map<string, Signal> = new Map();
  private patterns: Map<string, ResonancePattern> = new Map();
  private decisions: EmergentDecision[] = [];
  private oscillators: Map<string, AgentOscillator> = new Map();
  private globalCoupling = 0.5;
  private signalBuffer: Signal[] = [];
  private maxBufferSize: number;
  private patternCounter = 0;
  private decisionCounter = 0;

  constructor(maxBufferSize = 1000) {
    this.maxBufferSize = maxBufferSize;
  }

  // ── Signal Layer ──────────────────────────────────────────────

  emitSignal(signal: Signal): void {
    this.signals.set(signal.id, signal);
    this.signalBuffer.push(signal);
    if (this.signalBuffer.length > this.maxBufferSize) {
      this.signalBuffer.splice(0, this.signalBuffer.length - this.maxBufferSize);
    }
  }

  getSignals(source?: string): Signal[] {
    if (!source) return [...this.signals.values()];
    return [...this.signals.values()].filter((s) => s.source === source);
  }

  // ── Resonance Layer ───────────────────────────────────────────

  detectResonance(windowMs = 10000): ResonancePattern[] {
    const now = Date.now();
    const recent = this.signalBuffer.filter((s) => now - s.timestamp < windowMs);
    if (recent.length < 3) return [];

    const newPatterns: ResonancePattern[] = [];

    // Group by source and look for correlations
    const bySource = new Map<string, Signal[]>();
    for (const sig of recent) {
      const arr = bySource.get(sig.source) ?? [];
      arr.push(sig);
      bySource.set(sig.source, arr);
    }

    const sources = [...bySource.keys()];
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const a = bySource.get(sources[i])!;
        const b = bySource.get(sources[j])!;

        const correlation = this.computeCorrelation(a, b);
        if (Math.abs(correlation) > 0.7) {
          const pattern: ResonancePattern = {
            id: `RP-${++this.patternCounter}`,
            signals: [sources[i], sources[j]],
            strength: Math.abs(correlation),
            frequency: a.length / (windowMs / 1000),
            phase: correlation > 0 ? 0 : Math.PI,
            description: `Correlation between ${sources[i]} and ${sources[j]}: ${correlation.toFixed(3)}`,
            detectedAt: now,
          };
          this.patterns.set(pattern.id, pattern);
          newPatterns.push(pattern);
        }
      }
    }

    return newPatterns;
  }

  private computeCorrelation(a: Signal[], b: Signal[]): number {
    if (a.length < 2 || b.length < 2) return 0;

    const aVals = a.map((s) => s.value);
    const bVals = b.slice(0, aVals.length).map((s) => s.value);
    const n = Math.min(aVals.length, bVals.length);
    if (n < 2) return 0;

    const aMean = aVals.slice(0, n).reduce((s, v) => s + v, 0) / n;
    const bMean = bVals.slice(0, n).reduce((s, v) => s + v, 0) / n;

    let cov = 0, aVar = 0, bVar = 0;
    for (let i = 0; i < n; i++) {
      const da = aVals[i] - aMean;
      const db = bVals[i] - bMean;
      cov += da * db;
      aVar += da * da;
      bVar += db * db;
    }

    const denom = Math.sqrt(aVar * bVar);
    return denom === 0 ? 0 : cov / denom;
  }

  getPatterns(): ResonancePattern[] {
    return [...this.patterns.values()];
  }

  // ── Emergence Layer ───────────────────────────────────────────

  proposeDecision(
    patternId: string,
    agentId: string,
    action: string,
    confidence: number,
    requiresApproval = true
  ): EmergentDecision {
    const decision: EmergentDecision = {
      id: `ED-${++this.decisionCounter}`,
      pattern: patternId,
      action,
      confidence,
      agentId,
      requiresApproval,
      approved: requiresApproval ? null : true,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);
    return decision;
  }

  approveDecision(decisionId: string): boolean {
    const d = this.decisions.find((x) => x.id === decisionId);
    if (!d) return false;
    d.approved = true;
    return true;
  }

  rejectDecision(decisionId: string): boolean {
    const d = this.decisions.find((x) => x.id === decisionId);
    if (!d) return false;
    d.approved = false;
    return true;
  }

  getDecisions(agentId?: string): EmergentDecision[] {
    if (!agentId) return [...this.decisions];
    return this.decisions.filter((d) => d.agentId === agentId);
  }

  // ── Agent Coordination (Kuramoto) ─────────────────────────────

  registerAgent(
    agentId: string,
    naturalFrequency: number,
    couplingStrength = 1.0
  ): void {
    this.oscillators.set(agentId, {
      agentId,
      naturalFrequency,
      phase: Math.random() * 2 * Math.PI,
      amplitude: 1,
      couplingStrength,
      lastUpdate: Date.now(),
    });
  }

  unregisterAgent(agentId: string): void {
    this.oscillators.delete(agentId);
  }

  stepSync(dt = 0.1): { oscillators: AgentOscillator[]; orderParameter: { r: number; psi: number } } {
    const current = [...this.oscillators.values()];
    const updated = kuramotoStep(current, this.globalCoupling, dt);

    for (const osc of updated) {
      this.oscillators.set(osc.agentId, osc);
    }

    return {
      oscillators: updated,
      orderParameter: computeOrderParameter(updated),
    };
  }

  getSyncState(): { r: number; psi: number } {
    return computeOrderParameter([...this.oscillators.values()]);
  }

  setGlobalCoupling(k: number): void {
    this.globalCoupling = k;
  }

  getOscillators(): AgentOscillator[] {
    return [...this.oscillators.values()];
  }
}
