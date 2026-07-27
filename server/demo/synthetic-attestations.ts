/**
 * SYNTHETIC attestation-history generator — DEMO DATA ONLY (issue #456).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTHING IN THIS FILE MEASURES ANYTHING.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every record produced here comes out of a seeded PRNG over fixed, invented
 * validator profiles. It exists for exactly one purpose: to give the Slashing &
 * Liveness Visualizer and its what-if simulator a deterministic input so the
 * UI and the (real, unit-tested) penalty math can be exercised on a build that
 * has no validator fleet attached.
 *
 * It lives under `server/demo/` — not under `server/routes/` or a data layer —
 * so that an import of this module is self-evidently an import of fake data.
 * Its output is only ever reachable through the explicitly opt-in demo route in
 * `server/routes/nodes.ts`, and every value it returns is tagged
 * `synthetic: true`.
 *
 * Do not "promote" this module by wiring it into the live endpoint. If a real
 * attestation feed becomes available, implement it separately and leave this
 * where it is.
 */

import {
  SYNTHETIC_GENERATOR_ID,
  type AttestationRecord,
  type AttestationStatus,
  type SyntheticValidatorHistory,
  type TimelineWindow,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

/**
 * Tiny deterministic PRNG (mulberry32). Pure given its seed; used so the
 * synthesised history is stable across requests and unit-testable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slot cadence per window: how far apart the invented duties are spaced. */
const SLOT_STEP_MS: Record<TimelineWindow, number> = {
  "1h": 60 * 1000, // 1-minute slots over 1h -> 60 records
  "24h": 30 * 60 * 1000, // 30-minute slots over 24h -> 48 records
  "7d": 6 * 60 * 60 * 1000, // 6-hour slots over 7d -> 28 records
};

/** Invented validator. These identities do not correspond to any real node. */
export interface SyntheticValidatorProfile {
  validatorId: string;
  label: string;
  stake: number;
  /** Base miss probability for this fictional validator. */
  missRate: number;
  /** Probability a non-miss is `late` rather than `hit`. */
  lateRate: number;
  /** Inject a deterministic consecutive-miss outage of this many slots. */
  outageLength: number;
}

/**
 * Fixed cast of fictional validators. The `demo-` id prefix and `(demo)` label
 * suffix are deliberate: they survive copy/paste into a ticket or a screenshot,
 * where a JSON envelope field would not.
 */
export const SYNTHETIC_VALIDATOR_PROFILES: readonly SyntheticValidatorProfile[] = [
  { validatorId: "demo-aurora", label: "Aurora (demo)", stake: 32000, missRate: 0.04, lateRate: 0.03, outageLength: 0 },
  { validatorId: "demo-borealis", label: "Borealis (demo)", stake: 32000, missRate: 0.08, lateRate: 0.05, outageLength: 5 },
  { validatorId: "demo-cygnus", label: "Cygnus (demo)", stake: 64000, missRate: 0.02, lateRate: 0.02, outageLength: 0 },
  { validatorId: "demo-draco", label: "Draco (demo)", stake: 16000, missRate: 0.15, lateRate: 0.04, outageLength: 8 },
];

/** Default PRNG seed when the caller does not pin one. */
export const DEFAULT_SYNTHETIC_SEED = 0x5cada;

/**
 * Deterministically fabricate one validator's attestation history over a window.
 *
 * Pure: depends only on its arguments (profile, window, anchor, seed). Records
 * are returned in ascending slot/time order. An optional consecutive-miss
 * "outage" is injected near the end so liveness-fault detection has something to
 * highlight in the demo.
 *
 * The returned value is tagged `synthetic: true` and cannot be constructed
 * without that tag — see `SyntheticValidatorHistory`.
 */
export function generateValidatorHistory(
  profile: SyntheticValidatorProfile,
  window: TimelineWindow,
  anchorMs: number,
  seed: number,
): SyntheticValidatorHistory {
  const span = WINDOW_MS[window];
  const step = SLOT_STEP_MS[window];
  const count = Math.max(1, Math.floor(span / step));
  const start = anchorMs - span;

  // Seed combines the global seed with a per-validator salt for variety.
  let salt = 0;
  for (let i = 0; i < profile.validatorId.length; i += 1) {
    salt = (salt * 31 + profile.validatorId.charCodeAt(i)) | 0;
  }
  const rand = mulberry32((seed ^ salt) >>> 0);

  const outageStart =
    profile.outageLength > 0 ? Math.max(0, count - profile.outageLength - 1) : -1;
  const outageEnd = outageStart === -1 ? -1 : outageStart + profile.outageLength;

  const records: AttestationRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    let status: AttestationStatus;
    if (outageStart !== -1 && i >= outageStart && i < outageEnd) {
      status = "miss"; // deterministic injected outage
    } else {
      const r = rand();
      if (r < profile.missRate) status = "miss";
      else if (r < profile.missRate + profile.lateRate) status = "late";
      else status = "hit";
    }
    records.push({ slot: i, timestamp: start + i * step, status });
  }

  return {
    validatorId: profile.validatorId,
    label: profile.label,
    stake: profile.stake,
    records,
    synthetic: true,
    generator: SYNTHETIC_GENERATOR_ID,
  };
}

/** Fabricate the whole demo fleet, optionally narrowed to one validator id. */
export function generateFleetHistory(
  window: TimelineWindow,
  anchorMs: number,
  seed: number,
  validatorId?: string,
): SyntheticValidatorHistory[] {
  const profiles = validatorId
    ? SYNTHETIC_VALIDATOR_PROFILES.filter((p) => p.validatorId === validatorId)
    : SYNTHETIC_VALIDATOR_PROFILES;
  return profiles.map((p) => generateValidatorHistory(p, window, anchorMs, seed));
}
