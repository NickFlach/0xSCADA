/**
 * Gain Safety Envelope (ADR-0009)
 * ADR-0013 [13.4] — Issue #215
 *
 * Absolute bounds on controller gains. The pre-existing per-step rate
 * limit (PIDController.maxGainChangeFraction) constrains each change;
 * the envelope constrains the reachable set, so repeated rate-limited
 * steps can never walk gains outside safe territory.
 */

import type { GainEnvelope, GainRange } from '@shared/types/tuning';
import type { PIDGains } from '../optimization/pid-controller';

export const DEFAULT_ENVELOPE: GainEnvelope = {
  kpRange: { min: 0, max: 100 },
  kiRange: { min: 0, max: 50 },
  kdRange: { min: 0, max: 50 },
};

export function validateEnvelope(envelope: GainEnvelope): string | null {
  for (const [name, range] of Object.entries(envelope) as Array<[string, GainRange]>) {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      return `${name} bounds must be finite`;
    }
    if (range.min > range.max) {
      return `${name}: min (${range.min}) exceeds max (${range.max})`;
    }
    if (range.min < 0) {
      return `${name}: negative gains are outside the supported envelope`;
    }
  }
  return null;
}

/**
 * Human-readable list of every bound `gains` violates. Empty when the gains
 * are inside the envelope. Used to refuse an out-of-envelope recommendation at
 * proposal time with a message an engineer can act on.
 */
export function describeEnvelopeViolations(
  gains: PIDGains,
  envelope: GainEnvelope
): string[] {
  const checks: Array<[keyof PIDGains, GainRange]> = [
    ['kp', envelope.kpRange],
    ['ki', envelope.kiRange],
    ['kd', envelope.kdRange],
  ];
  const violations: string[] = [];
  for (const [name, range] of checks) {
    const value = gains[name];
    if (!Number.isFinite(value)) {
      violations.push(`${name}=${value} is not a finite gain`);
    } else if (value < range.min || value > range.max) {
      violations.push(`${name}=${value} outside [${range.min}, ${range.max}]`);
    }
  }
  return violations;
}

export function isWithinEnvelope(gains: PIDGains, envelope: GainEnvelope): boolean {
  return (
    gains.kp >= envelope.kpRange.min &&
    gains.kp <= envelope.kpRange.max &&
    gains.ki >= envelope.kiRange.min &&
    gains.ki <= envelope.kiRange.max &&
    gains.kd >= envelope.kdRange.min &&
    gains.kd <= envelope.kdRange.max
  );
}

export function clampToEnvelope(
  gains: PIDGains,
  envelope: GainEnvelope
): { gains: PIDGains; clamped: boolean } {
  const clampValue = (value: number, range: GainRange) =>
    Math.min(range.max, Math.max(range.min, value));
  const clamped: PIDGains = {
    kp: clampValue(gains.kp, envelope.kpRange),
    ki: clampValue(gains.ki, envelope.kiRange),
    kd: clampValue(gains.kd, envelope.kdRange),
  };
  return {
    gains: clamped,
    clamped: clamped.kp !== gains.kp || clamped.ki !== gains.ki || clamped.kd !== gains.kd,
  };
}

/**
 * Sizing a step at exactly `|from| * maxFraction` is not safe: applyGains
 * re-derives the ratio as `(next - from) / from`, and that round-trip can land
 * one ULP above the limit (e.g. from=1, fraction=0.1 gives next=1.1 and a
 * re-derived ratio of 0.10000000000000009). The controller would then refuse a
 * move this function deliberately sized to be acceptable. Aim marginally
 * inside the limit so the re-derived ratio never exceeds it.
 */
const RATE_LIMIT_MARGIN = 1 - 1e-9;

/**
 * Largest move from `current` toward `target` that stays within the
 * per-step rate-limit fraction on every gain. Guarantees the result
 * passes PIDController.applyGains for the same fraction.
 */
export function limitStepTowards(
  current: PIDGains,
  target: PIDGains,
  maxFraction: number
): { gains: PIDGains; complete: boolean } {
  const step = (from: number, to: number): number => {
    if (from === 0) {
      // applyGains admits |next| < 1 when the current gain is zero
      return Math.abs(to) < 1 ? to : Math.sign(to) * 0.999;
    }
    const maxDelta = Math.abs(from) * maxFraction;
    const delta = to - from;
    if (Math.abs(delta) <= maxDelta) return to;
    return from + Math.sign(delta) * maxDelta * RATE_LIMIT_MARGIN;
  };

  const gains: PIDGains = {
    kp: step(current.kp, target.kp),
    ki: step(current.ki, target.ki),
    kd: step(current.kd, target.kd),
  };
  return {
    gains,
    complete: gains.kp === target.kp && gains.ki === target.ki && gains.kd === target.kd,
  };
}
