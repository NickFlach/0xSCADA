/**
 * Paradox Resolver for SCADA Event Ordering
 * 
 * Adapted from QuantumSingularity's ParadoxResolver and SIN's ParadoxConflictResolver.
 * Handles causal ordering of SCADA events, conflict detection between simultaneous
 * sensor readings, and rollback mechanisms for contradictory states.
 * 
 * In SCADA, "paradoxes" are:
 * - Two sensors reporting contradictory states for the same process variable
 * - Control commands arriving out of causal order
 * - State rollbacks needed when a sensor is found to have drifted
 * - Simultaneous alarms that conflict on recommended actions
 */

import { EventEmitter } from 'events';

// ----- Types -----

export interface ScadaEvent {
  id: string;
  deviceId: string;
  tag: string;
  value: any;
  timestamp: Date;
  quality: 'good' | 'bad' | 'uncertain';
  source: 'sensor' | 'command' | 'alarm' | 'system';
  /** Lamport-style logical clock for causal ordering */
  logicalClock: number;
  /** Vector clock entries: deviceId → counter */
  vectorClock: Record<string, number>;
  /** Optional causal dependency: event ID this event depends on */
  causedBy?: string;
}

export interface ConflictDetection {
  conflictId: string;
  type: 'simultaneous_reading' | 'causal_violation' | 'contradictory_state' | 'command_race';
  events: ScadaEvent[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: Date;
  description: string;
}

export interface Resolution {
  conflictId: string;
  method: 'priority_based' | 'timestamp_tiebreak' | 'quality_weighted' | 'rollback' | 'merge';
  winner?: ScadaEvent;
  mergedValue?: any;
  rollbackTarget?: string; // event ID to roll back to
  confidence: number; // 0-1
  reasoning: string;
  resolvedAt: Date;
}

export interface RollbackPlan {
  id: string;
  triggerEventId: string;
  rollbackToEventId: string;
  affectedTags: string[];
  stateSnapshot: Record<string, any>;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: Date;
}

export interface ParadoxResolverConfig {
  /** Max time window (ms) for events to be considered "simultaneous" */
  simultaneousWindowMs: number;
  /** Max events to keep in causal history */
  maxHistorySize: number;
  /** Auto-resolve low-severity conflicts */
  autoResolveLowSeverity: boolean;
  /** Quality weight for resolution: higher = prefer higher-quality readings */
  qualityWeight: number;
}

const DEFAULT_CONFIG: ParadoxResolverConfig = {
  simultaneousWindowMs: 100,
  maxHistorySize: 10000,
  autoResolveLowSeverity: true,
  qualityWeight: 0.7,
};

// ----- Resolver -----

export class ParadoxResolver extends EventEmitter {
  private config: ParadoxResolverConfig;
  private eventHistory: Map<string, ScadaEvent> = new Map(); // id → event
  private tagLatest: Map<string, ScadaEvent> = new Map(); // tag → latest event
  private conflicts: Map<string, ConflictDetection> = new Map();
  private resolutions: Map<string, Resolution> = new Map();
  private rollbackPlans: Map<string, RollbackPlan> = new Map();
  private logicalClock = 0;

  constructor(config: Partial<ParadoxResolverConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Ingest a new SCADA event and check for paradoxes */
  async ingestEvent(event: ScadaEvent): Promise<ConflictDetection | null> {
    // Advance logical clock
    this.logicalClock = Math.max(this.logicalClock, event.logicalClock) + 1;
    event.logicalClock = this.logicalClock;

    // Store in history
    this.eventHistory.set(event.id, event);
    this.enforceHistoryLimit();

    // Check for conflicts
    const conflict = this.detectConflict(event);
    if (conflict) {
      this.conflicts.set(conflict.conflictId, conflict);
      this.emit('conflict', conflict);

      // Auto-resolve if configured
      if (this.config.autoResolveLowSeverity && conflict.severity === 'low') {
        const resolution = await this.resolve(conflict);
        return conflict;
      }
    }

    // Update latest state
    this.tagLatest.set(event.tag, event);
    return conflict;
  }

  /** Detect conflicts between new event and existing state */
  private detectConflict(event: ScadaEvent): ConflictDetection | null {
    const existing = this.tagLatest.get(event.tag);
    if (!existing) return null;

    // Check simultaneous readings
    const timeDiff = Math.abs(event.timestamp.getTime() - existing.timestamp.getTime());
    if (timeDiff < this.config.simultaneousWindowMs && event.deviceId !== existing.deviceId) {
      // Two different devices reporting on same tag within the window
      if (event.value !== existing.value) {
        return {
          conflictId: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'simultaneous_reading',
          events: [existing, event],
          severity: this.assessSeverity(existing, event),
          detectedAt: new Date(),
          description: `Simultaneous conflicting readings for ${event.tag}: ${existing.value} vs ${event.value}`,
        };
      }
    }

    // Check causal violations (vector clock comparison)
    if (event.causedBy && !this.eventHistory.has(event.causedBy)) {
      return {
        conflictId: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'causal_violation',
        events: [event],
        severity: 'high',
        detectedAt: new Date(),
        description: `Event ${event.id} claims causal dependency on ${event.causedBy} which is not in history`,
      };
    }

    // Check contradictory state transitions
    if (this.isContradictory(existing, event)) {
      return {
        conflictId: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'contradictory_state',
        events: [existing, event],
        severity: 'medium',
        detectedAt: new Date(),
        description: `Contradictory state for ${event.tag}: ${existing.value} → ${event.value} violates expected transition`,
      };
    }

    return null;
  }

  /** Resolve a conflict using configured strategy */
  async resolve(conflict: ConflictDetection): Promise<Resolution> {
    let resolution: Resolution;

    switch (conflict.type) {
      case 'simultaneous_reading':
        resolution = this.resolveSimultaneous(conflict);
        break;
      case 'causal_violation':
        resolution = this.resolveCausalViolation(conflict);
        break;
      case 'contradictory_state':
        resolution = this.resolveContradiction(conflict);
        break;
      case 'command_race':
        resolution = this.resolveCommandRace(conflict);
        break;
      default:
        resolution = {
          conflictId: conflict.conflictId,
          method: 'timestamp_tiebreak',
          winner: conflict.events[0],
          confidence: 0.5,
          reasoning: 'Fallback: used first event',
          resolvedAt: new Date(),
        };
    }

    this.resolutions.set(conflict.conflictId, resolution);
    this.emit('resolved', resolution);
    return resolution;
  }

  /** Quality-weighted resolution for simultaneous readings */
  private resolveSimultaneous(conflict: ConflictDetection): Resolution {
    const [a, b] = conflict.events;
    const scoreA = this.qualityScore(a);
    const scoreB = this.qualityScore(b);

    if (Math.abs(scoreA - scoreB) < 0.1) {
      // Scores too close — merge by averaging (for numeric values)
      if (typeof a.value === 'number' && typeof b.value === 'number') {
        const merged = (a.value * scoreA + b.value * scoreB) / (scoreA + scoreB);
        return {
          conflictId: conflict.conflictId,
          method: 'quality_weighted',
          mergedValue: merged,
          confidence: Math.max(scoreA, scoreB),
          reasoning: `Quality-weighted merge: (${a.value}×${scoreA.toFixed(2)} + ${b.value}×${scoreB.toFixed(2)}) / ${(scoreA + scoreB).toFixed(2)}`,
          resolvedAt: new Date(),
        };
      }
    }

    const winner = scoreA >= scoreB ? a : b;
    return {
      conflictId: conflict.conflictId,
      method: 'quality_weighted',
      winner,
      confidence: Math.max(scoreA, scoreB),
      reasoning: `Selected ${winner.deviceId} (quality score ${Math.max(scoreA, scoreB).toFixed(2)} vs ${Math.min(scoreA, scoreB).toFixed(2)})`,
      resolvedAt: new Date(),
    };
  }

  private resolveCausalViolation(conflict: ConflictDetection): Resolution {
    // For causal violations, create a rollback plan
    const event = conflict.events[0];
    const rollback: RollbackPlan = {
      id: `rollback_${Date.now()}`,
      triggerEventId: event.id,
      rollbackToEventId: event.causedBy!,
      affectedTags: [event.tag],
      stateSnapshot: this.captureStateSnapshot([event.tag]),
      status: 'pending',
      createdAt: new Date(),
    };
    this.rollbackPlans.set(rollback.id, rollback);
    this.emit('rollback_planned', rollback);

    return {
      conflictId: conflict.conflictId,
      method: 'rollback',
      rollbackTarget: event.causedBy,
      confidence: 0.6,
      reasoning: `Causal violation: rolling back to ${event.causedBy}. Rollback plan: ${rollback.id}`,
      resolvedAt: new Date(),
    };
  }

  private resolveContradiction(conflict: ConflictDetection): Resolution {
    const [existing, newer] = conflict.events;
    // Prefer newer event if quality is acceptable
    if (newer.quality === 'good') {
      return {
        conflictId: conflict.conflictId,
        method: 'priority_based',
        winner: newer,
        confidence: 0.75,
        reasoning: `Accepting newer good-quality reading over existing ${existing.quality} reading`,
        resolvedAt: new Date(),
      };
    }
    return {
      conflictId: conflict.conflictId,
      method: 'priority_based',
      winner: existing,
      confidence: 0.6,
      reasoning: `Keeping existing reading: newer reading quality is ${newer.quality}`,
      resolvedAt: new Date(),
    };
  }

  private resolveCommandRace(conflict: ConflictDetection): Resolution {
    // For command races, use priority + timestamp as tiebreak
    const sorted = [...conflict.events].sort((a, b) => {
      if (a.logicalClock !== b.logicalClock) return b.logicalClock - a.logicalClock;
      return a.timestamp.getTime() - b.timestamp.getTime();
    });
    return {
      conflictId: conflict.conflictId,
      method: 'timestamp_tiebreak',
      winner: sorted[0],
      confidence: 0.7,
      reasoning: `Command race resolved by logical clock (${sorted[0].logicalClock}) then timestamp`,
      resolvedAt: new Date(),
    };
  }

  /** Execute a rollback plan */
  async executeRollback(rollbackId: string): Promise<boolean> {
    const plan = this.rollbackPlans.get(rollbackId);
    if (!plan || plan.status !== 'pending') return false;

    plan.status = 'executing';
    try {
      // Restore state snapshot for affected tags
      for (const tag of plan.affectedTags) {
        const snapshotValue = plan.stateSnapshot[tag];
        if (snapshotValue !== undefined) {
          // Emit rollback event for the tag
          this.emit('tag_rollback', { tag, value: snapshotValue, rollbackId });
        }
      }
      plan.status = 'completed';
      this.emit('rollback_completed', plan);
      return true;
    } catch (err) {
      plan.status = 'failed';
      this.emit('rollback_failed', { plan, error: err });
      return false;
    }
  }

  // ----- Helpers -----

  private qualityScore(event: ScadaEvent): number {
    const qualityMap = { good: 1.0, uncertain: 0.5, bad: 0.1 };
    const qScore = qualityMap[event.quality] * this.config.qualityWeight;
    // Recency bonus
    const ageMs = Date.now() - event.timestamp.getTime();
    const recencyScore = Math.max(0, 1 - ageMs / 60000) * (1 - this.config.qualityWeight);
    return qScore + recencyScore;
  }

  private assessSeverity(a: ScadaEvent, b: ScadaEvent): ConflictDetection['severity'] {
    if (a.source === 'command' || b.source === 'command') return 'critical';
    if (a.source === 'alarm' || b.source === 'alarm') return 'high';
    if (typeof a.value === 'number' && typeof b.value === 'number') {
      const diff = Math.abs(a.value - b.value) / Math.max(Math.abs(a.value), Math.abs(b.value), 1);
      if (diff > 0.5) return 'high';
      if (diff > 0.1) return 'medium';
    }
    return 'low';
  }

  private isContradictory(existing: ScadaEvent, incoming: ScadaEvent): boolean {
    // Basic contradiction: boolean flip within very short time
    if (typeof existing.value === 'boolean' && typeof incoming.value === 'boolean') {
      const timeDiff = Math.abs(incoming.timestamp.getTime() - existing.timestamp.getTime());
      if (timeDiff < 50 && existing.value !== incoming.value) return true;
    }
    return false;
  }

  private captureStateSnapshot(tags: string[]): Record<string, any> {
    const snapshot: Record<string, any> = {};
    for (const tag of tags) {
      const latest = this.tagLatest.get(tag);
      if (latest) snapshot[tag] = latest.value;
    }
    return snapshot;
  }

  private enforceHistoryLimit(): void {
    if (this.eventHistory.size > this.config.maxHistorySize) {
      const entries = Array.from(this.eventHistory.entries());
      const toRemove = entries.slice(0, entries.length - this.config.maxHistorySize);
      for (const [key] of toRemove) {
        this.eventHistory.delete(key);
      }
    }
  }

  // ----- Status -----

  getStatus() {
    return {
      logicalClock: this.logicalClock,
      eventsInHistory: this.eventHistory.size,
      trackedTags: this.tagLatest.size,
      activeConflicts: this.conflicts.size,
      resolutions: this.resolutions.size,
      pendingRollbacks: Array.from(this.rollbackPlans.values()).filter(r => r.status === 'pending').length,
    };
  }

  getConflict(conflictId: string): ConflictDetection | undefined {
    return this.conflicts.get(conflictId);
  }

  getResolution(conflictId: string): Resolution | undefined {
    return this.resolutions.get(conflictId);
  }

  getRecentConflicts(limit = 20): ConflictDetection[] {
    return Array.from(this.conflicts.values())
      .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
      .slice(0, limit);
  }
}

// Singleton
export const paradoxResolver = new ParadoxResolver();
