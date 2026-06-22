/**
 * IEC 61850 GOOSE subscriber service.
 *
 * Opens a raw Layer-2 (AF_PACKET) socket on a configurable interface, filters
 * for the GOOSE ethertype (0x88B8), decodes each frame, validates it against
 * the registered subscriptions and surfaces accepted dataset values as tag
 * updates (origin="goose").
 *
 * CAPABILITY DETECTION
 * --------------------
 * A raw Ethernet (AF_PACKET / SOCK_RAW) socket requires:
 *   - Linux (AF_PACKET is Linux-only)
 *   - CAP_NET_RAW (root, or `setcap cap_net_raw+ep node`)
 *   - a native binding to capture L2 frames (Node has no built-in AF_PACKET)
 *
 * None of that is available on the dev box (Windows) or in CI, so the live
 * capture path is guarded behind {@link detectRawSocketCapability}. When the
 * capability is absent the service starts in a DISABLED state and never throws
 * — the pure decode/validation core (frame-parser + subscription) remains
 * fully usable (e.g. for pcap replay and unit tests). See the TODO in
 * `startCapture` for the native-binding integration point.
 *
 * Issue: #465
 */

import { logError, logInfo, logWarn } from "../../logger.js";
import { parseGooseFrame, GooseParseError } from "./frame-parser.js";
import { GooseSubscription, type GooseSubscriptionConfig } from "./subscription.js";
import type { GooseTagUpdate } from "./types.js";
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
  /** Network interface to capture on. Default: env GOOSE_IFACE or "eth0". */
  iface?: string;
  /** Initial subscriptions. More can be added later via {@link subscribe}. */
  subscriptions?: GooseSubscriptionConfig[];
  /**
   * Sink for accepted tag updates. Defaults to a logging sink.
   *
   * INTEGRATION (#206 tag-stream): wire this to
   * `tagStreamServer.broadcastTagUpdate(...)` once the GOOSE origin is added to
   * the shared TagUpdate type. We keep the seam abstract to avoid editing the
   * shared websocket module from this issue's branch.
   */
  onTagUpdate?: GooseTagUpdateSink;
  /** Override clock (testability). Returns ms since epoch. */
  now?: () => number;
}

export type GooseSubscriberState = "disabled" | "stopped" | "running" | "error";

export interface RawSocketCapability {
  available: boolean;
  reason: string;
}

/**
 * Determine whether a raw AF_PACKET capture socket can be opened in this
 * environment. Pure / side-effect-free so it can be unit tested.
 */
export function detectRawSocketCapability(
  platform: NodeJS.Platform = process.platform,
  isRoot: boolean = typeof process.getuid === "function" ? process.getuid!() === 0 : false,
): RawSocketCapability {
  if (platform !== "linux") {
    return {
      available: false,
      reason: `AF_PACKET raw sockets require Linux (platform=${platform}); live capture disabled`,
    };
  }
  if (!isRoot) {
    // CAP_NET_RAW may still be granted via file capabilities even when not root;
    // we cannot reliably detect that from JS, so we report it as the reason.
    return {
      available: false,
      reason:
        "raw L2 capture needs CAP_NET_RAW (run as root or `setcap cap_net_raw+ep $(command -v node)`)",
    };
  }
  // Even on Linux+root, Node has no built-in AF_PACKET binding — a native addon
  // (e.g. `cap`/`pcap`) is required. We surface this as the integration gap.
  return {
    available: false,
    reason:
      "no native L2 capture binding present (TODO: add a pcap/AF_PACKET addon to enable live capture)",
  };
}

export class GooseSubscriber {
  private readonly iface: string;
  private readonly subscriptions: GooseSubscription[] = [];
  private readonly onTagUpdate: GooseTagUpdateSink;
  private readonly now: () => number;
  private state: GooseSubscriberState = "stopped";
  private capability: RawSocketCapability;
  /** TTL staleness watchdog handle. */
  private ttlTimer?: ReturnType<typeof setInterval>;

  constructor(options: GooseSubscriberOptions = {}) {
    this.iface = options.iface ?? process.env.GOOSE_IFACE ?? "eth0";
    this.now = options.now ?? (() => Date.now());
    this.onTagUpdate =
      options.onTagUpdate ??
      ((u) => logInfo(`[goose] tag update ${u.tagName}=${u.value} (q=${u.quality}, st=${u.stNum})`));

    for (const sub of options.subscriptions ?? []) {
      this.subscribe(sub);
    }
    this.capability = detectRawSocketCapability();
  }

  getState(): GooseSubscriberState {
    return this.state;
  }

  getCapability(): RawSocketCapability {
    return this.capability;
  }

  getInterface(): string {
    return this.iface;
  }

  /** Register a new subscription. Returns the created subscription. */
  subscribe(config: GooseSubscriptionConfig): GooseSubscription {
    const sub = new GooseSubscription(config);
    this.subscriptions.push(sub);
    gooseSubscriptionsActive.set(this.subscriptions.length);
    return sub;
  }

  /**
   * Start the subscriber. On a non-capable host this transitions to "disabled"
   * (with a clear log line) instead of throwing — the decode core is still
   * usable via {@link handleFrame} for pcap replay / tests.
   */
  start(): GooseSubscriberState {
    if (!this.capability.available) {
      this.state = "disabled";
      logWarn(
        `[goose] live capture disabled on iface=${this.iface}: ${this.capability.reason}`,
      );
      return this.state;
    }
    try {
      this.startCapture();
      this.startTtlWatchdog();
      this.state = "running";
      logInfo(`[goose] subscriber running on ${this.iface} (ethertype 0x88B8)`);
    } catch (err) {
      this.state = "error";
      logError(err, "[goose] failed to start raw capture");
    }
    return this.state;
  }

  stop(): void {
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = undefined;
    }
    // TODO(#465): close the native capture handle here once integrated.
    this.state = "stopped";
  }

  /**
   * Open the raw AF_PACKET socket and begin reading frames.
   *
   * TODO(#465): This is the native-binding integration point. The intended
   * implementation (Linux, CAP_NET_RAW):
   *   1. open AF_PACKET/SOCK_RAW bound to ETH_P_ALL (or 0x88B8) on this.iface
   *   2. set a BPF filter for ethertype 0x88B8 (incl. the 802.1Q variant)
   *   3. for each captured frame: this.handleFrame(buf, this.now())
   * Node has no built-in AF_PACKET, so a native addon (e.g. `cap`, `pcap`,
   * `raw-socket`) is required. Until that dependency is approved/added, the
   * capability check above keeps us in DISABLED on every supported host, so
   * this body is intentionally unreachable in practice.
   */
  private startCapture(): void {
    throw new Error(
      "GOOSE live capture not yet wired to a native L2 binding (see TODO in startCapture)",
    );
  }

  /** Periodically flag subscriptions whose previous TTL elapsed (lost link). */
  private startTtlWatchdog(): void {
    this.ttlTimer = setInterval(() => {
      const now = this.now();
      for (const sub of this.subscriptions) {
        if (sub.isStale(now)) {
          gooseFramesRejectedTotal.inc({ reason: "ttl_expired" });
          logWarn(`[goose] subscription ${sub.config.gocbRef} link stale (TTL elapsed)`);
          sub.reset();
        }
      }
    }, 100);
  }

  /**
   * Decode + validate a single raw GOOSE frame and surface tag updates.
   *
   * This is the seam shared by the live capture path and pcap replay / tests.
   * It never throws — all failures are counted as rejections.
   *
   * @returns the accepted tag updates (empty array on rejection).
   */
  handleFrame(frame: Buffer, receiveMs: number = this.now()): GooseTagUpdate[] {
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

// Re-export the public surface for convenience.
export { parseGooseFrame, parseGoosePdu, GooseParseError } from "./frame-parser.js";
export { GooseSubscription } from "./subscription.js";
export type {
  GooseSubscriptionConfig,
  GooseSubscriptionConfigParsed,
  GooseValidationResult,
  DatasetMember,
} from "./subscription.js";
export * from "./types.js";
