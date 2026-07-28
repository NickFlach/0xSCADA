/**
 * GOOSE capture-backend seam.
 *
 * GOOSE is Layer-2 multicast: no IP, no UDP, EtherType 0x88B8. Node has no
 * built-in way to receive those frames, so the subscriber does NOT own capture.
 * Instead it consumes raw frames from a {@link GooseCaptureBackend}, which is
 * dependency-injected. That keeps one honest boundary between:
 *
 *   - decode + validation (frame-parser.ts / subscription.ts) — always works;
 *   - frame acquisition — environment-dependent.
 *
 * Backends shipped in this repository:
 *
 *   - {@link NullGooseCaptureBackend} — the default. Delivers nothing and says
 *     so. It never throws at import and never reports itself as running.
 *   - `GoosePcapReplayBackend` (pcap-backend.ts) — replays a captured `.pcap`
 *     offline, honouring recorded inter-frame timing.
 *   - `GooseLiveCaptureBackend` (live-backend.ts) — live capture, by spawning a
 *     libpcap tool (`dumpcap`/`tcpdump`) that streams pcap on stdout. Opt-in
 *     via `GOOSE_CAPTURE=live`; needs a Linux/BSD/macOS host and CAP_NET_RAW.
 *
 * NOT shipped: an in-process AF_PACKET binding. Node has none and this
 * repository adds no native addon — see {@link detectRawSocketCapability}. Any
 * other frame source can be added by implementing this interface and passing it
 * to `new GooseSubscriber({ backend })`.
 *
 * Issue: #465
 */

import { GOOSE_ETHERTYPE, VLAN_TPID } from "./types.js";

/**
 * Called by a backend for each captured link-layer frame.
 *
 * @param frame       full Ethernet frame, starting at the destination MAC.
 * @param receivedAtMs receive timestamp in the backend's own time base
 *                     (wall clock for a live backend; the capture's recorded
 *                     timestamp for a replay backend). TTL countdown and
 *                     round-trip latency are evaluated against this value, so
 *                     it must be consistent with {@link
 *                     GooseCaptureBackend.clockNowMs}.
 */
export type GooseFrameHandler = (frame: Buffer, receivedAtMs: number) => void;

/** Whether a backend can actually deliver frames here, and why not if it cannot. */
export interface GooseCaptureAvailability {
  available: boolean;
  reason: string;
}

/**
 * A source of raw GOOSE frames.
 *
 * Implementations must deliver complete Ethernet frames whose EtherType is
 * 0x88B8 (optionally behind one 802.1Q tag). Filtering non-GOOSE traffic is the
 * backend's job — {@link isGooseFrame} implements the same test a BPF filter
 * would.
 */
export interface GooseCaptureBackend {
  /** Short identifier used in logs, e.g. "null" or "pcap-replay". */
  readonly name: string;

  /**
   * Report whether {@link open} can succeed right now. The subscriber calls
   * this BEFORE open() and refuses to claim it is running when it is false.
   */
  availability(): GooseCaptureAvailability;

  /** Begin delivering frames to `onFrame`. Rejects if capture cannot start. */
  open(onFrame: GooseFrameHandler): Promise<void>;

  /** Stop delivering frames and release resources. Safe to call when closed. */
  close(): Promise<void>;

  /**
   * Optional: "now" in the same time base as the `receivedAtMs` values this
   * backend delivers. The subscriber's TTL watchdog uses it so a replayed
   * capture is aged against capture time rather than wall-clock time. Live
   * backends can omit it — the subscriber then falls back to its own clock.
   */
  clockNowMs?(): number;
}

/** Thrown when a backend that cannot capture is asked to open. */
export class GooseCaptureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GooseCaptureUnavailableError";
  }
}

/**
 * Extract the EtherType of an Ethernet II frame, transparently stepping over a
 * single 802.1Q tag. Returns null when the buffer is too short to hold one.
 *
 * Only a single 802.1Q tag is unwrapped, matching `parseGooseFrame`: a QinQ
 * (0x88A8 / 0x9100) outer tag is returned as-is and therefore filtered out
 * rather than being handed to a decoder that would reject it.
 */
export function readFrameEtherType(frame: Buffer): number | null {
  if (frame.length < 14) return null;
  const outer = frame.readUInt16BE(12);
  if (outer !== VLAN_TPID) return outer;
  if (frame.length < 18) return null;
  return frame.readUInt16BE(16);
}

/** True when `frame` is an EtherType 0x88B8 GOOSE frame. */
export function isGooseFrame(frame: Buffer): boolean {
  return readFrameEtherType(frame) === GOOSE_ETHERTYPE;
}

/**
 * Determine whether an IN-PROCESS raw AF_PACKET capture socket could be opened
 * here. Pure / side-effect-free so it can be unit tested.
 *
 * This never returns `available: true`: even on Linux as root, Node has no
 * AF_PACKET binding, and this repository intentionally ships no native capture
 * addon. Live capture is instead done out-of-process by
 * `GooseLiveCaptureBackend`. The function exists to produce an accurate,
 * host-specific explanation of what the DEFAULT backend is missing rather than
 * a generic "disabled".
 */
export function detectRawSocketCapability(
  platform: NodeJS.Platform = process.platform,
  isRoot: boolean = typeof process.getuid === "function" ? process.getuid!() === 0 : false,
): GooseCaptureAvailability {
  if (platform !== "linux") {
    return {
      available: false,
      reason: `AF_PACKET raw sockets require Linux (platform=${platform})`,
    };
  }
  if (!isRoot) {
    // CAP_NET_RAW may still be granted via file capabilities even when not root;
    // that cannot be detected reliably from JS, so it is reported as the reason.
    return {
      available: false,
      reason:
        "raw L2 capture needs CAP_NET_RAW (run as root or `setcap cap_net_raw+ep $(command -v node)`)",
    };
  }
  return {
    available: false,
    reason:
      "no native L2 capture binding is present — Node cannot open AF_PACKET; " +
      "set GOOSE_CAPTURE=live to capture through a libpcap tool instead, or " +
      "inject a backend implementing GooseCaptureBackend",
  };
}

export interface NullGooseCaptureBackendOptions {
  /** Interface this host *would* capture on, used only in the explanation. */
  iface?: string;
  /** Override the detected platform (testing). */
  platform?: NodeJS.Platform;
  /** Override the detected root-ness (testing). */
  isRoot?: boolean;
}

/**
 * The default backend: captures nothing, and says so.
 *
 * It exists so that constructing and starting a `GooseSubscriber` on a host
 * without live capture is a truthful no-op — `start()` resolves to
 * "unavailable" and logs why — instead of throwing (the previous behaviour) or
 * pretending to run.
 */
export class NullGooseCaptureBackend implements GooseCaptureBackend {
  readonly name = "null";
  private readonly iface: string;
  private readonly capability: GooseCaptureAvailability;

  constructor(options: NullGooseCaptureBackendOptions = {}) {
    this.iface = options.iface ?? "eth0";
    const capability = detectRawSocketCapability(options.platform, options.isRoot);
    this.capability = {
      available: capability.available,
      reason: `${capability.reason} (iface=${this.iface})`,
    };
  }

  availability(): GooseCaptureAvailability {
    return this.capability;
  }

  /** The interface a live backend would have been asked to bind. */
  getInterface(): string {
    return this.iface;
  }

  open(): Promise<void> {
    return Promise.reject(
      new GooseCaptureUnavailableError(
        `GOOSE live capture is not available: ${this.capability.reason}`,
      ),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
