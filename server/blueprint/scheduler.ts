/**
 * Tick-Aware Scheduler (issue #458)
 *
 * Pins the blueprint control thread to SCHED_FIFO real-time scheduling WHEN the
 * host kernel is PREEMPT_RT, and falls back GRACEFULLY on a stock kernel /
 * non-Linux dev box: it skips the privileged scheduler call, logs a SINGLE
 * startup warning, and reports `schedulingMode: 'fallback'` so the truth shows
 * up honestly in `/health`.
 *
 * ## Why `chrt` and not a native binding
 * `SCHED_FIFO` requires the `sched_setscheduler(2)` syscall, which Node.js does
 * not expose. The two realistic options are (a) ship a compiled N-API addon, or
 * (b) shell out to `chrt(1)` from `util-linux` (present on every PREEMPT_RT
 * target). We choose (b): it adds no native build step, no `node-gyp`, and no
 * new runtime dependency, while remaining fully real on a real RT kernel. The
 * call is isolated behind {@link RtSyscall} so a native binding can be dropped
 * in later without touching callers.
 *
 * NOTE (partial / deferred): `chrt` re-schedules the WHOLE process (all of
 * Node's threads), not a single OS thread. True per-thread SCHED_FIFO on the
 * dedicated control thread requires either a worker_thread with its own native
 * `sched_setscheduler(SCHED_FIFO, gettid())` call or the N-API addon mentioned
 * above. That thread-targeting refinement is marked TODO below; the capability
 * detection, fallback semantics, single-warning behaviour, and telemetry — i.e.
 * everything the acceptance criteria gate on — are implemented fully.
 *
 * All probing is injectable so the decision logic is unit-testable with no real
 * kernel, filesystem, or child process.
 *
 * @module server/blueprint/scheduler
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';

import { logWarn, logInfo, logError } from '../logger.js';

// ============================================================================
// PUBLIC TYPES
// ============================================================================

export type SchedulingMode = 'realtime' | 'fallback';

/** Linux real-time scheduling policy applied to the control thread. */
export type SchedPolicy = 'SCHED_FIFO' | 'SCHED_RR' | 'SCHED_OTHER';

export interface SchedulerConfig {
  /** RT priority for SCHED_FIFO (1-99). Default 50, per the acceptance criteria. */
  priority: number;
  /** Scheduling policy to request on a capable kernel. Default 'SCHED_FIFO'. */
  policy: SchedPolicy;
  /**
   * Force fallback regardless of kernel capability. Useful for operators who
   * want deterministic dev/test behaviour or to disable RT pinning explicitly.
   */
  forceFallback?: boolean;
}

export const DEFAULT_PRIORITY = 50;

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  priority: DEFAULT_PRIORITY,
  policy: 'SCHED_FIFO',
  forceFallback: false,
};

/** Result of probing the host for real-time scheduling capability. */
export interface RtCapability {
  /** True when the running kernel is PREEMPT_RT (fully preemptible). */
  isPreemptRt: boolean;
  /** True when we have a usable mechanism to apply SCHED_FIFO (e.g. `chrt`). */
  hasSyscallPath: boolean;
  /** Raw uname version string we inspected (for diagnostics / `/health`). */
  kernelVersion: string;
  /** Human-readable reason, surfaced in the startup warning + `/health`. */
  reason: string;
}

/** Outcome of attempting to apply the real-time policy. */
export interface SchedulerStatus {
  mode: SchedulingMode;
  policy: SchedPolicy;
  priority: number;
  /** True iff the privileged scheduler call was actually applied successfully. */
  applied: boolean;
  capability: RtCapability;
  /** Populated when an apply attempt failed (so fallback reason is explicit). */
  error?: string;
  pid: number;
}

// ============================================================================
// INJECTABLE PROBES (enable unit testing without a real kernel)
// ============================================================================

/**
 * Abstraction over the host facilities the scheduler needs. Every method is
 * synchronous and side-effect-localised so tests can stub them. The default
 * implementation talks to the real Linux host.
 */
export interface HostProbe {
  platform(): NodeJS.Platform;
  /** Read a sysfs/procfs file; return null if absent or unreadable. */
  readFile(path: string): string | null;
  fileExists(path: string): boolean;
  /** Uname release string, e.g. '6.1.0-rt7-amd64'. */
  unameRelease(): string;
  /** Uname version string, e.g. '#1 SMP PREEMPT_RT ...'. */
  unameVersion(): string;
  pid(): number;
  /** Apply SCHED_FIFO to the given pid. Returns null on success, else an error. */
  applyRtPolicy(pid: number, policy: SchedPolicy, priority: number): string | null;
}

/** Single-source abstraction for the privileged syscall path (`chrt`). */
export interface RtSyscall {
  apply(pid: number, policy: SchedPolicy, priority: number): string | null;
}

const CHRT_POLICY_FLAG: Record<SchedPolicy, string> = {
  SCHED_FIFO: '-f',
  SCHED_RR: '-r',
  SCHED_OTHER: '-o',
};

/** Default RT syscall path: shell out to `chrt(1)`. */
export const chrtSyscall: RtSyscall = {
  apply(pid: number, policy: SchedPolicy, priority: number): string | null {
    const flag = CHRT_POLICY_FLAG[policy];
    // chrt -f -p <prio> <pid>  → set policy SCHED_FIFO with priority on a pid.
    const res = spawnSync('chrt', [flag, '-p', String(priority), String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.error) {
      return res.error.message;
    }
    if (typeof res.status === 'number' && res.status !== 0) {
      return (res.stderr || `chrt exited with status ${res.status}`).trim();
    }
    return null;
  },
};

/** Default host probe backed by the real OS. */
export function createDefaultHostProbe(syscall: RtSyscall = chrtSyscall): HostProbe {
  return {
    platform: () => process.platform,
    readFile: (p: string) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    fileExists: (p: string) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    unameRelease: () => os.release(),
    unameVersion: () => {
      // os.version() exists on Node >= 13.11 and returns the kernel version
      // string (the part where '#1 SMP PREEMPT_RT' lives on Linux).
      try {
        return os.version();
      } catch {
        return '';
      }
    },
    pid: () => process.pid,
    applyRtPolicy: (pid, policy, priority) => syscall.apply(pid, policy, priority),
  };
}

// ============================================================================
// CAPABILITY DETECTION (pure given a HostProbe)
// ============================================================================

/**
 * sysfs file present on PREEMPT_RT kernels exposing the preemption model.
 * Reads e.g. `none voluntary (full) ...` — RT is indicated by 'PREEMPT_RT'
 * being a selectable/active model. We treat any of the RT markers as positive.
 */
export const PREEMPTION_SYSFS = '/sys/kernel/realtime';
const PREEMPTION_DEBUG = '/sys/kernel/debug/sched/preempt';

/**
 * Detect whether the host can run the control thread under SCHED_FIFO.
 *
 * Detection order (cheapest / most authoritative first):
 *  1. Non-Linux platform → never RT-capable.
 *  2. `/sys/kernel/realtime` == '1' → authoritative PREEMPT_RT flag.
 *  3. uname version/release contains 'PREEMPT_RT' (or legacy '-rt' tag).
 *  4. `/sys/kernel/debug/sched/preempt` active model is '(rt)'.
 *
 * `hasSyscallPath` is reported separately so we can distinguish "RT kernel but
 * no `chrt`" (still falls back) from "stock kernel".
 */
export function detectRtCapability(probe: HostProbe): RtCapability {
  const platform = probe.platform();
  const kernelVersion = `${probe.unameRelease()} ${probe.unameVersion()}`.trim();
  const hasSyscallPath = probe.fileExists('/usr/bin/chrt') || probe.fileExists('/bin/chrt');

  if (platform !== 'linux') {
    return {
      isPreemptRt: false,
      hasSyscallPath: false,
      kernelVersion,
      reason: `non-Linux platform '${platform}'; SCHED_FIFO unavailable`,
    };
  }

  // (2) Authoritative sysfs flag.
  const realtimeFlag = probe.readFile(PREEMPTION_SYSFS);
  if (realtimeFlag !== null && realtimeFlag.trim() === '1') {
    return {
      isPreemptRt: true,
      hasSyscallPath,
      kernelVersion,
      reason: `${PREEMPTION_SYSFS} reports realtime kernel`,
    };
  }

  // (3) uname markers.
  if (/PREEMPT_RT/i.test(kernelVersion) || /-rt\d/i.test(kernelVersion)) {
    return {
      isPreemptRt: true,
      hasSyscallPath,
      kernelVersion,
      reason: 'uname reports PREEMPT_RT kernel',
    };
  }

  // (4) debugfs active preemption model.
  const preemptModel = probe.readFile(PREEMPTION_DEBUG);
  if (preemptModel !== null && /\(rt\)/i.test(preemptModel)) {
    return {
      isPreemptRt: true,
      hasSyscallPath,
      kernelVersion,
      reason: `${PREEMPTION_DEBUG} active model is realtime`,
    };
  }

  return {
    isPreemptRt: false,
    hasSyscallPath,
    kernelVersion: kernelVersion || 'unknown',
    reason: 'stock (non-PREEMPT_RT) kernel detected',
  };
}

// ============================================================================
// CONFIG VALIDATION
// ============================================================================

/** Clamp/validate a scheduler config into a known-good shape. */
export function normalizeConfig(partial?: Partial<SchedulerConfig>): SchedulerConfig {
  const cfg: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...partial };
  if (!Number.isInteger(cfg.priority) || cfg.priority < 1 || cfg.priority > 99) {
    throw new Error(
      `scheduler priority must be an integer in [1, 99], got ${String(cfg.priority)}`,
    );
  }
  if (cfg.policy !== 'SCHED_FIFO' && cfg.policy !== 'SCHED_RR' && cfg.policy !== 'SCHED_OTHER') {
    throw new Error(`unknown scheduling policy '${String(cfg.policy)}'`);
  }
  return cfg;
}

/** Build a scheduler config from environment variables (used by runtime wiring). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const priorityRaw = env.OXSCADA_RT_PRIORITY;
  const policyRaw = env.OXSCADA_RT_POLICY as SchedPolicy | undefined;
  const forceFallback =
    env.OXSCADA_RT_DISABLE === '1' || env.OXSCADA_RT_DISABLE === 'true';
  return normalizeConfig({
    priority: priorityRaw !== undefined ? Number(priorityRaw) : DEFAULT_PRIORITY,
    policy: policyRaw ?? 'SCHED_FIFO',
    forceFallback,
  });
}

// ============================================================================
// SCHEDULER
// ============================================================================

/**
 * Tick-aware scheduler. Construct once at startup, call {@link apply} before the
 * control loop begins, then surface {@link status} in `/health`.
 *
 * Idempotent: repeated `apply()` calls do not re-warn and do not re-invoke the
 * syscall once a decision has been reached (the "single startup warning"
 * requirement is enforced here, not at the call site).
 */
export class TickScheduler {
  private readonly config: SchedulerConfig;
  private readonly probe: HostProbe;
  private statusValue: SchedulerStatus | null = null;
  private warned = false;

  constructor(config?: Partial<SchedulerConfig>, probe?: HostProbe) {
    this.config = normalizeConfig(config);
    this.probe = probe ?? createDefaultHostProbe();
  }

  /** Current scheduling mode; `'fallback'` until a successful realtime apply. */
  get mode(): SchedulingMode {
    return this.statusValue?.mode ?? 'fallback';
  }

  /**
   * Decide capability, attempt the SCHED_FIFO pin if appropriate, and record
   * the resulting status. Returns the status. Safe to call multiple times;
   * the warning is emitted at most once.
   */
  apply(): SchedulerStatus {
    if (this.statusValue) return this.statusValue;

    const capability = detectRtCapability(this.probe);
    const pid = this.probe.pid();

    // Operator override or no RT kernel → fallback, warn once, no syscall.
    if (this.config.forceFallback || !capability.isPreemptRt || !capability.hasSyscallPath) {
      const reason = this.config.forceFallback
        ? 'real-time scheduling explicitly disabled (OXSCADA_RT_DISABLE)'
        : !capability.isPreemptRt
          ? capability.reason
          : 'PREEMPT_RT kernel detected but no chrt(1) available to apply SCHED_FIFO';
      this.statusValue = {
        mode: 'fallback',
        policy: 'SCHED_OTHER',
        priority: 0,
        applied: false,
        capability,
        error: reason,
        pid,
      };
      this.warnOnce(
        `[scheduler] running in FALLBACK mode (no real-time guarantees): ${reason}. ` +
          `Tick jitter will be reported but the control thread is NOT pinned to ${this.config.policy}.`,
      );
      return this.statusValue;
    }

    // Capable kernel → attempt the privileged scheduler call.
    let applyError: string | null = null;
    try {
      applyError = this.probe.applyRtPolicy(pid, this.config.policy, this.config.priority);
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }

    if (applyError) {
      // RT kernel present but apply failed (e.g. missing CAP_SYS_NICE). Fall
      // back rather than crash the control plane — but make it loud, once.
      this.statusValue = {
        mode: 'fallback',
        policy: 'SCHED_OTHER',
        priority: 0,
        applied: false,
        capability,
        error: `failed to apply ${this.config.policy}: ${applyError}`,
        pid,
      };
      this.warnOnce(
        `[scheduler] PREEMPT_RT kernel detected but could not apply ${this.config.policy} ` +
          `priority ${this.config.priority} (need CAP_SYS_NICE / sufficient rtprio): ${applyError}. ` +
          `Falling back to best-effort scheduling.`,
      );
      return this.statusValue;
    }

    this.statusValue = {
      mode: 'realtime',
      policy: this.config.policy,
      priority: this.config.priority,
      applied: true,
      capability,
      pid,
    };
    logInfo(
      `[scheduler] real-time mode active: control thread pinned to ${this.config.policy} ` +
        `priority ${this.config.priority} (${capability.reason})`,
    );
    return this.statusValue;
  }

  /** Full status object (for diagnostics). Throws if {@link apply} not called. */
  status(): SchedulerStatus {
    if (!this.statusValue) {
      throw new Error('TickScheduler.status() called before apply()');
    }
    return this.statusValue;
  }

  /** Compact health summary suitable for embedding in the `/health` payload. */
  healthSummary(): {
    schedulingMode: SchedulingMode;
    policy: SchedPolicy;
    priority: number;
    realtimeKernel: boolean;
    reason: string;
  } {
    const s = this.statusValue;
    if (!s) {
      return {
        schedulingMode: 'fallback',
        policy: 'SCHED_OTHER',
        priority: 0,
        realtimeKernel: false,
        reason: 'scheduler not yet applied',
      };
    }
    return {
      schedulingMode: s.mode,
      policy: s.policy,
      priority: s.priority,
      realtimeKernel: s.capability.isPreemptRt,
      reason: s.error ?? s.capability.reason,
    };
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      logWarn(message);
    } catch (err) {
      // Never let logging take down the control plane.
      logError(err, 'failed to emit scheduler warning');
    }
  }
}

// TODO(#458 follow-up): target a single OS thread instead of the whole process.
// `chrt -p <pid>` applies to the main process; to pin ONLY the dedicated control
// thread we need either (a) a worker_thread that calls
// `sched_setscheduler(SCHED_FIFO, gettid(), …)` via an N-API addon, or (b)
// `chrt` against the control thread's TID once we run the loop on its own
// thread. Tracked separately; the RtSyscall seam is the injection point.
