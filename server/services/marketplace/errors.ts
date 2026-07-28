/**
 * Typed marketplace failures.
 *
 * Feature [13.6] of ADR-0013 — Issue #217.
 *
 * The HTTP layer must not guess a status code by pattern-matching an error
 * message. Every rejection the engine can produce carries a stable machine
 * code and the status the API surface should return for it.
 */

export type MarketplaceErrorCode =
  | 'invalid-manifest'
  | 'invalid-config'
  | 'ownership-conflict'
  | 'version-conflict'
  | 'not-found'
  | 'already-installed'
  | 'not-installed'
  | 'dependency-missing'
  | 'dependency-unsatisfied'
  | 'dependents-installed'
  | 'capability-not-declared'
  | 'capability-denied'
  | 'not-implemented'
  | 'invalid-state'
  | 'store-unavailable';

const STATUS_BY_CODE: Readonly<Record<MarketplaceErrorCode, number>> = Object.freeze({
  'invalid-manifest': 400,
  'invalid-config': 400,
  'ownership-conflict': 403,
  'version-conflict': 409,
  'not-found': 404,
  'already-installed': 409,
  'not-installed': 404,
  'dependency-missing': 409,
  'dependency-unsatisfied': 409,
  'dependents-installed': 409,
  'capability-not-declared': 400,
  'capability-denied': 403,
  'not-implemented': 409,
  'invalid-state': 409,
  'store-unavailable': 503,
});

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  readonly status: number;

  constructor(code: MarketplaceErrorCode, message: string) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isMarketplaceError(error: unknown): error is MarketplaceError {
  return error instanceof MarketplaceError;
}
