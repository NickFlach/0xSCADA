/**
 * Tick-Aware Scheduler (issue #458)
 *
 * Detects a PREEMPT_RT host and — **only when an operator has explicitly opted
 * in and named a dedicated control process** — pins that process to `SCHED_FIFO`.
 * Everywhere else it degrades to normal (best-effort) scheduling and says so.
 *
 * ## Safety posture (why this module has no import-time side effects)
 * `SCHED_FIFO` is a starvation-capable policy: a runaway FIFO task at priority
 * 50 preempts almost everything else on the box. Applying it to the process that
 * serves HTTP/WebSocket traffic can wedge the whole node. Therefore:
 *
 *   - Importing this module (or anything that re-exports it) performs **no**
 *     probing, no logging and no privileged call. Everything is lazy.
 *   - Real-time scheduling is **off by default** and requires
 *     `OXSCADA_RT_ENABLED=true` (repo convention: `<FEATURE>_ENABLED`).
 *   - {@link TickScheduler.apply} refuses to elevate the calling process, so an
 *     in-process control loop can never drag the API server into `SCHED_FIFO`.
 *   - Malformed configuration never throws: it is reported as a warning and
 *     resolves to fallback (fail-safe direction — no RT, no crash).
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

/** Linux real-time scheduling policy applied to the control process. */
export type SchedPolicy = 'SCHED_FIFO' | 'SCHED_RR' | 'SCHED_OTHER';

export interface SchedulerConfig {
  /** RT priority for SCHED_FIFO (1-99). Default 50, per the acceptance criteria. */
  priority: number;
  /** Scheduling policy to request on a capable kernel. Default 'SCHED_FIFO'. */
  policy: SchedPolicy;
  /**
   * Hold in fallback regardless of kernel capability. This is the DEFAULT: the
   * feature is opt-in, so anything that does not explicitly enable it stays
   * here.
   */
  forceFallback: boolean;
  /** Operator-visible explanation of why real-time scheduling is being held. */
  holdReason?: string;
}

export const DEFAULT_PRIORITY = 50;
export const MIN_PRIORITY = 1;
export const MAX_PRIORITY = 99;

/** Env var names, exported so docs/tests cannot drift from the implementation. */
export const ENV_RT_ENABLED = 'OXSCADA_RT_ENABLED';
export const ENV_RT_PRIORITY = 'OXSCADA_RT_PRIORITY';
export const ENV_RT_POLICY = 'OXSCADA_RT_POLICY';

/**
 * Safe default: fallback. Constructing a scheduler with no arguments must never
 * result in a privileged call.
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  priority: DEFAULT_PRIORITY,
  policy: 'SCHED_FIFO',
  forceFallback: true,
  holdReason: `real-time scheduling is opt-in; set ${ENV_RT_ENABLED}=true to enable it`,
};

/** Result of probing the host for real-time scheduling capability. */
export interface RtCapability {
  /** True when the running kernel is PREEMPT_RT (fully preemptible). */
  isPreemptRt: boolean;
  /** True when we have a usable mechanism to apply SCHED_FIFO (e.g. `chrt`). */
  hasSyscallPath: boolean;
  /** Raw uname strings we inspected (for diagnostics / `/health`). */
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
  /** True iff the operator opted in — i.e. real-time was actually attempted. */
  requested: boolean;
  capability: RtCapability;
  /** Populated whenever we are in fallback, so the reason is never implicit. */
  error?: string;
  pid: number;
}

/**
 * Explicit target accepted by {@link TickScheduler.apply}.
 *
 * The PID must belong to a process OTHER than the caller. `chrt` re-schedules a
 * whole process, so allowing `pid === process.pid` from inside the API server
 * would pin Express/WebSocket to `SCHED_FIFO` — precisely the failure mode this
 * module exists to prevent.
 */
export interface DedicatedSchedulerTarget {
  kind: 'dedicated-control-process';
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

/** sysfs file present on PREEMPT_RT kernels; reads `1` when RT is active. */
export const PREEMPTION_SYSFS = '/sys/kernel/realtime';
const PREEMPTION_DEBUG = '/sys/kernel/debug/sched/preempt';

/**
 * Detect whether the host can run a control process under SCHED_FIFO.
 *
 * Detection order (cheapest / most authoritative first):
 *  1. Non-Linux platform → never RT-capable.
 *  2. `/sys/kernel/realtime` == '1' → authoritative PREEMPT_RT flag.
 *  3. uname version/release contains 'PREEMPT_RT' (or legacy '-rtN' tag).
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

/**
 * Strict validator. THROWS on invalid input — it is the single definition of
 * "valid", used by {@link configFromEnv} and by the {@link TickScheduler}
 * constructor, both of which catch and degrade rather than propagate.
 */
export function normalizeConfig(partial?: Partial<SchedulerConfig>): SchedulerConfig {
  const cfg: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...partial };
  if (
    !Number.isInteger(cfg.priority)
    || cfg.priority < MIN_PRIORITY
    || cfg.priority > MAX_PRIORITY
  ) {
    throw new Error(
      `scheduler priority must be an integer in [${MIN_PRIORITY}, ${MAX_PRIORITY}], `
        + `got ${String(cfg.priority)}`,
    );
  }
  if (cfg.policy !== 'SCHED_FIFO' && cfg.policy !== 'SCHED_RR' && cfg.policy !== 'SCHED_OTHER') {
    throw new Error(`unknown scheduling policy '${String(cfg.policy)}'`);
  }
  return cfg;
}

/** Parsed environment configuration plus any operator-facing problems found. */
export interface SchedulerEnvConfig {
  config: SchedulerConfig;
  /**
   * Problems found while parsing. Empty when the environment is clean. Callers
   * log these ONCE (see {@link getScheduler}); this function never logs and
   * never throws, so it is safe to call from anywhere — including a health probe.
   */
  warnings: string[];
}

const TRUTHY = new Set(['1', 'true']);
const FALSY = new Set(['', '0', 'false']);

/**
 * Parse the opt-in flag. Unknown values are treated as DISABLED (fail-safe) and
 * reported, rather than being coerced into "enabled".
 */
function parseEnabled(raw: string | undefined, warnings: string[]): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  warnings.push(
    `${ENV_RT_ENABLED}='${raw}' is not a boolean ('true'/'1' or 'false'/'0'); `
      + `real-time scheduling stays disabled`,
  );
  return false;
}

/**
 * Parse the RT priority. Deliberately stricter than `Number()`: `''`, `'  '`,
 * `'1e2'`, `'0x40'` and `'3.5'` are all rejected rather than silently coerced
 * into a plausible-looking priority.
 *
 * Returns `null` when the value is unusable; the caller then holds in fallback.
 */
function parsePriority(raw: string | undefined, warnings: string[]): number | null {
  if (raw === undefined) return DEFAULT_PRIORITY;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    warnings.push(
      `${ENV_RT_PRIORITY}='${raw}' is not an integer in `
        + `[${MIN_PRIORITY}, ${MAX_PRIORITY}]; falling back to normal scheduling`,
    );
    return null;
  }
  const parsed = Number(value);
  if (parsed < MIN_PRIORITY || parsed > MAX_PRIORITY) {
    warnings.push(
      `${ENV_RT_PRIORITY}='${raw}' is outside the valid SCHED_FIFO range `
        + `[${MIN_PRIORITY}, ${MAX_PRIORITY}]; falling back to normal scheduling`,
    );
    return null;
  }
  return parsed;
}

/** Parse the requested policy; `null` means "unusable, hold in fallback". */
function parsePolicy(raw: string | undefined, warnings: string[]): SchedPolicy | null {
  if (raw === undefined) return 'SCHED_FIFO';
  const value = raw.trim().toUpperCase();
  if (value === 'SCHED_FIFO' || value === 'SCHED_RR' || value === 'SCHED_OTHER') {
    return value;
  }
  warnings.push(
    `${ENV_RT_POLICY}='${raw}' is not one of SCHED_FIFO / SCHED_RR / SCHED_OTHER; `
      + `falling back to normal scheduling`,
  );
  return null;
}

/**
 * Build a scheduler config from environment variables.
 *
 * PURE: no logging, no throwing, no host access. Real-time scheduling is opt-in
 * (`OXSCADA_RT_ENABLED=true`); every other outcome — unset, disabled, or
 * malformed — resolves to a held `forceFallback` config carrying a
 * human-readable `holdReason`. A malformed value therefore can never abort
 * startup.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SchedulerEnvConfig {
  const warnings: string[] = [];
  const enabled = parseEnabled(env[ENV_RT_ENABLED], warnings);
  const priority = parsePriority(env[ENV_RT_PRIORITY], warnings);
  const policy = parsePolicy(env[ENV_RT_POLICY], warnings);

  const held = (holdReason: string): SchedulerEnvConfig => ({
    config: { ...DEFAULT_SCHEDULER_CONFIG, forceFallback: true, holdReason },
    warnings,
  });

  if (warnings.length > 0) {
    return held(`invalid real-time scheduler configuration: ${warnings.join('; ')}`);
  }
  if (!enabled) {
    return held(`real-time scheduling is opt-in and ${ENV_RT_ENABLED} is not set to 'true'`);
  }
  // `priority`/`policy` are non-null here: anything that produced null also
  // pushed a warning, which was handled above.
  return {
    config: {
      priority: priority ?? DEFAULT_PRIORITY,
      policy: policy ?? 'SCHED_FIFO',
      forceFallback: false,
    },
    warnings,
  };
}

// ============================================================================
// SCHEDULER
// ============================================================================

/**
 * Tick-aware scheduler. Construct at a control-process composition root, call
 * {@link apply} with a dedicated process target, then surface
 * {@link healthSummary} in `/health`.
 *
 * Idempotent: repeated `apply()` calls do not re-warn and do not re-invoke the
 * syscall once a decision has been reached (the "single startup warning"
 * requirement is enforced here, not at the call site).
 */
export class TickScheduler {
  private readonly config: SchedulerConfig;
  private readonly probe: HostProbe;
  private readonly configError: string | null;
  private statusValue: SchedulerStatus | null = null;
  private warned = false;

  /**
   * Never throws. An invalid config degrades to a held fallback config and is
   * reported through {@link healthSummary} and the single `apply()` warning.
   */
  constructor(config?: Partial<SchedulerConfig>, probe?: HostProbe) {
    let resolved: SchedulerConfig;
    let configError: string | null = null;
    try {
      resolved = normalizeConfig(config);
    } catch (err) {
      configError =
        `invalid real-time scheduler configuration, holding in fallback: `
        + `${err instanceof Error ? err.message : String(err)}`;
      resolved = { ...DEFAULT_SCHEDULER_CONFIG, forceFallback: true, holdReason: configError };
    }
    this.config = resolved;
    this.configError = configError;
    this.probe = probe ?? createDefaultHostProbe();
  }

  /** Current scheduling mode; `'fallback'` until a successful realtime apply. */
  get mode(): SchedulingMode {
    return this.statusValue?.mode ?? 'fallback';
  }

  /**
   * Decide capability, attempt the SCHED_FIFO pin if (and only if) the operator
   * opted in AND a valid dedicated control-process target was supplied, and
   * record the resulting status. Safe to call multiple times; the warning is
   * emitted at most once.
   *
   * This is the ONLY place a privileged scheduling call can happen, and nothing
   * calls it at import time.
   */
  apply(target?: DedicatedSchedulerTarget): SchedulerStatus {
    if (this.statusValue) return this.statusValue;

    // A held configuration short-circuits BEFORE touching the host at all, so an
    // opted-out or malformed deployment does no probing and no syscall.
    if (this.config.forceFallback) {
      return this.recordFallback(
        {
          isPreemptRt: false,
          hasSyscallPath: false,
          kernelVersion: 'not probed (real-time scheduling not requested)',
          reason: 'real-time scheduling not requested',
        },
        target?.pid ?? this.probe.pid(),
        this.configError ?? this.config.holdReason ?? 'real-time scheduling explicitly held',
        /* requested */ false,
      );
    }

    const capability = detectRtCapability(this.probe);
    const callerPid = this.probe.pid();
    const targetIsValid =
      target?.kind === 'dedicated-control-process'
      && Number.isSafeInteger(target.pid)
      && target.pid > 0
      && target.pid !== callerPid;
    const pid = targetIsValid ? target.pid : callerPid;

    const targetHoldReason = !target
      ? 'no dedicated control process target was supplied'
      : !Number.isSafeInteger(target.pid) || target.pid <= 0
        ? `invalid dedicated control process pid ${String(target.pid)}`
        : target.pid === callerPid
          ? 'refusing to apply a process-wide real-time policy to the calling (API server) process'
          : null;

    // Unsafe/missing target or no RT kernel → fallback. No privileged syscall is
    // attempted in any of these branches.
    if (!targetIsValid || !capability.isPreemptRt || !capability.hasSyscallPath) {
      const reason =
        targetHoldReason
        ?? (!capability.isPreemptRt
          ? capability.reason
          : 'PREEMPT_RT kernel detected but no chrt(1) available to apply SCHED_FIFO');
      return this.recordFallback(capability, pid, reason, /* requested */ true);
    }

    // Capable kernel → attempt the privileged scheduler call.
    let applyError: string | null = null;
    try {
      applyError = this.probe.applyRtPolicy(pid, this.config.policy, this.config.priority);
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }

    if (applyError) {
      // RT kernel present but apply failed (e.g. missing CAP_SYS_NICE). Fall back
      // rather than crash the control plane — but make it loud, once.
      return this.recordFallback(
        capability,
        pid,
        `failed to apply ${this.config.policy}: ${applyError}`,
        /* requested */ true,
        `[scheduler] PREEMPT_RT kernel detected but could not apply ${this.config.policy} `
          + `priority ${this.config.priority} (need CAP_SYS_NICE / sufficient rtprio): `
          + `${applyError}. Falling back to best-effort scheduling.`,
      );
    }

    this.statusValue = {
      mode: 'realtime',
      policy: this.config.policy,
      priority: this.config.priority,
      applied: true,
      requested: true,
      capability,
      pid,
    };
    logInfo(
      `[scheduler] real-time mode active: dedicated control process ${pid} pinned to `
        + `${this.config.policy} priority ${this.config.priority} (${capability.reason})`,
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

  /**
   * Compact health summary suitable for embedding in the `/health` payload.
   *
   * Reports the truth and nothing more: `schedulingMode` is `'realtime'` only
   * after the privileged call actually succeeded. Before {@link apply} runs, or
   * after any fallback, it reports `'fallback'` together with the reason.
   */
  healthSummary(): SchedulerHealthSummary {
    const s = this.statusValue;
    if (!s) {
      return {
        schedulingMode: 'fallback',
        policy: 'SCHED_OTHER',
        priority: 0,
        applied: false,
        requested: false,
        realtimeKernel: false,
        reason:
          this.configError
          ?? this.config.holdReason
          ?? 'scheduler not applied: no dedicated control process target has been supplied',
      };
    }
    return {
      schedulingMode: s.mode,
      policy: s.policy,
      priority: s.priority,
      applied: s.applied,
      requested: s.requested,
      realtimeKernel: s.capability.isPreemptRt,
      reason: s.error ?? s.capability.reason,
    };
  }

  /** Record a fallback decision and emit the single startup warning. */
  private recordFallback(
    capability: RtCapability,
    pid: number,
    reason: string,
    requested: boolean,
    warning?: string,
  ): SchedulerStatus {
    this.statusValue = {
      mode: 'fallback',
      policy: 'SCHED_OTHER',
      priority: 0,
      applied: false,
      requested,
      capability,
      error: reason,
      pid,
    };
    this.warnOnce(
      warning
        ?? `[scheduler] running in FALLBACK mode (no real-time guarantees): ${reason}. `
          + `Tick jitter is still reported, but no process is pinned to SCHED_FIFO.`,
    );
    return this.statusValue;
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

/** Shape embedded in `/health` under the `scheduler` service. */
export interface SchedulerHealthSummary {
  schedulingMode: SchedulingMode;
  policy: SchedPolicy;
  priority: number;
  /** True iff the privileged call succeeded. Never inferred from the kernel. */
  applied: boolean;
  /** True iff the operator opted in and real-time was actually attempted. */
  requested: boolean;
  realtimeKernel: boolean;
  reason: string;
}

// ============================================================================
// PROCESS-WIDE SINGLETON (lazy — nothing runs at import)
// ============================================================================

let sharedScheduler: TickScheduler | null = null;

/**
 * Process-wide scheduler, built from the environment on FIRST USE.
 *
 * Constructing it performs no host probing and no privileged call — that only
 * happens inside {@link TickScheduler.apply}. Because the instance is memoised,
 * any environment-configuration warnings are logged exactly once per process.
 */
export function getScheduler(): TickScheduler {
  if (!sharedScheduler) {
    const { config, warnings } = configFromEnv();
    for (const warning of warnings) {
      logWarn(`[scheduler] ${warning}`);
    }
    sharedScheduler = new TickScheduler(config);
  }
  return sharedScheduler;
}

/**
 * Explicitly apply real-time scheduling to a dedicated control process.
 *
 * Requiring an explicit target is what keeps this out of import graphs: no
 * module can elevate the API server as a side effect of being loaded, and the
 * scheduler refuses `pid === process.pid` outright.
 */
export function applyScheduler(target: DedicatedSchedulerTarget): SchedulerStatus {
  return getScheduler().apply(target);
}

// TODO(#458 follow-up): target a single OS thread instead of the whole process.
// `chrt -p <pid>` applies to a whole process; to pin ONLY a control thread we
// need either (a) a worker_thread that calls
// `sched_setscheduler(SCHED_FIFO, gettid(), …)` via an N-API addon, or (b)
// `chrt` against the control thread's TID once the loop runs on its own thread.
// Tracked separately; the RtSyscall seam is the injection point.
