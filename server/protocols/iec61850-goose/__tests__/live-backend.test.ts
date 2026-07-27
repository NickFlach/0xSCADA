/**
 * Tests for the LIVE GOOSE capture backend.
 *
 * A real substation bus is not available here, and no test in this repository
 * captures from one. What these tests do prove is the whole real code path
 * around the capture tool: the backend spawns a child process with an argv
 * array, reads classic pcap off its stdout in whatever chunks the pipe hands
 * over, decodes it incrementally, applies the EtherType 0x88B8 filter, and
 * feeds the subscriber — which decodes, validates, emits tag updates and moves
 * the Prometheus counters.
 *
 * The child is a fake: `process.execPath -e <script>` replaying a known pcap
 * byte stream (and, in the failure tests, exiting with a real capture tool's
 * stderr). Everything on this side of the pipe is production code, including
 * the parts that are hardest to get right — chunk boundaries, process
 * lifecycle, and the failure diagnostics.
 *
 * Issue: #465
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GooseLiveCaptureBackend,
  GOOSE_BPF_FILTER,
  DEFAULT_GOOSE_IFACE,
  DEFAULT_GOOSE_SNAPLEN,
  buildDumpcapArgs,
  buildTcpdumpArgs,
  buildCaptureCommand,
  resolveExecutable,
  type GooseCaptureCommand,
} from "../live-backend.js";
import { GooseSubscriber } from "../index.js";
import { encodePcap } from "../pcap.js";
import { GOOSE_ETHERTYPE, VLAN_TPID } from "../types.js";
import type { GooseTagUpdate } from "../types.js";
import type { GooseSubscriptionConfig } from "../subscription.js";
import {
  gooseFramesReceivedTotal,
  gooseFramesRejectedTotal,
  gooseRoundTripUs,
  type GooseRejectReason,
} from "../metrics.js";
import {
  buildArpRequestFrame,
  buildFrame,
  buildPdu,
  canonicalFrame,
  data,
  REPLAY_APP_ID,
  REPLAY_CONF_REV,
  REPLAY_DAT_SET,
  REPLAY_DEST_MAC,
  REPLAY_GOCB_REF,
  REPLAY_PUBLISH_LATENCY_MS,
  REPLAY_SRC_MAC,
} from "./fixtures.js";

// ───────────────────────────────────────────────────────────────────────────
// Fake capture tool: emits a pcap byte stream on stdout, exactly as
// `dumpcap -w -` / `tcpdump -w -` do.
// ───────────────────────────────────────────────────────────────────────────

/**
 * argv (after the script): pcapFile, chunkBytes, delayMs, exitCode, stderrText,
 * mode. `mode === "hang"` keeps the process alive after the stream, which is
 * how a real capture tool behaves — it never finishes on its own.
 */
const FAKE_CAPTURE_SCRIPT = `
const fs = require("node:fs");
const [file, chunkArg, delayArg, codeArg, stderrText, mode] = process.argv.slice(1);
if (stderrText) process.stderr.write(stderrText);
const exitCode = Number(codeArg) || 0;
const buf = file ? fs.readFileSync(file) : Buffer.alloc(0);
const size = Number(chunkArg) > 0 ? Number(chunkArg) : (buf.length || 1);
const wait = Number(delayArg) || 0;
let i = 0;
function done() {
  if (mode === "hang") { setInterval(function () {}, 1000); return; }
  if (exitCode) process.exitCode = exitCode;
}
function step() {
  if (wait > 0) {
    if (i >= buf.length) { done(); return; }
    process.stdout.write(buf.subarray(i, i + size));
    i += size;
    setTimeout(step, wait);
    return;
  }
  while (i < buf.length) { process.stdout.write(buf.subarray(i, i + size)); i += size; }
  done();
}
step();
`;

interface FakeCaptureOptions {
  /** Path of the pcap file to stream. Omit to emit nothing on stdout. */
  pcapPath?: string;
  /** Bytes per stdout write. Omit to write the whole file in one go. */
  chunkBytes?: number;
  /** Delay between writes, forcing genuinely separate chunks on the pipe. */
  delayMs?: number;
  /** Exit code once the stream is done. */
  exitCode?: number;
  /** Text written to stderr before anything else. */
  stderr?: string;
  /** Stay alive after streaming, like a real capture tool. */
  hang?: boolean;
}

function fakeCapture(options: FakeCaptureOptions = {}): GooseCaptureCommand {
  return {
    file: process.execPath,
    args: [
      "-e",
      FAKE_CAPTURE_SCRIPT,
      options.pcapPath ?? "",
      String(options.chunkBytes ?? 0),
      String(options.delayMs ?? 0),
      String(options.exitCode ?? 0),
      options.stderr ?? "",
      options.hang ? "hang" : "exit",
    ],
    label: "fake-capture",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Fixtures on disk
// ───────────────────────────────────────────────────────────────────────────

let workDir: string;

/** Write a pcap into the temp dir and return its path. */
function writeCapture(name: string, bytes: Buffer): string {
  const path = join(workDir, name);
  writeFileSync(path, bytes);
  return path;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "goose-live-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Collect the frames a backend delivers over one open/close cycle. */
async function captureFrames(
  backend: GooseLiveCaptureBackend,
): Promise<Array<{ frame: Buffer; receivedAtMs: number }>> {
  const frames: Array<{ frame: Buffer; receivedAtMs: number }> = [];
  await backend.open((frame, receivedAtMs) => frames.push({ frame, receivedAtMs }));
  await backend.completion();
  await backend.close();
  return frames;
}

// ───────────────────────────────────────────────────────────────────────────

describe("GOOSE BPF filter", () => {
  it("matches GOOSE both untagged and behind one 802.1Q tag", () => {
    expect(GOOSE_BPF_FILTER).toBe("ether proto 0x88b8 or (vlan and ether proto 0x88b8)");
    expect(GOOSE_ETHERTYPE).toBe(0x88b8);
  });

  it("puts the untagged term before `vlan`, which shifts later offsets by 4", () => {
    // pcap-filter(7): the first `vlan` in an expression re-bases every offset
    // after it. `ether proto 0x88b8` before it therefore reads offset 12
    // (untagged) and the one after it reads offset 16 (tagged). Reversing the
    // two terms would leave the untagged test looking at the wrong offset.
    const vlanIndex = GOOSE_BPF_FILTER.indexOf("vlan");
    const firstProtoIndex = GOOSE_BPF_FILTER.indexOf("ether proto");
    expect(firstProtoIndex).toBeGreaterThanOrEqual(0);
    expect(vlanIndex).toBeGreaterThan(firstProtoIndex);
    // Exactly one tag is unwrapped — matching what the frame parser can decode.
    expect(GOOSE_BPF_FILTER.match(/vlan/g)).toHaveLength(1);
  });
});

describe("capture tool argv", () => {
  it("builds dumpcap argv that forces classic pcap on stdout", () => {
    const args = buildDumpcapArgs("eth0", 65535, GOOSE_BPF_FILTER);
    expect(args).toEqual([
      "-i", "eth0",
      "-P", // pcap, not pcapng — the decoder reads classic pcap only
      "-q",
      "-s", "65535",
      "-w", "-",
      "-f", GOOSE_BPF_FILTER,
    ]);
  });

  it("builds tcpdump argv with packet-buffered output", () => {
    const args = buildTcpdumpArgs("eth1", 1500, GOOSE_BPF_FILTER);
    expect(args).toEqual([
      "-i", "eth1",
      "-U", // flush per packet; without it frames sit in a 4 KiB stdio buffer
      "-n",
      "-s", "1500",
      "-w", "-",
      GOOSE_BPF_FILTER,
    ]);
  });

  it("keeps the filter as a single argv element, so no shell can see it", () => {
    const hostile = "ether proto 0x88b8; rm -rf /";
    const command = buildCaptureCommand("tcpdump", "/usr/bin/tcpdump", "eth0", 65535, hostile);
    expect(command.args.filter((a) => a === hostile)).toHaveLength(1);
    expect(command.args.some((a) => a.includes(" ") && a !== hostile)).toBe(false);
  });

  it("passes an interface name through verbatim rather than interpolating it", () => {
    const command = buildCaptureCommand("dumpcap", "dumpcap", "eth0 && reboot", 65535, "x");
    expect(command.args).toContain("eth0 && reboot");
  });
});

describe("resolveExecutable", () => {
  /** A POSIX filesystem with exactly one capture tool installed. */
  const posixFs = (present: string) => (path: string) => path === present;

  it("searches a colon-separated PATH in order", () => {
    expect(
      resolveExecutable(
        "tcpdump",
        { PATH: "/sbin:/usr/sbin:/usr/bin" },
        "linux",
        posixFs("/usr/bin/tcpdump"),
      ),
    ).toBe("/usr/bin/tcpdump");
  });

  it("returns null when nothing on PATH matches", () => {
    expect(resolveExecutable("dumpcap", { PATH: "/sbin:/usr/bin" }, "linux", () => false)).toBeNull();
    expect(resolveExecutable("", {}, "linux", () => true)).toBeNull();
    expect(resolveExecutable("dumpcap", {}, "linux", () => true)).toBeNull();
  });

  it("checks a path-qualified name directly instead of searching PATH", () => {
    expect(
      resolveExecutable(
        "/opt/wireshark/dumpcap",
        { PATH: "/usr/bin" },
        "linux",
        posixFs("/opt/wireshark/dumpcap"),
      ),
    ).toBe("/opt/wireshark/dumpcap");
    expect(
      resolveExecutable("/definitely/not/here/dumpcap", {}, "linux", () => false),
    ).toBeNull();
  });

  it("finds a real file on this host's own filesystem", () => {
    const binDir = join(workDir, "bin-real");
    mkdirSync(binDir, { recursive: true });
    const toolPath = join(binDir, process.platform === "win32" ? "tcpdump.exe" : "tcpdump");
    writeFileSync(toolPath, "");
    const found = resolveExecutable("tcpdump", { PATH: binDir }, process.platform);
    // Windows resolves through PATHEXT, whose case is the environment's, not
    // the file's — the path is the same file either way.
    expect(found?.toLowerCase()).toBe(toolPath.toLowerCase());
    expect(resolveExecutable(process.execPath, {}, process.platform)).toBe(process.execPath);
  });
});

describe("availability()", () => {
  it("reports the platform truthfully on this host, and never throws", () => {
    const backend = new GooseLiveCaptureBackend({ iface: "eth0" });
    const availability = backend.availability();

    if (process.platform === "win32") {
      // Windows capture is Npcap-based and is not implemented here.
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/win32/);
      expect(availability.reason).toMatch(/not supported/i);
    } else if (availability.available) {
      // A capture tool really is installed on this host.
      expect(availability.reason).toMatch(/dumpcap|tcpdump/);
      expect(availability.reason).toContain("eth0");
    } else {
      expect(availability.reason).toMatch(/no GOOSE capture tool found on PATH/i);
    }
  });

  it("names the unsupported platform rather than claiming a generic failure", () => {
    const backend = new GooseLiveCaptureBackend({ platform: "win32", iface: "eth0" });
    expect(backend.availability()).toEqual({
      available: false,
      reason: expect.stringContaining("platform=win32"),
    });
    expect(backend.availability().reason).toMatch(/Npcap/);
  });

  it("reports a missing capture tool with the names it looked for", () => {
    const backend = new GooseLiveCaptureBackend({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
    });
    const availability = backend.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/dumpcap, tcpdump/);
    expect(availability.reason).toMatch(/GOOSE_CAPTURE_TOOL_PATH/);
  });

  it("reports available, naming the tool, when one is on PATH", () => {
    const backend = new GooseLiveCaptureBackend({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: (path) => path === "/usr/bin/dumpcap",
      iface: "eth9",
    });
    const availability = backend.availability();
    expect(availability.available).toBe(true);
    expect(availability.reason).toMatch(/dumpcap/);
    expect(availability.reason).toContain("eth9");
    // Honest about what it has NOT proven.
    expect(availability.reason).toMatch(/permission is only proven/i);
  });

  it("does not claim availability for a configured command that does not exist", () => {
    const backend = new GooseLiveCaptureBackend({
      command: { file: join(workDir, "no-such-tool"), args: [], label: "missing" },
    });
    expect(backend.availability().available).toBe(false);
    expect(backend.availability().reason).toMatch(/not found/i);
  });

  it("prefers dumpcap over tcpdump when both are installed", () => {
    const both = (path: string): boolean =>
      path === "/usr/bin/dumpcap" || path === "/usr/bin/tcpdump";
    const backend = new GooseLiveCaptureBackend({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: both,
    });
    expect(backend.getCommand()?.label).toBe("dumpcap (/usr/bin/dumpcap)");

    const forced = new GooseLiveCaptureBackend({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: both,
      tool: "tcpdump",
    });
    expect(forced.getCommand()?.label).toBe("tcpdump (/usr/bin/tcpdump)");
    expect(forced.getCommand()?.args).toEqual(
      buildTcpdumpArgs("eth0", DEFAULT_GOOSE_SNAPLEN, GOOSE_BPF_FILTER),
    );
  });

  it("reports a configured tool path that does not exist", () => {
    const backend = new GooseLiveCaptureBackend({
      platform: "linux",
      tool: "dumpcap",
      toolPath: "/opt/wireshark/dumpcap",
      exists: () => false,
    });
    expect(backend.availability()).toEqual({
      available: false,
      reason: "configured GOOSE capture tool not found: /opt/wireshark/dumpcap",
    });
  });

  it("defaults to eth0 and a 65535-byte snapshot length", () => {
    const backend = new GooseLiveCaptureBackend();
    expect(backend.getInterface()).toBe(DEFAULT_GOOSE_IFACE);
    expect(DEFAULT_GOOSE_IFACE).toBe("eth0");
    expect(backend.getFilter()).toBe(GOOSE_BPF_FILTER);
    expect(DEFAULT_GOOSE_SNAPLEN).toBe(65535);
  });

  it("rejects a nonsensical interface or snapshot length at construction", () => {
    expect(() => new GooseLiveCaptureBackend({ iface: "  " })).toThrow(/interface name/i);
    expect(() => new GooseLiveCaptureBackend({ snapLen: 0 })).toThrow(/snapLen/);
  });
});

describe("live capture — streaming a pcap off a child process", () => {
  it("delivers every GOOSE frame from a capture streamed in one write", async () => {
    const path = writeCapture(
      "single-write.pcap",
      encodePcap([
        { timestampMs: Date.now(), data: canonicalFrame({ stNum: 1 }) },
        { timestampMs: Date.now(), data: canonicalFrame({ stNum: 2 }) },
      ]),
    );
    const backend = new GooseLiveCaptureBackend({ command: fakeCapture({ pcapPath: path }) });
    const frames = await captureFrames(backend);

    expect(frames).toHaveLength(2);
    expect(backend.getStats().gooseFrames).toBe(2);
    expect(backend.getStats().recordsDecoded).toBe(2);
    expect(backend.getLastError()).toBeNull();
  });

  it("reassembles frames across pathological chunk boundaries", async () => {
    // 7 bytes per write splits inside the global header, inside record headers
    // and inside frame bodies — the boundaries a pipe really produces.
    const frames = [
      canonicalFrame({ stNum: 1 }),
      canonicalFrame({ stNum: 2 }),
      canonicalFrame({ stNum: 3 }),
    ];
    const path = writeCapture(
      "chunked.pcap",
      encodePcap(frames.map((data, i) => ({ timestampMs: Date.now() + i, data }))),
    );

    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, chunkBytes: 7 }),
    });
    const captured = await captureFrames(backend);

    expect(captured).toHaveLength(3);
    captured.forEach((entry, i) => {
      expect(entry.frame.equals(frames[i])).toBe(true);
    });
  });

  it("reassembles frames when the writes really are separate pipe chunks", async () => {
    const frames = [canonicalFrame({ stNum: 1 }), canonicalFrame({ stNum: 2 })];
    const path = writeCapture(
      "delayed.pcap",
      encodePcap(frames.map((data, i) => ({ timestampMs: Date.now() + i, data }))),
    );

    // 13-byte writes 1 ms apart: the reader observes many small, genuinely
    // distinct chunks rather than one coalesced buffer.
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, chunkBytes: 13, delayMs: 1 }),
    });
    const captured = await captureFrames(backend);

    expect(captured).toHaveLength(2);
    expect(captured[0].frame.equals(frames[0])).toBe(true);
    expect(captured[1].frame.equals(frames[1])).toBe(true);
  });

  for (const options of [
    { byteOrder: "big" as const, nanosecondPrecision: false, name: "big-endian µs" },
    { byteOrder: "little" as const, nanosecondPrecision: true, name: "little-endian ns" },
    { byteOrder: "big" as const, nanosecondPrecision: true, name: "big-endian ns" },
  ]) {
    it(`decodes a ${options.name} capture stream`, async () => {
      const frame = canonicalFrame({ stNum: 4 });
      const path = writeCapture(
        `byteorder-${options.byteOrder}-${options.nanosecondPrecision}.pcap`,
        encodePcap([{ timestampMs: Date.now(), data: frame }], {
          byteOrder: options.byteOrder,
          nanosecondPrecision: options.nanosecondPrecision,
        }),
      );
      const backend = new GooseLiveCaptureBackend({
        command: fakeCapture({ pcapPath: path, chunkBytes: 5 }),
      });
      const captured = await captureFrames(backend);
      expect(captured).toHaveLength(1);
      expect(captured[0].frame.equals(frame)).toBe(true);
    });
  }

  it("filters out non-GOOSE frames even if they reach stdout", async () => {
    const goose = canonicalFrame();
    const path = writeCapture(
      "mixed.pcap",
      encodePcap([
        { timestampMs: Date.now(), data: buildArpRequestFrame() },
        { timestampMs: Date.now(), data: goose },
      ]),
    );
    const backend = new GooseLiveCaptureBackend({ command: fakeCapture({ pcapPath: path }) });
    const captured = await captureFrames(backend);

    // The BPF filter would normally drop the ARP frame in the kernel; the
    // backend re-checks the EtherType so a mis-set GOOSE_CAPTURE_FILTER cannot
    // feed non-GOOSE traffic to the BER decoder.
    expect(captured).toHaveLength(1);
    expect(captured[0].frame.equals(goose)).toBe(true);
    expect(backend.getStats().nonGooseFrames).toBe(1);
    expect(backend.getStats().gooseFrames).toBe(1);
  });

  it("delivers a VLAN-tagged GOOSE frame, and only unwraps one tag", async () => {
    // GOOSE is normally published on a dedicated priority-tagged VLAN — that is
    // the entire reason GOOSE_BPF_FILTER carries the `vlan` term. Assert the
    // tagged case as an actual FRAME through the whole path, not just as a
    // string in the filter, and assert the QinQ boundary the filter stops at.
    const tagged = canonicalFrame({ stNum: 6 }, { vlan: { id: 100, priority: 4 } });
    expect(tagged.readUInt16BE(12)).toBe(VLAN_TPID);
    expect(tagged.readUInt16BE(16)).toBe(GOOSE_ETHERTYPE);

    // The same frame behind an additional 0x88a8 outer tag.
    const qinq = Buffer.concat([
      tagged.subarray(0, 12),
      Buffer.from([0x88, 0xa8, 0x00, 0x64]),
      tagged.subarray(12),
    ]);

    const path = writeCapture(
      "vlan-tagged.pcap",
      encodePcap([
        { timestampMs: Date.now(), data: qinq },
        { timestampMs: Date.now(), data: tagged },
      ]),
    );
    // 9-byte writes, so the tag itself lands across a chunk boundary.
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, chunkBytes: 9 }),
    });
    const captured = await captureFrames(backend);

    expect(captured).toHaveLength(1);
    expect(captured[0].frame.equals(tagged)).toBe(true);
    // Exactly one tag is unwrapped: the QinQ frame is filtered out rather than
    // half-decoded, matching what readFrameEtherType()/the frame parser handle.
    expect(backend.getStats().gooseFrames).toBe(1);
    expect(backend.getStats().nonGooseFrames).toBe(1);
  });

  it("rejects a snapped frame instead of decoding a partial APDU", async () => {
    const frame = canonicalFrame();
    const path = writeCapture(
      "snapped.pcap",
      encodePcap([
        { timestampMs: Date.now(), data: frame.subarray(0, 30), originalLength: frame.length },
        { timestampMs: Date.now(), data: frame },
      ]),
    );
    const backend = new GooseLiveCaptureBackend({ command: fakeCapture({ pcapPath: path }) });
    const captured = await captureFrames(backend);

    expect(backend.getStats().truncatedFrames).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].frame.equals(frame)).toBe(true);
  });

  it("uses the kernel capture timestamp when it agrees with the local clock", async () => {
    const capturedAt = Date.now() - 25;
    const path = writeCapture(
      "timestamps.pcap",
      encodePcap([{ timestampMs: capturedAt, data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({ command: fakeCapture({ pcapPath: path }) });
    const frames = await captureFrames(backend);

    expect(frames[0].receivedAtMs).toBe(capturedAt);
    expect(backend.getStats().clockFallbacks).toBe(0);
    expect(backend.clockNowMs()).toBeGreaterThanOrEqual(capturedAt);
  });

  it("falls back to the wall clock when capture timestamps are implausible", async () => {
    // A 2023 timestamp on a capture claiming to be live: using it would make
    // every subscription instantly TTL-expired.
    const path = writeCapture(
      "skewed.pcap",
      encodePcap([{ timestampMs: 1_700_000_000_000, data: canonicalFrame() }]),
    );
    const now = 1_800_000_000_000;
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path }),
      now: () => now,
    });
    const frames = await captureFrames(backend);

    expect(frames[0].receivedAtMs).toBe(now);
    expect(backend.getStats().clockFallbacks).toBe(1);
  });

  it("kills the capture tool when the stream exceeds the record bound", async () => {
    const path = writeCapture(
      "oversized.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    // 24-byte writes: the first is exactly the global header, so the capture is
    // already "started" when the oversized record header arrives.
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, chunkBytes: 24, delayMs: 5, hang: true }),
      maxRecordBytes: 32,
    });
    const frames: Buffer[] = [];
    await backend.open((frame) => frames.push(frame));
    await backend.completion();

    expect(frames).toHaveLength(0);
    expect(backend.getLastError()?.message).toMatch(/exceeds the 32-byte record limit/i);
    expect(backend.isRunning()).toBe(false);
    await backend.close();
  });

  it("refuses to start when the very first record is over the bound", async () => {
    const path = writeCapture(
      "oversized-at-start.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
      maxRecordBytes: 32,
    });
    await expect(backend.open(() => {})).rejects.toThrow(/exceeds the 32-byte record limit/i);
    await backend.close();
  });

  it("refuses a capture whose link type is not Ethernet", async () => {
    const path = writeCapture(
      "sll.pcap",
      encodePcap([{ timestampMs: Date.now(), data: Buffer.alloc(32) }], { linkType: 113 }),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
      iface: "any",
    });
    await expect(backend.open(() => {})).rejects.toThrow(/link type 113, not Ethernet/i);
    await backend.close();
  });

  it("refuses to be opened twice concurrently", async () => {
    const path = writeCapture(
      "concurrent.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
    });
    await backend.open(() => {});
    await expect(backend.open(() => {})).rejects.toThrow(/already capturing/i);
    await backend.close();
  });
});

describe("live capture — failure modes", () => {
  it("reports a missing capture tool clearly on spawn ENOENT", async () => {
    const backend = new GooseLiveCaptureBackend({
      command: {
        file: join(workDir, "0xscada-no-such-capture-tool"),
        args: [],
        label: "missing-tool",
      },
    });
    await expect(backend.open(() => {})).rejects.toThrow(/capture tool not found/i);
    await backend.close();
  });

  it("surfaces the tool's stderr when it exits before capturing", async () => {
    const backend = new GooseLiveCaptureBackend({
      iface: "eth7",
      command: fakeCapture({
        exitCode: 1,
        stderr: "tcpdump: eth7: No such device exists (SIOCGIFHWADDR: No such device)",
      }),
    });
    await expect(backend.open(() => {})).rejects.toThrow(/No such device exists/);
    expect(backend.getLastError()?.message).toMatch(/could not open interface 'eth7'/i);
    expect(backend.getLastError()?.message).toMatch(/GOOSE_IFACE/);
    await backend.close();
  });

  it("turns a permission failure into an actionable CAP_NET_RAW message", async () => {
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({
        exitCode: 2,
        stderr:
          "dumpcap: You don't have permission to capture on that device " +
          "(socket: Operation not permitted).",
      }),
    });
    await expect(backend.open(() => {})).rejects.toThrow(/CAP_NET_RAW/);
    const message = backend.getLastError()?.message ?? "";
    expect(message).toMatch(/denied permission/i);
    expect(message).toMatch(/setcap cap_net_raw/);
    // The tool's own words are kept, not paraphrased away.
    expect(message).toMatch(/Operation not permitted/);
    await backend.close();
  });

  it("reports an exit with no stderr rather than an empty message", async () => {
    const backend = new GooseLiveCaptureBackend({ command: fakeCapture({ exitCode: 3 }) });
    await expect(backend.open(() => {})).rejects.toThrow(/exit code 3.*no stderr output/is);
    await backend.close();
  });

  it("gives up when the tool never emits a pcap header", async () => {
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ hang: true }),
      startupTimeoutMs: 200,
    });
    await expect(backend.open(() => {})).rejects.toThrow(/no pcap header within 200ms/i);
    // The hung tool must have been killed, not left running.
    await backend.completion();
    await backend.close();
    expect(backend.isRunning()).toBe(false);
  });

  it("never fabricates a frame when capture cannot start", async () => {
    const frames: Buffer[] = [];
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ exitCode: 1, stderr: "dumpcap: permission denied" }),
    });
    await expect(backend.open((frame) => frames.push(frame))).rejects.toThrow();
    expect(frames).toHaveLength(0);
    expect(backend.getStats().gooseFrames).toBe(0);
    await backend.close();
  });
});

describe("live capture — lifecycle", () => {
  it("close() kills a capture tool that would otherwise run forever", async () => {
    const path = writeCapture(
      "hang.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
    });

    const frames: Buffer[] = [];
    await backend.open((frame) => frames.push(frame));
    expect(frames).toHaveLength(1);
    expect(backend.isRunning()).toBe(true);

    // close() only returns once the child is reaped, so this test hanging would
    // itself be the failure signal for a leaked process.
    await backend.close();
    expect(backend.isRunning()).toBe(false);
    const stats = backend.getStats();
    expect(stats.exitCode !== null || stats.exitSignal !== null).toBe(true);
  });

  it("close() is safe twice and when the backend was never opened", async () => {
    const fresh = new GooseLiveCaptureBackend();
    await expect(fresh.close()).resolves.toBeUndefined();
    await expect(fresh.close()).resolves.toBeUndefined();

    const path = writeCapture(
      "double-close.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
    });
    await backend.open(() => {});
    await backend.close();
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it("does not accumulate process exit listeners across captures", async () => {
    const path = writeCapture(
      "listeners.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const before = process.listenerCount("exit");
    for (let i = 0; i < 5; i++) {
      const backend = new GooseLiveCaptureBackend({
        command: fakeCapture({ pcapPath: path, hang: true }),
      });
      await backend.open(() => {});
      // The hook that kills an orphaned capture tool is installed while running.
      expect(process.listenerCount("exit")).toBe(before + 1);
      await backend.close();
    }
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("can be reopened after a clean close", async () => {
    const path = writeCapture(
      "reopen.pcap",
      encodePcap([{ timestampMs: Date.now(), data: canonicalFrame() }]),
    );
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, hang: true }),
    });
    const first: Buffer[] = [];
    await backend.open((frame) => first.push(frame));
    await backend.close();

    const second: Buffer[] = [];
    await backend.open((frame) => second.push(frame));
    await backend.close();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End to end: live backend → subscriber → tag updates + metrics
// ───────────────────────────────────────────────────────────────────────────

const TAG_POSITION = "IED1/XCBR1.Pos.stVal";
const TAG_QUALITY = "IED1/XCBR1.Pos.q";
const TAG_CURRENT = "IED1/MMXU1.A.phsA.cVal.mag.f";

const liveSubscription: GooseSubscriptionConfig = {
  gocbRef: REPLAY_GOCB_REF,
  appId: REPLAY_APP_ID,
  expectedDestMac: REPLAY_DEST_MAC,
  expectedSrcMac: REPLAY_SRC_MAC,
  expectedConfRev: REPLAY_CONF_REV,
  dataset: [
    { tagName: TAG_POSITION, type: "boolean" },
    { tagName: TAG_QUALITY, type: "quality", isQuality: true },
    { tagName: TAG_CURRENT, type: "float" },
  ],
};

function rejected(reason: GooseRejectReason): number {
  return gooseFramesRejectedTotal.get({ reason });
}

function received(appId: number): number {
  return gooseFramesReceivedTotal.get({ app_id: `0x${appId.toString(16)}` });
}

function roundTrip(gocbRef: string): { sum: number; count: number } {
  const entry = gooseRoundTripUs.collect().find((e) => e.labels.gocb_ref === gocbRef);
  return entry ? { sum: entry.sum, count: entry.count } : { sum: 0, count: 0 };
}

/**
 * A short bus trace timed against the current wall clock, so the timestamps a
 * live capture would carry are realistic: each PDU is published 2 ms before the
 * frame is captured.
 */
function buildLiveTrace(startMs: number): Buffer {
  const frame = (offsetMs: number, stNum: number, position: boolean, amps: number): Buffer => {
    const timestampMs = startMs + offsetMs;
    return buildFrame(
      buildPdu({
        gocbRef: REPLAY_GOCB_REF,
        timeAllowedToLive: 2000,
        datSet: REPLAY_DAT_SET,
        goID: "gcb01",
        confRev: REPLAY_CONF_REV,
        t: timestampMs - REPLAY_PUBLISH_LATENCY_MS,
        stNum,
        sqNum: 0,
        allData: [data.boolean(position), data.quality({ validity: "good" }), data.float32(amps)],
      }),
      { destMac: REPLAY_DEST_MAC, srcMac: REPLAY_SRC_MAC, appId: REPLAY_APP_ID },
    );
  };

  return encodePcap([
    { timestampMs: startMs, data: frame(0, 1, false, 41) },
    { timestampMs: startMs + 20, data: buildArpRequestFrame() },
    { timestampMs: startMs + 40, data: frame(40, 2, true, 42.5) },
    { timestampMs: startMs + 60, data: frame(60, 3, true, 43.25) },
  ]);
}

describe("live capture → GooseSubscriber (end to end)", () => {
  it("produces tag updates and moves the Prometheus counters", async () => {
    const startMs = Date.now() - 100;
    const path = writeCapture("e2e.pcap", buildLiveTrace(startMs));

    const beforeReceived = received(REPLAY_APP_ID);
    const beforeNoSubscription = rejected("no_subscription");
    const beforeParseError = rejected("parse_error");
    const beforeRoundTrip = roundTrip(REPLAY_GOCB_REF);

    const updates: GooseTagUpdate[] = [];
    // 11-byte writes: the subscriber is fed from a stream that is fragmented
    // through every part of the pcap framing.
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ pcapPath: path, chunkBytes: 11, hang: true }),
    });
    const subscriber = new GooseSubscriber({
      backend,
      subscriptions: [liveSubscription],
      onTagUpdate: (update) => updates.push(update),
    });

    const state = await subscriber.start();
    expect(state).toBe("running");

    // Wait for the whole trace to arrive, then shut the capture down.
    await waitFor(() => updates.length >= 9);
    await subscriber.stop();
    expect(subscriber.getState()).toBe("stopped");

    // 3 accepted GOOSE frames x 3 dataset members.
    expect(updates).toHaveLength(9);
    expect(updates.every((u) => u.origin === "goose")).toBe(true);
    expect(updates.every((u) => u.gocbRef === REPLAY_GOCB_REF)).toBe(true);
    expect(updates.filter((u) => u.tagName === TAG_POSITION).map((u) => u.value)).toEqual([
      false,
      true,
      true,
    ]);
    expect(updates.filter((u) => u.tagName === TAG_CURRENT).map((u) => u.value)).toEqual([
      41, 42.5, 43.25,
    ]);
    expect(updates.filter((u) => u.tagName === TAG_QUALITY).every((u) => u.quality === "good")).toBe(
      true,
    );

    expect(received(REPLAY_APP_ID) - beforeReceived).toBe(3);
    expect(rejected("no_subscription") - beforeNoSubscription).toBe(0);
    // The ARP frame was dropped by the EtherType filter, so it was never parsed.
    expect(rejected("parse_error") - beforeParseError).toBe(0);

    const after = roundTrip(REPLAY_GOCB_REF);
    const count = after.count - beforeRoundTrip.count;
    const sum = after.sum - beforeRoundTrip.sum;
    expect(count).toBe(3);
    // Round trip is publisher `t` → kernel capture time, so it reflects the
    // trace's own 2 ms publish latency and not this test's scheduling.
    expect(sum / count).toBeCloseTo(REPLAY_PUBLISH_LATENCY_MS * 1000, 0);
    expect(sum / count).toBeLessThan(4000);

    const stats = backend.getStats();
    expect(stats.gooseFrames).toBe(3);
    expect(stats.nonGooseFrames).toBe(1);
    expect(stats.clockFallbacks).toBe(0);
    expect(backend.getBufferedBytes()).toBe(0);
  });

  it("reports 'unavailable' instead of running when the tool is missing", async () => {
    const backend = new GooseLiveCaptureBackend({
      platform: "linux",
      env: { PATH: "/nonexistent" },
    });
    const subscriber = new GooseSubscriber({ backend, subscriptions: [liveSubscription] });
    await expect(subscriber.start()).resolves.toBe("unavailable");
    await subscriber.stop();
  });

  it("reports 'error' when the capture tool fails to start", async () => {
    const backend = new GooseLiveCaptureBackend({
      command: fakeCapture({ exitCode: 1, stderr: "dumpcap: Operation not permitted" }),
    });
    const subscriber = new GooseSubscriber({ backend, subscriptions: [liveSubscription] });
    await expect(subscriber.start()).resolves.toBe("error");
    await subscriber.stop();
  });
});

/** Poll until `predicate` holds, or fail the test by timing out. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for capture output");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
