/**
 * IEC 61850 GOOSE subscription configuration + validation.
 *
 * A `GooseSubscription` owns the per-control-block validation state machine:
 *   - matches an incoming frame to its config (gocbRef + appId + MAC)
 *   - validates dataset shape
 *   - tracks stNum/sqNum monotonicity (IEC 61850-8-1 §18)
 *   - enforces timeAllowedToLive (TTL) countdown / staleness
 *   - surfaces quality bits and simulated/test handling
 *   - produces GooseTagUpdate[] for accepted frames
 *
 * This module is PURE (no sockets) and fully unit-testable. The caller provides
 * the receive time so tests are deterministic.
 *
 * Issue: #465
 */

import { z } from "zod";
import { decodeQuality } from "./frame-parser.js";
import type { GooseDataValue, GooseFrame, GooseQuality, GooseTagUpdate } from "./types.js";
import type { GooseRejectReason } from "./metrics.js";

// ───────────────────────────────────────────────────────────────────────────
// Config (Zod-validated)
// ───────────────────────────────────────────────────────────────────────────

const MAC_REGEX = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

/** Expected type of one dataset member, used for shape validation. */
export const datasetMemberSchema = z.object({
  /** logical tag name to emit on acceptance (e.g. "IED1/GGIO1.Ind1.stVal") */
  tagName: z.string().min(1),
  /** expected GooseDataValue.type */
  type: z.enum([
    "boolean",
    "int",
    "uint",
    "float",
    "bitstring",
    "quality",
    "octetstring",
    "visiblestring",
    "utctime",
    "structure",
  ]),
  /**
   * If true and this member decodes to a Quality, its bits are evaluated and a
   * "bad"/"uncertain" quality is propagated onto the emitted tag update.
   */
  isQuality: z.boolean().optional(),
});

export type DatasetMember = z.infer<typeof datasetMemberSchema>;

export const gooseSubscriptionConfigSchema = z.object({
  /** GOOSE control block reference, e.g. "IED1LD0/LLN0$GO$gcb01" */
  gocbRef: z.string().min(1),
  /** APPID expected in the GOOSE link header (0x0000..0x3fff per the standard) */
  appId: z.number().int().min(0).max(0x3fff),
  /** expected destination multicast MAC (lowercase colon-hex). Optional. */
  expectedDestMac: z.string().regex(MAC_REGEX).optional(),
  /** expected source MAC of the publishing IED. Optional. */
  expectedSrcMac: z.string().regex(MAC_REGEX).optional(),
  /** expected dataset shape (ordered list of member types + tag names) */
  dataset: z.array(datasetMemberSchema).min(1),
  /**
   * If set, confRev must match this value; a change is rejected (re-config of
   * the publisher requires operator re-commissioning).
   */
  expectedConfRev: z.number().int().nonnegative().optional(),
  /**
   * How to treat frames with the simulation/test bit set:
   *   - "reject": drop (default for production)
   *   - "accept": surface as normal tag updates
   *   - "accept-flagged": surface but mark simulated=true (default)
   */
  simulationPolicy: z.enum(["reject", "accept", "accept-flagged"]).default("accept-flagged"),
});

export type GooseSubscriptionConfig = z.input<typeof gooseSubscriptionConfigSchema>;
export type GooseSubscriptionConfigParsed = z.output<typeof gooseSubscriptionConfigSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Validation result
// ───────────────────────────────────────────────────────────────────────────

export type GooseValidationResult =
  | {
      accepted: true;
      updates: GooseTagUpdate[];
      /** round-trip latency in microseconds (receive time minus publisher `t`). */
      roundTripUs: number;
      /** true if this frame indicated a state change (stNum incremented). */
      stateChanged: boolean;
      /** true if the previous message's TTL had elapsed before this frame arrived. */
      wasStale: boolean;
    }
  | {
      accepted: false;
      reason: GooseRejectReason;
      detail: string;
    };

// ───────────────────────────────────────────────────────────────────────────
// Subscription
// ───────────────────────────────────────────────────────────────────────────

interface SubscriptionState {
  lastStNum?: number;
  lastSqNum?: number;
  /** wall-clock ms by which the previous message expected a retransmission. */
  expiresAt?: number;
}

export class GooseSubscription {
  readonly config: GooseSubscriptionConfigParsed;
  private state: SubscriptionState = {};

  constructor(config: GooseSubscriptionConfig) {
    this.config = gooseSubscriptionConfigSchema.parse(config);
  }

  /** True if `frame` is addressed to this subscription's control block. */
  matches(frame: GooseFrame): boolean {
    return frame.pdu.gocbRef === this.config.gocbRef && frame.appId === this.config.appId;
  }

  /**
   * True if the previously-seen message's TTL has elapsed by `nowMs`.
   * Used by the subscriber to flag a stale/lost link even when no new frame
   * arrives (the TTL countdown).
   */
  isStale(nowMs: number): boolean {
    return this.state.expiresAt !== undefined && nowMs > this.state.expiresAt;
  }

  /** Reset monotonicity/TTL state (e.g. after a link drop is acknowledged). */
  reset(): void {
    this.state = {};
  }

  /**
   * Validate an incoming frame against this subscription and, if accepted,
   * produce tag updates. `receiveMs` is the local receive timestamp (ms).
   */
  validate(frame: GooseFrame, receiveMs: number): GooseValidationResult {
    const { pdu } = frame;

    // 1. MAC checks
    if (this.config.expectedDestMac && frame.destMac !== this.config.expectedDestMac.toLowerCase()) {
      return reject("mac_mismatch", `destMac ${frame.destMac} != ${this.config.expectedDestMac}`);
    }
    if (this.config.expectedSrcMac && frame.srcMac !== this.config.expectedSrcMac.toLowerCase()) {
      return reject("mac_mismatch", `srcMac ${frame.srcMac} != ${this.config.expectedSrcMac}`);
    }

    // 2. APPID (matches() already checks, but guard for direct callers)
    if (frame.appId !== this.config.appId) {
      return reject("app_id_mismatch", `appId 0x${frame.appId.toString(16)}`);
    }

    // 3. needs-commissioning
    if (pdu.ndsCom) {
      return reject("nds_com", "publisher signalled needsCommissioning");
    }

    // 4. confRev
    if (this.config.expectedConfRev !== undefined && pdu.confRev !== this.config.expectedConfRev) {
      return reject(
        "conf_rev_mismatch",
        `confRev ${pdu.confRev} != expected ${this.config.expectedConfRev}`,
      );
    }

    // 5. simulation/test bit
    if (pdu.simulation && this.config.simulationPolicy === "reject") {
      return reject("nds_com", "simulation bit set and policy=reject");
    }

    // 6. dataset shape
    const shapeError = this.checkDatasetShape(pdu.allData);
    if (shapeError) {
      return reject("dataset_shape", shapeError);
    }

    // 7. TTL / staleness — if the previous message's TTL elapsed before this
    //    frame arrived, the link was stale. We still accept the new value but
    //    report it so the caller can record the gap.
    const wasStale = this.isStale(receiveMs);

    // 8. stNum / sqNum monotonicity (IEC 61850-8-1 §18.1).
    //    stNum increments on every dataset change and must not regress.
    //    Within the same stNum, sqNum increments per retransmission.
    const { lastStNum, lastSqNum } = this.state;
    let stateChanged = false;

    if (lastStNum !== undefined) {
      if (pdu.stNum < lastStNum) {
        // Allow the documented 32-bit wraparound back to 1 (or 0) per the standard.
        if (!(pdu.stNum <= 1 && lastStNum >= 0xfffffff0)) {
          return reject("stnum_regression", `stNum ${pdu.stNum} < last ${lastStNum}`);
        }
      }
      if (pdu.stNum === lastStNum) {
        // same state — sqNum must be strictly increasing (allow wrap to 0).
        if (lastSqNum !== undefined && pdu.sqNum <= lastSqNum) {
          if (!(pdu.sqNum === 0 && lastSqNum >= 0xfffffff0)) {
            return reject(
              "sqnum_regression",
              `sqNum ${pdu.sqNum} <= last ${lastSqNum} for stNum ${pdu.stNum}`,
            );
          }
        }
      } else {
        stateChanged = true;
      }
    } else {
      stateChanged = true; // first frame seen
    }

    // Accept: advance state.
    this.state.lastStNum = pdu.stNum;
    this.state.lastSqNum = pdu.sqNum;
    this.state.expiresAt = receiveMs + pdu.timeAllowedToLive;

    const updates = this.buildTagUpdates(frame, receiveMs);
    // round trip: receive time minus publisher event time. Guard against clock
    // skew producing negatives (report 0 in that case).
    const roundTripUs = Math.max(0, (receiveMs - pdu.t) * 1000);

    return { accepted: true, updates, roundTripUs, stateChanged, wasStale };
  }

  /** Validate the decoded dataset against the configured expected shape. */
  private checkDatasetShape(allData: GooseDataValue[]): string | null {
    const expected = this.config.dataset;
    if (allData.length !== expected.length) {
      return `dataset entry count ${allData.length} != expected ${expected.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const actual = allData[i];
      const want = expected[i];
      // Quality may decode as either "quality" or generic "bitstring".
      if (want.type === "quality") {
        if (actual.type !== "quality" && actual.type !== "bitstring") {
          return `member ${i} (${want.tagName}) expected quality, got ${actual.type}`;
        }
        continue;
      }
      if (actual.type !== want.type) {
        return `member ${i} (${want.tagName}) expected ${want.type}, got ${actual.type}`;
      }
    }
    return null;
  }

  /** Map accepted dataset members onto GooseTagUpdate records. */
  private buildTagUpdates(frame: GooseFrame, receiveMs: number): GooseTagUpdate[] {
    const { pdu } = frame;
    const updates: GooseTagUpdate[] = [];
    const timestamp = new Date(receiveMs).toISOString();

    for (let i = 0; i < this.config.dataset.length; i++) {
      const member = this.config.dataset[i];
      const data = pdu.allData[i];
      const { value, quality } = projectValue(data, member);
      updates.push({
        tagName: member.tagName,
        value,
        quality,
        timestamp,
        origin: "goose",
        gocbRef: pdu.gocbRef,
        stNum: pdu.stNum,
        simulated: pdu.simulation,
      });
    }
    return updates;
  }
}

/**
 * Project a decoded dataset member onto a scalar tag value + quality.
 * Quality members map onto the tag's quality discriminator rather than a value.
 */
function projectValue(
  data: GooseDataValue,
  member: DatasetMember,
): { value: number | string | boolean; quality: "good" | "bad" | "uncertain" } {
  let quality: "good" | "bad" | "uncertain" = "good";

  // If this member is a Quality, derive the quality discriminator.
  const q = extractQuality(data);
  if (q) {
    quality = qualityToTagQuality(q);
    // Surface a compact string representation of validity as the value.
    return { value: q.validity, quality };
  }

  switch (data.type) {
    case "boolean":
      return { value: data.value, quality };
    case "int":
    case "uint":
    case "float":
      return { value: data.value, quality };
    case "visiblestring":
      return { value: data.value, quality };
    case "bitstring":
      return { value: bitsToString(data.value.bits), quality };
    case "octetstring":
      return { value: data.value.toString("hex"), quality };
    case "utctime":
      return { value: data.value.seconds * 1000, quality };
    case "structure":
      return { value: `struct(${data.value.length})`, quality };
    case "quality":
      // Handled above, but keep exhaustive.
      return { value: data.value.validity, quality: qualityToTagQuality(data.value) };
    case "unknown":
    default:
      return { value: `unknown(0x${("tag" in data ? data.tag : 0).toString(16)})`, quality: "uncertain" };
  }
}

/** Extract a GooseQuality if the member is (or decodes to) a quality. */
function extractQuality(data: GooseDataValue): GooseQuality | null {
  if (data.type === "quality") return data.value;
  return null;
}

/** Map IEC 61850 Quality onto the coarse tag-stream quality enum. */
export function qualityToTagQuality(q: GooseQuality): "good" | "bad" | "uncertain" {
  if (q.validity === "invalid" || q.failure || q.badReference) return "bad";
  if (
    q.validity === "questionable" ||
    q.validity === "reserved" ||
    q.oldData ||
    q.outOfRange ||
    q.overflow ||
    q.inconsistent ||
    q.inaccurate ||
    q.oscillatory ||
    q.source === "substituted" ||
    q.operatorBlocked ||
    q.test
  ) {
    return "uncertain";
  }
  return "good";
}

function bitsToString(bits: boolean[]): string {
  return bits.map((b) => (b ? "1" : "0")).join("");
}

/** Re-export for callers that have a raw bitstring buffer. */
export { decodeQuality };

function reject(reason: GooseRejectReason, detail: string): GooseValidationResult {
  return { accepted: false, reason, detail };
}
