/**
 * LIVE GOOSE capture backend — real Layer-2 frames off a real interface.
 *
 * GOOSE is EtherType 0x88B8 riding directly on Ethernet: no IP, no UDP, so no
 * Node socket can receive it. The usual answer is a native libpcap addon, which
 * this repository deliberately does not take on (node-gyp in CI). The answer
 * here is the other half of the same libpcap: a capture TOOL that streams
 * classic pcap on stdout, spawned as a child process.
 *
 *   dumpcap -i eth0 -P -q -s 65535 -w - -f '<bpf>'     (preferred)
 *   tcpdump -i eth0 -U -n -s 65535 -w - '<bpf>'        (fallback)
 *
 * The frames are genuinely captured — libpcap opens the capture handle, the
 * kernel copies the frames, the BPF filter runs in the kernel — and the pipe
 * carries them into {@link PcapStreamDecoder}, the same pcap machinery the
 * offline replay backend uses. What this module owns is the process lifecycle,
 * the filter, and the honesty of {@link GooseLiveCaptureBackend.availability}.
 *
 * WHAT IS AND IS NOT VERIFIED
 * ---------------------------
 * The whole path — spawn → stdout → incremental pcap decode → EtherType filter
 * → frame handler → subscriber → tag updates + metrics — is covered by tests
 * that point the backend at a fake capture command emitting a known pcap byte
 * stream. What is NOT verified anywhere in this repository is capture from a
 * real substation bus or a real IED: no such hardware is available here. The
 * argv, the BPF filter and the privilege requirements are written from the
 * tools' documented behaviour, not from an observed live capture.
 *
 * PRIVILEGE. Opening a capture handle needs CAP_NET_RAW (or root). This backend
 * never tries to acquire it; it detects the failure and reports it with the
 * command needed to fix it. See docs/protocols/iec61850-goose.md.
 *
 * Issue: #465
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { logError, logInfo, logWarn } from "../../logger.js";
import { GooseCaptureUnavailableError, isGooseFrame } from "./capture-backend.js";
import type {
  GooseCaptureAvailability,
  GooseCaptureBackend,
  GooseFrameHandler,
} from "./capture-backend.js";
import { LINKTYPE_ETHERNET, type PcapGlobalHeader } from "./pcap.js";
import { PcapStreamDecoder, type StreamedPcapPacket } from "./pcap-stream.js";
import { GOOSE_ETHERTYPE } from "./types.js";

/** Interface bound when none is configured — the acceptance criterion's default. */
export const DEFAULT_GOOSE_IFACE = "eth0";

/** Default snapshot length. A GOOSE frame never approaches this. */
export const DEFAULT_GOOSE_SNAPLEN = 65535;

/**
 * BPF filter matching GOOSE both untagged and behind one 802.1Q tag.
 *
 * `ether proto 0x88b8` alone is WRONG for a substation bus. It compiles to a
 * comparison at Ethernet offset 12, and on a VLAN-tagged frame offset 12 holds
 * the 802.1Q TPID (0x8100) — the real EtherType has been pushed out to offset
 * 16. Since GOOSE is normally published on a dedicated priority-tagged VLAN,
 * that filter would silently drop exactly the traffic being subscribed to.
 *
 * libpcap's `vlan` keyword is the fix, with one sharp edge: it is not a plain
 * predicate. The first `vlan` in an expression shifts the decoding offsets of
 * everything AFTER it by 4 bytes (pcap-filter(7)). So the two terms are not
 * interchangeable and the order matters:
 *
 *   ether proto 0x88b8            → offset 12, matches untagged GOOSE
 *   or (vlan and ether proto 0x88b8) → `vlan` matches the TPID and shifts the
 *                                       base, so this `ether proto` reads
 *                                       offset 16 and matches tagged GOOSE
 *
 * Writing the VLAN term first would leave the offsets shifted for the untagged
 * term and match nothing sane.
 *
 * Only ONE tag is unwrapped. That is deliberate: it matches
 * `readFrameEtherType()` and the frame parser, neither of which decodes a QinQ
 * (0x88A8/0x9100) outer tag. Widening the filter to `vlan and vlan` would
 * deliver frames the decoder would then reject.
 */
export const GOOSE_BPF_FILTER = `ether proto 0x${GOOSE_ETHERTYPE.toString(16)} or (vlan and ether proto 0x${GOOSE_ETHERTYPE.toString(16)})`;

/**
 * Platforms where the `<tool> -w -` capture path is used. Windows is excluded
 * on purpose: capture there goes through Npcap with a different privilege model
 * and different tool packaging, and nothing in this repository has been written
 * or tested against it — so it reports unavailable rather than guessing.
 */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>([
  "linux",
  "darwin",
  "freebsd",
  "openbsd",
  "netbsd",
  "sunos",
  "aix",
]);

/** Capture tools this backend knows how to drive. */
export type GooseCaptureToolName = "dumpcap" | "tcpdump";

/** Tool selection: `auto` prefers dumpcap, then tcpdump. */
export type GooseCaptureToolSelection = GooseCaptureToolName | "auto";

/**
 * A resolved capture command. `args` is an ARGUMENT VECTOR, never a shell
 * string: the child is spawned without a shell, so an interface name or filter
 * containing shell metacharacters is passed through as one opaque argument and
 * cannot be interpreted as a command.
 */
export interface GooseCaptureCommand {
  /** Executable path or bare name. */
  file: string;
  /** Argument vector, one element per argument. */
  args: readonly string[];
  /** Human-readable description used in logs and availability reasons. */
  label: string;
}

/** Counters describing what the live capture has actually seen. */
export interface GooseLiveCaptureStats {
  /** Bytes read from the capture tool's stdout. */
  bytesRead: number;
  /** pcap records decoded from the stream. */
  recordsDecoded: number;
  /** Records whose EtherType is 0x88B8 and were handed to the subscriber. */
  gooseFrames: number;
  /** Records dropped because they are not GOOSE (belt-and-braces behind the BPF). */
  nonGooseFrames: number;
  /** Records dropped because the snapshot length cut the frame short. */
  truncatedFrames: number;
  /** Frames whose recorded capture timestamp was unusable, so wall clock was used. */
  clockFallbacks: number;
  /** Capture tool exit code, once it has exited. */
  exitCode: number | null;
  /** Signal that killed the capture tool, if any. */
  exitSignal: NodeJS.Signals | null;
}

export interface GooseLiveCaptureOptions {
  /** Interface to capture on. Default {@link DEFAULT_GOOSE_IFACE} ("eth0"). */
  iface?: string;
  /** Which capture tool to use. Default "auto" (dumpcap, then tcpdump). */
  tool?: GooseCaptureToolSelection;
  /** Explicit path to the capture tool, bypassing the PATH search. */
  toolPath?: string;
  /** Snapshot length passed to the tool. Default {@link DEFAULT_GOOSE_SNAPLEN}. */
  snapLen?: number;
  /** Override the BPF filter. Default {@link GOOSE_BPF_FILTER}. */
  filter?: string;
  /**
   * Fully-specified command, bypassing tool resolution entirely. The operator
   * takes responsibility for it emitting classic pcap on stdout. Tests use this
   * to drive the real spawn/stream/decode path from a known byte stream.
   */
  command?: GooseCaptureCommand;
  /**
   * How long to wait for the tool to emit the pcap global header before giving
   * up. This is the readiness signal: libpcap writes it once the capture handle
   * is open, so `open()` resolving means capture really started. Default 5000.
   */
  startupTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on close. Default 2000. */
  killGraceMs?: number;
  /** Upper bound on how long `close()` waits for the child to exit. Default 5000. */
  closeTimeoutMs?: number;
  /** Largest accepted pcap record. Defaults to the snapshot length. */
  maxRecordBytes?: number;
  /** Largest undecodable residue held between chunks. */
  maxBufferedBytes?: number;
  /** Override the detected platform (testing). */
  platform?: NodeJS.Platform;
  /** Environment used for the PATH search (testing). */
  env?: NodeJS.ProcessEnv;
  /** Executable-existence probe (testing). */
  exists?: (path: string) => boolean;
  /** Clock, ms since epoch. Default `Date.now`. */
  now?: () => number;
}

/**
 * Largest disagreement tolerated between a frame's recorded capture timestamp
 * and the local wall clock before the recorded value is discarded. libpcap
 * timestamps come from the same host clock as `Date.now()`, so a gap this large
 * means the timestamps are not usable (a mis-synced NIC hardware clock, or a
 * stream that is not really live) — and using them would make every
 * subscription instantly TTL-expired.
 */
const MAX_CAPTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Stderr kept for diagnostics; the tail is what carries the error. */
const MAX_STDERR_CHARS = 8192;

/** Patterns that identify the "libpcap could not get CAP_NET_RAW" family. */
const PERMISSION_PATTERNS: readonly RegExp[] = [
  /permission denied/i,
  /operation not permitted/i,
  /you don'?t have permission/i,
  /are you root/i,
  /must be root/i,
  /root privileges/i,
  /\beperm\b/i,
  /\beacces\b/i,
  /cap_net_raw/i,
];

/** Patterns that identify a bad interface name. */
const NO_SUCH_DEVICE_PATTERNS: readonly RegExp[] = [
  /no such device/i,
  /doesn'?t exist/i,
  /does not exist/i,
  /no such capture device/i,
  /that device does not exist/i,
];

const PERMISSION_REMEDY =
  "libpcap needs CAP_NET_RAW to open a capture handle. Either grant it to the " +
  "capture tool (`sudo setcap cap_net_raw,cap_net_admin+eip $(command -v dumpcap)`), " +
  "add the service account to the group that owns dumpcap (Debian/Ubuntu: " +
  "`sudo dpkg-reconfigure wireshark-common` then `sudo usermod -aG wireshark <user>`), " +
  "or run the capture tool as root.";

// ───────────────────────────────────────────────────────────────────────────
// Executable resolution (platform-injectable so it is unit-testable anywhere)
// ───────────────────────────────────────────────────────────────────────────

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function hasPathSeparator(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /[\\/]/.test(file) : file.includes("/");
}

function joinPath(dir: string, file: string, platform: NodeJS.Platform): string {
  const sep = platform === "win32" ? "\\" : "/";
  return /[\\/]$/.test(dir) ? `${dir}${file}` : `${dir}${sep}${file}`;
}

/**
 * Resolve `file` to an existing executable, searching PATH when it is a bare
 * name. Returns null when nothing matches — this is what makes
 * {@link GooseLiveCaptureBackend.availability} able to say "no capture tool is
 * installed" without spawning anything.
 */
export function resolveExecutable(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (file === "") return null;
  const extensions =
    platform === "win32"
      ? [
          "",
          ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .map((e) => e.trim())
            .filter((e) => e.length > 0),
        ]
      : [""];

  const probe = (candidate: string): string | null => {
    for (const ext of extensions) {
      const full = `${candidate}${ext}`;
      if (exists(full)) return full;
    }
    return null;
  };

  if (hasPathSeparator(file, platform)) return probe(file);

  const search = (env.PATH ?? env.Path ?? "").split(pathDelimiter(platform));
  for (const rawDir of search) {
    const dir = rawDir.trim().replace(/^"|"$/g, "");
    if (dir === "") continue;
    const hit = probe(joinPath(dir, file, platform));
    if (hit) return hit;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Command construction
// ───────────────────────────────────────────────────────────────────────────

/**
 * argv for `dumpcap`.
 *
 * `-P` is not optional: dumpcap defaults to pcapNG, which this decoder does not
 * read. `-q` suppresses the running packet-count display on stderr so stderr
 * stays useful for errors. `-w -` streams the capture file to stdout.
 */
export function buildDumpcapArgs(iface: string, snapLen: number, filter: string): string[] {
  return ["-i", iface, "-P", "-q", "-s", String(snapLen), "-w", "-", "-f", filter];
}

/**
 * argv for `tcpdump`.
 *
 * `-U` is not optional: without packet-buffered output tcpdump holds frames in
 * a 4 KiB stdio buffer, which would add unbounded latency to a protocol with a
 * sub-4 ms budget. `-n` avoids name lookups. tcpdump writes classic pcap.
 */
export function buildTcpdumpArgs(iface: string, snapLen: number, filter: string): string[] {
  return ["-i", iface, "-U", "-n", "-s", String(snapLen), "-w", "-", filter];
}

/** Build the argv for a known tool. */
export function buildCaptureCommand(
  tool: GooseCaptureToolName,
  file: string,
  iface: string,
  snapLen: number,
  filter: string,
): GooseCaptureCommand {
  const args =
    tool === "dumpcap"
      ? buildDumpcapArgs(iface, snapLen, filter)
      : buildTcpdumpArgs(iface, snapLen, filter);
  return { file, args, label: `${tool} (${file})` };
}

// ───────────────────────────────────────────────────────────────────────────
// Backend
// ───────────────────────────────────────────────────────────────────────────

function emptyStats(): GooseLiveCaptureStats {
  return {
    bytesRead: 0,
    recordsDecoded: 0,
    gooseFrames: 0,
    nonGooseFrames: 0,
    truncatedFrames: 0,
    clockFallbacks: 0,
    exitCode: null,
    exitSignal: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Live GOOSE capture via a libpcap CLI tool.
 *
 * ```ts
 * const backend = new GooseLiveCaptureBackend({ iface: "eth0" });
 * if (!backend.availability().available) { ... }
 * const subscriber = new GooseSubscriber({ backend, subscriptions });
 * await subscriber.start();  // "running" only once frames can actually flow
 * ```
 */
export class GooseLiveCaptureBackend implements GooseCaptureBackend {
  readonly name = "live-pcap";

  private readonly iface: string;
  private readonly tool: GooseCaptureToolSelection;
  private readonly toolPath?: string;
  private readonly snapLen: number;
  private readonly filter: string;
  private readonly commandOverride?: GooseCaptureCommand;
  private readonly startupTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxRecordBytes: number;
  private readonly maxBufferedBytes?: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exists: (path: string) => boolean;
  private readonly now: () => number;

  private child: ChildProcess | null = null;
  private command: GooseCaptureCommand | null = null;
  private decoder: PcapStreamDecoder | null = null;
  private stderrTail = "";
  private stats: GooseLiveCaptureStats = emptyStats();
  private lastError: Error | null = null;
  private closing = false;
  private warnedTruncation = false;
  private warnedClockSkew = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;
  /** Registered on `process.exit` while a capture runs; see {@link installExitHook}. */
  private exitHook: (() => void) | null = null;

  constructor(options: GooseLiveCaptureOptions = {}) {
    this.iface = options.iface ?? DEFAULT_GOOSE_IFACE;
    this.tool = options.tool ?? "auto";
    this.toolPath = options.toolPath;
    this.snapLen = options.snapLen ?? DEFAULT_GOOSE_SNAPLEN;
    this.filter = options.filter ?? GOOSE_BPF_FILTER;
    this.commandOverride = options.command;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5000;
    this.killGraceMs = options.killGraceMs ?? 2000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5000;
    this.maxRecordBytes = options.maxRecordBytes ?? this.snapLen;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.exists = options.exists ?? existsSync;
    this.now = options.now ?? (() => Date.now());

    if (this.iface.trim() === "") {
      throw new Error("GooseLiveCaptureBackend requires a non-empty interface name");
    }
    if (!Number.isInteger(this.snapLen) || this.snapLen <= 0) {
      throw new Error(
        `GooseLiveCaptureBackend: snapLen must be a positive integer, got ${this.snapLen}`,
      );
    }
  }

  /** The interface this backend captures on. */
  getInterface(): string {
    return this.iface;
  }

  /** The BPF filter handed to the capture tool. */
  getFilter(): string {
    return this.filter;
  }

  /** The command in use (after open) or the one that would be used. */
  getCommand(): GooseCaptureCommand | null {
    if (this.command) return this.command;
    try {
      return this.resolveCommand();
    } catch {
      return null;
    }
  }

  /** Snapshot of the capture counters. */
  getStats(): GooseLiveCaptureStats {
    return { ...this.stats };
  }

  /** The most recent capture failure, if any. */
  getLastError(): Error | null {
    return this.lastError;
  }

  /** Bytes the pcap decoder is holding while it waits for the rest of a record. */
  getBufferedBytes(): number {
    return this.decoder?.getBufferedBytes() ?? 0;
  }

  /** True while a capture process is running and has not been asked to stop. */
  isRunning(): boolean {
    return this.child !== null && !this.closing;
  }

  /** Resolves when the capture process has exited (immediately if never started). */
  completion(): Promise<void> {
    return this.exitPromise;
  }

  /**
   * Whether a capture could be started here. Truthful and non-throwing: it
   * reports the unsupported platform, or that no capture tool is installed, or
   * the command that would be run.
   *
   * It does NOT prove the capture will succeed — only the kernel can say
   * whether this process holds CAP_NET_RAW and whether the interface exists.
   * Those failures surface from {@link open}, with the remedy in the message.
   */
  availability(): GooseCaptureAvailability {
    try {
      const command = this.resolveCommand();
      if (this.commandOverride) {
        const resolved = resolveExecutable(command.file, this.env, this.platform, this.exists);
        if (!resolved) {
          return {
            available: false,
            reason: `configured GOOSE capture command not found: ${command.file}`,
          };
        }
      }
      return {
        available: true,
        reason:
          `${command.label} on iface=${this.iface}, filter='${this.filter}' ` +
          "(capture permission is only proven when the tool starts)",
      };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Spawn the capture tool and stream frames to `onFrame`.
   *
   * Resolves only once the pcap global header has been decoded — libpcap emits
   * it when the capture handle is open, so a resolved promise means frames can
   * actually arrive. Rejects (with the tool's stderr, and a remedy for the
   * permission case) if the tool cannot start.
   */
  open(onFrame: GooseFrameHandler): Promise<void> {
    if (this.child) {
      return Promise.reject(
        new Error(`GooseLiveCaptureBackend is already capturing on ${this.iface}`),
      );
    }

    let command: GooseCaptureCommand;
    try {
      command = this.resolveCommand();
    } catch (err) {
      return Promise.reject(err);
    }

    this.closing = false;
    this.stderrTail = "";
    this.stats = emptyStats();
    this.lastError = null;
    this.warnedTruncation = false;
    this.warnedClockSkew = false;
    this.command = command;

    const decoder = new PcapStreamDecoder({
      maxRecordBytes: this.maxRecordBytes,
      maxBufferedBytes: this.maxBufferedBytes,
      onHeader: (header) => this.checkCaptureHeader(header),
    });
    this.decoder = decoder;

    this.exitPromise = new Promise<void>((resolveExit) => {
      this.resolveExit = resolveExit;
    });

    // No shell: `command.args` is an argv array, so an interface name or filter
    // containing shell metacharacters is one opaque argument, never a command.
    const child = spawn(command.file, [...command.args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.installExitHook(child);

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settleOk = (): void => {
        if (settled) return;
        settled = true;
        this.clearStartupTimer();
        logInfo(
          `[goose] live capture started: ${command.label} on ${this.iface} ` +
            `(snaplen=${this.snapLen}, filter='${this.filter}')`,
        );
        resolve();
      };

      const settleErr = (err: Error): void => {
        if (settled) {
          this.lastError = err;
          return;
        }
        settled = true;
        this.clearStartupTimer();
        this.abort(err);
        reject(err);
      };

      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        settleErr(
          new Error(
            `${command.label} produced no pcap header within ${this.startupTimeoutMs}ms on ` +
              `${this.iface}; the capture never started${this.stderrSuffix()}`,
          ),
        );
      }, this.startupTimeoutMs);
      // The capture tool's own handle keeps the loop alive while it runs; this
      // watchdog must not extend the process lifetime on its own.
      this.startupTimer.unref?.();

      child.once("error", (err: NodeJS.ErrnoException) => {
        settleErr(this.spawnError(err, command));
        // A spawn failure leaves no process to reap; release the handle so the
        // backend can be opened again without a phantom "already capturing".
        this.child = null;
        this.clearExitHook();
        this.settleExit();
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (text: string) => {
        this.stderrTail = (this.stderrTail + text).slice(-MAX_STDERR_CHARS);
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        this.stats.bytesRead += chunk.length;
        let packets: StreamedPcapPacket[];
        try {
          packets = decoder.push(chunk);
        } catch (err) {
          const failure =
            err instanceof Error ? err : new Error(`pcap stream decode failed: ${String(err)}`);
          if (!settled) {
            settleErr(failure);
          } else {
            // Framing is lost and pcap has no resync marker: stop the tool
            // rather than feed the decoder garbage for the rest of the run.
            logError(
              failure,
              `[goose] live capture on ${this.iface} lost pcap framing; stopping the capture tool`,
            );
            this.abort(failure);
          }
          return;
        }

        if (!settled && decoder.getHeader() !== null) settleOk();
        for (const packet of packets) this.deliver(packet, onFrame);
      });

      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        this.stats.exitCode = code;
        this.stats.exitSignal = signal;
        this.child = null;
        this.clearKillTimer();
        this.clearExitHook();
        this.settleExit();

        if (!settled) {
          settleErr(this.startupExitError(code, signal, command));
          return;
        }
        if (this.closing) return; // we asked it to stop

        if (signal === null && code === 0) {
          // A clean exit is the end of the capture, not a failure (a tool run
          // with `-a duration:N` or `-c N` ends this way). Frames have stopped
          // arriving either way, so it is still worth a line.
          logWarn(
            `[goose] ${command.label} exited normally; live GOOSE capture on ` +
              `${this.iface} has stopped after ${this.stats.gooseFrames} frame(s)`,
          );
          try {
            decoder.end();
          } catch (endErr) {
            logWarn(`[goose] live capture stream ended mid-record: ${(endErr as Error).message}`);
          }
          return;
        }

        const err = new Error(
          `${command.label} stopped capturing on ${this.iface} ` +
            `(${describeExit(code, signal)})${this.stderrSuffix()}`,
        );
        this.lastError = err;
        logError(err, "[goose] live GOOSE capture ended unexpectedly");
      });
    });
  }

  /**
   * Stop the capture. Kills the child (SIGTERM, then SIGKILL after the grace
   * period), waits for it to exit, and is safe to call twice or when open() was
   * never called.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.clearStartupTimer();
    if (!this.child) {
      this.clearKillTimer();
      this.clearExitHook();
      return;
    }
    this.terminate();
    // Bounded: stop() must never hang the server on a wedged capture tool.
    await Promise.race([this.exitPromise, delay(this.closeTimeoutMs)]);
    this.clearKillTimer();
    this.clearExitHook();
  }

  /**
   * Wall clock, matching the epoch of the capture timestamps delivered with
   * each frame (libpcap timestamps come from this same host clock).
   */
  clockNowMs(): number {
    return this.now();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Reject a capture whose link layer is not Ethernet. `-i any` on Linux yields
   * LINKTYPE_LINUX_SLL, whose frames have no Ethernet header at all, so every
   * "GOOSE frame" decoded from it would be misaligned nonsense.
   */
  private checkCaptureHeader(header: PcapGlobalHeader): void {
    if (header.linkType !== LINKTYPE_ETHERNET) {
      throw new Error(
        `capture on ${this.iface} has link type ${header.linkType}, not Ethernet ` +
          `(${LINKTYPE_ETHERNET}); GOOSE frames only exist on a real Ethernet interface ` +
          "(a Linux `any` capture yields LINKTYPE_LINUX_SLL and cannot be used)",
      );
    }
  }

  /** Apply the EtherType filter and hand the frame on. */
  private deliver(packet: StreamedPcapPacket, onFrame: GooseFrameHandler): void {
    this.stats.recordsDecoded += 1;

    if (packet.truncated) {
      // The snapshot length cut the frame short: the BER APDU is incomplete, so
      // decoding it would either throw or yield a partial dataset. Neither is
      // acceptable for a protection-grade signal — drop it and say so.
      this.stats.truncatedFrames += 1;
      if (!this.warnedTruncation) {
        this.warnedTruncation = true;
        logWarn(
          `[goose] dropping snapped frame on ${this.iface}: captured ` +
            `${packet.capturedLength} of ${packet.originalLength} bytes — raise the ` +
            `snapshot length (currently ${this.snapLen})`,
        );
      }
      return;
    }

    // Belt and braces behind the kernel BPF filter: the same test the offline
    // backend applies, so a mis-set GOOSE_CAPTURE_FILTER cannot feed non-GOOSE
    // traffic into the BER decoder.
    if (!isGooseFrame(packet.data)) {
      this.stats.nonGooseFrames += 1;
      return;
    }

    this.stats.gooseFrames += 1;
    try {
      onFrame(packet.data, this.receiveTimestamp(packet));
    } catch (err) {
      logError(err, "[goose] live capture frame handler threw");
    }
  }

  /**
   * Receive time for a captured frame.
   *
   * Prefers the pcap record's timestamp, which libpcap takes from the kernel at
   * the moment the frame was copied off the NIC. That excludes the capture
   * tool's buffering, the pipe and Node's scheduling — all of which are
   * comparable to the sub-4 ms budget `goose_round_trip_us` is measuring, so
   * using `Date.now()` here would inflate the metric with our own latency.
   *
   * Falls back to the wall clock when the recorded timestamp cannot be
   * reconciled with it (see {@link MAX_CAPTURE_CLOCK_SKEW_MS}), because TTL
   * expiry is judged against `clockNowMs()` and a skewed timestamp would make
   * every subscription look permanently stale.
   */
  private receiveTimestamp(packet: StreamedPcapPacket): number {
    const wall = this.now();
    const captured = packet.timestampMs;
    if (Number.isFinite(captured) && Math.abs(wall - captured) <= MAX_CAPTURE_CLOCK_SKEW_MS) {
      return captured;
    }
    this.stats.clockFallbacks += 1;
    if (!this.warnedClockSkew) {
      this.warnedClockSkew = true;
      logWarn(
        `[goose] capture timestamps on ${this.iface} disagree with the local clock by ` +
          `more than ${MAX_CAPTURE_CLOCK_SKEW_MS}ms (recorded ${captured}, local ${wall}); ` +
          "using the local clock for TTL and round-trip latency",
      );
    }
    return wall;
  }

  /** Decide which command to run. Throws when nothing can be run here. */
  private resolveCommand(): GooseCaptureCommand {
    if (this.commandOverride) return this.commandOverride;

    if (!SUPPORTED_PLATFORMS.has(this.platform)) {
      throw new GooseCaptureUnavailableError(
        `live GOOSE capture is not supported on platform=${this.platform}: it spawns a ` +
          "libpcap tool (dumpcap/tcpdump) that streams pcap on stdout, which is a " +
          "Linux/BSD/macOS path. Windows capture goes through Npcap and is not " +
          "implemented here — use GOOSE_CAPTURE=pcap to replay a capture instead",
      );
    }

    const names: GooseCaptureToolName[] =
      this.tool === "auto" ? ["dumpcap", "tcpdump"] : [this.tool];
    for (const name of names) {
      const candidate = this.toolPath ?? name;
      const resolved = resolveExecutable(candidate, this.env, this.platform, this.exists);
      if (resolved) return buildCaptureCommand(name, resolved, this.iface, this.snapLen, this.filter);
    }

    throw new GooseCaptureUnavailableError(
      this.toolPath
        ? `configured GOOSE capture tool not found: ${this.toolPath}`
        : `no GOOSE capture tool found on PATH (looked for ${names.join(", ")}); ` +
          "install wireshark's dumpcap or tcpdump, or set GOOSE_CAPTURE_TOOL_PATH",
    );
  }

  /** Map a spawn failure onto an actionable message. */
  private spawnError(err: NodeJS.ErrnoException, command: GooseCaptureCommand): Error {
    if (err.code === "ENOENT") {
      return new Error(
        `GOOSE capture tool not found: ${command.file} (install wireshark's dumpcap or ` +
          "tcpdump, or set GOOSE_CAPTURE_TOOL_PATH to its absolute path)",
      );
    }
    if (err.code === "EACCES") {
      return new Error(
        `GOOSE capture tool ${command.file} is not executable by this process (EACCES). ` +
          PERMISSION_REMEDY,
      );
    }
    return new Error(`failed to start ${command.label}: ${err.message}`);
  }

  /** Diagnose an exit that happened before the capture ever started. */
  private startupExitError(
    code: number | null,
    signal: NodeJS.Signals | null,
    command: GooseCaptureCommand,
  ): Error {
    const stderr = this.stderrTail.trim();
    if (matchesAny(stderr, PERMISSION_PATTERNS)) {
      return new Error(
        `${command.label} was denied permission to capture on ${this.iface} ` +
          `(${describeExit(code, signal)}). ${PERMISSION_REMEDY}${this.stderrSuffix()}`,
      );
    }
    if (matchesAny(stderr, NO_SUCH_DEVICE_PATTERNS)) {
      return new Error(
        `${command.label} could not open interface '${this.iface}' ` +
          `(${describeExit(code, signal)}) — check the interface name and that it is up ` +
          `(set GOOSE_IFACE)${this.stderrSuffix()}`,
      );
    }
    return new Error(
      `${command.label} exited before capturing on ${this.iface} ` +
        `(${describeExit(code, signal)})${this.stderrSuffix()}`,
    );
  }

  private stderrSuffix(): string {
    const stderr = this.stderrTail.trim();
    return stderr === "" ? " (no stderr output)" : `: ${stderr}`;
  }

  /**
   * Record a fatal capture failure and stop the tool. Marks the backend as no
   * longer running so the `close` handler does not report the shutdown we
   * ourselves initiated as a second, unexplained failure.
   */
  private abort(err: Error): void {
    this.lastError = err;
    this.closing = true;
    this.terminate();
  }

  /** Stop reading and kill the capture tool. Idempotent. */
  private terminate(): void {
    const child = this.child;
    if (!child) return;
    child.stdout?.removeAllListeners("data");
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already reaped between the check and the signal — nothing to do.
      }
      if (!this.killTimer) {
        const timer = setTimeout(() => {
          this.killTimer = null;
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, this.killGraceMs);
        timer.unref?.();
        this.killTimer = timer;
      }
    }
  }

  /**
   * Kill the capture tool if this process exits without closing the backend.
   *
   * A child spawned by Node is NOT killed when its parent exits, so a server
   * that shuts down without calling `stop()` would leave `dumpcap` capturing
   * forever. This closes the common case (normal exit, `process.exit()`).
   *
   * It cannot close every case: a `SIGKILL`, or an unhandled `SIGTERM`/`SIGINT`
   * with no listener, terminates the process without running `exit` handlers.
   * Under a process supervisor that kills the whole control group (systemd's
   * default `KillMode`) or from a terminal — where the signal reaches the whole
   * foreground process group — the child dies with the parent anyway.
   *
   * The listener is removed as soon as the child is reaped, so a long-lived
   * process that opens and closes captures does not accumulate listeners.
   */
  private installExitHook(child: ChildProcess): void {
    this.clearExitHook();
    const hook = (): void => {
      // Must be synchronous: `exit` handlers cannot await anything.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    this.exitHook = hook;
    process.once("exit", hook);
  }

  private clearExitHook(): void {
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = null;
    }
  }

  private settleExit(): void {
    const resolveExit = this.resolveExit;
    this.resolveExit = null;
    resolveExit?.();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `killed by ${signal}`;
  return `exit code ${code ?? "unknown"}`;
}
