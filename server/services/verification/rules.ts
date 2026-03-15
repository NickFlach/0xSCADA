/**
 * Built-in Verification Rules
 * Issue #344: Build 5-layer verification pipeline framework
 * 
 * Provides ready-to-use rules for common SCADA verification scenarios.
 * Users can add custom rules via the layer.addRule() API.
 */

import type {
  VerificationRule,
  VerificationFinding,
  VerificationInput,
  VerificationLayer,
} from './types';

// ─── Rule Factory Helpers ───────────────────────────────────────────────────

function finding(
  layer: VerificationLayer,
  ruleId: string,
  severity: VerificationFinding['severity'],
  message: string,
  extras?: Partial<VerificationFinding>,
): VerificationFinding {
  return {
    layer,
    ruleId,
    severity,
    status: 'fail',
    message,
    timestamp: new Date().toISOString(),
    ...extras,
  };
}

// ─── L1: Schema Rules ───────────────────────────────────────────────────────

/** Checks that required fields exist in the data payload */
export function requiredFieldsRule(fields: string[]): VerificationRule {
  return {
    id: 'schema.required-fields',
    name: 'Required Fields',
    description: `Ensures fields [${fields.join(', ')}] are present`,
    severity: 'error',
    enabled: true,
    check(input: VerificationInput) {
      const findings: VerificationFinding[] = [];
      for (const field of fields) {
        if (!(field in input.data)) {
          findings.push(finding(1, 'schema.required-fields', 'error', `Missing required field: ${field}`, { path: field }));
        }
      }
      return findings;
    },
  };
}

/** Checks that field types match expected data types */
export function fieldTypeRule(schema: Record<string, string>): VerificationRule {
  return {
    id: 'schema.field-types',
    name: 'Field Type Validation',
    severity: 'error',
    enabled: true,
    check(input: VerificationInput) {
      const findings: VerificationFinding[] = [];
      for (const [field, expectedType] of Object.entries(schema)) {
        const val = input.data[field];
        if (val !== undefined && typeof val !== expectedType) {
          findings.push(finding(1, 'schema.field-types', 'error',
            `Field "${field}" expected type ${expectedType}, got ${typeof val}`,
            { path: field, expected: expectedType, actual: typeof val }));
        }
      }
      return findings;
    },
  };
}

// ─── L2: Range Rules ────────────────────────────────────────────────────────

export interface RangeBound {
  field: string;
  min?: number;
  max?: number;
  unit?: string;
}

/** Checks that numeric fields are within engineering limits */
export function rangeBoundsRule(bounds: RangeBound[]): VerificationRule {
  return {
    id: 'range.bounds',
    name: 'Range Bounds Check',
    severity: 'warning',
    enabled: true,
    check(input: VerificationInput) {
      const findings: VerificationFinding[] = [];
      for (const bound of bounds) {
        const val = input.data[bound.field];
        if (typeof val !== 'number') continue;
        if (bound.min !== undefined && val < bound.min) {
          findings.push(finding(2, 'range.bounds', 'warning',
            `${bound.field} = ${val} below minimum ${bound.min}${bound.unit ? ' ' + bound.unit : ''}`,
            { path: bound.field, expected: bound.min, actual: val }));
        }
        if (bound.max !== undefined && val > bound.max) {
          findings.push(finding(2, 'range.bounds', 'warning',
            `${bound.field} = ${val} above maximum ${bound.max}${bound.unit ? ' ' + bound.unit : ''}`,
            { path: bound.field, expected: bound.max, actual: val }));
        }
      }
      return findings;
    },
  };
}

// ─── L3: Cross-Reference Rules ──────────────────────────────────────────────

/** Checks that two fields have a consistent relationship */
export function consistencyRule(
  fieldA: string,
  fieldB: string,
  predicate: (a: unknown, b: unknown) => boolean,
  message: string,
): VerificationRule {
  return {
    id: `xref.consistency.${fieldA}-${fieldB}`,
    name: `Consistency: ${fieldA} ↔ ${fieldB}`,
    severity: 'error',
    enabled: true,
    check(input: VerificationInput) {
      const a = input.data[fieldA];
      const b = input.data[fieldB];
      if (a === undefined || b === undefined) return [];
      if (!predicate(a, b)) {
        return [finding(3, `xref.consistency.${fieldA}-${fieldB}`, 'error', message, {
          path: `${fieldA}, ${fieldB}`,
          expected: 'consistent',
          actual: `${fieldA}=${JSON.stringify(a)}, ${fieldB}=${JSON.stringify(b)}`,
        })];
      }
      return [];
    },
  };
}

// ─── L4: Temporal Rules ─────────────────────────────────────────────────────

/** Detects values stuck at the same reading (flatline) */
export function stuckDetectionRule(field: string, maxSameCount: number): VerificationRule {
  return {
    id: `temporal.stuck.${field}`,
    name: `Stuck Detection: ${field}`,
    severity: 'warning',
    enabled: true,
    check(input: VerificationInput) {
      if (!input.history || input.history.length < maxSameCount) return [];
      const recent = input.history.slice(-maxSameCount);
      const allSame = recent.every(h => h.value === recent[0].value);
      if (allSame) {
        return [finding(4, `temporal.stuck.${field}`, 'warning',
          `${field} stuck at ${JSON.stringify(recent[0].value)} for ${maxSameCount} readings`,
          { path: field, actual: recent[0].value })];
      }
      return [];
    },
  };
}

/** Detects rate-of-change exceeding a threshold */
export function rateOfChangeRule(field: string, maxRate: number, unit: string = '/s'): VerificationRule {
  return {
    id: `temporal.roc.${field}`,
    name: `Rate of Change: ${field}`,
    severity: 'warning',
    enabled: true,
    check(input: VerificationInput) {
      if (!input.history || input.history.length < 2) return [];
      const last = input.history[input.history.length - 1];
      const prev = input.history[input.history.length - 2];
      const lastVal = typeof last.value === 'number' ? last.value : NaN;
      const prevVal = typeof prev.value === 'number' ? prev.value : NaN;
      if (isNaN(lastVal) || isNaN(prevVal)) return [];
      const dt = (new Date(last.timestamp as string).getTime() - new Date(prev.timestamp as string).getTime()) / 1000;
      if (dt <= 0) return [];
      const rate = Math.abs(lastVal - prevVal) / dt;
      if (rate > maxRate) {
        return [finding(4, `temporal.roc.${field}`, 'warning',
          `${field} rate of change ${rate.toFixed(2)}${unit} exceeds limit ${maxRate}${unit}`,
          { path: field, expected: maxRate, actual: rate })];
      }
      return [];
    },
  };
}

// ─── L5: Semantic Rules ─────────────────────────────────────────────────────

/** Custom process logic rule evaluated against process context */
export function processLogicRule(
  id: string,
  name: string,
  predicate: (data: Record<string, unknown>, ctx: Record<string, unknown>) => boolean,
  failMessage: string,
): VerificationRule {
  return {
    id: `semantic.${id}`,
    name,
    severity: 'error',
    enabled: true,
    check(input: VerificationInput) {
      const ctx = input.processContext ?? {};
      if (!predicate(input.data, ctx)) {
        return [finding(5, `semantic.${id}`, 'error', failMessage)];
      }
      return [];
    },
  };
}
