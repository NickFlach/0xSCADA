/**
 * Tests for the deterministic validator-history generator backing the
 * /api/nodes/history endpoint (issue #456).
 *
 * These exercise the PURE `generateValidatorHistory` function (no Express,
 * no network) and confirm:
 *  - determinism: identical (profile, window, anchor, seed) -> identical output,
 *  - the injected consecutive-miss "outage" is detectable as a liveness fault,
 *  - the generated history replays cleanly through the pure client simulator.
 */

import { describe, it, expect } from "vitest";
import { generateValidatorHistory } from "../routes/nodes";
import {
  detectLivenessFaults,
  simulateRule,
} from "../../client/src/lib/slashing-simulator";
import type { SlashingRule, TimelineWindow } from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

const ANCHOR = 1_700_000_000_000;

const profileNoOutage = {
  validatorId: "val-test-clean",
  label: "Clean",
  stake: 32000,
  missRate: 0.05,
  lateRate: 0.03,
  outageLength: 0,
};

const profileWithOutage = {
  validatorId: "val-test-outage",
  label: "Outage",
  stake: 16000,
  missRate: 0.05,
  lateRate: 0.03,
  outageLength: 6,
};

describe("generateValidatorHistory", () => {
  it("is deterministic for a fixed seed", () => {
    const a = generateValidatorHistory(profileNoOutage, "24h", ANCHOR, 1234);
    const b = generateValidatorHistory(profileNoOutage, "24h", ANCHOR, 1234);
    expect(a).toEqual(b);
  });

  it("changes output when the seed changes", () => {
    const a = generateValidatorHistory(profileNoOutage, "24h", ANCHOR, 1);
    const b = generateValidatorHistory(profileNoOutage, "24h", ANCHOR, 2);
    const statusesA = a.records.map((r) => r.status).join("");
    const statusesB = b.records.map((r) => r.status).join("");
    expect(statusesA).not.toBe(statusesB);
  });

  it("produces ascending, in-window, correctly-spaced records", () => {
    const win: TimelineWindow = "24h";
    const h = generateValidatorHistory(profileNoOutage, win, ANCHOR, 7);
    // 24h / 30min = 48 slots
    expect(h.records).toHaveLength(48);
    expect(h.records[0].slot).toBe(0);
    expect(h.records[h.records.length - 1].slot).toBe(47);
    // ascending timestamps, all within (anchor - window, anchor]
    const start = ANCHOR - WINDOW_MS[win];
    for (let i = 0; i < h.records.length; i += 1) {
      expect(h.records[i].timestamp).toBeGreaterThanOrEqual(start);
      expect(h.records[i].timestamp).toBeLessThanOrEqual(ANCHOR);
      if (i > 0) expect(h.records[i].timestamp).toBeGreaterThan(h.records[i - 1].timestamp);
    }
  });

  it("injects a detectable consecutive-miss outage", () => {
    const h = generateValidatorHistory(profileWithOutage, "24h", ANCHOR, 99);
    const runs = detectLivenessFaults(h.records, profileWithOutage.outageLength);
    // At least one run of length >= the injected outage length.
    expect(runs.some((r) => r.length >= profileWithOutage.outageLength)).toBe(true);
  });

  it("replays through the pure simulator and penalises the outage", () => {
    const h = generateValidatorHistory(profileWithOutage, "24h", ANCHOR, 99);
    // Penalise every miss beyond the 2nd within the full window.
    const rule: SlashingRule = {
      name: "test rule",
      missThreshold: 2,
      windowMs: WINDOW_MS["24h"],
      penaltyPctPerMiss: 1,
    };
    const result = simulateRule(h, rule);
    // The 6-slot outage alone guarantees > 2 misses in-window -> some penalty.
    expect(result.totalPenaltyPct).toBeGreaterThan(0);
    // No mutation of the generated history.
    expect(result.evaluated).toHaveLength(h.records.length);
  });
});
