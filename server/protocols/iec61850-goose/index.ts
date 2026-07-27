/**
 * IEC 61850 GOOSE subscriber service.
 *
 * Consumes raw EtherType-0x88B8 frames from an injected
 * {@link GooseCaptureBackend}, decodes each frame, validates it against the
 * registered subscriptions (timing, monotonicity, quality) and surfaces
 * accepted dataset values as tag updates with `origin="goose"`.
 *
 * WHAT THIS CAN AND CANNOT DO
 * ---------------------------
 * GOOSE is Layer-2 multicast. Node cannot receive those frames without a
 * native addon, and this repository ships none. Therefore:
 *
 *   - LIVE capture is NOT provided. The default {@link NullGooseCaptureBackend}
 *     delivers nothing, `start()` resolves to "unavailable", and it says why in
 *     a log line. It does not throw and it never reports itself as running.
 *   - OFFLINE replay IS provided and fully works: point
 *     {@link GoosePcapReplayBackend} at a captured `.pcap` and the decoder,
 *     validator, tag-update emission and metrics all run on real frames.
 *   - A live backend is an injection point: implement
 *     {@link GooseCaptureBackend} against a native binding and pass it as
 *     `options.backend`. Nothing else in this module needs to change.
 *
 * Issue: #465
 */

import { logError, logInfo, logWarn } from "../../logger.js";
import { tagStreamServer } from "../../websocket/tag-stream.js";
import { parseGooseFrame, GooseParseError } from "./frame-parser.js";
import { GooseSubscription, type GooseSubscriptionConfig } from "./subscription.js";
import type { GooseTagUpdate } from "./types.js";
import {
  NullGooseCaptureBackend,
  type GooseCaptureAvailability,
  type GooseCaptureBackend,
} from "./capture-backend.js";
import { GoosePcapReplayBackend } from "./pcap-backend.js";
import { loadGooseServiceConfig, type GooseServiceConfig } from "./config.js";
import {
  gooseFramesReceivedTotal,
  gooseFramesRejectedTotal,
  gooseRoundTripUs,
  gooseLastStNum,
  gooseSubscriptionsActive,
} from "./metrics.js";

/** Callback invoked for every accepted GOOSE tag update. */
export type GooseTagUpdateSink = (update: GooseTagUpdate) => void;

export interface GooseSubscriberOptions {
  /**
   * Frame source. Defaults to {@link NullGooseCaptureBackend}, i.e. no capture.
   * Inject {@link GoosePcapReplayBackend} for offline replay, or your own
   * implementation for live capture.
   */
  backend?: GooseCaptureBackend;
  /** Initial subscriptions. More can be added later via {@link subscribe}. */
  subscriptions?: GooseSubscriptionConfig[];
  /**
   * Sink for accepted tag updates. Defaults to a logging sink;
   * {@link startGooseSubscriber} wires it to the websocket tag stream.
   */
  onTagUpdate?: GooseTagUpdateSink;
  /** Override clock (testability). Returns ms since epoch. */
  now?: () => number;
  /** TTL watchdog interval in ms. Default 100. */
  ttlSweepIntervalMs?: number;
}

/**
 * - "stopped"     — constructed, or stopped after running.
 * - "running"     — a backend is open and frames are being consumed.
 * - "unavailable" — the backend reported it cannot capture here (default case).
 * - "error"       — the backend was available but failed to open.
 */
export type GooseSubscriberState = "unavailable" | "stopped" | "running" | "error";

export class GooseSubscriber {
  private readonly backend: GooseCaptureBackend;
  private readonly subscriptions: GooseSubscription[] = [];
  private readonly onTagUpdate: GooseTagUpdateSink;
  private readonly now: () => number;
  private readonly ttlSweepIntervalMs: number;
  private state: GooseSubscriberState = "stopped";
  /** TTL staleness watchdog handle. */
  private ttlTimer?: ReturnType<typeof setInterval>;

  constructor(options: GooseSubscriberOptions = {}) {
    this.backend = options.backend ?? new NullGooseCaptureBackend();
    this.now = options.now ?? (() => Date.now());
    this.ttlSweepIntervalMs = options.ttlSweepIntervalMs ?? 100;
    this.onTagUpdate =
      options.onTagUpdate ??
      ((u) => logInfo(`[goose] tag update ${u.tagName}=${u.value} (q=${u.quality}, st=${u.stNum})`));

    for (const sub of options.subscriptions ?? []) {
      this.subscribe(sub);
    }
  }

  getState(): GooseSubscriberState {
    return this.state;
  }

  /** The injected backend, for diagnostics. */
  getBackend(): GooseCaptureBackend {
    return this.backend;
  }

  /** Whether the injected backend can capture here, and why not if it cannot. */
  getBackendAvailability(): GooseCaptureAvailability {
    return this.backend.availability();
  }

  /** Register a new subscription. Returns the created subscription. */
  subscribe(config: GooseSubscriptionConfig): GooseSubscription {
    const sub = new GooseSubscription(config);
    this.subscriptions.push(sub);
    gooseSubscriptionsActive.set(this.subscriptions.length);
    return sub;
  }

  /**
   * Open the capture backend and begin consuming frames.
   *
   * Resolves to "unavailable" (never throws) when the backend cannot capture on
   * this host — that is the normal outcome with the default null backend.
   */
  async start(): Promise<GooseSubscriberState> {
    if (this.state === "running") {
      // Opening the backend a second time would either throw (pcap replay) or
      // install a second frame stream, double-counting every metric.
      logWarn(`[goose] subscriber is already running on backend "${this.backend.name}"`);
      return this.state;
    }
    const availability = this.backend.availability();
    if (!availability.available) {
      this.state = "unavailable";
      logWarn(
        `[goose] capture backend "${this.backend.name}" cannot receive frames: ` +
          `${availability.reason}. Decode/validation stay available via handleFrame(); ` +
          "replay a capture with GOOSE_PCAP_FILE or inject a live GooseCaptureBackend.",
      );
      return this.state;
    }

    try {
      await this.backend.open((frame, receivedAtMs) => {
        this.handleFrame(frame, receivedAtMs);
      });
      this.startTtlWatchdog();
      this.state = "running";
      logInfo(
        `[goose] subscriber running on backend "${this.backend.name}" ` +
          `(${availability.reason}); ${this.subscriptions.length} subscription(s)`,
      );
    } catch (err) {
      this.state = "error";
      logError(err, `[goose] capture backend "${this.backend.name}" failed to open`);
    }
    return this.state;
  }

  /** Close the backend and stop the TTL watchdog. */
  async stop(): Promise<void> {
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = undefined;
    }
    try {
      await this.backend.close();
    } catch (err) {
      logError(err, `[goose] capture backend "${this.backend.name}" failed to close`);
    }
    this.state = "stopped";
  }

  /**
   * "Now" in the backend's receive-timestamp time base. For a replayed capture
   * this is capture time, so TTL expiry is judged exactly as it would have been
   * judged live rather than against today's wall clock.
   */
  private captureNow(): number {
    return this.backend.clockNowMs?.() ?? this.now();
  }

  /**
   * Flag every subscription whose previous message's timeAllowedToLive has
   * elapsed: the publisher missed its retransmission window, so the last value
   * can no longer be trusted. Public so the countdown can be driven
   * deterministically in tests instead of only by the interval timer.
   *
   * @returns the subscriptions that were found stale and reset.
   */
  sweepStaleSubscriptions(nowMs: number = this.captureNow()): GooseSubscription[] {
    const stale: GooseSubscription[] = [];
    for (const sub of this.subscriptions) {
      if (sub.isStale(nowMs)) {
        gooseFramesRejectedTotal.inc({ reason: "ttl_expired" });
        logWarn(`[goose] subscription ${sub.config.gocbRef} link stale (TTL elapsed)`);
        sub.reset();
        stale.push(sub);
      }
    }
    return stale;
  }

  /** Periodically flag subscriptions whose previous TTL elapsed (lost link). */
  private startTtlWatchdog(): void {
    if (this.ttlTimer) return;
    const timer = setInterval(() => {
      this.sweepStaleSubscriptions();
    }, this.ttlSweepIntervalMs);
    // The watchdog is background bookkeeping: it must not hold the process open.
    timer.unref?.();
    this.ttlTimer = timer;
  }

  /**
   * Decode + validate a single raw GOOSE frame and surface tag updates.
   *
   * This is the seam every backend feeds. It never throws — all failures are
   * counted as rejections.
   *
   * @returns the accepted tag updates (empty array on rejection).
   */
  handleFrame(frame: Buffer, receiveMs: number = this.captureNow()): GooseTagUpdate[] {
    let parsed;
    try {
      parsed = parseGooseFrame(frame);
    } catch (err) {
      gooseFramesRejectedTotal.inc({ reason: "parse_error" });
      if (!(err instanceof GooseParseError)) {
        logError(err, "[goose] unexpected error parsing frame");
      }
      return [];
    }

    gooseFramesReceivedTotal.inc({ app_id: `0x${parsed.appId.toString(16)}` });

    const sub = this.subscriptions.find((s) => s.matches(parsed));
    if (!sub) {
      gooseFramesRejectedTotal.inc({ reason: "no_subscription" });
      return [];
    }

    const result = sub.validate(parsed, receiveMs);
    if (!result.accepted) {
      gooseFramesRejectedTotal.inc({ reason: result.reason });
      return [];
    }

    gooseRoundTripUs.observe(result.roundTripUs, { gocb_ref: parsed.pdu.gocbRef });
    gooseLastStNum.set(parsed.pdu.stNum, { gocb_ref: parsed.pdu.gocbRef });

    if (result.wasStale) {
      // Link recovered after a missed retransmission window; record the gap.
      gooseFramesRejectedTotal.inc({ reason: "ttl_expired" });
      logWarn(`[goose] ${parsed.pdu.gocbRef} resumed after stale TTL window`);
    }

    for (const update of result.updates) {
      try {
        this.onTagUpdate(update);
      } catch (err) {
        logError(err, "[goose] tag update sink threw");
      }
    }
    return result.updates;
  }

  /** Expose registered subscriptions (read-only) for diagnostics. */
  getSubscriptions(): ReadonlyArray<GooseSubscription> {
    return this.subscriptions;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Service wiring (mirrors server/protocols/sparkplug-b/index.ts)
// ───────────────────────────────────────────────────────────────────────────

let _subscriber: GooseSubscriber | null = null;

/**
 * Build a subscriber from the environment and start it.
 *
 * Returns null when no subscriptions are configured — the service stays off
 * rather than inventing a control-block map. When subscriptions ARE configured
 * but no capture source is, it still starts and reports "unavailable" so the
 * gap is visible in the boot log instead of looking like a silent success.
 */
export async function startGooseSubscriber(
  config: GooseServiceConfig = loadGooseServiceConfig(),
): Promise<GooseSubscriber | null> {
  // A previously started subscriber owns a watchdog interval (and possibly an
  // in-flight replay); replacing the singleton without stopping it would leak
  // both and keep a second frame stream feeding the tag stream.
  await stopGooseSubscriber();

  if (config.subscriptions.length === 0) {
    logInfo(
      "[goose] subscriber not configured (set GOOSE_SUBSCRIPTIONS_FILE to a JSON " +
        "array of control-block subscriptions to enable it)",
    );
    return null;
  }

  const backend: GooseCaptureBackend = config.pcapPath
    ? new GoosePcapReplayBackend({ path: config.pcapPath, realtime: config.pcapRealtime })
    : new NullGooseCaptureBackend({ iface: config.iface });

  const subscriber = new GooseSubscriber({
    backend,
    subscriptions: config.subscriptions,
    // Decoded GOOSE dataset members become tag updates on the existing tag
    // stream. GooseTagUpdate is a superset of the stream's TagUpdate, so the
    // extra provenance fields (origin/gocbRef/stNum/simulated) ride along.
    onTagUpdate: (update) => tagStreamServer.broadcastTagUpdate(update),
  });

  _subscriber = subscriber;
  await subscriber.start();
  return subscriber;
}

/** Stop the GOOSE subscriber started by {@link startGooseSubscriber}. */
export async function stopGooseSubscriber(): Promise<void> {
  const subscriber = _subscriber;
  _subscriber = null;
  await subscriber?.stop();
}

/** The running subscriber, if any (diagnostics/health). */
export function getGooseSubscriber(): GooseSubscriber | null {
  return _subscriber;
}

// Re-export the public surface for convenience.
export { parseGooseFrame, parseGoosePdu, GooseParseError } from "./frame-parser.js";
export { GooseSubscription } from "./subscription.js";
export type {
  GooseSubscriptionConfig,
  GooseSubscriptionConfigParsed,
  GooseValidationResult,
  DatasetMember,
} from "./subscription.js";
export {
  NullGooseCaptureBackend,
  GooseCaptureUnavailableError,
  detectRawSocketCapability,
  isGooseFrame,
  readFrameEtherType,
} from "./capture-backend.js";
export type {
  GooseCaptureBackend,
  GooseCaptureAvailability,
  GooseFrameHandler,
} from "./capture-backend.js";
export { GoosePcapReplayBackend } from "./pcap-backend.js";
export type { GoosePcapReplayOptions, GoosePcapReplayStats } from "./pcap-backend.js";
export {
  parsePcap,
  encodePcap,
  readPcapGlobalHeader,
  PcapParseError,
  LINKTYPE_ETHERNET,
  PCAP_MAGIC_MICROSECONDS,
  PCAP_MAGIC_NANOSECONDS,
} from "./pcap.js";
export type { PcapFile, PcapPacket, PcapGlobalHeader } from "./pcap.js";
export {
  loadGooseServiceConfig,
  gooseServiceConfigSchema,
  loadGooseSubscriptionsFile,
} from "./config.js";
export type { GooseServiceConfig } from "./config.js";
export * from "./types.js";
