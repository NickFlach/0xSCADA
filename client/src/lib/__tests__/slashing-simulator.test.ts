/**
 * Tests for the pure-functional slashing/liveness simulator (issue #456).
 *
 * The centrepiece is the KEY TEST required by the issue's Verification section:
 * replay a KNOWN 24h attestation history through a specific rule R and assert
 * the output matches a HAND-COMPUTED expectation.
 *
 * All fixtures are deterministic and use a fixed epoch anchor so there is no
 * dependence on the wall clock.
 */

import { describe, it, expect } from "vitest";
import {
  bucketTimeline,
  detectLivenessFaults,
  filterToWindow,
  parseRulePhrase,
  simulateAll,
  simulateRule,
  sortRecords,
  summarize,
} from "../slashing-simulator";
import type {
  AttestationRecord,
  AttestationStatus,
  SlashingRule,
  ValidatorHistory,
} from "@shared/types/slashing";
import { WINDOW_MS } from "@shared/types/slashing";

// A fixed epoch so the fixtures are wall-clock independent.
const EPOCH = 1_700_000_000_000; // arbitrary fixed ms
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Build records from a compact status string, one slot per `stepMs`. */
function buildRecords(
  statuses: AttestationStatus[],
  stepMs: number,
  startTs = EPOCH,
  startSlot = 0,
): AttestationRecord[] {
  return statuses.map((status, i) => ({
    slot: startSlot + i,
    timestamp: startTs + i * stepMs,
    status,
  }));
}

function makeHistory(
  records: AttestationRecord[],
  stake = 1000,
  validatorId = "val-1",
): ValidatorHistory {
  return { validatorId, label: "Validator 1", stake, records };
}

describe("sortRecords", () => {
  it("sorts ascending by slot without mutating the input", () => {
    const input: AttestationRecord[] = [
      { slot: 2, timestamp: EPOCH + 2, status: "hit" },
      { slot: 0, timestamp: EPOCH, status: "miss" },
      { slot: 1, timestamp: EPOCH + 1, status: "late" },
    ];
    const snapshot = JSON.stringify(input);
    const sorted = sortRecords(input);
    expect(sorted.map((r) => r.slot)).toEqual([0, 1, 2]);
    // input untouched (purity)
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("summarize", () => {
  it("counts statuses and computes participation rate", () => {
    const recs = buildRecords(["hit", "hit", "miss", "late", "miss"], MIN);
    const s = summarize(recs);
    expect(s).toEqual({
      total: 5,
      hits: 2,
      misses: 2,
      late: 1,
      // (hits + late) / total = 3/5
      participationRate: 0.6,
    });
  });

  it("returns 0 participation for empty input", () => {
    expect(summarize([])).toEqual({
      total: 0,
      hits: 0,
      misses: 0,
      late: 0,
      participationRate: 0,
    });
  });
});

describe("filterToWindow", () => {
  it("keeps only records within the window anchored at the latest record", () => {
    // 30 records spaced 1h apart -> spans 29h. 24h window keeps the last 25.
    const recs = buildRecords(Array(30).fill("hit"), HOUR);
    const filtered = filterToWindow(recs, "24h");
    // anchor is last ts; cutoff = anchor - 24h. Records at hours [5..29] inclusive = 25.
    expect(filtered.length).toBe(25);
    expect(filtered[0].slot).toBe(5);
    expect(filtered[filtered.length - 1].slot).toBe(29);
  });

  it("respects an explicit `now` anchor", () => {
    const recs = buildRecords(Array(10).fill("hit"), HOUR);
    // now anchored one hour after the last record -> cutoff shifts right by 1h.
    const filtered = filterToWindow(recs, "1h", EPOCH + 9 * HOUR + 30 * MIN);
    // window [now-1h, now] = [8.5h, 9.5h]; record at 9h qualifies, 8h does not.
    expect(filtered.map((r) => r.slot)).toEqual([9]);
  });

  it("returns empty for empty input", () => {
    expect(filterToWindow([], "1h")).toEqual([]);
  });
});

describe("detectLivenessFaults", () => {
  it("flags consecutive-miss runs at or above the threshold", () => {
    // hit, miss x4, hit, miss x2, hit
    const recs = buildRecords(
      ["hit", "miss", "miss", "miss", "miss", "hit", "miss", "miss", "hit"],
      MIN,
    );
    const runs = detectLivenessFaults(recs, 3);
    // Only the run of 4 qualifies (run of 2 < threshold 3).
    expect(runs).toHaveLength(1);
    expect(runs[0].length).toBe(4);
    expect(runs[0].startSlot).toBe(1);
    expect(runs[0].endSlot).toBe(4);
    expect(runs[0].startIndex).toBe(1);
    expect(runs[0].endIndex).toBe(4);
  });

  it("treats `late` as breaking a miss run", () => {
    const recs = buildRecords(["miss", "miss", "late", "miss", "miss"], MIN);
    const runs = detectLivenessFaults(recs, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].length).toBe(2);
    expect(runs[1].length).toBe(2);
  });

  it("flags a single trailing run that reaches end of history", () => {
    const recs = buildRecords(["hit", "hit", "miss", "miss", "miss"], MIN);
    const runs = detectLivenessFaults(recs, 3);
    expect(runs).toHaveLength(1);
    expect(runs[0].endSlot).toBe(4);
  });

  it("returns no runs when threshold is never met", () => {
    const recs = buildRecords(["miss", "hit", "miss", "hit"], MIN);
    expect(detectLivenessFaults(recs, 2)).toEqual([]);
  });
});

describe("parseRulePhrase", () => {
  it("parses the canonical phrasing", () => {
    const rule = parseRulePhrase("slash 1% per miss after 10 in 1h");
    expect(rule).not.toBeNull();
    expect(rule!.penaltyPctPerMiss).toBe(1);
    expect(rule!.missThreshold).toBe(10);
    expect(rule!.windowMs).toBe(WINDOW_MS["1h"]);
  });

  it("parses decimals, the word 'percent', and 'misses'", () => {
    const rule = parseRulePhrase("slash 0.5 percent per miss after 5 misses in 24h");
    expect(rule).not.toBeNull();
    expect(rule!.penaltyPctPerMiss).toBe(0.5);
    expect(rule!.missThreshold).toBe(5);
    expect(rule!.windowMs).toBe(WINDOW_MS["24h"]);
  });

  it("returns null for unparseable input", () => {
    expect(parseRulePhrase("please slash everyone")).toBeNull();
    expect(parseRulePhrase("")).toBeNull();
    expect(parseRulePhrase("slash 1% per miss after 10 in 3y")).toBeNull();
  });
});

describe("bucketTimeline", () => {
  it("buckets records into the requested number of even buckets", () => {
    // 24 records, one per hour, 24h window, 24 buckets -> one record per bucket.
    const recs = buildRecords(Array(24).fill("hit"), HOUR);
    const buckets = bucketTimeline(recs, "24h", 24);
    expect(buckets).toHaveLength(24);
    const totalCounted = buckets.reduce((acc, b) => acc + b.total, 0);
    // anchor = last ts (hour 23); window start = hour -1. All 24 fall in range.
    expect(totalCounted).toBe(24);
  });

  it("aggregates hit/miss/late counts per bucket", () => {
    const recs = buildRecords(["hit", "miss", "late", "hit"], 6 * HOUR);
    const buckets = bucketTimeline(recs, "24h", 4);
    const total = buckets.reduce(
      (acc, b) => {
        acc.hits += b.hits;
        acc.misses += b.misses;
        acc.late += b.late;
        return acc;
      },
      { hits: 0, misses: 0, late: 0 },
    );
    expect(total).toEqual({ hits: 2, misses: 1, late: 1 });
  });
});

describe("simulateRule — purity", () => {
  it("does not mutate the history or rule arguments", () => {
    const recs = buildRecords(["miss", "miss", "miss"], HOUR);
    const history = makeHistory(recs);
    const rule: SlashingRule = {
      name: "r",
      missThreshold: 1,
      windowMs: 24 * HOUR,
      penaltyPctPerMiss: 1,
    };
    const histSnap = JSON.stringify(history);
    const ruleSnap = JSON.stringify(rule);
    simulateRule(history, rule);
    expect(JSON.stringify(history)).toBe(histSnap);
    expect(JSON.stringify(rule)).toBe(ruleSnap);
  });

  it("produces no penalties when there are no misses", () => {
    const history = makeHistory(buildRecords(Array(10).fill("hit"), HOUR));
    const rule: SlashingRule = {
      name: "r",
      missThreshold: 0,
      windowMs: 24 * HOUR,
      penaltyPctPerMiss: 5,
    };
    const result = simulateRule(history, rule);
    expect(result.penalties).toEqual([]);
    expect(result.totalPenaltyPct).toBe(0);
    expect(result.totalPenaltyAmount).toBe(0);
  });
});

// =============================================================================
// KEY TEST (issue Verification): replay a KNOWN 24h history through rule R and
// assert the output matches a HAND-COMPUTED expectation.
// =============================================================================
describe("KEY TEST: 24h replay with hand-computed expectation", () => {
  // FIXTURE: 24 hourly slots over exactly 24h (hours 0..23 from EPOCH).
  // Stake = 10_000 units. Misses placed at the following hours:
  //   hours: 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23
  //   stat:  H  M  H  M  M  H  M  H  M  H  M  H  M  H  M  H  H  H  H  H  M  M  M  M
  // Misses occur at hours: 1,3,4,6,8,10,12,14, then 20,21,22,23.
  // Total misses = 12.
  const statuses: AttestationStatus[] = [
    "hit", // 0
    "miss", // 1
    "hit", // 2
    "miss", // 3
    "miss", // 4
    "hit", // 5
    "miss", // 6
    "hit", // 7
    "miss", // 8
    "hit", // 9
    "miss", // 10
    "hit", // 11
    "miss", // 12
    "hit", // 13
    "miss", // 14
    "hit", // 15
    "hit", // 16
    "hit", // 17
    "hit", // 18
    "hit", // 19
    "miss", // 20
    "miss", // 21
    "miss", // 22
    "miss", // 23
  ];
  const STAKE = 10_000;
  const records = buildRecords(statuses, HOUR);
  const history = makeHistory(records, STAKE, "val-key");

  // RULE R: "slash 2% per miss after 3 misses in 24h".
  // windowMs = 24h, missThreshold = 3, penaltyPctPerMiss = 2.
  const ruleR: SlashingRule = {
    name: "slash 2% per miss after 3 in 24h",
    missThreshold: 3,
    windowMs: 24 * HOUR,
    penaltyPctPerMiss: 2,
  };

  // HAND COMPUTATION (sliding 24h window; since the whole fixture spans <24h,
  // every miss's window includes ALL prior misses):
  //   Miss #  hour  cumulative-misses-in-window  penalised?
  //     1      1            1                      no  (<=3)
  //     2      3            2                      no  (<=3)
  //     3      4            3                      no  (<=3 — threshold is 3)
  //     4      6            4                      YES (4 > 3) -> +2%
  //     5      8            5                      YES         -> +2%
  //     6     10            6                      YES         -> +2%
  //     7     12            7                      YES         -> +2%
  //     8     14            8                      YES         -> +2%
  //     9     20            9                      YES         -> +2%
  //    10     21           10                      YES         -> +2%
  //    11     22           11                      YES         -> +2%
  //    12     23           12                      YES         -> +2%
  //   => 9 penalised misses, each 2% -> total 18% of 10_000 = 1_800 units.

  it("evaluates the full history (no window) with the expected penalties", () => {
    const result = simulateRule(history, ruleR);

    // 9 penalty events, at hours 6,8,10,12,14,20,21,22,23 -> slots equal hours.
    expect(result.penalties.map((p) => p.slot)).toEqual([6, 8, 10, 12, 14, 20, 21, 22, 23]);

    // Each penalised miss is 2% of stake.
    for (const p of result.penalties) {
      expect(p.penaltyPct).toBe(2);
      expect(p.penaltyAmount).toBeCloseTo(200, 6); // 2% of 10_000
    }

    // The in-window miss counts increase 4..12 across the penalised misses.
    expect(result.penalties.map((p) => p.missesInWindow)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);

    // Totals.
    expect(result.totalPenaltyPct).toBeCloseTo(18, 6);
    expect(result.totalPenaltyAmount).toBeCloseTo(1_800, 6);

    // Participation summary: 12 misses, 12 hits, 0 late.
    expect(result.summary.total).toBe(24);
    expect(result.summary.misses).toBe(12);
    expect(result.summary.hits).toBe(12);
    expect(result.summary.participationRate).toBeCloseTo(12 / 24, 6);

    // Liveness faults at default threshold 3: only the trailing run hours 20-23
    // is a consecutive-miss run of length >= 3. (hours 3,4 is a run of 2.)
    expect(result.livenessFaults).toHaveLength(1);
    expect(result.livenessFaults[0].length).toBe(4);
    expect(result.livenessFaults[0].startSlot).toBe(20);
    expect(result.livenessFaults[0].endSlot).toBe(23);
  });

  it("honours maxPenaltyPct as a cap", () => {
    // Cap at 10% -> only the first 5 penalised misses (5 * 2% = 10%) apply.
    const capped: SlashingRule = { ...ruleR, maxPenaltyPct: 10 };
    const result = simulateRule(history, capped);
    expect(result.totalPenaltyPct).toBeCloseTo(10, 6);
    expect(result.totalPenaltyAmount).toBeCloseTo(1_000, 6);
    // 9 threshold-crossing events still reported; first 5 carry penalty, rest 0.
    const nonZero = result.penalties.filter((p) => p.penaltyPct > 0);
    expect(nonZero).toHaveLength(5);
    const zero = result.penalties.filter((p) => p.penaltyPct === 0);
    expect(zero).toHaveLength(4);
  });

  it("changes results under a tight 1h sliding window", () => {
    // With a 1h window, each miss only ever sees ITSELF in-window (misses are
    // >= 1h apart in this fixture, and consecutive trailing misses are exactly
    // 1h apart so window [t-1h, t] includes the immediately-prior miss too).
    // Trailing block hours 20,21,22,23 are 1h apart:
    //   hour 20: window [19h,20h] -> misses {20} = 1
    //   hour 21: window [20h,21h] -> misses {20,21} = 2
    //   hour 22: window [21h,22h] -> misses {21,22} = 2
    //   hour 23: window [22h,23h] -> misses {22,23} = 2
    // Earlier isolated misses (1,3,4,6,8,10,12,14): only 3&4 are 1h apart.
    //   hour 4: window [3h,4h] -> misses {3,4} = 2
    // With threshold 3, NO miss ever reaches >3 in a 1h window -> no penalties.
    const tight: SlashingRule = { ...ruleR, windowMs: 1 * HOUR };
    const result = simulateRule(history, tight);
    expect(result.penalties).toEqual([]);
    expect(result.totalPenaltyPct).toBe(0);
  });

  it("restricting the UI window to 24h yields the same evaluated set here", () => {
    // The fixture spans exactly 23h, so a 24h UI window keeps everything.
    const result = simulateRule(history, ruleR, "24h");
    expect(result.evaluated).toHaveLength(24);
    expect(result.totalPenaltyPct).toBeCloseTo(18, 6);
  });
});

describe("simulateAll", () => {
  it("simulates every validator and keys results by id", () => {
    const a = makeHistory(buildRecords(["miss", "miss"], HOUR), 100, "a");
    const b = makeHistory(buildRecords(["hit", "hit"], HOUR), 100, "b");
    const rule: SlashingRule = {
      name: "r",
      missThreshold: 0,
      windowMs: 24 * HOUR,
      penaltyPctPerMiss: 5,
    };
    const all = simulateAll([a, b], rule);
    expect(Object.keys(all).sort()).toEqual(["a", "b"]);
    // a: 2 misses, both penalised (threshold 0) -> 10%
    expect(all.a.totalPenaltyPct).toBeCloseTo(10, 6);
    // b: no misses
    expect(all.b.totalPenaltyPct).toBe(0);
  });
});
