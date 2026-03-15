/**
 * Real-Time SPC Engine
 * 
 * Issue #353: Statistical Process Control
 * 
 * Processes streaming tag data through control charts, applies rules,
 * computes capability indices, and generates anomaly scores.
 */

import { EventEmitter } from 'events';
import { XBarRChart, SChart, CUSUMChart, EWMAChart, ControlLimits, CUSUMConfig, EWMAConfig } from './control-charts';
import { checkRules, RuleViolation, RuleSet } from './rules-engine';
import { computeCapability, CapabilityIndices, SpecificationLimits } from './capability';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SPCEngineConfig {
  id: string;
  tagName: string;
  subgroupSize: number;
  specs?: SpecificationLimits;
  cusumConfig?: CUSUMConfig;
  ewmaConfig?: EWMAConfig;
  ruleSet?: RuleSet;
}

export interface AnomalyScore {
  timestamp: number;
  score: number;             // 0.0 = normal, 1.0 = definitely anomalous
  signals: AnomalySignal[];
}

export interface AnomalySignal {
  source: string;
  triggered: boolean;
  weight: number;
}

export interface SPCStatus {
  tagName: string;
  sampleCount: number;
  subgroupCount: number;
  latestAnomalyScore: number;
  activeViolations: RuleViolation[];
  capability: CapabilityIndices | null;
  xBarLimits: ControlLimits | null;
}

// ─── Engine ─────────────────────────────────────────────────────────────

export class SPCEngine extends EventEmitter {
  readonly id: string;
  readonly tagName: string;

  private subgroupSize: number;
  private specs: SpecificationLimits | null;
  private ruleSet: RuleSet;

  // Charts
  private xBarRChart: XBarRChart;
  private sChart: SChart;
  private cusumChart: CUSUMChart | null = null;
  private ewmaChart: EWMAChart | null = null;

  // Buffers
  private currentSubgroup: number[] = [];
  private allValues: number[] = [];
  private subgroupRanges: number[] = [];
  private xBarValues: number[] = [];

  // State
  private activeViolations: RuleViolation[] = [];
  private latestScore: AnomalyScore = { timestamp: 0, score: 0, signals: [] };
  private sampleCount = 0;
  private subgroupCount = 0;

  constructor(config: SPCEngineConfig) {
    super();
    this.id = config.id;
    this.tagName = config.tagName;
    this.subgroupSize = config.subgroupSize;
    this.specs = config.specs ?? null;
    this.ruleSet = config.ruleSet ?? 'all';

    this.xBarRChart = new XBarRChart(config.subgroupSize);
    this.sChart = new SChart(config.subgroupSize);

    if (config.cusumConfig) {
      this.cusumChart = new CUSUMChart(config.cusumConfig);
    }
    if (config.ewmaConfig) {
      this.ewmaChart = new EWMAChart(config.ewmaConfig);
    }
  }

  /**
   * Process a single incoming value from streaming tag data.
   * Accumulates into subgroups and runs analysis when a subgroup is complete.
   */
  addValue(value: number, timestamp?: number): AnomalyScore | null {
    const ts = timestamp ?? Date.now();
    this.sampleCount++;
    this.allValues.push(value);
    this.currentSubgroup.push(value);

    // CUSUM and EWMA process every individual value
    let cusumSignal = false;
    let ewmaSignal = false;

    if (this.cusumChart) {
      const r = this.cusumChart.addValue(value, ts);
      cusumSignal = r.signal;
    }
    if (this.ewmaChart) {
      const r = this.ewmaChart.addValue(value, ts);
      ewmaSignal = r.signal;
    }

    // Check if subgroup is complete
    if (this.currentSubgroup.length >= this.subgroupSize) {
      return this.processSubgroup(ts, cusumSignal, ewmaSignal);
    }

    // Between subgroups — only return score if CUSUM/EWMA triggered
    if (cusumSignal || ewmaSignal) {
      const score = this.computeAnomalyScore([], cusumSignal, ewmaSignal);
      this.latestScore = score;
      if (score.score > 0.5) this.emit('anomaly', score);
      return score;
    }

    return null;
  }

  private processSubgroup(ts: number, cusumSignal: boolean, ewmaSignal: boolean): AnomalyScore {
    this.subgroupCount++;
    const subgroupData = { values: [...this.currentSubgroup], timestamp: ts };

    // Run charts
    const { xBar, r } = this.xBarRChart.addSubgroup(subgroupData);
    this.sChart.addSubgroup(subgroupData);

    this.xBarValues.push(xBar.value);
    this.subgroupRanges.push(r.value);
    this.currentSubgroup = [];

    // Run rules on X-bar values
    const limits = this.xBarRChart.getXBarLimits();
    let violations: RuleViolation[] = [];
    if (limits) {
      violations = checkRules(this.xBarValues, limits, this.ruleSet);
      this.activeViolations = violations;
      if (violations.length > 0) {
        this.emit('out-of-control', violations);
      }
    }

    // Compute anomaly score
    const score = this.computeAnomalyScore(violations, cusumSignal, ewmaSignal);
    this.latestScore = score;
    if (score.score > 0.5) this.emit('anomaly', score);
    return score;
  }

  private computeAnomalyScore(
    violations: RuleViolation[],
    cusumSignal: boolean,
    ewmaSignal: boolean,
  ): AnomalyScore {
    const signals: AnomalySignal[] = [];

    // Rule violations
    const alarmCount = violations.filter(v => v.severity === 'alarm').length;
    const warnCount = violations.filter(v => v.severity === 'warning').length;
    signals.push({ source: 'rules-alarm', triggered: alarmCount > 0, weight: 0.4 });
    signals.push({ source: 'rules-warning', triggered: warnCount > 0, weight: 0.2 });
    signals.push({ source: 'cusum', triggered: cusumSignal, weight: 0.25 });
    signals.push({ source: 'ewma', triggered: ewmaSignal, weight: 0.15 });

    const score = signals.reduce((s, sig) => s + (sig.triggered ? sig.weight : 0), 0);

    return { timestamp: Date.now(), score: Math.min(1, score), signals };
  }

  // ─── Status & capability ───────────────────────────────────────

  getCapability(): CapabilityIndices | null {
    if (!this.specs || this.allValues.length < 30) return null;
    return computeCapability(this.allValues, this.subgroupRanges, this.subgroupSize, this.specs);
  }

  getStatus(): SPCStatus {
    return {
      tagName: this.tagName,
      sampleCount: this.sampleCount,
      subgroupCount: this.subgroupCount,
      latestAnomalyScore: this.latestScore.score,
      activeViolations: this.activeViolations,
      capability: this.getCapability(),
      xBarLimits: this.xBarRChart.getXBarLimits(),
    };
  }

  getLatestAnomalyScore(): AnomalyScore {
    return this.latestScore;
  }
}
