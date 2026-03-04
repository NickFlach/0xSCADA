/**
 * Verification Layer Implementations
 * Issue #344: Build 5-layer verification pipeline framework
 * 
 * Base layer class + concrete implementations for all 5 layers.
 */

import pino from 'pino';
import type {
  IVerificationLayer,
  VerificationLayer,
  VerificationLayerConfig,
  VerificationInput,
  VerificationRule,
  VerificationFinding,
  VerificationSeverity,
  LayerResult,
} from './types';
import { LAYER_NAMES } from './types';

const logger = pino({ name: 'verification-layers' });

// ─── Severity Ordering ──────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<VerificationSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

function meetsThreshold(severity: VerificationSeverity, threshold: VerificationSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[threshold];
}

// ─── Base Layer ─────────────────────────────────────────────────────────────

export class BaseVerificationLayer<TCtx = unknown> implements IVerificationLayer<TCtx> {
  readonly layer: VerificationLayer;
  readonly name: string;
  rules: VerificationRule<TCtx>[] = [];

  constructor(layer: VerificationLayer) {
    this.layer = layer;
    this.name = LAYER_NAMES[layer];
  }

  addRule(rule: VerificationRule<TCtx>): void {
    this.rules.push(rule);
  }

  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
  }

  async execute(input: VerificationInput, config: VerificationLayerConfig, ctx?: TCtx): Promise<LayerResult> {
    if (!config.enabled) {
      return {
        layer: this.layer,
        layerName: this.name,
        status: 'skip',
        findings: [],
        durationMs: 0,
        skipped: true,
        skipReason: 'Layer disabled',
      };
    }

    const start = Date.now();
    const findings: VerificationFinding[] = [];
    const enabledRules = this.rules.filter(r => r.enabled);

    try {
      const rulePromises = enabledRules.map(async (rule) => {
        try {
          const result = await Promise.race([
            Promise.resolve(rule.check(input, ctx as TCtx)),
            new Promise<VerificationFinding[]>((_, reject) =>
              setTimeout(() => reject(new Error(`Rule ${rule.id} timed out`)), config.timeoutMs)
            ),
          ]);
          return result;
        } catch (err) {
          return [{
            layer: this.layer,
            ruleId: rule.id,
            severity: 'error' as VerificationSeverity,
            status: 'error' as const,
            message: `Rule execution error: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
          }];
        }
      });

      const results = await Promise.all(rulePromises);
      for (const ruleFinding of results) {
        findings.push(...ruleFinding);
      }
    } catch (err) {
      logger.error({ layer: this.layer, err }, 'Layer execution error');
      findings.push({
        layer: this.layer,
        ruleId: '__layer__',
        severity: 'critical',
        status: 'error',
        message: `Layer execution error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const hasFailing = findings.some(
      f => f.status === 'fail' && meetsThreshold(f.severity, config.failureSeverity)
    );
    const hasError = findings.some(f => f.status === 'error');

    return {
      layer: this.layer,
      layerName: this.name,
      status: hasError ? 'error' : hasFailing ? 'fail' : 'pass',
      findings,
      durationMs: Date.now() - start,
      skipped: false,
    };
  }
}

// ─── Concrete Layers ────────────────────────────────────────────────────────

/** L1 — Schema validation: data shape, required fields, types */
export class SchemaValidationLayer extends BaseVerificationLayer {
  constructor() { super(1); }
}

/** L2 — Range/bounds: engineering limits, alarm thresholds */
export class RangeBoundsLayer extends BaseVerificationLayer {
  constructor() { super(2); }
}

/** L3 — Cross-reference: consistency across related tags */
export class CrossReferenceLayer extends BaseVerificationLayer {
  constructor() { super(3); }
}

/** L4 — Temporal: rate-of-change, stuck detection, sequence checks */
export class TemporalValidationLayer extends BaseVerificationLayer {
  constructor() { super(4); }
}

/** L5 — Semantic: process logic, physics constraints */
export class SemanticValidationLayer extends BaseVerificationLayer {
  constructor() { super(5); }
}
