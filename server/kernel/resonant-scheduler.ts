/**
 * Resonant Scheduler with λ-Adaptive Damping
 * Issue #141: [Kernel] Implement resonant scheduler with λ-adaptive damping
 *
 * Uses a Kuramoto-model inspired coupling to synchronize related tasks.
 * Tasks have natural frequencies (execution rates). The scheduler adjusts
 * coupling strength and applies adaptive damping to prevent oscillation.
 */

import { EventEmitter } from 'events';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SchedulerTask {
  id: string;
  /** Natural frequency ω_i in Hz (desired executions per second) */
  naturalFrequency: number;
  /** Current phase θ_i in radians [0, 2π) */
  phase: number;
  /** Task group — tasks in the same group couple together */
  group: string;
  /** Priority weight (higher = more influence on group synchronization) */
  weight: number;
  /** Execution callback */
  execute: () => Promise<void> | void;
  /** Internal: last execution timestamp */
  lastExecuted?: number;
  /** Internal: effective frequency after coupling */
  effectiveFrequency?: number;
  /** Whether this task is active */
  active: boolean;
}

export interface SchedulerConfig {
  /** Base coupling strength K (Kuramoto model) */
  couplingStrength: number;
  /** Initial damping factor λ */
  lambda: number;
  /** Minimum λ floor */
  lambdaMin: number;
  /** Maximum λ ceiling */
  lambdaMax: number;
  /** λ adaptation rate — how fast damping adjusts */
  lambdaAdaptRate: number;
  /** Tick interval in ms */
  tickIntervalMs: number;
  /** Coherence target — desired order parameter r ∈ [0,1] */
  coherenceTarget: number;
}

export interface SchedulerMetrics {
  /** Kuramoto order parameter r ∈ [0,1]. 1 = full sync, 0 = incoherent */
  orderParameter: number;
  /** Mean phase ψ */
  meanPhase: number;
  /** Current damping λ */
  lambda: number;
  /** Tasks per group */
  groupSizes: Record<string, number>;
  /** Total tasks */
  taskCount: number;
  /** Total executions since start */
  totalExecutions: number;
}

// ─── Default Config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SchedulerConfig = {
  couplingStrength: 2.0,
  lambda: 0.5,
  lambdaMin: 0.01,
  lambdaMax: 5.0,
  lambdaAdaptRate: 0.1,
  tickIntervalMs: 100,
  coherenceTarget: 0.8,
};

// ─── Scheduler ───────────────────────────────────────────────────────────────

export class ResonantScheduler extends EventEmitter {
  private tasks: Map<string, SchedulerTask> = new Map();
  private config: SchedulerConfig;
  private lambda: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalExecutions = 0;
  private lastTick = 0;

  constructor(config: Partial<SchedulerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lambda = this.config.lambda;
  }

  /** Register a task */
  addTask(task: Omit<SchedulerTask, 'phase' | 'active' | 'effectiveFrequency'>): void {
    this.tasks.set(task.id, {
      ...task,
      phase: Math.random() * 2 * Math.PI, // random initial phase
      active: true,
      effectiveFrequency: task.naturalFrequency,
    });
    this.emit('task:added', task.id);
  }

  /** Remove a task */
  removeTask(id: string): boolean {
    const removed = this.tasks.delete(id);
    if (removed) this.emit('task:removed', id);
    return removed;
  }

  /** Start the scheduler loop */
  start(): void {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.config.tickIntervalMs);
    this.emit('started');
  }

  /** Stop the scheduler */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emit('stopped');
    }
  }

  /** Main tick — advance phases, apply coupling, execute ready tasks */
  private tick(): void {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000; // seconds
    this.lastTick = now;

    if (dt <= 0) return;

    // Group tasks
    const groups = new Map<string, SchedulerTask[]>();
    for (const task of this.tasks.values()) {
      if (!task.active) continue;
      const list = groups.get(task.group) ?? [];
      list.push(task);
      groups.set(task.group, list);
    }

    // Kuramoto coupling per group
    for (const [, members] of groups) {
      this.applyKuramotoCoupling(members, dt);
    }

    // Compute global order parameter and adapt λ
    const metrics = this.computeOrderParameter();
    this.adaptLambda(metrics.orderParameter);

    // Execute tasks whose phase crossed 2π (one full cycle)
    for (const task of this.tasks.values()) {
      if (!task.active) continue;
      const prevPhase = task.phase - task.effectiveFrequency! * 2 * Math.PI * dt;
      // Fire if we crossed a 2π boundary
      if (Math.floor(task.phase / (2 * Math.PI)) > Math.floor(prevPhase / (2 * Math.PI))) {
        this.executeTask(task, now);
      }
    }

    this.emit('tick', this.getMetrics());
  }

  /**
   * Kuramoto model:
   *   dθ_i/dt = ω_i + (K/N) * Σ_j w_j * sin(θ_j − θ_i) − λ * (dθ_i/dt − ω_i)
   *
   * The damping term prevents runaway synchronization oscillations.
   */
  private applyKuramotoCoupling(members: SchedulerTask[], dt: number): void {
    const N = members.length;
    if (N < 2) {
      // Single task: just advance phase
      for (const task of members) {
        task.phase += task.naturalFrequency * 2 * Math.PI * dt;
        task.effectiveFrequency = task.naturalFrequency;
      }
      return;
    }

    const K = this.config.couplingStrength;

    for (const task of members) {
      // Compute coupling term
      let coupling = 0;
      for (const other of members) {
        if (other.id === task.id) continue;
        coupling += other.weight * Math.sin(other.phase - task.phase);
      }
      coupling *= K / N;

      // Effective frequency with damping
      // dθ/dt = ω + coupling, damped by λ
      const rawDrive = task.naturalFrequency * 2 * Math.PI + coupling;
      const naturalDrive = task.naturalFrequency * 2 * Math.PI;
      const dampedDrive = naturalDrive + (rawDrive - naturalDrive) / (1 + this.lambda);

      task.phase += dampedDrive * dt;
      task.effectiveFrequency = dampedDrive / (2 * Math.PI);

      // Keep phase in [0, large) — don't modulo to preserve cycle counting
    }
  }

  /** Compute Kuramoto order parameter r*e^(iψ) = (1/N) Σ e^(iθ_j) */
  private computeOrderParameter(): { orderParameter: number; meanPhase: number } {
    let cosSum = 0, sinSum = 0, count = 0;
    for (const task of this.tasks.values()) {
      if (!task.active) continue;
      cosSum += Math.cos(task.phase);
      sinSum += Math.sin(task.phase);
      count++;
    }
    if (count === 0) return { orderParameter: 0, meanPhase: 0 };
    const r = Math.sqrt(cosSum * cosSum + sinSum * sinSum) / count;
    const psi = Math.atan2(sinSum, cosSum);
    return { orderParameter: r, meanPhase: psi };
  }

  /**
   * Adaptive damping:
   *   If coherence > target → decrease λ (allow more freedom)
   *   If coherence < target → increase λ (damp oscillations)
   */
  private adaptLambda(r: number): void {
    const error = this.config.coherenceTarget - r;
    this.lambda += this.config.lambdaAdaptRate * error;
    this.lambda = Math.max(this.config.lambdaMin, Math.min(this.config.lambdaMax, this.lambda));
  }

  /** Execute a task */
  private async executeTask(task: SchedulerTask, now: number): Promise<void> {
    task.lastExecuted = now;
    this.totalExecutions++;
    try {
      await task.execute();
      this.emit('task:executed', task.id);
    } catch (err) {
      this.emit('task:error', task.id, err);
    }
  }

  /** Get current metrics */
  getMetrics(): SchedulerMetrics {
    const { orderParameter, meanPhase } = this.computeOrderParameter();
    const groupSizes: Record<string, number> = {};
    for (const task of this.tasks.values()) {
      groupSizes[task.group] = (groupSizes[task.group] ?? 0) + 1;
    }
    return {
      orderParameter,
      meanPhase,
      lambda: this.lambda,
      groupSizes,
      taskCount: this.tasks.size,
      totalExecutions: this.totalExecutions,
    };
  }

  /** Get a snapshot of all task states */
  getTaskStates(): Array<{ id: string; phase: number; effectiveFrequency: number; group: string }> {
    return Array.from(this.tasks.values()).map(t => ({
      id: t.id,
      phase: t.phase,
      effectiveFrequency: t.effectiveFrequency!,
      group: t.group,
    }));
  }
}
