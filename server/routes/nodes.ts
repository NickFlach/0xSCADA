/**
 * Node / validator routes (issue #456).
 *
 * Provides the MINIMAL read-only `/history` endpoint that backs the Slashing &
 * Liveness Visualizer. It returns per-validator attestation participation
 * history (hits / misses / late) over a requested window so the client-side
 * pure simulator can replay slashing rules against ACTUAL history.
 *
 * IMPORTANT — read-only / no mutations: this router never writes. Per the issue
 * it is a "read + projection" surface only.
 *
 * INTEGRATION (#wave:2a Validator Dashboard): the canonical attestation data
 * source is owned by the Validator Dashboard issue's data layer, which is not
 * present on `main` for this branch. Until that lands we synthesise a
 * DETERMINISTIC history from a seed so the endpoint is fully functional and
 * testable offline. The generator is isolated in `generateValidatorHistory` so
 * that swapping in the real data layer is a one-function change. This is the
 * single explicitly-deferred seam in this feature.
 */

import { Router } from "express";
import { z } from "zod";
import type {
  AttestationRecord,
  AttestationStatus,
  TimelineWindow,
  ValidatorHistory,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

const router = Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HistoryQuerySchema = z.object({
  /** Timeline window to return. */
  window: z.enum(["1h", "24h", "7d"]).default("24h"),
  /** Optional validator filter; when omitted, all known validators returned. */
  validatorId: z.string().min(1).optional(),
  /** Optional deterministic seed override (testing / reproducibility). */
  seed: z.coerce.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Deterministic synthetic data layer (INTEGRATION seam — see file header)
// ---------------------------------------------------------------------------

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

/** Slot cadence per window: how far apart attestation duties are spaced. */
const SLOT_STEP_MS: Record<TimelineWindow, number> = {
  "1h": 60 * 1000, // 1-minute slots over 1h -> 60 records
  "24h": 30 * 60 * 1000, // 30-minute slots over 24h -> 48 records
  "7d": 6 * 60 * 60 * 1000, // 6-hour slots over 7d -> 28 records
};

interface ValidatorProfile {
  validatorId: string;
  label: string;
  stake: number;
  /** Base miss probability for this validator. */
  missRate: number;
  /** Probability a non-miss is `late` rather than `hit`. */
  lateRate: number;
  /** Inject a deterministic consecutive-miss outage of this many slots. */
  outageLength: number;
}

const VALIDATOR_PROFILES: ValidatorProfile[] = [
  { validatorId: "val-aurora", label: "Aurora", stake: 32000, missRate: 0.04, lateRate: 0.03, outageLength: 0 },
  { validatorId: "val-borealis", label: "Borealis", stake: 32000, missRate: 0.08, lateRate: 0.05, outageLength: 5 },
  { validatorId: "val-cygnus", label: "Cygnus", stake: 64000, missRate: 0.02, lateRate: 0.02, outageLength: 0 },
  { validatorId: "val-draco", label: "Draco", stake: 16000, missRate: 0.15, lateRate: 0.04, outageLength: 8 },
];

/**
 * Deterministically generate one validator's attestation history over a window.
 *
 * Pure: depends only on its arguments (profile, window, anchor, seed). Records
 * are returned in ascending slot/time order. An optional consecutive-miss
 * "outage" is injected near the end so liveness-fault detection has something
 * to highlight in the demo data.
 */
export function generateValidatorHistory(
  profile: ValidatorProfile,
  window: TimelineWindow,
  anchorMs: number,
  seed: number,
): ValidatorHistory {
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
  };
}

const DEFAULT_SEED = 0x5cada;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** List known validators (id + label + stake), no history. */
router.get("/", (_req, res) => {
  res.json({
    validators: VALIDATOR_PROFILES.map((p) => ({
      validatorId: p.validatorId,
      label: p.label,
      stake: p.stake,
    })),
  });
});

/**
 * GET /api/nodes/history?window=24h[&validatorId=...][&seed=...]
 *
 * Returns deterministic per-validator attestation history for the requested
 * window. Read-only.
 */
router.get("/history", (req, res) => {
  const parsed = HistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid history query", details: parsed.error.flatten() });
  }
  const { window, validatorId, seed } = parsed.data;
  const anchorMs = Date.now();
  const effectiveSeed = seed ?? DEFAULT_SEED;

  const profiles = validatorId
    ? VALIDATOR_PROFILES.filter((p) => p.validatorId === validatorId)
    : VALIDATOR_PROFILES;

  if (validatorId && profiles.length === 0) {
    return res.status(404).json({ error: `Unknown validator: ${validatorId}` });
  }

  const histories = profiles.map((p) =>
    generateValidatorHistory(p, window, anchorMs, effectiveSeed),
  );

  return res.json({
    window,
    anchorMs,
    seed: effectiveSeed,
    validators: histories,
  });
});

export { router as nodesRoutes };
