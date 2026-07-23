/**
 * Safety Guard — enforces constraints on evolved resolution strategies
 *
 * Ensures that evolved genomes don't produce dangerous or unreliable
 * resolutions in production SCADA environments.
 *
 * Safety layers:
 * 1. Floor strategies: 4 original static strategies are immortal
 * 2. Confidence floor: fallback to static when evolved confidence < threshold
 * 3. Novelty budget: cap on how many resolutions use experimental genomes
 * 4. Audit integration: all evolved decisions logged with full lineage
 * 5. Kill switch: instantly disable all evolved strategies
 *
 * @see ADR-0023
 * @closes #383
 */

import { ResolutionGenome, GenomeEvaluation } from './genome';
import { FitnessEvaluator } from './fitness';
import { BUILTIN_PRIMITIVES } from './primitives';
import type { Resolution } from '../paradox-resolver';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SafetyConfig {
  /** Minimum confidence from evolved strategy before fallback (default 0.3) */
  confidenceFloor: number;
  /** Max fraction of resolutions using experimental genomes (gen < maturityGen) (default 0.3) */
  noveltyBudget: number;
  /** Generation threshold below which a genome is considered "experimental" (default 5) */
  maturityGeneration: number;
  /** Rolling window size for novelty budget tracking (default 100) */
  noveltyWindowSize: number;
}

export interface SafetyDecision {
  /** Whether the evolved strategy was allowed */
  allowed: boolean;
  /** Reason for the decision */
  reason: string;
  /** If not allowed, the fallback strategy used */
  fallbackStrategy?: string;
  /** The genome that was evaluated (or null if fallback) */
  genomeId: string | null;
  /** Generation of the genome */
  generation: number;
  /** Was this genome experimental? */
  isExperimental: boolean;
  /** Current novelty ratio */
  noveltyRatio: number;
}

export interface FloorStrategy {
  id: string;
  name: string;
  /** The static resolution method this maps to in the original resolver */
  resolverMethod: string;
}

export interface AuditEntry {
  timestamp: number;
  processArea: string;
  genomeId: string | null;
  generation: number;
  confidence: number;
  decision: SafetyDecision;
  /** Genome lineage (ancestry chain) */
  ancestry: string[];
}

const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  confidenceFloor: 0.3,
  noveltyBudget: 0.3,
  maturityGeneration: 5,
  noveltyWindowSize: 100,
};

// ─── Floor Strategies ───────────────────────────────────────────────────────

/**
 * The four immortal strategies. These can never be evolved away and serve
 * as fallbacks when evolved strategies fail safety checks.
 */
export const FLOOR_STRATEGIES: FloorStrategy[] = [
  { id: 'floor_temporal', name: 'Temporal Priority', resolverMethod: 'temporal_priority' },
  { id: 'floor_confidence', name: 'Sensor Confidence', resolverMethod: 'sensor_confidence' },
  { id: 'floor_voting', name: 'Voting', resolverMethod: 'voting' },
  { id: 'floor_physics', name: 'Physics Arbitration', resolverMethod: 'physics_arbitration' },
];

// ─── Safety Guard ───────────────────────────────────────────────────────────

export class SafetyGuard {
  private config: SafetyConfig;
  private fitnessEval: FitnessEvaluator;

  /** Kill switch — when true, all evolved strategies are disabled */
  private killSwitchActive = false;

  /** Rolling window tracking novelty usage: true = experimental genome used */
  private noveltyWindow: boolean[] = [];

  /** Audit log (bounded) */
  private auditLog: AuditEntry[] = [];
  private static readonly MAX_AUDIT_LOG = 1000;

  constructor(fitnessEval: FitnessEvaluator, config: Partial<SafetyConfig> = {}) {
    this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
    this.fitnessEval = fitnessEval;
  }

  // ─── Kill Switch ────────────────────────────────────────────────

  /** Activate kill switch — all evolved strategies disabled immediately */
  activateKillSwitch(): void {
    this.killSwitchActive = true;
  }

  /** Deactivate kill switch — resume evolved strategy usage */
  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  // ─── Safety Check ──────────────────────────────────────────────

  /**
   * Check whether an evolved genome's resolution should be used or
   * whether we should fall back to a static strategy.
   *
   * Called AFTER the genome has been evaluated but BEFORE the resolution
   * is committed.
   */
  checkResolution(
    genome: ResolutionGenome,
    evaluation: GenomeEvaluation,
    processArea: string,
  ): SafetyDecision {
    const isExperimental = genome.generation < this.config.maturityGeneration;
    const currentNoveltyRatio = this.getNoveltyRatio();

    // 1. Kill switch
    if (this.killSwitchActive) {
      const decision: SafetyDecision = {
        allowed: false,
        reason: 'Kill switch active — all evolved strategies disabled',
        fallbackStrategy: this.selectBestFloorStrategy(processArea),
        genomeId: genome.id,
        generation: genome.generation,
        isExperimental,
        noveltyRatio: currentNoveltyRatio,
      };
      this.recordDecision(decision, genome, evaluation.score, processArea);
      return decision;
    }

    // 2. Confidence floor
    if (evaluation.score < this.config.confidenceFloor) {
      const decision: SafetyDecision = {
        allowed: false,
        reason: `Confidence ${evaluation.score.toFixed(3)} below floor ${this.config.confidenceFloor}`,
        fallbackStrategy: this.selectBestFloorStrategy(processArea),
        genomeId: genome.id,
        generation: genome.generation,
        isExperimental,
        noveltyRatio: currentNoveltyRatio,
      };
      this.recordDecision(decision, genome, evaluation.score, processArea);
      return decision;
    }

    // 3. Novelty budget (only applies to experimental genomes)
    if (isExperimental && currentNoveltyRatio >= this.config.noveltyBudget) {
      const decision: SafetyDecision = {
        allowed: false,
        reason: `Novelty budget exhausted (${(currentNoveltyRatio * 100).toFixed(1)}% >= ${(this.config.noveltyBudget * 100).toFixed(1)}%)`,
        fallbackStrategy: this.selectBestFloorStrategy(processArea),
        genomeId: genome.id,
        generation: genome.generation,
        isExperimental,
        noveltyRatio: currentNoveltyRatio,
      };
      this.recordDecision(decision, genome, evaluation.score, processArea);
      return decision;
    }

    // Passed all checks
    const decision: SafetyDecision = {
      allowed: true,
      reason: 'All safety checks passed',
      genomeId: genome.id,
      generation: genome.generation,
      isExperimental,
      noveltyRatio: currentNoveltyRatio,
    };

    this.recordDecision(decision, genome, evaluation.score, processArea);
    return decision;
  }

  // ─── Floor Strategy Selection ───────────────────────────────────

  /**
   * Select the best floor strategy for a process area.
   * In a real system this would consider the process area's characteristics;
   * for now, defaults to sensor confidence (most reliable general-purpose).
   */
  private selectBestFloorStrategy(processArea: string): string {
    // Default heuristic: sensor_confidence is safest general-purpose fallback
    return 'sensor_confidence';
  }

  /** Get all floor strategies */
  getFloorStrategies(): FloorStrategy[] {
    return [...FLOOR_STRATEGIES];
  }

  /** Check if a strategy ID is a floor strategy (immortal) */
  isFloorStrategy(strategyId: string): boolean {
    return FLOOR_STRATEGIES.some(f => f.id === strategyId || f.resolverMethod === strategyId);
  }

  // ─── Novelty Budget ─────────────────────────────────────────────

  /**
   * Get current novelty ratio: fraction of recent resolution DECISIONS that
   * actually used an experimental genome (#451 B1).
   *
   * The window records every decision — allowed-experimental (true),
   * allowed-mature (false), and blocked→static-fallback (false) — so the
   * denominator is all resolutions, matching the ADR-0023 budget semantics
   * ("max fraction of resolutions using experimental genomes"). Recording only
   * allowed-experimental outcomes made the ratio collapse to 1.0 after the
   * first experimental resolution and deadlock every subsequent one.
   */
  getNoveltyRatio(): number {
    if (this.noveltyWindow.length === 0) return 0;
    const experimentalCount = this.noveltyWindow.filter(v => v).length;
    return experimentalCount / this.noveltyWindow.length;
  }

  /** Reset the novelty window (e.g., after a major configuration change) */
  resetNoveltyWindow(): void {
    this.noveltyWindow = [];
  }

  // ─── Audit ──────────────────────────────────────────────────────

  private recordDecision(
    decision: SafetyDecision,
    genome: ResolutionGenome,
    confidence: number,
    processArea: string,
  ): void {
    // Novelty tracking (#451 B1): record EVERY decision. An experimental
    // genome was actually used only when the decision was allowed AND the
    // genome is below the maturity generation; every other outcome (mature
    // genome, or blocked→static fallback) counts as a non-experimental
    // resolution.
    const usedExperimental = decision.allowed && decision.isExperimental;
    this.noveltyWindow.push(usedExperimental);
    if (this.noveltyWindow.length > this.config.noveltyWindowSize) {
      this.noveltyWindow.shift();
    }

    const entry: AuditEntry = {
      timestamp: Date.now(),
      processArea,
      genomeId: genome.id,
      generation: genome.generation,
      confidence,
      decision,
      ancestry: [...genome.ancestry],
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > SafetyGuard.MAX_AUDIT_LOG) {
      this.auditLog = this.auditLog.slice(-SafetyGuard.MAX_AUDIT_LOG);
    }
  }

  /** Get audit log entries, optionally filtered */
  getAuditLog(options?: {
    processArea?: string;
    limit?: number;
    allowedOnly?: boolean;
  }): AuditEntry[] {
    let entries = this.auditLog;

    if (options?.processArea) {
      entries = entries.filter(e => e.processArea === options.processArea);
    }
    if (options?.allowedOnly !== undefined) {
      entries = entries.filter(e => e.decision.allowed === options.allowedOnly);
    }
    if (options?.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /** Get summary stats */
  getStats(): {
    killSwitchActive: boolean;
    noveltyRatio: number;
    totalDecisions: number;
    allowedCount: number;
    blockedCount: number;
    blockReasons: Record<string, number>;
  } {
    let allowedCount = 0;
    let blockedCount = 0;
    const blockReasons: Record<string, number> = {};

    for (const entry of this.auditLog) {
      if (entry.decision.allowed) {
        allowedCount++;
      } else {
        blockedCount++;
        const reason = entry.decision.reason.split(' — ')[0].split('(')[0].trim();
        blockReasons[reason] = (blockReasons[reason] ?? 0) + 1;
      }
    }

    return {
      killSwitchActive: this.killSwitchActive,
      noveltyRatio: this.getNoveltyRatio(),
      totalDecisions: this.auditLog.length,
      allowedCount,
      blockedCount,
      blockReasons,
    };
  }
}
