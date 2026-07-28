/**
 * Offline GOOSE capture backend: replay a captured `.pcap`.
 *
 * This backend is fully functional — it is how the subscriber is actually
 * exercised end to end without a native L2 binding. It reads a classic libpcap
 * file, keeps only the EtherType 0x88B8 frames, and hands them to the
 * subscriber with the capture's recorded inter-frame timing.
 *
 * TIME BASE — the receive timestamp delivered with each frame is the packet's
 * RECORDED capture time, not `Date.now()`. That is deliberate: the publisher's
 * event time `t` inside the PDU also comes from the capture, so
 * `goose_round_trip_us` measures the real publish→capture latency of the trace.
 * Rebasing onto the local clock would instead report "how old is this file",
 * which is meaningless. {@link GoosePcapReplayBackend.clockNowMs} exposes the
 * same time base so the subscriber's TTL watchdog ages subscriptions against
 * capture time.
 *
 * Issue: #465
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { logError } from "../../logger.js";
import { isGooseFrame } from "./capture-backend.js";
import type {
  GooseCaptureAvailability,
  GooseCaptureBackend,
  GooseFrameHandler,
} from "./capture-backend.js";
import { LINKTYPE_ETHERNET, parsePcap, type PcapPacket } from "./pcap.js";

export interface GoosePcapReplayOptions {
  /** Path to a classic `.pcap` file. Required unless `buffer` is given. */
  path?: string;
  /** Already-loaded capture bytes. Takes precedence over `path`. */
  buffer?: Buffer;
  /**
   * Honour the recorded inter-frame gaps (default). Set false for a fast,
   * no-delay drain — used by tests and by bulk re-validation of a trace.
   */
  realtime?: boolean;
  /** Replay speed multiplier for realtime mode. >1 is faster. Default 1. */
  speed?: number;
}

export interface GoosePcapReplayStats {
  /** Packet records present in the file. */
  packetsInFile: number;
  /** Records whose EtherType is 0x88B8 (what gets replayed). */
  gooseFrames: number;
  /** Records filtered out because they are not GOOSE. */
  nonGooseFrames: number;
  /** GOOSE frames actually handed to the subscriber so far. */
  delivered: number;
  /** Recorded span of the GOOSE frames, in ms (0 when fewer than two). */
  captureSpanMs: number;
}

/**
 * Replays a `.pcap` capture as a {@link GooseCaptureBackend}.
 *
 * ```ts
 * const backend = new GoosePcapReplayBackend({ path: "trace.pcap" });
 * const subscriber = new GooseSubscriber({ backend, subscriptions });
 * await subscriber.start();          // "running"
 * await backend.completion();        // resolves when the trace is exhausted
 * ```
 */
export class GoosePcapReplayBackend implements GooseCaptureBackend {
  readonly name = "pcap-replay";

  private readonly options: GoosePcapReplayOptions;
  private readonly realtime: boolean;
  private readonly speed: number;

  private frames: PcapPacket[] = [];
  private nextIndex = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFrame: GooseFrameHandler | null = null;
  /** True between open() and close(). */
  private opened = false;
  /** True once open() has been called; a backend instance replays exactly once. */
  private everOpened = false;

  /** Wall-clock ms at which replay started (realtime mode only). */
  private replayStartedAtWallMs = 0;
  /** Recorded timestamp of the first GOOSE frame in the capture. */
  private firstFrameMs: number | null = null;
  /** Recorded timestamp of the most recently delivered frame. */
  private lastDeliveredMs: number | null = null;

  private stats: GoosePcapReplayStats = {
    packetsInFile: 0,
    gooseFrames: 0,
    nonGooseFrames: 0,
    delivered: 0,
    captureSpanMs: 0,
  };

  private completionPromise: Promise<GoosePcapReplayStats>;
  private resolveCompletion!: (stats: GoosePcapReplayStats) => void;

  constructor(options: GoosePcapReplayOptions) {
    if (!options.path && !options.buffer) {
      throw new Error("GoosePcapReplayBackend requires either `path` or `buffer`");
    }
    if (options.speed !== undefined && !(options.speed > 0)) {
      throw new Error(`GoosePcapReplayBackend: speed must be > 0, got ${options.speed}`);
    }
    this.options = options;
    this.realtime = options.realtime ?? true;
    this.speed = options.speed ?? 1;
    this.completionPromise = new Promise<GoosePcapReplayStats>((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  availability(): GooseCaptureAvailability {
    if (this.options.buffer) {
      return { available: true, reason: "replaying an in-memory capture" };
    }
    const path = this.options.path as string;
    if (!existsSync(path)) {
      return { available: false, reason: `pcap file not found: ${path}` };
    }
    return {
      available: true,
      reason: `replaying ${path}${this.realtime ? "" : " (no-delay mode)"}`,
    };
  }

  /**
   * Load the capture and start delivering frames. Resolves once replay has
   * STARTED; use {@link completion} to await the end of the trace.
   */
  async open(onFrame: GooseFrameHandler): Promise<void> {
    if (this.everOpened) {
      throw new Error(
        "GoosePcapReplayBackend.open() called twice — construct a new backend to replay again",
      );
    }
    this.everOpened = true;

    let file;
    try {
      const bytes = this.options.buffer ?? (await readFile(this.options.path as string));
      file = parsePcap(bytes);
      if (file.header.linkType !== LINKTYPE_ETHERNET) {
        throw new Error(
          `pcap link type ${file.header.linkType} is not Ethernet (${LINKTYPE_ETHERNET}); ` +
            "GOOSE frames can only be replayed from an Ethernet capture",
        );
      }
    } catch (err) {
      // A capture that never loads still has to settle completion(), or a
      // caller awaiting the end of the replay would wait forever.
      this.finish();
      throw err;
    }

    this.frames = file.packets.filter((packet) => isGooseFrame(packet.data));
    this.stats = {
      packetsInFile: file.packets.length,
      gooseFrames: this.frames.length,
      nonGooseFrames: file.packets.length - this.frames.length,
      delivered: 0,
      captureSpanMs:
        this.frames.length > 1
          ? this.frames[this.frames.length - 1].timestampMs - this.frames[0].timestampMs
          : 0,
    };

    this.onFrame = onFrame;
    this.opened = true;
    this.nextIndex = 0;
    this.firstFrameMs = this.frames.length > 0 ? this.frames[0].timestampMs : null;
    this.lastDeliveredMs = null;
    this.replayStartedAtWallMs = Date.now();

    if (this.realtime) {
      this.scheduleNext();
    } else {
      while (this.opened && this.nextIndex < this.frames.length) {
        this.deliver(this.frames[this.nextIndex++]);
      }
      this.finish();
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opened = false;
    this.onFrame = null;
    // A caller awaiting completion() after an early close must not hang.
    this.resolveCompletion({ ...this.stats });
  }

  /** Resolves with the replay statistics once the capture is exhausted. */
  completion(): Promise<GoosePcapReplayStats> {
    return this.completionPromise;
  }

  /** Snapshot of the replay counters. */
  getStats(): GoosePcapReplayStats {
    return { ...this.stats };
  }

  /**
   * Current time in the capture's own time base, so TTL expiry is judged the
   * way it would have been judged live.
   *
   * Realtime mode advances with the wall clock (scaled by `speed`) and keeps
   * advancing past the last frame, which is what lets the TTL watchdog notice
   * that a publisher stopped transmitting. No-delay mode collapses time, so it
   * reports the timestamp of the last delivered frame.
   */
  clockNowMs(): number {
    if (this.firstFrameMs === null) {
      return this.lastDeliveredMs ?? Date.now();
    }
    if (!this.realtime) {
      return this.lastDeliveredMs ?? this.firstFrameMs;
    }
    return this.firstFrameMs + (Date.now() - this.replayStartedAtWallMs) * this.speed;
  }

  private scheduleNext(): void {
    if (!this.opened) return;
    if (this.nextIndex >= this.frames.length) {
      this.finish();
      return;
    }
    const packet = this.frames[this.nextIndex];
    const targetOffsetMs = (packet.timestampMs - (this.firstFrameMs ?? 0)) / this.speed;
    const elapsedMs = Date.now() - this.replayStartedAtWallMs;
    const delayMs = Math.max(0, targetOffsetMs - elapsedMs);

    // Deliberately NOT unref()'d: an in-flight replay is real work, and unref
    // would let the process exit half way through a trace.
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.opened) return;
      this.nextIndex += 1;
      this.deliver(packet);
      this.scheduleNext();
    }, delayMs);
  }

  private deliver(packet: PcapPacket): void {
    this.lastDeliveredMs = packet.timestampMs;
    this.stats.delivered += 1;
    try {
      this.onFrame?.(packet.data, packet.timestampMs);
    } catch (err) {
      // A handler that throws must not kill the timer chain or the process.
      logError(err, "[goose] pcap replay frame handler threw");
    }
  }

  private finish(): void {
    this.resolveCompletion({ ...this.stats });
  }
}
