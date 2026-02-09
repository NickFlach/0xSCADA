/**
 * Propagation Telemetry Service
 *
 * GhostOS Propagation Model - Telemetry Emission and Metrics
 * See docs/propagation-model.md Section 8 for specification
 *
 * Issue: #166 - Propagation Telemetry
 * Epic: #161 - GhostOS Propagation Model
 *
 * Required Metrics (from spec):
 * - propagation_coupling: Gauge
 * - propagation_loss: Gauge
 * - propagation_duration_ms: Histogram
 * - propagation_mode_selected: Counter
 * - propagation_safe_hold_triggered: Counter
 * - propagation_fallback_executed: Counter
 * - propagation_coherence_variance: Gauge
 * - propagation_impact_score: Gauge
 */

import {
  PropagationMode,
  IntentPacket,
  FallbackStrategy,
} from "../../shared/types/intent-packet";

import {
  ModeSelectionResult,
  PolicyFlag,
  RiskLevel,
  SafeHoldEvidence,
  GuardrailResult,
} from "../../shared/types/propagation";

// =============================================================================
// METRIC TYPES
// =============================================================================

export interface PropagationMetricLabels {
  intent_type?: string;
  mode?: PropagationMode;
  target_scope?: string;
  path_length?: number;
  outcome?: PropagationOutcome;
  reason?: string;
  strategy?: FallbackStrategy;
}

export type PropagationOutcome = "success" | "fallback" | "held" | "rejected";

export interface MetricValue {
  value: number;
  labels: PropagationMetricLabels;
  timestamp: number;
}

export interface HistogramBucket {
  le: number;
  count: number;
}

export interface PropagationMetricsSnapshot {
  // Gauges
  coupling: MetricValue[];
  loss: MetricValue[];
  effectiveCoupling: MetricValue[];
  coherenceVariance: MetricValue[];
  impactScore: MetricValue[];

  // Counters
  modeSelected: Record<PropagationMode, number>;
  safeHoldTriggered: Record<string, number>; // by reason
  fallbackExecuted: Record<FallbackStrategy, number>;
  totalPropagations: number;

  // Histogram
  durationBuckets: HistogramBucket[];
  durationSum: number;
  durationCount: number;

  // Derived
  successRate: number;
  safeHoldRate: number;
  avgDuration: number;
}

// =============================================================================
// TELEMETRY EVENT
// =============================================================================

export interface PropagationTelemetryEvent {
  event_type: "PROPAGATION_TELEMETRY";
  timestamp: string;
  intent_id: string;

  metrics: {
    coupling: number;
    loss: number;
    effective_coupling: number;
    coherence_before?: number;
    coherence_after?: number;
    impact_score?: number;
  };

  mode_selected: PropagationMode;
  mode_rationale: string;
  policy_flags: string[];

  outcome: PropagationOutcome;
  duration_ms: number;
}

// =============================================================================
// TELEMETRY COLLECTOR
// =============================================================================

export class PropagationTelemetry {
  private metrics: PropagationMetricsSnapshot;
  private events: PropagationTelemetryEvent[] = [];
  private readonly maxEvents: number;
  private readonly maxMetricSamples: number;

  // Duration histogram buckets (Prometheus-compatible)
  private durationBuckets: HistogramBucket[] = [
    { le: 1, count: 0 },     // 1ms
    { le: 5, count: 0 },     // 5ms
    { le: 10, count: 0 },    // 10ms
    { le: 25, count: 0 },    // 25ms
    { le: 50, count: 0 },    // 50ms
    { le: 100, count: 0 },   // 100ms
    { le: 250, count: 0 },   // 250ms
    { le: 500, count: 0 },   // 500ms
    { le: 1000, count: 0 },  // 1s
    { le: 5000, count: 0 },  // 5s
    { le: Infinity, count: 0 }, // +Inf
  ];

  constructor(options: { maxEvents?: number; maxMetricSamples?: number } = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
    this.maxMetricSamples = options.maxMetricSamples ?? 100;
    this.metrics = this.initializeMetrics();
  }

  private initializeMetrics(): PropagationMetricsSnapshot {
    return {
      coupling: [],
      loss: [],
      effectiveCoupling: [],
      coherenceVariance: [],
      impactScore: [],
      modeSelected: {
        [PropagationMode.LOCAL_COHERENCE]: 0,
        [PropagationMode.REMOTE_COHERENCE]: 0,
        [PropagationMode.SAFE_HOLD]: 0,
        [PropagationMode.EXPLORATION]: 0,
      },
      safeHoldTriggered: {},
      fallbackExecuted: {
        [FallbackStrategy.ROLLBACK]: 0,
        [FallbackStrategy.COMPENSATE]: 0,
        [FallbackStrategy.ESCALATE]: 0,
        [FallbackStrategy.ABORT]: 0,
      },
      totalPropagations: 0,
      durationBuckets: this.durationBuckets,
      durationSum: 0,
      durationCount: 0,
      successRate: 0,
      safeHoldRate: 0,
      avgDuration: 0,
    };
  }

  // ===========================================================================
  // METRIC RECORDING
  // ===========================================================================

  /**
   * Record a complete propagation event
   */
  recordPropagation(
    packet: IntentPacket,
    result: ModeSelectionResult,
    outcome: PropagationOutcome,
    durationMs: number,
    options?: {
      coherenceBefore?: number;
      coherenceAfter?: number;
      impactScore?: number;
    }
  ): PropagationTelemetryEvent {
    const timestamp = new Date().toISOString();
    const labels: PropagationMetricLabels = {
      mode: result.mode,
      outcome,
      target_scope: this.getTargetScope(packet),
    };

    // Record gauge metrics
    this.recordGauge("coupling", result.rationale.coupling, labels);
    this.recordGauge("loss", result.rationale.loss, labels);
    this.recordGauge("effectiveCoupling", result.effectiveCoupling, labels);

    if (options?.coherenceAfter !== undefined && options?.coherenceBefore !== undefined) {
      const variance = Math.abs(options.coherenceAfter - options.coherenceBefore);
      this.recordGauge("coherenceVariance", variance, labels);
    }

    if (options?.impactScore !== undefined) {
      this.recordGauge("impactScore", options.impactScore, labels);
    }

    // Record counters
    this.metrics.modeSelected[result.mode]++;
    this.metrics.totalPropagations++;

    if (result.mode === PropagationMode.SAFE_HOLD) {
      const reason = result.activeFlags[0] || "threshold";
      this.metrics.safeHoldTriggered[reason] =
        (this.metrics.safeHoldTriggered[reason] || 0) + 1;
    }

    // Record duration histogram
    this.recordDuration(durationMs);

    // Update derived metrics
    this.updateDerivedMetrics();

    // Build telemetry event
    const event: PropagationTelemetryEvent = {
      event_type: "PROPAGATION_TELEMETRY",
      timestamp,
      intent_id: packet.intent_id,
      metrics: {
        coupling: result.rationale.coupling,
        loss: result.rationale.loss,
        effective_coupling: result.effectiveCoupling,
        coherence_before: options?.coherenceBefore,
        coherence_after: options?.coherenceAfter,
        impact_score: options?.impactScore,
      },
      mode_selected: result.mode,
      mode_rationale: result.reason,
      policy_flags: result.activeFlags,
      outcome,
      duration_ms: durationMs,
    };

    // Store event
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  /**
   * Record SAFE_HOLD trigger event
   */
  recordSafeHold(
    evidence: SafeHoldEvidence,
    durationMs: number
  ): void {
    const reason = evidence.primaryReason;
    this.metrics.safeHoldTriggered[reason] =
      (this.metrics.safeHoldTriggered[reason] || 0) + 1;

    this.recordDuration(durationMs);
    this.updateDerivedMetrics();
  }

  /**
   * Record fallback execution
   */
  recordFallback(
    strategy: FallbackStrategy,
    success: boolean,
    durationMs: number
  ): void {
    this.metrics.fallbackExecuted[strategy]++;
    this.recordDuration(durationMs);
  }

  /**
   * Record guardrail evaluation
   */
  recordGuardrailEvaluation(
    result: GuardrailResult,
    durationMs: number
  ): void {
    // Track processing time in histogram
    this.recordDuration(durationMs);

    // Track individual guardrail pass/fail
    for (const check of result.checksPerformed) {
      // Could extend to per-guardrail metrics if needed
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private recordGauge(
    name: keyof Pick<PropagationMetricsSnapshot, "coupling" | "loss" | "effectiveCoupling" | "coherenceVariance" | "impactScore">,
    value: number,
    labels: PropagationMetricLabels
  ): void {
    const sample: MetricValue = {
      value,
      labels,
      timestamp: Date.now(),
    };

    this.metrics[name].push(sample);
    if (this.metrics[name].length > this.maxMetricSamples) {
      this.metrics[name].shift();
    }
  }

  private recordDuration(durationMs: number): void {
    for (const bucket of this.durationBuckets) {
      if (durationMs <= bucket.le) {
        bucket.count++;
        break;
      }
    }

    this.metrics.durationSum += durationMs;
    this.metrics.durationCount++;
  }

  private updateDerivedMetrics(): void {
    const total = this.metrics.totalPropagations;
    if (total === 0) return;

    const safeHolds = this.metrics.modeSelected[PropagationMode.SAFE_HOLD];
    const successful =
      this.metrics.modeSelected[PropagationMode.LOCAL_COHERENCE] +
      this.metrics.modeSelected[PropagationMode.REMOTE_COHERENCE] +
      this.metrics.modeSelected[PropagationMode.EXPLORATION];

    this.metrics.successRate = successful / total;
    this.metrics.safeHoldRate = safeHolds / total;
    this.metrics.avgDuration =
      this.metrics.durationCount > 0
        ? this.metrics.durationSum / this.metrics.durationCount
        : 0;
  }

  private getTargetScope(packet: IntentPacket): string {
    const selector = packet.target_selector;
    if (selector.allSites) return "all_sites";
    if (selector.allAssets) return "all_assets";
    if (selector.siteIds?.length) return `sites:${selector.siteIds.length}`;
    if (selector.assetIds?.length) return `assets:${selector.assetIds.length}`;
    if (selector.assetTypes?.length) return `types:${selector.assetTypes.length}`;
    return "unknown";
  }

  // ===========================================================================
  // METRICS EXPORT
  // ===========================================================================

  /**
   * Get current metrics snapshot
   */
  getMetrics(): PropagationMetricsSnapshot {
    return { ...this.metrics };
  }

  /**
   * Get recent telemetry events
   */
  getEvents(limit?: number): PropagationTelemetryEvent[] {
    const events = [...this.events];
    if (limit) {
      return events.slice(-limit);
    }
    return events;
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus(): string {
    const lines: string[] = [];

    // Gauge metrics - coupling
    lines.push("# HELP propagation_coupling Coupling score at propagation time");
    lines.push("# TYPE propagation_coupling gauge");
    for (const sample of this.metrics.coupling.slice(-10)) {
      const labels = this.formatLabels(sample.labels);
      lines.push(`propagation_coupling${labels} ${sample.value}`);
    }

    // Gauge metrics - loss
    lines.push("# HELP propagation_loss Loss score at propagation time");
    lines.push("# TYPE propagation_loss gauge");
    for (const sample of this.metrics.loss.slice(-10)) {
      const labels = this.formatLabels(sample.labels);
      lines.push(`propagation_loss${labels} ${sample.value}`);
    }

    // Counter - mode selected
    lines.push("# HELP propagation_mode_selected_total Mode selection frequency");
    lines.push("# TYPE propagation_mode_selected_total counter");
    for (const [mode, count] of Object.entries(this.metrics.modeSelected)) {
      lines.push(`propagation_mode_selected_total{mode="${mode}"} ${count}`);
    }

    // Counter - SAFE_HOLD triggered
    lines.push("# HELP propagation_safe_hold_triggered_total SAFE_HOLD activations");
    lines.push("# TYPE propagation_safe_hold_triggered_total counter");
    for (const [reason, count] of Object.entries(this.metrics.safeHoldTriggered)) {
      lines.push(`propagation_safe_hold_triggered_total{reason="${reason}"} ${count}`);
    }

    // Counter - fallback executed
    lines.push("# HELP propagation_fallback_executed_total Fallback plan executions");
    lines.push("# TYPE propagation_fallback_executed_total counter");
    for (const [strategy, count] of Object.entries(this.metrics.fallbackExecuted)) {
      lines.push(`propagation_fallback_executed_total{strategy="${strategy}"} ${count}`);
    }

    // Histogram - duration
    lines.push("# HELP propagation_duration_ms End-to-end propagation time");
    lines.push("# TYPE propagation_duration_ms histogram");
    for (const bucket of this.durationBuckets) {
      const le = bucket.le === Infinity ? "+Inf" : bucket.le.toString();
      lines.push(`propagation_duration_ms_bucket{le="${le}"} ${bucket.count}`);
    }
    lines.push(`propagation_duration_ms_sum ${this.metrics.durationSum}`);
    lines.push(`propagation_duration_ms_count ${this.metrics.durationCount}`);

    // Summary metrics
    lines.push("# HELP propagation_success_rate Propagation success rate");
    lines.push("# TYPE propagation_success_rate gauge");
    lines.push(`propagation_success_rate ${this.metrics.successRate}`);

    lines.push("# HELP propagation_safe_hold_rate SAFE_HOLD trigger rate");
    lines.push("# TYPE propagation_safe_hold_rate gauge");
    lines.push(`propagation_safe_hold_rate ${this.metrics.safeHoldRate}`);

    return lines.join("\n");
  }

  private formatLabels(labels: PropagationMetricLabels): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(labels)) {
      if (value !== undefined) {
        parts.push(`${key}="${value}"`);
      }
    }
    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  }

  /**
   * Get cardinality statistics for monitoring
   */
  getCardinalityStats(): {
    uniqueModes: number;
    uniqueReasons: number;
    uniqueScopes: number;
    totalSamples: number;
  } {
    const scopes = new Set<string>();
    for (const sample of this.metrics.coupling) {
      if (sample.labels.target_scope) {
        scopes.add(sample.labels.target_scope);
      }
    }

    return {
      uniqueModes: Object.keys(this.metrics.modeSelected).length,
      uniqueReasons: Object.keys(this.metrics.safeHoldTriggered).length,
      uniqueScopes: scopes.size,
      totalSamples:
        this.metrics.coupling.length +
        this.metrics.loss.length +
        this.metrics.effectiveCoupling.length,
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = this.initializeMetrics();
    this.events = [];
    this.durationBuckets.forEach((b) => (b.count = 0));
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let telemetryInstance: PropagationTelemetry | null = null;

export function getPropagationTelemetry(
  options?: { maxEvents?: number; maxMetricSamples?: number }
): PropagationTelemetry {
  if (!telemetryInstance) {
    telemetryInstance = new PropagationTelemetry(options);
  }
  return telemetryInstance;
}

export function resetPropagationTelemetry(): void {
  telemetryInstance = null;
}
