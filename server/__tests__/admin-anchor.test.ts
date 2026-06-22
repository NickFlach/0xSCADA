/**
 * Admin Anchor-Backend — confirm-token gate unit tests (#455)
 *
 * Verifies the pure gate logic that protects non-dry-run (committing) switches:
 * an operator must echo a backend-specific confirm token, and a token for one
 * backend must NOT authorise a switch to a different backend.
 */

import { describe, it, expect } from 'vitest';
import {
  expectedConfirmToken,
  isValidConfirmToken,
} from '../routes/admin-anchor';
import type { AnchorBackend } from '../bridge/anchor-router';

const BACKENDS: AnchorBackend[] = ['l2', 'node', 'both'];

describe('expectedConfirmToken', () => {
  it('is deterministic and backend-specific', () => {
    expect(expectedConfirmToken('l2')).toBe('confirm-switch-l2');
    expect(expectedConfirmToken('node')).toBe('confirm-switch-node');
    expect(expectedConfirmToken('both')).toBe('confirm-switch-both');
  });

  it('produces distinct tokens per backend', () => {
    const tokens = new Set(BACKENDS.map(expectedConfirmToken));
    expect(tokens.size).toBe(BACKENDS.length);
  });
});

describe('isValidConfirmToken', () => {
  it('accepts the matching token for each backend', () => {
    for (const b of BACKENDS) {
      expect(isValidConfirmToken(b, expectedConfirmToken(b))).toBe(true);
    }
  });

  it('rejects a missing or empty token (operator must opt in)', () => {
    expect(isValidConfirmToken('l2', undefined)).toBe(false);
    expect(isValidConfirmToken('l2', '')).toBe(false);
  });

  it('rejects a token issued for a DIFFERENT backend', () => {
    expect(isValidConfirmToken('l2', expectedConfirmToken('node'))).toBe(false);
    expect(isValidConfirmToken('both', expectedConfirmToken('l2'))).toBe(false);
    expect(isValidConfirmToken('node', expectedConfirmToken('both'))).toBe(false);
  });

  it('rejects an arbitrary garbage token', () => {
    expect(isValidConfirmToken('l2', 'yes')).toBe(false);
    expect(isValidConfirmToken('node', 'confirm')).toBe(false);
  });
});
