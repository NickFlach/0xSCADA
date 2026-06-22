/**
 * Tick-Aware Scheduler tests (#458)
 *
 * Covers capability detection, the realtime-apply path, every fallback branch,
 * and the single-startup-warning guarantee. All host interaction is injected
 * via a fake HostProbe so these run on any platform with no real kernel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TickScheduler,
  detectRtCapability,
  normalizeConfig,
  configFromEnv,
  PREEMPTION_SYSFS,
  type HostProbe,
  type SchedPolicy,
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

function makeProbe(opts: FakeProbeOptions = {}): { probe: HostProbe } {
  const files = opts.files ?? {};
  const existing = new Set(opts.existing ?? []);
  const probe: HostProbe = {
    platform: () => opts.platform ?? 'linux',
    readFile: (p) => (p in files ? files[p] : null),
    fileExists: (p) => existing.has(p),
    unameRelease: () => opts.release ?? '6.1.0-generic',
    unameVersion: () => opts.version ?? '#1 SMP Debian',
    pid: () => 4242,
    applyRtPolicy: (pid, policy, priority) => {
      if (opts.applyImpl) return opts.applyImpl(pid, policy, priority);
      return opts.applyResult ?? null;
    },
  };
  return { probe };
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
    const sched = new TickScheduler({ priority: 70 }, probe);
    const status = sched.apply();

    expect(status.mode).toBe('realtime');
    expect(status.applied).toBe(true);
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
    new TickScheduler({ priority: 55, policy: 'SCHED_FIFO' }, probe).apply();
    expect(apply).toHaveBeenCalledWith(4242, 'SCHED_FIFO', 55);
  });
});

describe('TickScheduler.apply — fallback paths', () => {
  it('falls back on a stock kernel and warns exactly once', () => {
    const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const { probe } = makeProbe({ existing: [CHRT] });
    const sched = new TickScheduler({}, probe);

    const status = sched.apply();
    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.policy).toBe('SCHED_OTHER');

    // Idempotent: repeated apply() must not re-warn or change the decision.
    sched.apply();
    sched.apply();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back on non-Linux without invoking the syscall', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({ platform: 'win32', applyImpl: apply });
    const status = new TickScheduler({}, probe).apply();
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
    const status = new TickScheduler({}, probe).apply();
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
    const status = new TickScheduler({}, probe).apply();
    expect(status.mode).toBe('fallback');
    expect(status.applied).toBe(false);
    expect(status.error).toMatch(/Operation not permitted/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('honours forceFallback even on an RT kernel', () => {
    vi.spyOn(logger, 'logWarn').mockImplementation(() => {});
    const apply = vi.fn();
    const { probe } = makeProbe({
      files: { [PREEMPTION_SYSFS]: '1' },
      existing: [CHRT],
      applyImpl: apply,
    });
    const status = new TickScheduler({ forceFallback: true }, probe).apply();
    expect(status.mode).toBe('fallback');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('TickScheduler.healthSummary', () => {
  it('exposes schedulingMode realtime after a successful apply', () => {
    vi.spyOn(logger, 'logInfo').mockImplementation(() => {});
    const { probe } = makeProbe({ files: { [PREEMPTION_SYSFS]: '1' }, existing: [CHRT] });
    const sched = new TickScheduler({}, probe);
    sched.apply();
    const summary = sched.healthSummary();
    expect(summary.schedulingMode).toBe('realtime');
    expect(summary.policy).toBe('SCHED_FIFO');
    expect(summary.priority).toBe(50);
    expect(summary.realtimeKernel).toBe(true);
  });

  it('reports fallback before apply() is called', () => {
    const { probe } = makeProbe();
    const summary = new TickScheduler({}, probe).healthSummary();
    expect(summary.schedulingMode).toBe('fallback');
  });
});

describe('normalizeConfig / configFromEnv', () => {
  it('defaults priority to 50 and policy to SCHED_FIFO', () => {
    const cfg = normalizeConfig();
    expect(cfg.priority).toBe(50);
    expect(cfg.policy).toBe('SCHED_FIFO');
  });

  it('rejects out-of-range priority', () => {
    expect(() => normalizeConfig({ priority: 0 })).toThrow(/priority/);
    expect(() => normalizeConfig({ priority: 100 })).toThrow(/priority/);
    expect(() => normalizeConfig({ priority: 3.5 })).toThrow(/priority/);
  });

  it('reads priority/policy/disable from env', () => {
    const cfg = configFromEnv({
      OXSCADA_RT_PRIORITY: '80',
      OXSCADA_RT_POLICY: 'SCHED_RR',
    } as NodeJS.ProcessEnv);
    expect(cfg.priority).toBe(80);
    expect(cfg.policy).toBe('SCHED_RR');

    const disabled = configFromEnv({ OXSCADA_RT_DISABLE: '1' } as NodeJS.ProcessEnv);
    expect(disabled.forceFallback).toBe(true);
  });
});
