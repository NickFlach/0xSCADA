/**
 * Paradox Resolution Engine for SCADA Event Conflict Resolution
 * 
 * Adapted from QuantumSingularity's ParadoxResolver for industrial SCADA systems.
 * Handles detection and resolution of contradictory/paradoxical event combinations
 * from process data using multiple resolution strategies.
 * 
 * In SCADA, "paradoxes" are:
 * - Two sensors reporting contradictory states for the same process variable
 * - Control commands arriving out of causal order
 * - State rollbacks needed when a sensor is found to have drifted
 * - Simultaneous alarms that conflict on recommended actions
 * - Physics violations (valve open but zero flow)
 * 
 * Resolution strategies:
 * - Temporal priority: prefer most recent good-quality reading
 * - Sensor confidence weighting: weighted by calibration quality
 * - Voting: majority-wins when 3+ sensors cover the same variable
 * - Physics-based arbitration: reject readings that violate physical laws
 * 
 * @see ADR-0022 Wave 3
 * @closes #346
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScadaEvent {
  id: string;
  deviceId: string;
  tag: string;
  value: unknown;
  timestamp: Date;
  quality: 'good' | 'bad' | 'uncertain';
  source: 'sensor' | 'command' | 'alarm' | 'system';
  /** Lamport-style logical clock for causal ordering */
  logicalClock: number;
  /** Vector clock entries: deviceId → counter */
  vectorClock: Record<string, number>;
  /** Optional causal dependency: event ID this event depends on */
  causedBy?: string;
  /** Process area for area-specific rules */
  processArea?: string;
  /** Sensor confidence from calibration data (0-1) */
  sensorConfidence?: number;
}

export type ConflictType =
  | 'simultaneous_reading'
  | 'causal_violation'
  | 'contradictory_state'
  | 'command_race'
  | 'physics_violation';

export interface ConflictDetection {
  conflictId: string;
  type: ConflictType;
  events: ScadaEvent[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: Date;
  description: string;
  processArea?: string;
}

export type ResolutionMethod =
  | 'temporal_priority'
  | 'confidence_weighted'
  | 'voting'
  | 'physics_arbitration'
  | 'quality_weighted'
  | 'timestamp_tiebreak'
  | 'rollback'
  | 'merge';

export interface Resolution {
  conflictId: string;
  method: ResolutionMethod;
  winner?: ScadaEvent;
  mergedValue?: unknown;
  rollbackTarget?: string;
  confidence: number;
  reasoning: string;
  resolvedAt: Date;
}

export interface ResolvedEvent {
  id: string;
  originalConflictId: string;
  tag: string;
  resolvedValue: unknown;
  confidence: number;
  method: ResolutionMethod;
  reasoning: string;
  contributingEvents: string[];
  timestamp: Date;
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

/** Physics constraint for validating sensor readings */
export interface PhysicsConstraint {
  id: string;
  name: string;
  description: string;
  /** Tags involved in this constraint */
  tags: string[];
  /** Validation function: returns true if readings are physically consistent */
  validate: (readings: Map<string, any>) => PhysicsValidationResult;
}

export interface PhysicsValidationResult {
  valid: boolean;
  violatingTags: string[];
  description: string;
  suggestedValues?: Record<string, any>;
}

/** Per-process-area resolution rules */
export interface ProcessAreaRules {
  processArea: string;
  /** Preferred resolution strategy for this area */
  preferredStrategy: ResolutionMethod;
  /** Minimum number of sensors for voting to be valid */
  minVotingQuorum: number;
  /** Physics constraints specific to this area */
  physicsConstraints: PhysicsConstraint[];
  /** Sensor priority order (highest first) */
  sensorPriority: string[];
  /** Auto-resolve threshold: conflicts below this severity auto-resolve */
  autoResolveSeverity: ConflictDetection['severity'];
  /** Custom confidence weight overrides per device */
  deviceConfidenceOverrides: Record<string, number>;
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
  /** Default minimum quorum for voting strategy */
  defaultVotingQuorum: number;
}

const DEFAULT_CONFIG: ParadoxResolverConfig = {
  simultaneousWindowMs: 100,
  maxHistorySize: 10000,
  autoResolveLowSeverity: true,
  qualityWeight: 0.7,
  defaultVotingQuorum: 3,
};

// ─── Built-in Physics Constraints ───────────────────────────────────────────

/** Common SCADA physics constraints */
export function createValveFlowConstraint(
  valveTag: string,
  flowTag: string,
): PhysicsConstraint {
  return {
    id: `physics_valve_flow_${valveTag}_${flowTag}`,
    name: 'Valve-Flow Consistency',
    description: `Valve ${valveTag} position must be consistent with flow ${flowTag}`,
    tags: [valveTag, flowTag],
    validate: (readings) => {
      const valvePos = readings.get(valveTag);
      const flow = readings.get(flowTag);
      if (valvePos === undefined || flow === undefined) {
        return { valid: true, violatingTags: [], description: 'Insufficient data' };
      }
      // Valve fully closed but flow detected
      if (valvePos === 0 && typeof flow === 'number' && flow > 0.5) {
        return {
          valid: false,
          violatingTags: [flowTag],
          description: `Valve ${valveTag} is closed (0) but flow ${flowTag} reads ${flow}`,
          suggestedValues: { [flowTag]: 0 },
        };
      }
      // Valve fully open but no flow (could indicate blockage, still flag)
      if (typeof valvePos === 'number' && valvePos > 90 && typeof flow === 'number' && flow < 0.1) {
        return {
          valid: false,
          violatingTags: [valveTag, flowTag],
          description: `Valve ${valveTag} is open (${valvePos}) but no flow detected on ${flowTag}`,
        };
      }
      return { valid: true, violatingTags: [], description: 'Consistent' };
    },
  };
}

export function createPressureTemperatureConstraint(
  pressureTag: string,
  temperatureTag: string,
  maxPressureAtTemp: (temp: number) => number,
): PhysicsConstraint {
  return {
    id: `physics_pt_${pressureTag}_${temperatureTag}`,
    name: 'Pressure-Temperature Consistency',
    description: `Pressure ${pressureTag} must be within physical limits given temperature ${temperatureTag}`,
    tags: [pressureTag, temperatureTag],
    validate: (readings) => {
      const pressure = readings.get(pressureTag);
      const temperature = readings.get(temperatureTag);
      if (typeof pressure !== 'number' || typeof temperature !== 'number') {
        return { valid: true, violatingTags: [], description: 'Insufficient data' };
      }
      const maxP = maxPressureAtTemp(temperature);
      if (pressure > maxP) {
        return {
          valid: false,
          violatingTags: [pressureTag],
          description: `Pressure ${pressure} exceeds physical maximum ${maxP.toFixed(1)} at temperature ${temperature}`,
          suggestedValues: { [pressureTag]: maxP },
        };
      }
      return { valid: true, violatingTags: [], description: 'Consistent' };
    },
  };
}

// ─── Paradox Resolver ───────────────────────────────────────────────────────

export class ParadoxResolver extends EventEmitter {
  private config: ParadoxResolverConfig;
  private eventHistory: Map<string, ScadaEvent> = new Map();
  private tagLatest: Map<string, ScadaEvent> = new Map();
  /** All events per tag for voting (recent window) */
  private tagEventWindow: Map<string, ScadaEvent[]> = new Map();
  private conflicts: Map<string, ConflictDetection> = new Map();
  private resolutions: Map<string, Resolution> = new Map();
  private resolvedEvents: Map<string, ResolvedEvent> = new Map();
  private rollbackPlans: Map<string, RollbackPlan> = new Map();
  private static readonly MAX_MAP_SIZE = 10000;
  private processAreaRules: Map<string, ProcessAreaRules> = new Map();
  private globalPhysicsConstraints: PhysicsConstraint[] = [];
  private logicalClock = 0;

  constructor(config: Partial<ParadoxResolverConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Configuration ──────────────────────────────────────────────────────

  /** Register resolution rules for a specific process area */
  registerProcessAreaRules(rules: ProcessAreaRules): void {
    this.processAreaRules.set(rules.processArea, rules);
    this.emit('rules_registered', { processArea: rules.processArea });
  }

  /** Add a global physics constraint */
  addPhysicsConstraint(constraint: PhysicsConstraint): void {
    this.globalPhysicsConstraints.push(constraint);
  }

  /** Get rules for a process area (or defaults) */
  private getRulesForArea(area?: string): ProcessAreaRules | null {
    if (!area) return null;
    return this.processAreaRules.get(area) ?? null;
  }

  // ─── Event Ingestion ────────────────────────────────────────────────────

  /** Ingest a new SCADA event and check for paradoxes */
  async ingestEvent(event: ScadaEvent): Promise<ConflictDetection | null> {
    // Advance logical clock
    this.logicalClock = Math.max(this.logicalClock, event.logicalClock) + 1;
    event.logicalClock = this.logicalClock;

    // Store in history
    this.eventHistory.set(event.id, event);
    this.enforceHistoryLimit();

    // Maintain per-tag event window for voting
    this.updateTagWindow(event);

    // Check for physics violations first
    const physicsConflict = this.checkPhysicsConstraints(event);
    if (physicsConflict) {
      this.conflicts.set(physicsConflict.conflictId, physicsConflict);
      this.emit('conflict', physicsConflict);
      const areaRules = this.getRulesForArea(event.processArea);
      if (this.shouldAutoResolve(physicsConflict, areaRules)) {
        await this.resolve(physicsConflict);
      }
      return physicsConflict;
    }

    // Check for standard conflicts
    const conflict = this.detectConflict(event);
    if (conflict) {
      this.conflicts.set(conflict.conflictId, conflict);
      this.emit('conflict', conflict);

      const areaRules = this.getRulesForArea(event.processArea);
      if (this.shouldAutoResolve(conflict, areaRules)) {
        await this.resolve(conflict);
      }
      return conflict;
    }

    // Update latest state
    this.tagLatest.set(event.tag, event);
    return null;
  }

  private updateTagWindow(event: ScadaEvent): void {
    const window = this.tagEventWindow.get(event.tag) ?? [];
    window.push(event);
    // Keep only events within the simultaneous window × 10 for voting
    const cutoff = Date.now() - this.config.simultaneousWindowMs * 10;
    const filtered = window.filter(e => e.timestamp.getTime() > cutoff);
    this.tagEventWindow.set(event.tag, filtered);
  }

  private shouldAutoResolve(conflict: ConflictDetection, areaRules: ProcessAreaRules | null): boolean {
    const threshold = areaRules?.autoResolveSeverity ?? 'low';
    const severityOrder = ['low', 'medium', 'high', 'critical'];
    const conflictLevel = severityOrder.indexOf(conflict.severity);
    const thresholdLevel = severityOrder.indexOf(threshold);
    return this.config.autoResolveLowSeverity && conflictLevel <= thresholdLevel;
  }

  // ─── Conflict Detection ─────────────────────────────────────────────────

  private detectConflict(event: ScadaEvent): ConflictDetection | null {
    const existing = this.tagLatest.get(event.tag);
    if (!existing) return null;

    // Check simultaneous readings
    const timeDiff = Math.abs(event.timestamp.getTime() - existing.timestamp.getTime());
    if (timeDiff < this.config.simultaneousWindowMs && event.deviceId !== existing.deviceId) {
      if (event.value !== existing.value) {
        return {
          conflictId: this.generateId('conflict'),
          type: 'simultaneous_reading',
          events: [existing, event],
          severity: this.assessSeverity(existing, event),
          detectedAt: new Date(),
          description: `Simultaneous conflicting readings for ${event.tag}: ${existing.value} vs ${event.value}`,
          processArea: event.processArea,
        };
      }
    }

    // Check causal violations
    if (event.causedBy && !this.eventHistory.has(event.causedBy)) {
      return {
        conflictId: this.generateId('conflict'),
        type: 'causal_violation',
        events: [event],
        severity: 'high',
        detectedAt: new Date(),
        description: `Event ${event.id} claims causal dependency on ${event.causedBy} which is not in history`,
        processArea: event.processArea,
      };
    }

    // Check contradictory state transitions
    if (this.isContradictory(existing, event)) {
      return {
        conflictId: this.generateId('conflict'),
        type: 'contradictory_state',
        events: [existing, event],
        severity: 'medium',
        detectedAt: new Date(),
        description: `Contradictory state for ${event.tag}: ${existing.value} → ${event.value} violates expected transition`,
        processArea: event.processArea,
      };
    }

    return null;
  }

  /** Check all physics constraints against current readings */
  private checkPhysicsConstraints(event: ScadaEvent): ConflictDetection | null {
    const areaRules = this.getRulesForArea(event.processArea);
    const constraints = [
      ...this.globalPhysicsConstraints,
      ...(areaRules?.physicsConstraints ?? []),
    ];

    for (const constraint of constraints) {
      if (!constraint.tags.includes(event.tag)) continue;

      // Build current readings map for this constraint
      const readings = new Map<string, any>();
      for (const tag of constraint.tags) {
        if (tag === event.tag) {
          readings.set(tag, event.value);
        } else {
          const latest = this.tagLatest.get(tag);
          if (latest) readings.set(tag, latest.value);
        }
      }

      const result = constraint.validate(readings);
      if (!result.valid) {
        // Gather all involved events
        const involvedEvents = [event];
        for (const tag of result.violatingTags) {
          if (tag !== event.tag) {
            const latest = this.tagLatest.get(tag);
            if (latest) involvedEvents.push(latest);
          }
        }

        return {
          conflictId: this.generateId('conflict'),
          type: 'physics_violation',
          events: involvedEvents,
          severity: 'high',
          detectedAt: new Date(),
          description: `Physics violation (${constraint.name}): ${result.description}`,
          processArea: event.processArea,
        };
      }
    }

    return null;
  }

  // ─── Resolution Strategies ──────────────────────────────────────────────

  /** Resolve a conflict using the best available strategy */
  async resolve(conflict: ConflictDetection): Promise<Resolution> {
    const areaRules = this.getRulesForArea(conflict.processArea);
    const preferredMethod = areaRules?.preferredStrategy;

    let resolution: Resolution;

    // If area rules specify a preferred strategy, try it first
    if (preferredMethod) {
      resolution = this.applyStrategy(preferredMethod, conflict, areaRules);
    } else {
      // Default strategy selection based on conflict type
      switch (conflict.type) {
        case 'simultaneous_reading':
          resolution = this.resolveByBestStrategy(conflict, areaRules);
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
        case 'physics_violation':
          resolution = this.resolvePhysicsViolation(conflict);
          break;
        default:
          resolution = this.fallbackResolution(conflict);
      }
    }

    this.resolutions.set(conflict.conflictId, resolution);
    this.enforceMapLimit(this.conflicts, ParadoxResolver.MAX_MAP_SIZE);
    this.enforceMapLimit(this.resolutions, ParadoxResolver.MAX_MAP_SIZE);

    // Emit resolved event with confidence score
    const resolved = this.emitResolvedEvent(conflict, resolution);
    this.resolvedEvents.set(resolved.id, resolved);
    this.enforceMapLimit(this.resolvedEvents, ParadoxResolver.MAX_MAP_SIZE);

    this.emit('resolved', resolution);
    this.emit('resolved_event', resolved);
    return resolution;
  }

  /** Pick the best strategy for simultaneous readings */
  private resolveByBestStrategy(
    conflict: ConflictDetection,
    areaRules: ProcessAreaRules | null,
  ): Resolution {
    // If we have enough sensors for voting, use voting
    const quorum = areaRules?.minVotingQuorum ?? this.config.defaultVotingQuorum;
    const tagEvents = this.tagEventWindow.get(conflict.events[0]?.tag) ?? [];
    const uniqueDevices = new Set(tagEvents.map(e => e.deviceId));

    if (uniqueDevices.size >= quorum) {
      return this.resolveByVoting(conflict, tagEvents, areaRules);
    }

    // Fall back to confidence weighting
    return this.resolveByConfidenceWeighting(conflict, areaRules);
  }

  private applyStrategy(
    method: ResolutionMethod,
    conflict: ConflictDetection,
    areaRules: ProcessAreaRules | null,
  ): Resolution {
    switch (method) {
      case 'voting': {
        const tagEvents = this.tagEventWindow.get(conflict.events[0]?.tag) ?? [];
        return this.resolveByVoting(conflict, tagEvents, areaRules);
      }
      case 'confidence_weighted':
        return this.resolveByConfidenceWeighting(conflict, areaRules);
      case 'temporal_priority':
        return this.resolveByTemporalPriority(conflict);
      case 'physics_arbitration':
        return this.resolvePhysicsViolation(conflict);
      default:
        return this.resolveByConfidenceWeighting(conflict, areaRules);
    }
  }

  /** Voting resolution: majority value wins among recent readings from distinct devices */
  private resolveByVoting(
    conflict: ConflictDetection,
    tagEvents: ScadaEvent[],
    areaRules: ProcessAreaRules | null,
  ): Resolution {
    // Group by device, take latest from each
    const byDevice = new Map<string, ScadaEvent>();
    for (const e of tagEvents) {
      const existing = byDevice.get(e.deviceId);
      if (!existing || e.timestamp > existing.timestamp) {
        byDevice.set(e.deviceId, e);
      }
    }

    // Count votes per value (for numeric, bucket to nearest integer)
    const votes = new Map<string, { count: number; events: ScadaEvent[] }>();
    for (const event of byDevice.values()) {
      const key = typeof event.value === 'number'
        ? Math.round(event.value).toString()
        : String(event.value);
      const bucket = votes.get(key) ?? { count: 0, events: [] };
      bucket.count++;
      bucket.events.push(event);
      votes.set(key, bucket);
    }

    // Find majority
    let bestKey = '';
    let bestCount = 0;
    for (const [key, bucket] of votes) {
      if (bucket.count > bestCount) {
        bestCount = bucket.count;
        bestKey = key;
      }
    }

    const winnerBucket = votes.get(bestKey)!;
    const totalVotes = byDevice.size;
    const confidence = bestCount / totalVotes;

    // For numeric values, use weighted average of the winning group
    let finalValue: unknown;
    if (winnerBucket.events.every(e => typeof e.value === 'number')) {
      const weights = winnerBucket.events.map(e => e.sensorConfidence ?? this.qualityScore(e));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      finalValue = winnerBucket.events.reduce(
        (sum, e, i) => sum + (e.value as number) * weights[i],
        0,
      ) / totalWeight;
    } else {
      finalValue = winnerBucket.events[0].value;
    }

    return {
      conflictId: conflict.conflictId,
      method: 'voting',
      mergedValue: finalValue,
      winner: winnerBucket.events[0],
      confidence,
      reasoning: `Voting: ${bestCount}/${totalVotes} devices agree on value ≈${bestKey}. ` +
        `Devices: ${Array.from(byDevice.keys()).join(', ')}`,
      resolvedAt: new Date(),
    };
  }

  /** Confidence-weighted resolution using sensor calibration confidence */
  private resolveByConfidenceWeighting(
    conflict: ConflictDetection,
    areaRules: ProcessAreaRules | null,
  ): Resolution {
    const events = conflict.events;
    const scored = events.map(e => {
      const override = areaRules?.deviceConfidenceOverrides[e.deviceId];
      const sensorConf = override ?? e.sensorConfidence ?? 0.5;
      const qualityMult = { good: 1.0, uncertain: 0.5, bad: 0.1 }[e.quality];
      return { event: e, score: sensorConf * qualityMult };
    });

    scored.sort((a, b) => b.score - a.score);

    // If numeric values, do weighted merge when scores are close
    if (
      scored.length >= 2 &&
      scored.every(s => typeof s.event.value === 'number') &&
      scored[0].score - scored[1].score < 0.15
    ) {
      const totalWeight = scored.reduce((s, x) => s + x.score, 0);
      const merged = scored.reduce(
        (sum, x) => sum + (x.event.value as number) * x.score,
        0,
      ) / totalWeight;

      return {
        conflictId: conflict.conflictId,
        method: 'confidence_weighted',
        mergedValue: merged,
        confidence: scored[0].score,
        reasoning: `Confidence-weighted merge of ${scored.length} readings. ` +
          scored.map(s => `${s.event.deviceId}: ${s.event.value} (conf=${s.score.toFixed(3)})`).join(', '),
        resolvedAt: new Date(),
      };
    }

    const winner = scored[0];
    return {
      conflictId: conflict.conflictId,
      method: 'confidence_weighted',
      winner: winner.event,
      confidence: winner.score,
      reasoning: `Selected ${winner.event.deviceId} with confidence ${winner.score.toFixed(3)} ` +
        `(quality=${winner.event.quality}, sensorConf=${winner.event.sensorConfidence ?? 'default'})`,
      resolvedAt: new Date(),
    };
  }

  /** Temporal priority: prefer the most recent good-quality reading */
  private resolveByTemporalPriority(conflict: ConflictDetection): Resolution {
    const goodEvents = conflict.events.filter(e => e.quality === 'good');
    const candidates = goodEvents.length > 0 ? goodEvents : conflict.events;
    const sorted = [...candidates].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
    const winner = sorted[0];

    return {
      conflictId: conflict.conflictId,
      method: 'temporal_priority',
      winner,
      confidence: winner.quality === 'good' ? 0.8 : 0.5,
      reasoning: `Temporal priority: selected most recent ${winner.quality}-quality reading from ${winner.deviceId} at ${winner.timestamp.toISOString()}`,
      resolvedAt: new Date(),
    };
  }

  /** Physics-based arbitration: use suggested values from constraint validation */
  private resolvePhysicsViolation(conflict: ConflictDetection): Resolution {
    // Re-run physics checks to get suggested values
    const areaRules = this.getRulesForArea(conflict.processArea);
    const constraints = [
      ...this.globalPhysicsConstraints,
      ...(areaRules?.physicsConstraints ?? []),
    ];

    for (const constraint of constraints) {
      const readings = new Map<string, any>();
      for (const event of conflict.events) {
        readings.set(event.tag, event.value);
      }
      // Also include latest values for constraint tags not in conflict
      for (const tag of constraint.tags) {
        if (!readings.has(tag)) {
          const latest = this.tagLatest.get(tag);
          if (latest) readings.set(tag, latest.value);
        }
      }

      const result = constraint.validate(readings);
      if (!result.valid && result.suggestedValues) {
        return {
          conflictId: conflict.conflictId,
          method: 'physics_arbitration',
          mergedValue: result.suggestedValues,
          confidence: 0.85,
          reasoning: `Physics arbitration (${constraint.name}): ${result.description}. Applied physics-based correction.`,
          resolvedAt: new Date(),
        };
      }
      if (!result.valid) {
        // No suggested values — prefer the sensor NOT in the violating set
        const nonViolating = conflict.events.find(
          e => !result.violatingTags.includes(e.tag),
        );
        if (nonViolating) {
          return {
            conflictId: conflict.conflictId,
            method: 'physics_arbitration',
            winner: nonViolating,
            confidence: 0.7,
            reasoning: `Physics arbitration (${constraint.name}): ${result.description}. Preferred non-violating sensor ${nonViolating.deviceId}.`,
            resolvedAt: new Date(),
          };
        }
      }
    }

    // Fallback if no constraint matched
    return this.resolveByTemporalPriority(conflict);
  }

  private resolveCausalViolation(conflict: ConflictDetection): Resolution {
    const event = conflict.events[0];
    const rollback: RollbackPlan = {
      id: this.generateId('rollback'),
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
    if (newer.quality === 'good') {
      return {
        conflictId: conflict.conflictId,
        method: 'temporal_priority',
        winner: newer,
        confidence: 0.75,
        reasoning: `Accepting newer good-quality reading over existing ${existing.quality} reading`,
        resolvedAt: new Date(),
      };
    }
    return {
      conflictId: conflict.conflictId,
      method: 'temporal_priority',
      winner: existing,
      confidence: 0.6,
      reasoning: `Keeping existing reading: newer reading quality is ${newer.quality}`,
      resolvedAt: new Date(),
    };
  }

  private resolveCommandRace(conflict: ConflictDetection): Resolution {
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

  private fallbackResolution(conflict: ConflictDetection): Resolution {
    return {
      conflictId: conflict.conflictId,
      method: 'timestamp_tiebreak',
      winner: conflict.events[0],
      confidence: 0.5,
      reasoning: 'Fallback: used first event',
      resolvedAt: new Date(),
    };
  }

  /** Emit a resolved event with confidence score */
  private emitResolvedEvent(conflict: ConflictDetection, resolution: Resolution): ResolvedEvent {
    const resolvedValue = resolution.mergedValue ?? resolution.winner?.value;
    const resolved: ResolvedEvent = {
      id: this.generateId('resolved'),
      originalConflictId: conflict.conflictId,
      tag: conflict.events[0]?.tag ?? 'unknown',
      resolvedValue,
      confidence: resolution.confidence,
      method: resolution.method,
      reasoning: resolution.reasoning,
      contributingEvents: conflict.events.map(e => e.id),
      timestamp: new Date(),
    };
    return resolved;
  }

  /** Execute a rollback plan */
  async executeRollback(rollbackId: string): Promise<boolean> {
    const plan = this.rollbackPlans.get(rollbackId);
    if (!plan || plan.status !== 'pending') return false;

    plan.status = 'executing';
    try {
      for (const tag of plan.affectedTags) {
        const snapshotValue = plan.stateSnapshot[tag];
        if (snapshotValue !== undefined) {
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

  // ─── Helpers ────────────────────────────────────────────────────────────

  private qualityScore(event: ScadaEvent): number {
    const qualityMap = { good: 1.0, uncertain: 0.5, bad: 0.1 };
    const qScore = qualityMap[event.quality] * this.config.qualityWeight;
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

  private enforceMapLimit<T>(map: Map<string, T>, maxSize: number): void {
    if (map.size > maxSize) {
      const keys = Array.from(map.keys());
      const toRemove = keys.slice(0, keys.length - maxSize);
      for (const key of toRemove) map.delete(key);
    }
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

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  // ─── Status & Query ─────────────────────────────────────────────────────

  getStatus() {
    return {
      logicalClock: this.logicalClock,
      eventsInHistory: this.eventHistory.size,
      trackedTags: this.tagLatest.size,
      activeConflicts: this.conflicts.size,
      resolutions: this.resolutions.size,
      resolvedEvents: this.resolvedEvents.size,
      pendingRollbacks: Array.from(this.rollbackPlans.values()).filter(r => r.status === 'pending').length,
      registeredAreas: Array.from(this.processAreaRules.keys()),
      physicsConstraints: this.globalPhysicsConstraints.length,
    };
  }

  getConflict(conflictId: string): ConflictDetection | undefined {
    return this.conflicts.get(conflictId);
  }

  getResolution(conflictId: string): Resolution | undefined {
    return this.resolutions.get(conflictId);
  }

  getResolvedEvent(id: string): ResolvedEvent | undefined {
    return this.resolvedEvents.get(id);
  }

  getRecentConflicts(limit = 20): ConflictDetection[] {
    return Array.from(this.conflicts.values())
      .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
      .slice(0, limit);
  }

  getRecentResolvedEvents(limit = 20): ResolvedEvent[] {
    return Array.from(this.resolvedEvents.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  getConflictLog(): Array<{ conflict: ConflictDetection; resolution?: Resolution; resolvedEvent?: ResolvedEvent }> {
    return Array.from(this.conflicts.values()).map(conflict => ({
      conflict,
      resolution: this.resolutions.get(conflict.conflictId),
      resolvedEvent: Array.from(this.resolvedEvents.values()).find(
        re => re.originalConflictId === conflict.conflictId,
      ),
    }));
  }
}

// Singleton
export const paradoxResolver = new ParadoxResolver();
