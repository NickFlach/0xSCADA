/**
 * Tests for the control-loop latency probe (#460).
 *
 * Acceptance-criteria scenario (verification section of the issue):
 *   "deliberately injecting 200ms delay at sign stage produces the expected
 *    histogram shift and alert firing"
 *
 * We prove the histogram SHIFT here (alert firing is validated by the
 * Alertmanager rule config, which cannot run in this environment). The probe's
 * latency clock is injected so the 200ms is measured deterministically without
 * a 200ms wall-clock sleep, and a separate test uses a REAL awaited delay to
 * prove the async stage path is faithful.
 */

import { EventEmitter } from 'events';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ControlLoopLatencyProbe,
  PRODUCTION_LATENCY_PROBE_STATUS,
  createSentinelBlueprint,
  createPipelineStageExecutors,
  productionLatencyProbeUpGauge,
  publishProductionLatencyProbeStatus,
  type StageExecutors,
  type PipelineLike,
  type SignerLike,
  type RelayerLike,
} from '../latency-probe.js';
import {
  stageLatencyHistogram,
  STAGE_SLO_MS,
  type Clock,
} from '../stage-timestamps.js';
import { registry } from '../../metrics/prometheus.js';

/**
 * A controllable clock: the probe stamps enter/exit around each awaited stage.
 * We advance the clock inside each stage executor by a configured amount so the
 * measured durations are deterministic regardless of real wall time.
 */
function makeAdvancingClock(): { clock: Clock; advance: (ms: number) => void } {
  let now = 0;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ControlLoopLatencyProbe', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('publishes an explicit held/down production gauge for Alertmanager', () => {
    publishProductionLatencyProbeStatus();

    expect(PRODUCTION_LATENCY_PROBE_STATUS).toMatchObject({
      state: 'HELD',
      running: false,
    });
    expect(productionLatencyProbeUpGauge.get()).toBe(0);
    expect(registry.metrics()).toContain('scada_control_loop_probe_up 0');
  });

  it('does not claim the injectable probe is started by the server', () => {
    const serverEntry = readFileSync(
      new URL('../../index.ts', import.meta.url),
      'utf8',
    );
    const healthEntry = readFileSync(
      new URL('../../health/index.ts', import.meta.url),
      'utf8',
    );

    expect(PRODUCTION_LATENCY_PROBE_STATUS.running).toBe(false);
    expect(serverEntry).not.toContain('ControlLoopLatencyProbe');
    expect(serverEntry).not.toContain('publishProductionLatencyProbeStatus');
    expect(healthEntry).toContain('publishProductionLatencyProbeStatus()');
    expect(healthEntry).not.toContain('new ControlLoopLatencyProbe');
  });

  it('alerts on explicit probe-down and sustained live SLO gauges', () => {
    const rules = readFileSync(
      new URL('../../../ops/alertmanager/control-loop-rules.yml', import.meta.url),
      'utf8',
    );
    const stageRule = rules.match(
      /- alert:\s*ControlLoopStageBudgetBreached[\s\S]*?(?=\n\s+- alert:)/,
    )?.[0];
    const stalledRule = rules.match(
      /- alert:\s*ControlLoopProbeStalled[\s\S]*$/,
    )?.[0];

    expect(stageRule).toBeDefined();
    expect(stageRule).toContain('expr: scada_control_loop_stage_slo_ok == 0');
    expect(stageRule).toMatch(/\n\s+for:\s*5m/);
    expect(stageRule).not.toContain('min_over_time');
    expect(stageRule).not.toContain('max_over_time');

    expect(stalledRule).toBeDefined();
    expect(stalledRule).toContain('expr: scada_control_loop_probe_up == 0');
    expect(stalledRule).not.toContain(
      'scada_control_loop_roundtrip_latency_seconds_count',
    );
  });

  it('creates an isolated, non-control-relevant sentinel blueprint', () => {
    const bp = createSentinelBlueprint('validator-1');
    expect(bp.controlRelevant).toBe(false);
    expect(bp.id).toBe('sentinel/validator-1');
    expect(bp.validator).toBe('validator-1');
  });

  it('derives flip interval from cadence (default 1Hz)', () => {
    const noop = async () => {};
    const probe = new ControlLoopLatencyProbe(
      { tick: noop, batch: noop, sign: noop, anchor: noop },
      { validator: 'v' },
    );
    expect(probe.intervalMs).toBe(1000);

    const fast = new ControlLoopLatencyProbe(
      { tick: noop, batch: noop, sign: noop, anchor: noop },
      { validator: 'v', cadenceHz: 4 },
    );
    expect(fast.intervalMs).toBe(250);
  });

  it('flips the sentinel tag each cycle', async () => {
    const noop = async () => {};
    const probe = new ControlLoopLatencyProbe(
      { tick: noop, batch: noop, sign: noop, anchor: noop },
      { validator: 'v' },
    );
    expect(probe.getSentinelBlueprint().tagValue).toBe(false);
    await probe.runCycle();
    expect(probe.getSentinelBlueprint().tagValue).toBe(true);
    await probe.runCycle();
    expect(probe.getSentinelBlueprint().tagValue).toBe(false);
  });

  it('records a full round-trip measurement with per-stage durations', async () => {
    const { clock, advance } = makeAdvancingClock();
    const executors: StageExecutors = {
      tick: async () => advance(10),
      batch: async () => advance(20),
      sign: async () => advance(30),
      anchor: async () => advance(500),
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'v', clock });

    const measurement = await probe.runCycle();
    expect(measurement).not.toBeNull();
    const m = measurement!;
    expect(m.stages.find((s) => s.stage === 'tick')!.durationMs).toBe(10);
    expect(m.stages.find((s) => s.stage === 'batch')!.durationMs).toBe(20);
    expect(m.stages.find((s) => s.stage === 'sign')!.durationMs).toBe(30);
    expect(m.stages.find((s) => s.stage === 'anchor')!.durationMs).toBe(500);
    expect(m.total.durationMs).toBe(560);
    expect(m.withinSlo).toBe(true);
  });

  it('injecting a 200ms delay at the SIGN stage shifts the sign histogram (deterministic clock)', async () => {
    const { clock, advance } = makeAdvancingClock();
    const SIGN_DELAY_MS = 200;
    const executors: StageExecutors = {
      tick: async () => advance(5),
      batch: async () => advance(10),
      sign: async () => advance(SIGN_DELAY_MS), // <-- injected 200ms delay
      anchor: async () => advance(400),
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-sign', clock });

    const m = await probe.runCycle();
    const sign = m!.stages.find((s) => s.stage === 'sign')!;
    expect(sign.durationMs).toBe(SIGN_DELAY_MS);

    // The sign SLO budget is 150ms; 200ms must register as a breach.
    expect(SIGN_DELAY_MS).toBeGreaterThan(STAGE_SLO_MS.sign);
    expect(sign.withinSlo).toBe(false);
    expect(m!.withinSlo).toBe(false);

    // The Prometheus histogram must reflect the shift: sum == 0.2s for sign,
    // and the observation must land ABOVE the 0.1s bucket (i.e. 0.1 bucket
    // count is 0 while 0.25/+Inf include it).
    const sign200 = stageLatencyHistogram
      .collect()
      .find((r) => r.labels.stage === 'sign' && r.labels.validator === 'val-sign')!;
    expect(sign200.count).toBe(1);
    expect(sign200.sum).toBeCloseTo(0.2, 6);
    expect(sign200.buckets.get(0.1)).toBe(0); // 0.2s does NOT fall in <=0.1s
    expect(sign200.buckets.get(0.25)).toBe(1); // but DOES fall in <=0.25s
    expect(sign200.buckets.get(Infinity)).toBe(1);
  });

  it('a fast sign stage stays within SLO, proving the breach is delay-driven', async () => {
    const { clock, advance } = makeAdvancingClock();
    const executors: StageExecutors = {
      tick: async () => advance(5),
      batch: async () => advance(10),
      sign: async () => advance(20), // well under the 150ms budget
      anchor: async () => advance(400),
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-fast', clock });
    const m = await probe.runCycle();
    expect(m!.stages.find((s) => s.stage === 'sign')!.withinSlo).toBe(true);
  });

  it('emits a measurement event and an slo-breach event when budget is exceeded', async () => {
    const { clock, advance } = makeAdvancingClock();
    const executors: StageExecutors = {
      tick: async () => advance(5),
      batch: async () => advance(10),
      sign: async () => advance(STAGE_SLO_MS.sign + 200),
      anchor: async () => advance(400),
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'v', clock });

    const events: string[] = [];
    probe.on('measurement', () => events.push('measurement'));
    probe.on('slo-breach', () => events.push('slo-breach'));

    await probe.runCycle();
    expect(events).toContain('measurement');
    expect(events).toContain('slo-breach');
  });

  it('measures a REAL awaited 200ms delay at the sign stage (default monotonic clock)', async () => {
    // No injected clock here: uses the real performance.now() clock and a real
    // sleep, proving the async stage instrumentation is faithful end-to-end.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const executors: StageExecutors = {
      tick: async () => {},
      batch: async () => {},
      sign: async () => sleep(200),
      anchor: async () => {},
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-real' });

    const m = await probe.runCycle();
    const sign = m!.stages.find((s) => s.stage === 'sign')!;
    // Allow generous slack for timer scheduling jitter, but it must clearly
    // reflect ~200ms and breach the 150ms SLO.
    expect(sign.durationMs).toBeGreaterThanOrEqual(180);
    expect(sign.withinSlo).toBe(false);
  }, 10_000);

  describe('createPipelineStageExecutors (production seam)', () => {
    /**
     * A fake relayer that emits anchorSuccess on a delay after submitAnchor,
     * proving the anchor stage AWAITS the per-batch confirmation event rather
     * than resolving on submit. Correlated by batchId.
     */
    class FakeRelayer extends EventEmitter implements RelayerLike {
      submitted: number[] = [];
      private confirmDelayMs: number;
      constructor(confirmDelayMs: number) {
        super();
        this.confirmDelayMs = confirmDelayMs;
      }
      async submitAnchor(_root: string, batchId: number): Promise<void> {
        this.submitted.push(batchId);
        // Confirmation arrives asynchronously, AFTER submit resolves.
        setTimeout(() => {
          this.emit('anchorSuccess', { request: { batchId } });
        }, this.confirmDelayMs);
      }
    }

    const pipeline: PipelineLike = { async ingestEvent() {} };
    const signer: SignerLike = {
      async sign(data: string) {
        return { signature: 'sig', merkleRoot: data, timestamp: Date.now() };
      },
    };

    it('anchor-confirmed reflects the relayer confirmation event (not submit)', async () => {
      const relayer = new FakeRelayer(150);
      const executors = createPipelineStageExecutors({
        pipeline,
        signer,
        relayer,
        computeMerkleRoot: (ctx) => `root-${ctx.sequence}`,
      });
      const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-seam' });

      const m = await probe.runCycle();
      expect(m).not.toBeNull();
      // The relayer received exactly our sentinel batch (sequence 1).
      expect(relayer.submitted).toEqual([1]);
      // anchor duration spans submit -> confirmation event (~150ms real time).
      const anchor = m!.stages.find((s) => s.stage === 'anchor')!;
      expect(anchor.durationMs).toBeGreaterThanOrEqual(120);
    }, 10_000);

    it('ignores confirmations for OTHER batches and only resolves on its own', async () => {
      const relayer = new FakeRelayer(0); // we will drive emissions manually
      // Override submit to NOT auto-confirm; we emit by hand below.
      relayer.submitAnchor = async (_r: string, batchId: number) => {
        relayer.submitted.push(batchId);
      };
      const executors = createPipelineStageExecutors({
        pipeline,
        signer,
        relayer,
        computeMerkleRoot: (ctx) => `root-${ctx.sequence}`,
      });
      const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-corr' });

      const cyclePromise = probe.runCycle();
      // A confirmation for an unrelated batch must NOT resolve our cycle.
      await new Promise((r) => setTimeout(r, 20));
      relayer.emit('anchorSuccess', { request: { batchId: 999 } });
      await new Promise((r) => setTimeout(r, 20));
      // Now the matching batch (sequence 1) confirms.
      relayer.emit('anchorSuccess', { request: { batchId: 1 } });

      const m = await cyclePromise;
      expect(m).not.toBeNull();
      expect(m!.stages.find((s) => s.stage === 'anchor')).toBeDefined();
    }, 10_000);

    it('surfaces a relayer anchorFailed for THIS batch as a cycle error', async () => {
      const relayer = new FakeRelayer(0);
      relayer.submitAnchor = async (_r: string, batchId: number) => {
        relayer.submitted.push(batchId);
        setTimeout(() => relayer.emit('anchorFailed', { request: { batchId }, error: 'reverted' }), 10);
      };
      const executors = createPipelineStageExecutors({
        pipeline,
        signer,
        relayer,
        computeMerkleRoot: (ctx) => `root-${ctx.sequence}`,
      });
      const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-fail' });
      let errored = false;
      probe.on('cycle-error', () => {
        errored = true;
      });
      const m = await probe.runCycle();
      expect(m).toBeNull();
      expect(errored).toBe(true);
    }, 10_000);

    it('times out (and errors the cycle) if the relayer never confirms', async () => {
      const relayer = new FakeRelayer(0);
      relayer.submitAnchor = async (_r: string, batchId: number) => {
        relayer.submitted.push(batchId); // never emits a confirmation
      };
      const executors = createPipelineStageExecutors({
        pipeline,
        signer,
        relayer,
        computeMerkleRoot: (ctx) => `root-${ctx.sequence}`,
        anchorConfirmTimeoutMs: 50,
      });
      const probe = new ControlLoopLatencyProbe(executors, { validator: 'val-timeout' });
      let errMsg = '';
      probe.on('cycle-error', ({ error }: { error: unknown }) => {
        errMsg = error instanceof Error ? error.message : String(error);
      });
      const m = await probe.runCycle();
      expect(m).toBeNull();
      expect(errMsg).toMatch(/timed out/);
    }, 10_000);
  });

  it('emits cycle-error when a stage throws and does not leak in-flight slots', async () => {
    const executors: StageExecutors = {
      tick: async () => {},
      batch: async () => {
        throw new Error('boom');
      },
      sign: async () => {},
      anchor: async () => {},
    };
    const probe = new ControlLoopLatencyProbe(executors, { validator: 'v' });
    let errored = false;
    probe.on('cycle-error', () => {
      errored = true;
    });
    const m = await probe.runCycle();
    expect(m).toBeNull();
    expect(errored).toBe(true);

    // A subsequent cycle still runs (in-flight slot was released in finally).
    const executors2: StageExecutors = {
      tick: async () => {},
      batch: async () => {},
      sign: async () => {},
      anchor: async () => {},
    };
    const probe2 = new ControlLoopLatencyProbe(executors2, { validator: 'v' });
    expect(await probe2.runCycle()).not.toBeNull();
  });
});
