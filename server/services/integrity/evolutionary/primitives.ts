/**
 * Resolution Primitives for Evolutionary Paradox Resolution
 *
 * Each primitive is a function that takes conflict data and returns
 * a partial resolution score with weight. Primitives are the atomic
 * building blocks that genomes compose into resolution strategies.
 *
 * @see ADR-0023
 * @closes #380 (partial)
 */

import type { ConflictDetection, ScadaEvent } from '../paradox-resolver';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PrimitiveResult {
  /** Score contribution from this primitive (0–1) */
  score: number;
  /** How strongly this primitive's score should be weighted */
  weight: number;
  /** Which event this primitive favors, if any */
  favoredEventId?: string;
  /** Optional merged/suggested value */
  suggestedValue?: unknown;
  /** Human-readable reasoning */
  reasoning: string;
}

export interface ConflictContext {
  conflict: ConflictDetection;
  /** Recent history for the same tag */
  recentReadings?: ScadaEvent[];
  /** Neighbor tags and their latest values */
  neighborValues?: Map<string, unknown>;
  /** Known physics constraints for this process area */
  physicsValid?: boolean;
}

export interface ResolutionPrimitive {
  id: string;
  name: string;
  description: string;
  evaluate: (ctx: ConflictContext) => PrimitiveResult;
}

// ─── Primitive Implementations ──────────────────────────────────────────────

/**
 * Temporal weight: prefer the most recent reading.
 * Score is proportional to recency relative to the conflict window.
 */
export const temporal_weight: ResolutionPrimitive = {
  id: 'temporal_weight',
  name: 'Temporal Weight',
  description: 'Favors the most recent event in the conflict set',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    const events = ctx.conflict.events;
    if (events.length === 0) {
      return { score: 0.5, weight: 1, reasoning: 'No events' };
    }
    const sorted = [...events].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
    const newest = sorted[0];
    const oldest = sorted[sorted.length - 1];
    const span = newest.timestamp.getTime() - oldest.timestamp.getTime();
    // If span is 0, all events are simultaneous → neutral score
    const score = span > 0 ? 1.0 : 0.5;
    return {
      score,
      weight: 1,
      favoredEventId: newest.id,
      reasoning: `Most recent event: ${newest.deviceId} at ${newest.timestamp.toISOString()}`,
    };
  },
};

/**
 * Confidence weight: prefer the reading with the highest sensor confidence.
 */
export const confidence_weight: ResolutionPrimitive = {
  id: 'confidence_weight',
  name: 'Confidence Weight',
  description: 'Favors the event with the highest sensor confidence score',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    const events = ctx.conflict.events;
    if (events.length === 0) {
      return { score: 0.5, weight: 1, reasoning: 'No events' };
    }
    const scored = events.map(e => ({
      event: e,
      conf: (e.sensorConfidence ?? 0.5) * (e.quality === 'good' ? 1.0 : e.quality === 'uncertain' ? 0.5 : 0.1),
    }));
    scored.sort((a, b) => b.conf - a.conf);
    const best = scored[0];
    return {
      score: best.conf,
      weight: 1.2,
      favoredEventId: best.event.id,
      reasoning: `Highest confidence: ${best.event.deviceId} (${best.conf.toFixed(3)})`,
    };
  },
};

/**
 * Vote: majority-wins among distinct devices reporting on the same tag.
 */
export const vote: ResolutionPrimitive = {
  id: 'vote',
  name: 'Voting',
  description: 'Majority-wins voting across distinct devices',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    const events = ctx.conflict.events;
    if (events.length < 2) {
      return { score: 0.5, weight: 0.8, reasoning: 'Insufficient events for voting' };
    }
    // Group by rounded value
    const buckets = new Map<string, ScadaEvent[]>();
    for (const e of events) {
      const key = typeof e.value === 'number' ? Math.round(e.value).toString() : String(e.value);
      const arr = buckets.get(key) ?? [];
      arr.push(e);
      buckets.set(key, arr);
    }
    let bestKey = '';
    let bestCount = 0;
    for (const [key, arr] of buckets) {
      if (arr.length > bestCount) {
        bestCount = arr.length;
        bestKey = key;
      }
    }
    const winners = buckets.get(bestKey)!;
    const score = bestCount / events.length;
    return {
      score,
      weight: 1,
      favoredEventId: winners[0].id,
      reasoning: `Vote: ${bestCount}/${events.length} agree on ≈${bestKey}`,
    };
  },
};

/**
 * Physics check: penalizes resolutions that violate known physics constraints.
 */
export const physics_check: ResolutionPrimitive = {
  id: 'physics_check',
  name: 'Physics Check',
  description: 'Penalizes events involved in physics violations',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    if (ctx.physicsValid === undefined) {
      return { score: 0.5, weight: 0.5, reasoning: 'No physics data available' };
    }
    if (ctx.physicsValid) {
      return { score: 1.0, weight: 1.5, reasoning: 'Physics constraints satisfied' };
    }
    // Physics violation detected — score is low
    return {
      score: 0.1,
      weight: 1.5,
      reasoning: 'Physics violation detected — penalizing',
    };
  },
};

/**
 * History bias: prefer values consistent with recent historical trend.
 */
export const history_bias: ResolutionPrimitive = {
  id: 'history_bias',
  name: 'History Bias',
  description: 'Favors readings consistent with recent historical values',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    const recent = ctx.recentReadings;
    if (!recent || recent.length < 2) {
      return { score: 0.5, weight: 0.7, reasoning: 'Insufficient history' };
    }
    // Compute recent average for numeric values
    const numericValues = recent
      .map(e => e.value)
      .filter((v): v is number => typeof v === 'number');
    if (numericValues.length < 2) {
      return { score: 0.5, weight: 0.7, reasoning: 'Non-numeric history' };
    }
    const avg = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
    const stddev = Math.sqrt(
      numericValues.reduce((s, v) => s + (v - avg) ** 2, 0) / numericValues.length,
    );

    // Score each conflict event by closeness to historical mean
    const events = ctx.conflict.events.filter(e => typeof e.value === 'number');
    if (events.length === 0) {
      return { score: 0.5, weight: 0.7, reasoning: 'No numeric conflict events' };
    }
    let bestEvent = events[0];
    let bestDist = Infinity;
    for (const e of events) {
      const dist = Math.abs((e.value as number) - avg);
      if (dist < bestDist) {
        bestDist = dist;
        bestEvent = e;
      }
    }
    // Score: 1.0 if within 1 stddev, decays beyond
    const normalizedDist = stddev > 0 ? bestDist / stddev : bestDist;
    const score = Math.exp(-normalizedDist);
    return {
      score,
      weight: 0.9,
      favoredEventId: bestEvent.id,
      reasoning: `Closest to history (μ=${avg.toFixed(2)}, σ=${stddev.toFixed(2)}): ${bestEvent.deviceId} dist=${bestDist.toFixed(2)}`,
    };
  },
};

/**
 * Neighbor correlation: checks if the reading is consistent with
 * correlated neighbor tags (e.g., upstream/downstream sensors).
 */
export const neighbor_correlation: ResolutionPrimitive = {
  id: 'neighbor_correlation',
  name: 'Neighbor Correlation',
  description: 'Favors readings consistent with neighboring sensor values',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    if (!ctx.neighborValues || ctx.neighborValues.size === 0) {
      return { score: 0.5, weight: 0.6, reasoning: 'No neighbor data' };
    }
    // Simple: check if any conflict event's value is close to neighbor average
    const neighborNums: number[] = [];
    for (const v of ctx.neighborValues.values()) {
      if (typeof v === 'number') neighborNums.push(v);
    }
    if (neighborNums.length === 0) {
      return { score: 0.5, weight: 0.6, reasoning: 'Non-numeric neighbors' };
    }
    const neighborAvg = neighborNums.reduce((a, b) => a + b, 0) / neighborNums.length;

    const events = ctx.conflict.events.filter(e => typeof e.value === 'number');
    if (events.length === 0) {
      return { score: 0.5, weight: 0.6, reasoning: 'No numeric conflict events' };
    }
    let bestEvent = events[0];
    let bestDist = Infinity;
    for (const e of events) {
      const dist = Math.abs((e.value as number) - neighborAvg);
      if (dist < bestDist) {
        bestDist = dist;
        bestEvent = e;
      }
    }
    const score = Math.exp(-bestDist / Math.max(Math.abs(neighborAvg), 1));
    return {
      score,
      weight: 0.8,
      favoredEventId: bestEvent.id,
      reasoning: `Neighbor avg=${neighborAvg.toFixed(2)}, closest: ${bestEvent.deviceId}`,
    };
  },
};

/**
 * Rate filter: penalizes readings that imply an unrealistic rate of change.
 */
export const rate_filter: ResolutionPrimitive = {
  id: 'rate_filter',
  name: 'Rate Filter',
  description: 'Penalizes readings implying an unrealistic rate of change',
  evaluate(ctx: ConflictContext): PrimitiveResult {
    const recent = ctx.recentReadings;
    if (!recent || recent.length === 0) {
      return { score: 0.5, weight: 0.8, reasoning: 'No history for rate check' };
    }
    const lastReading = recent[recent.length - 1];
    if (typeof lastReading.value !== 'number') {
      return { score: 0.5, weight: 0.8, reasoning: 'Non-numeric last reading' };
    }
    const events = ctx.conflict.events.filter(e => typeof e.value === 'number');
    if (events.length === 0) {
      return { score: 0.5, weight: 0.8, reasoning: 'No numeric conflict events' };
    }

    // Compute rate of change for each event relative to last reading
    let bestEvent = events[0];
    let bestScore = 0;
    for (const e of events) {
      const dt = Math.abs(e.timestamp.getTime() - lastReading.timestamp.getTime()) / 1000; // seconds
      if (dt === 0) continue;
      const rate = Math.abs((e.value as number) - (lastReading.value as number)) / dt;
      // Assume rates > 100 units/sec are suspicious; score decays exponentially
      const s = Math.exp(-rate / 100);
      if (s > bestScore) {
        bestScore = s;
        bestEvent = e;
      }
    }
    return {
      score: bestScore || 0.5,
      weight: 0.8,
      favoredEventId: bestEvent.id,
      reasoning: `Rate filter favors ${bestEvent.deviceId} (score=${bestScore.toFixed(3)})`,
    };
  },
};

/** All built-in primitives */
export const BUILTIN_PRIMITIVES: ResolutionPrimitive[] = [
  temporal_weight,
  confidence_weight,
  vote,
  physics_check,
  history_bias,
  neighbor_correlation,
  rate_filter,
];
