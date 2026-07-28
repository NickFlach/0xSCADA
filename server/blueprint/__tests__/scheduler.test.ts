/**
 * Tick-Aware Scheduler tests (#458)
 *
 * Covers capability detection, the realtime-apply path, every fallback branch,
 * the single-startup-warning guarantee, and — the regression this issue was
 * reopened for — that malformed `OXSCADA_RT_*` configuration NEVER throws and
 * always degrades to normal scheduling.
 *
 * All host interaction is injected via a fake HostProbe so these run on any
 * platform with no real kernel and no child process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TickScheduler,
  detectRtCapability,
  normalizeConfig,
  configFromEnv,
  DEFAULT_PRIORITY,
  DEFAULT_SCHEDULER_CONFIG,
  ENV_RT_ENABLED,
  ENV_RT_POLICY,
  ENV_RT_PRIORITY,
  PREEMPTION_SYSFS,
  type HostProbe,
  type SchedPolicy,
  type SchedulerConfig,
} from '../scheduler';

// Spy on the logger so we can assert the "single startup warning" requirement.
import * as logger from '../../logger';

interface FakeProbeOptions {
  platform?: NodeJS.Platform;
  files?: Record<string, string>;
  existing?: string[];
  release?: string;
  version?: string;
  applyResult?: string | null;
  applyImpl?: (pid: number, policy: SchedPolicy, priority: number) => string | null;
}

const DEDICATED_TARGET = {
  kind: 'dedicated-control-process' as const,
  pid: 4343,
};

/** An opted-in config — the tests that exercise the RT path need this. */
const OPTED_IN: Partial<SchedulerConfig> = { forceFallback: false };

interface FakeProbe {
  probe: HostProbe;
  /** Counts every host observation, so "did we probe at all?" is assertable. */
  probeCalls: () => number;
}

function makeProbe(opts: FakeProbeOptions = {}): FakeProbe {
  const files = opts.files ?? {};
  const existing = new Set(opts.existing ?? []);
  let calls = 0;
  const count = <T>(value: T): T => {
    calls += 1;
    return value;
  };
  const probe: HostProbe = {
    platform: () => count(opts.platform ?? 'linux'),
    readFile: (p) => count(p in files ? files[p] : null),
    fileExists: (p) => count(existing.has(p)),
    unameRelease: () => count(opts.release ?? '6.1.0-generic'),
    unameVersion: () => count(opts.version ?? '#1 SMP Debian'),
    pid: () => 4242,
    applyRtPolicy: (pid, policy, priority) => {
      calls += 1;
      if (opts.applyImpl) return opts.applyImpl(pid, policy, priority);
      return opts.applyResult ?? null;
    },
  };
  return { probe, probeCalls: () => calls };
}

const CHRT = '/usr/bin/chrt';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('detectRtCapability', () => {
  it('reports non-Linux platforms as not RT-capable', () => {
    const { probe } = makeProbe({ platform: 'win32' });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(false);
    expect(cap.hasSyscallPath).toBe(false);
    expect(cap.reason).toMatch(/non-Linux/);
  });

  it('detects PREEMPT_RT via /sys/kernel/realtime == 1', () => {
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1\n' },
      existing: [CHRT],
    });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(true);
    expect(cap.hasSyscallPath).toBe(true);
    expect(cap.reason).toContain(PREEMPTION_SYSFS);
  });

  it('detects PREEMPT_RT via uname version string', () => {
    const { probe } = makeProbe({
      version: '#1 SMP PREEMPT_RT Tue ...',
      existing: [CHRT],
    });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(true);
    expect(cap.reason).toMatch(/uname/);
  });

  it('detects legacy -rtN kernels via uname release', () => {
    const { probe } = makeProbe({ release: '5.15.0-rt17-amd64', existing: [CHRT] });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(true);
  });

  it('detects RT via debugfs preempt model', () => {
    const { probe } = makeProbe({
      files: { '/sys/kernel/debug/sched/preempt': 'none voluntary full (rt)' },
      existing: [CHRT],
    });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(true);
  });

  it('reports a stock kernel as not RT but still notes chrt availability', () => {
    const { probe } = makeProbe({ existing: [CHRT] });
    const cap = detectRtCapability(probe);
    expect(cap.isPreemptRt).toBe(false);
    expect(cap.hasSyscallPath).toBe(true);
    expect(cap.reason).toMatch(/stock/);
  });
});

describe('TickScheduler.apply — realtime path', () => {
  it('applies SCHED_FIFO at the configured priority on an RT kernel', () => {
    const infoSpy = vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
    });
    const sched = new TickScheduler({ ...OPTED_IN, priority: 70 }, probe);
    const status = sched.apply(DEDICATED_TARGET);

    expect(status.mode).toBe('realtime');
    expect(status.applied).toBe(true);
    expect(status.requested).toBe(true);
    expect(status.policy).toBe('SCHED_FIFO');
    expect(status.priority).toBe(70);
    expect(sched.mode).toBe('realtime');
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the configured pid/policy/priority to the syscall', () => {
    vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
    const apply = vi.fn().mockReturnValue(null);
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });
    new TickScheduler({ ...OPTED_IN, priority: 55, policy: 'SCHED_FIFO' }, probe)
      .apply(DEDICATED_TARGET);
    expect(apply).toHaveBeenCalledWith(4343, 'SCHED_FIFO', 55);
  });
});

describe('TickScheduler.apply — opt-in gating', () => {
  it('holds in fallback by DEFAULT and never touches the host', () => {
    const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe, probeCalls } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });

    // No config at all → the opt-in default (forceFallback) must win even on a
    // fully RT-capable host with a valid dedicated target.
    const status = new TickScheduler(undefined, probe).apply(DEDICATED_TARGET);

    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.requested).toBe(false);
    expect(status.error).toMatch(new RegExp(ENV_RT_ENABLED));
    expect(apply).not.toHaveBeenCalled();
    expect(probeCalls()).toBe(0); // not even kernel detection ran
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('DEFAULT_SCHEDULER_CONFIG is fail-safe (held, priority 50, SCHED_FIFO)', () => {
    expect(DEFAULT_SCHEDULER_CONFIG.forceFallback).toBe(true);
    expect(DEFAULT_SCHEDULER_CONFIG.priority).toBe(DEFAULT_PRIORITY);
    expect(DEFAULT_SCHEDULER_CONFIG.policy).toBe('SCHED_FIFO');
  });
});

describe('TickScheduler.apply — fallback paths', () => {
  it('falls back on a stock kernel and warns exactly once', () => {
    const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe({ existing: [CHRT] });
    const sched = new TickScheduler(OPTED_IN, probe);

    const status = sched.apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.requested).toBe(true);
    expect(status.policy).toBe('SCHED_OTHER');

    // Idempotent: repeated apply() must not re-warn or change the decision.
    sched.apply(DEDICATED_TARGET);
    sched.apply(DEDICATED_TARGET);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back on non-Linux without invoking the syscall', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({ platform: 'win32', applyImpl: apply });
    const status = new TickScheduler(OPTED_IN, probe).apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(apply).not.toHaveBeenCalled();
  });

  it('falls back when RT kernel but chrt is missing', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [], // no chrt
      applyImpl: apply,
    });
    const status = new TickScheduler(OPTED_IN, probe).apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(status.error).toMatch(/chrt/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('falls back (not crash) when the syscall reports an error', () => {
    const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyResult: 'Operation not permitted',
    });
    const status = new TickScheduler(OPTED_IN, probe).apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.error).toMatch(/Operation not permitted/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back (not crash) when the syscall throws', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: () => {
        throw new Error('chrt: command not found');
      },
    });
    const status = new TickScheduler(OPTED_IN, probe).apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(status.error).toMatch(/command not found/);
  });

  it('refuses to apply RT scheduling without a dedicated process target', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });

    const status = new TickScheduler(OPTED_IN, probe).apply();

    expect(status.mode).toBe('fallback');
    expect(status.error).toMatch(/no dedicated control process/i);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to target the calling (API server) process pid', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });

    const status = new TickScheduler(OPTED_IN, probe).apply({
      kind: 'dedicated-control-process',
      pid: 4242, // === probe.pid()
    });

    expect(status.mode).toBe('fallback');
    expect(status.error).toMatch(/calling \(API server\) process/i);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses a nonsensical pid', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });
    const status = new TickScheduler(OPTED_IN, probe).apply({
      kind: 'dedicated-control-process',
      pid: -1,
    });
    expect(status.mode).toBe('fallback');
    expect(status.error).toMatch(/invalid dedicated control process pid/i);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('TickScheduler.healthSummary', () => {
  it('exposes schedulingMode realtime after a successful apply', () => {
    vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
    const { probe } = makeProbe({ files: { [PREEMPTION_SYSFS]: '1' }, existing: [CHRT] });
    const sched = new TickScheduler(OPTED_IN, probe);
    sched.apply(DEDICATED_TARGET);
    const summary = sched.healthSummary();
    expect(summary.schedulingMode).toBe('realtime');
    expect(summary.policy).toBe('SCHED_FIFO');
    expect(summary.priority).toBe(DEFAULT_PRIORITY);
    expect(summary.applied).toBe(true);
    expect(summary.requested).toBe(true);
    expect(summary.realtimeKernel).toBe(true);
  });

  it('reports fallback before apply() is called', () => {
    const { probe } = makeProbe();
    const summary = new TickScheduler(OPTED_IN, probe).healthSummary();
    expect(summary.schedulingMode).toBe('fallback');
    expect(summary.applied).toBe(false);
  });

  it('never implies realtime when the apply failed on an RT kernel', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyResult: 'Operation not permitted',
    });
    const sched = new TickScheduler(OPTED_IN, probe);
    sched.apply(DEDICATED_TARGET);
    const summary = sched.healthSummary();
    // The kernel IS realtime, but we did not get the policy — say so.
    expect(summary.realtimeKernel).toBe(true);
    expect(summary.schedulingMode).toBe('fallback');
    expect(summary.applied).toBe(false);
    expect(summary.policy).toBe('SCHED_OTHER');
    expect(summary.priority).toBe(0);
  });
});

describe('normalizeConfig', () => {
  it('defaults priority to 50 and policy to SCHED_FIFO', () => {
    const cfg = normalizeConfig();
    expect(cfg.priority).toBe(DEFAULT_PRIORITY);
    expect(cfg.policy).toBe('SCHED_FIFO');
  });

  it('rejects out-of-range priority', () => {
    expect(() => normalizeConfig({ priority: 0 })).toThrow(/priority/);
    expect(() => normalizeConfig({ priority: 100 })).toThrow(/priority/);
    expect(() => normalizeConfig({ priority: 3.5 })).toThrow(/priority/);
    expect(() => normalizeConfig({ priority: Number.NaN })).toThrow(/priority/);
  });

  it('rejects an unknown policy', () => {
    expect(() => normalizeConfig({ policy: 'SCHED_DEADLINE' as SchedPolicy })).toThrow(/policy/);
  });
});

describe('configFromEnv — opt-in and malformed-value handling (#458 regression)', () => {
  it('is OFF by default: an empty environment holds in fallback', () => {
    const { config, warnings } = configFromEnv({} as NodeJS.ProcessEnv);
    expect(config.forceFallback).toBe(true);
    expect(config.holdReason).toMatch(/opt-in/i);
    expect(warnings).toEqual([]); // "not enabled" is not an error
  });

  it('enables real-time only for an explicit true/1', () => {
    for (const raw of ['true', 'TRUE', ' true ', '1']) {
      const { config, warnings } = configFromEnv({
        [ENV_RT_ENABLED]: raw,
      } as NodeJS.ProcessEnv);
      expect(config.forceFallback, raw).toBe(false);
      expect(warnings, raw).toEqual([]);
    }
    for (const raw of ['false', '0', '']) {
      const { config } = configFromEnv({ [ENV_RT_ENABLED]: raw } as NodeJS.ProcessEnv);
      expect(config.forceFallback, raw).toBe(true);
    }
  });

  it('reads a valid priority and policy', () => {
    const { config, warnings } = configFromEnv({
      [ENV_RT_ENABLED]: 'true',
      [ENV_RT_PRIORITY]: '80',
      [ENV_RT_POLICY]: 'SCHED_RR',
    } as NodeJS.ProcessEnv);
    expect(config.priority).toBe(80);
    expect(config.policy).toBe('SCHED_RR');
    expect(config.forceFallback).toBe(false);
    expect(warnings).toEqual([]);
  });

  // This is the exact defect the maintainer rejected the first attempt for:
  // a malformed OXSCADA_RT_PRIORITY crashed the server at import. It must not
  // throw, must warn clearly, and must degrade to normal scheduling.
  const MALFORMED_PRIORITIES = [
    'not-an-integer',
    '', // empty
    '   ', // whitespace only
    '0', // below the SCHED_FIFO range
    '100', // above the SCHED_FIFO range
    '-5', // negative
    '3.5', // non-integer
    'NaN',
    'Infinity',
    '1e2', // Number() would make this 100 — out of range, and not an integer literal
    '0x40', // Number() would make this a plausible-looking 64; still rejected
    '50; rm -rf /', // injection-shaped
  ];

  it.each(MALFORMED_PRIORITIES)(
    'never throws for OXSCADA_RT_PRIORITY=%j and falls back to normal scheduling',
    (raw) => {
      const env = {
        [ENV_RT_ENABLED]: 'true',
        [ENV_RT_PRIORITY]: raw,
      } as NodeJS.ProcessEnv;

      expect(() => configFromEnv(env)).not.toThrow();

      const { config, warnings } = configFromEnv(env);
      expect(config.forceFallback).toBe(true);
      expect(config.priority).toBe(DEFAULT_PRIORITY);
      expect(config.holdReason).toContain(ENV_RT_PRIORITY);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain(ENV_RT_PRIORITY);
    },
  );

  it('never throws for a malformed OXSCADA_RT_POLICY', () => {
    const env = {
      [ENV_RT_ENABLED]: 'true',
      [ENV_RT_POLICY]: 'SCHED_DEADLINE',
    } as NodeJS.ProcessEnv;
    expect(() => configFromEnv(env)).not.toThrow();
    const { config, warnings } = configFromEnv(env);
    expect(config.forceFallback).toBe(true);
    expect(warnings[0]).toContain(ENV_RT_POLICY);
  });

  it('treats a non-boolean OXSCADA_RT_ENABLED as disabled and reports it', () => {
    const { config, warnings } = configFromEnv({
      [ENV_RT_ENABLED]: 'yes-please',
    } as NodeJS.ProcessEnv);
    expect(config.forceFallback).toBe(true);
    expect(warnings[0]).toContain(ENV_RT_ENABLED);
  });

  it('does not log — callers decide when to warn (so health probes stay quiet)', () => {
    const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    configFromEnv({
      [ENV_RT_ENABLED]: 'true',
      [ENV_RT_PRIORITY]: 'garbage',
    } as NodeJS.ProcessEnv);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('TickScheduler constructor — never throws on bad config (#458 regression)', () => {
  it('degrades an out-of-range priority instead of throwing', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe, probeCalls } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
    });

    let sched!: TickScheduler;
    expect(() => {
      sched = new TickScheduler({ priority: 999, forceFallback: false }, probe);
    }).not.toThrow();

    const summary = sched.healthSummary();
    expect(summary.schedulingMode).toBe('fallback');
    expect(summary.reason).toMatch(/invalid real-time scheduler configuration/i);

    const status = sched.apply(DEDICATED_TARGET);
    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(probeCalls()).toBe(0);
  });

  it('degrades an unknown policy instead of throwing', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe();
    expect(
      () => new TickScheduler({ policy: 'SCHED_DEADLINE' as SchedPolicy }, probe),
    ).not.toThrow();
  });
});

describe('getScheduler — lazy singleton, warns once, never throws', () => {
  const ENV_KEYS = [ENV_RT_ENABLED, ENV_RT_PRIORITY, ENV_RT_POLICY] as const;

  /** Load a pristine copy of the scheduler module under a given environment. */
  async function loadWithEnv(env: Record<string, string | undefined>) {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      const value = env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    const freshLogger = await import('../../logger');
    const warnSpy = vi.spyOn(freshLogger, 'logWarn').mockImplementation(() => {});
    const mod = await import('../scheduler');
    const restore = (): void => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.restoreAllMocks();
      vi.resetModules();
    };
    return { mod, warnSpy, restore };
  }

  it('does not throw and warns exactly once on a malformed priority', async () => {
    const { mod, warnSpy, restore } = await loadWithEnv({
      [ENV_RT_ENABLED]: 'true',
      [ENV_RT_PRIORITY]: 'definitely-not-a-number',
      [ENV_RT_POLICY]: undefined,
    });
    try {
      expect(() => mod.getScheduler()).not.toThrow();
      // Memoised: repeated access must not re-warn.
      mod.getScheduler();
      mod.getScheduler();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(ENV_RT_PRIORITY);

      const summary = mod.getScheduler().healthSummary();
      expect(summary.schedulingMode).toBe('fallback');
      expect(summary.applied).toBe(false);
    } finally {
      restore();
    }
  });

  it('is silent and held when real-time scheduling is simply not enabled', async () => {
    const { mod, warnSpy, restore } = await loadWithEnv({
      [ENV_RT_ENABLED]: undefined,
      [ENV_RT_PRIORITY]: undefined,
      [ENV_RT_POLICY]: undefined,
    });
    try {
      const summary = mod.getScheduler().healthSummary();
      expect(summary.schedulingMode).toBe('fallback');
      expect(summary.requested).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('applyScheduler refuses the calling process even when opted in', async () => {
    const { mod, restore } = await loadWithEnv({
      [ENV_RT_ENABLED]: 'true',
      [ENV_RT_PRIORITY]: '50',
      [ENV_RT_POLICY]: undefined,
    });
    try {
      const status = mod.applyScheduler({
        kind: 'dedicated-control-process',
        pid: process.pid,
      });
      expect(status.mode).toBe('fallback');
      expect(status.applied).toBe(false);
    } finally {
      restore();
    }
  });
});
