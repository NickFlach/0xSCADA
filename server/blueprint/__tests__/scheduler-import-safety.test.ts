/**
 * Import-safety regression test (#458).
 *
 * The first attempt at this issue applied real-time scheduling as a SIDE EFFECT
 * of importing `server/health`, which pinned the Express/WebSocket process to
 * SCHED_FIFO on a PREEMPT_RT host, and crashed at import when
 * `OXSCADA_RT_PRIORITY` was malformed.
 *
 * This test locks both properties down at the seam where it would actually
 * happen: `chrt(1)` is only ever reached through `spawnSync`, so we mock
 * `node:child_process` and assert the process spawn count across a module load
 * performed with real-time scheduling fully enabled in the environment.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({
    status: 0,
    stdout: '',
    stderr: '',
    signal: null,
    pid: 1,
    output: [],
  })),
}));

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const ENV_KEYS = ['OXSCADA_RT_ENABLED', 'OXSCADA_RT_PRIORITY', 'OXSCADA_RT_POLICY'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  spawnSyncMock.mockClear();
  vi.resetModules();
});

describe('server/blueprint import safety (#458)', () => {
  it('importing the barrel with real-time ENABLED spawns no process', async () => {
    setEnv({
      OXSCADA_RT_ENABLED: 'true',
      OXSCADA_RT_PRIORITY: '50',
      OXSCADA_RT_POLICY: 'SCHED_FIFO',
    });
    vi.resetModules();

    const mod = await import('../index');

    // The whole point: loading the module graph must not touch scheduling.
    expect(spawnSyncMock).not.toHaveBeenCalled();
    // The spawn assertion alone is host-dependent — on a non-PREEMPT_RT test box
    // an import-time apply() would fall back before reaching chrt and would slip
    // through. `status()` is the host-independent discriminator: it throws until
    // apply() has recorded a decision, so this fails on ANY host the moment an
    // import-time apply() is reintroduced.
    expect(() => mod.getScheduler().status()).toThrow(/before apply\(\)/);
    // …and the shared scheduler must still report the honest, unapplied state.
    expect(mod.getScheduler().healthSummary().schedulingMode).toBe('fallback');
    expect(mod.getScheduler().healthSummary().applied).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('the spawn seam is genuinely observable (non-vacuous control)', async () => {
    setEnv({ OXSCADA_RT_ENABLED: 'true', OXSCADA_RT_PRIORITY: '50' });
    vi.resetModules();

    const mod = await import('../index');
    const err = mod.chrtSyscall.apply(4343, 'SCHED_FIFO', 50);

    expect(err).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'chrt',
      ['-f', '-p', '50', '4343'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('importing with a MALFORMED priority does not throw', async () => {
    setEnv({ OXSCADA_RT_ENABLED: 'true', OXSCADA_RT_PRIORITY: 'not-a-number' });
    vi.resetModules();

    await expect(import('../index')).resolves.toBeDefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('a malformed priority also cannot crash the first getScheduler() call', async () => {
    setEnv({ OXSCADA_RT_ENABLED: 'true', OXSCADA_RT_PRIORITY: '9999' });
    vi.resetModules();

    const mod = await import('../index');
    const freshLogger = await import('../../logger');
    const warnSpy = vi.spyOn(freshLogger, 'logWarn').mockImplementation(() => {});

    expect(() => mod.getScheduler()).not.toThrow();
    expect(mod.getScheduler().healthSummary().schedulingMode).toBe('fallback');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
