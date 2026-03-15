/**
 * SPC Rules Engine — Western Electric & Nelson Rules
 * 
 * Issue #353: Statistical process control for anomaly detection
 * 
 * Implements all 4 Western Electric rules and 8 Nelson rules
 * for detecting out-of-control conditions in control chart data.
 */

import { ControlLimits } from './control-charts';

// ─── Types ──────────────────────────────────────────────────────────────

export interface RuleViolation {
  rule: string;
  description: string;
  pointIndices: number[];
  severity: 'warning' | 'alarm';
  timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sigma(limits: ControlLimits): number {
  return (limits.ucl - limits.cl) / 3;
}

function zone(value: number, limits: ControlLimits): number {
  const s = sigma(limits);
  if (s === 0) return 0;
  return (value - limits.cl) / s; // In units of sigma
}

// ─── Western Electric Rules ─────────────────────────────────────────────

/**
 * Rule 1: One point beyond 3σ from center line
 */
function westernElectricRule1(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > limits.ucl || values[i] < limits.lcl) {
      violations.push({
        rule: 'WE-1',
        description: 'Point beyond 3σ control limit',
        pointIndices: [i],
        severity: 'alarm',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Rule 2: 2 of 3 consecutive points beyond 2σ on same side
 */
function westernElectricRule2(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const s = sigma(limits);
  const twoSigmaUp = limits.cl + 2 * s;
  const twoSigmaDown = limits.cl - 2 * s;

  for (let i = 2; i < values.length; i++) {
    const window = [values[i - 2], values[i - 1], values[i]];
    const above = window.filter(v => v > twoSigmaUp).length;
    const below = window.filter(v => v < twoSigmaDown).length;
    if (above >= 2 || below >= 2) {
      violations.push({
        rule: 'WE-2',
        description: '2 of 3 consecutive points beyond 2σ on same side',
        pointIndices: [i - 2, i - 1, i],
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Rule 3: 4 of 5 consecutive points beyond 1σ on same side
 */
function westernElectricRule3(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const s = sigma(limits);
  const oneSigmaUp = limits.cl + s;
  const oneSigmaDown = limits.cl - s;

  for (let i = 4; i < values.length; i++) {
    const window = values.slice(i - 4, i + 1);
    const above = window.filter(v => v > oneSigmaUp).length;
    const below = window.filter(v => v < oneSigmaDown).length;
    if (above >= 4 || below >= 4) {
      violations.push({
        rule: 'WE-3',
        description: '4 of 5 consecutive points beyond 1σ on same side',
        pointIndices: [i - 4, i - 3, i - 2, i - 1, i],
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Rule 4: 8 consecutive points on same side of center line
 */
function westernElectricRule4(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (let i = 7; i < values.length; i++) {
    const window = values.slice(i - 7, i + 1);
    const allAbove = window.every(v => v > limits.cl);
    const allBelow = window.every(v => v < limits.cl);
    if (allAbove || allBelow) {
      violations.push({
        rule: 'WE-4',
        description: '8 consecutive points on same side of center line',
        pointIndices: Array.from({ length: 8 }, (_, j) => i - 7 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

// ─── Nelson Rules ───────────────────────────────────────────────────────

/**
 * Nelson Rule 1: Same as WE Rule 1
 * Nelson Rule 2: 9 points in a row on same side of center line
 */
function nelsonRule2(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (let i = 8; i < values.length; i++) {
    const window = values.slice(i - 8, i + 1);
    if (window.every(v => v > limits.cl) || window.every(v => v < limits.cl)) {
      violations.push({
        rule: 'Nelson-2',
        description: '9 consecutive points on same side of center line',
        pointIndices: Array.from({ length: 9 }, (_, j) => i - 8 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Nelson Rule 3: 6 points in a row steadily increasing or decreasing
 */
function nelsonRule3(values: number[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (let i = 5; i < values.length; i++) {
    const window = values.slice(i - 5, i + 1);
    let increasing = true, decreasing = true;
    for (let j = 1; j < window.length; j++) {
      if (window[j] <= window[j - 1]) increasing = false;
      if (window[j] >= window[j - 1]) decreasing = false;
    }
    if (increasing || decreasing) {
      violations.push({
        rule: 'Nelson-3',
        description: '6 consecutive points steadily increasing or decreasing',
        pointIndices: Array.from({ length: 6 }, (_, j) => i - 5 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Nelson Rule 4: 14 points alternating up and down
 */
function nelsonRule4(values: number[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  for (let i = 13; i < values.length; i++) {
    const window = values.slice(i - 13, i + 1);
    let alternating = true;
    for (let j = 2; j < window.length; j++) {
      const prev = window[j - 1] - window[j - 2];
      const curr = window[j] - window[j - 1];
      if (prev * curr >= 0) { alternating = false; break; }
    }
    if (alternating) {
      violations.push({
        rule: 'Nelson-4',
        description: '14 points alternating up and down',
        pointIndices: Array.from({ length: 14 }, (_, j) => i - 13 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Nelson Rule 5: 2 of 3 points beyond 2σ on same side (same as WE-2)
 * Nelson Rule 6: 4 of 5 points beyond 1σ on same side (same as WE-3)
 * Nelson Rule 7: 15 points within 1σ (stratification / reduced variation)
 */
function nelsonRule7(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const s = sigma(limits);

  for (let i = 14; i < values.length; i++) {
    const window = values.slice(i - 14, i + 1);
    if (window.every(v => Math.abs(v - limits.cl) < s)) {
      violations.push({
        rule: 'Nelson-7',
        description: '15 consecutive points within 1σ (stratification)',
        pointIndices: Array.from({ length: 15 }, (_, j) => i - 14 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

/**
 * Nelson Rule 8: 8 points beyond 1σ on either side (mixture pattern)
 */
function nelsonRule8(values: number[], limits: ControlLimits): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const s = sigma(limits);

  for (let i = 7; i < values.length; i++) {
    const window = values.slice(i - 7, i + 1);
    if (window.every(v => Math.abs(v - limits.cl) > s)) {
      violations.push({
        rule: 'Nelson-8',
        description: '8 consecutive points beyond 1σ on either side (mixture)',
        pointIndices: Array.from({ length: 8 }, (_, j) => i - 7 + j),
        severity: 'warning',
        timestamp: Date.now(),
      });
    }
  }
  return violations;
}

// ─── Combined Rule Checker ──────────────────────────────────────────────

export type RuleSet = 'western-electric' | 'nelson' | 'all';

export function checkRules(values: number[], limits: ControlLimits, ruleSet: RuleSet = 'all'): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (ruleSet === 'western-electric' || ruleSet === 'all') {
    violations.push(...westernElectricRule1(values, limits));
    violations.push(...westernElectricRule2(values, limits));
    violations.push(...westernElectricRule3(values, limits));
    violations.push(...westernElectricRule4(values, limits));
  }

  if (ruleSet === 'nelson' || ruleSet === 'all') {
    // Nelson 1 = WE-1 (already included in 'all')
    if (ruleSet === 'nelson') violations.push(...westernElectricRule1(values, limits));
    violations.push(...nelsonRule2(values, limits));
    violations.push(...nelsonRule3(values));
    violations.push(...nelsonRule4(values));
    // Nelson 5 = WE-2, Nelson 6 = WE-3 (already included in 'all')
    if (ruleSet === 'nelson') {
      violations.push(...westernElectricRule2(values, limits));
      violations.push(...westernElectricRule3(values, limits));
    }
    violations.push(...nelsonRule7(values, limits));
    violations.push(...nelsonRule8(values, limits));
  }

  return violations;
}
