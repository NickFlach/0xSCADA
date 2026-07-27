/**
 * Tests for the control-loop sentinel latency probe (#460).
 *
 * The probe is the traffic source, not the measurement source: it flips an
 * isolated sentinel tag into the REAL anchor pipeline and lets that pipeline
 * time its own stages. These tests pin down the two properties the maintainer
 * review turned on:
 *
 *  1. `scada_control_loop_probe_up` is a real series in both states, so an
 *     absent probe is observable (and alertable) rather than invisible.
 *  2. The probe never manufactures a stage duration. A flip that is not
 *     confirmed is counted, never timed.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { JsonRpcProvider } from 'ethers';

import {
  ControlLoopLatencyProbe,
  createSentinelBlueprint,
  isLatencyProbeEnabled,
  readLatencyProbeConfig,
  startControlLoopLatencyProbe,
  stopControlLoopLatencyProbe,
  publishControlLoopProbeStatus,
  getControlLoopLatencyProbe,
  probeUpGauge,
  probeFlipsCounter,
  sentinelRoundTripHistogram,
  SENTINEL_EVENT_TYPE,
  MIN_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_INTERVAL_MS,
  PROBE_ENABLED_ENV,
  PROBE_INTERVAL_ENV,
  type SentinelAnchorTarget,
} from '../latency-probe.js';
import { AnchorPipeline, type AnchorLatencyEvent } from '../anchor-pipeline';
import type { AnchorContractLike } from '../relayer';
import { registry } from '../../metrics/prometheus.js';
import { stageLatencyHistogram } from '../stage-timestamps.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface IngestedEvent {
  id: string;
  type: string;
  source: string;
  data: Record<string, unknown>;
}

/** A pipeline stand-in that records ingests and lets tests emit outcomes. */
class FakeAnchorTarget extends EventEmitter implements SentinelAnchorTarget {
  readonly ingested: IngestedEvent[] = [];
  failIngest = false;

  async ingestEvent(event: IngestedEvent): Promise<void> {
    if (this.failIngest) throw new Error('pipeline not started');
    this.ingested.push(event);
  }

  /** Emit the pipeline's per-batch latency event for the given event ids. */
  settle(eventIds: string[], outcome: AnchorLatencyEvent['outcome']): void {
    const payload: AnchorLatencyEvent = {
      batchId: 1,
      eventIds,
      outcome,
      measurement: {
        traceId: 'fake',
        source: 'fake',
        stages: [],
        total: null,
        unmeasured: [],
        anomalies: [],
        complete: false,
        withinSlo: true,
      },
    };
    this.emit('anchor-latency', payload);
  }
}

describe('sentinel probe: opt-in gating', () => {
  const originalEnabled = process.env[PROBE_ENABLED_ENV];
  const originalInterval = process.env[PROBE_INTERVAL_ENV];

  afterEach(() => {
    stopControlLoopLatencyProbe();
    if (originalEnabled === undefined) delete process.env[PROBE_ENABLED_ENV];
    else process.env[PROBE_ENABLED_ENV] = originalEnabled;
    if (originalInterval === undefined) delete process.env[PROBE_INTERVAL_ENV];
    else process.env[PROBE_INTERVAL_ENV] = originalInterval;
  });

  it('is off unless explicitly opted in', () => {
    expect(isLatencyProbeEnabled({})).toBe(false);
    expect(isLatencyProbeEnabled({ [PROBE_ENABLED_ENV]: '' })).toBe(false);
    expect(isLatencyProbeEnabled({ [PROBE_ENABLED_ENV]: '1' })).toBe(false);
    expect(isLatencyProbeEnabled({ [PROBE_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(isLatencyProbeEnabled({ [PROBE_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('does not start when disabled, and leaves probe_up at 0', () => {
    registry.reset();
    const target = new FakeAnchorTarget();
    const probe = startControlLoopLatencyProbe(target, {});
    expect(probe).toBeNull();
    expect(getControlLoopLatencyProbe()).toBeNull();
    expect(probeUpGauge.get()).toBe(0);
    expect(registry.metrics()).toContain('scada_control_loop_probe_up 0');
  });

  it('does not start when opted in but no pipeline exists', () => {
    registry.reset();
    const probe = startControlLoopLatencyProbe(null, { [PROBE_ENABLED_ENV]: 'true' });
    expect(probe).toBeNull();
    expect(probeUpGauge.get()).toBe(0);
  });

  it('starts when opted in, and probe_up returns to 0 on stop', () => {
    registry.reset();
    const target = new FakeAnchorTarget();
    const probe = startControlLoopLatencyProbe(target, {
      [PROBE_ENABLED_ENV]: 'true',
      [PROBE_INTERVAL_ENV]: '250',
    });
    expect(probe).not.toBeNull();
    expect(probe!.isRunning()).toBe(true);
    expect(probe!.intervalMs).toBe(250);
    expect(probeUpGauge.get()).toBe(1);
    expect(registry.metrics()).toContain('scada_control_loop_probe_up 1');

    stopControlLoopLatencyProbe();
    expect(probeUpGauge.get()).toBe(0);
    expect(registry.metrics()).toContain('scada_control_loop_probe_up 0');
  });

  it('publishes the current status on demand (health-composition path)', () => {
    registry.reset();
    // A reset clears the value, so the exposition carries the HELP/TYPE header
    // but no sample — and Prometheus only alerts on samples. Composition
    // republishes the gauge so a real 0 sample exists on the very next scrape.
    expect(registry.metrics()).toContain('# TYPE scada_control_loop_probe_up gauge');
    expect(registry.metrics()).not.toContain('scada_control_loop_probe_up 0');
    publishControlLoopProbeStatus();
    expect(registry.metrics()).toContain('scada_control_loop_probe_up 0');
  });

  it('clamps a nonsensical cadence instead of busy-looping the pipeline', () => {
    expect(readLatencyProbeConfig({ [PROBE_INTERVAL_ENV]: '1' }).intervalMs).toBe(MIN_PROBE_INTERVAL_MS);
    expect(readLatencyProbeConfig({ [PROBE_INTERVAL_ENV]: '-5' }).intervalMs).toBe(DEFAULT_PROBE_INTERVAL_MS);
    expect(readLatencyProbeConfig({ [PROBE_INTERVAL_ENV]: 'abc' }).intervalMs).toBe(DEFAULT_PROBE_INTERVAL_MS);
    expect(readLatencyProbeConfig({}).intervalMs).toBe(DEFAULT_PROBE_INTERVAL_MS);
    expect(readLatencyProbeConfig({ [PROBE_INTERVAL_ENV]: '5000' }).intervalMs).toBe(5000);
  });
});

describe('sentinel blueprint isolation', () => {
  it('is explicitly not control-relevant', () => {
    const bp = createSentinelBlueprint('site-1');
    expect(bp.controlRelevant).toBe(false);
    expect(bp.id).toBe('sentinel/site-1');
    expect(bp.tagName).toBe('sentinel_probe_tag');
  });

  it('tags every ingested flip as sentinel traffic', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 'site-1' });
    await probe.flipOnce();

    expect(target.ingested).toHaveLength(1);
    const [event] = target.ingested;
    expect(event.type).toBe(SENTINEL_EVENT_TYPE);
    expect(event.source).toBe('sentinel/site-1');
    expect(event.data).toMatchObject({ sentinel: true, controlRelevant: false });
  });

  it('flips the tag on every cycle', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 'site-1' });
    expect(probe.getSentinelBlueprint().tagValue).toBe(false);
    await probe.flipOnce();
    expect(probe.getSentinelBlueprint().tagValue).toBe(true);
    await probe.flipOnce();
    expect(probe.getSentinelBlueprint().tagValue).toBe(false);
  });
});

describe('sentinel probe: measures, never fabricates', () => {
  beforeEach(() => {
    registry.reset();
  });

  it('emits no stage latency of its own', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's' });
    probe.start();
    await probe.flipOnce();
    probe.stop();

    // Stage durations come from the pipeline timing real work. A probe running
    // against a target that anchors nothing must publish no stage series.
    expect(stageLatencyHistogram.collect()).toHaveLength(0);
    expect(probeFlipsCounter.get({ outcome: 'ingested' })).toBe(1);
  });

  it('times a round-trip only when the batch was actually confirmed', async () => {
    let now = 0;
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's', clock: () => now });
    probe.start();

    const confirmedId = await probe.flipOnce();
    now = 12_000;
    target.settle([confirmedId!], 'confirmed');

    expect(sentinelRoundTripHistogram.collect()).toHaveLength(1);
    expect(sentinelRoundTripHistogram.collect()[0].sum).toBeCloseTo(12, 6);
    expect(probeFlipsCounter.get({ outcome: 'confirmed' })).toBe(1);

    // A flip whose batch failed is counted as dropped and NOT timed.
    const droppedId = await probe.flipOnce();
    now = 30_000;
    target.settle([droppedId!], 'failed');
    expect(sentinelRoundTripHistogram.collect()[0].count).toBe(1); // unchanged
    expect(probeFlipsCounter.get({ outcome: 'dropped' })).toBe(1);

    probe.stop();
  });

  it('ignores anchor outcomes for events it did not flip', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's' });
    probe.start();
    await probe.flipOnce();
    target.settle(['some-plant-event'], 'confirmed');
    expect(sentinelRoundTripHistogram.collect()).toHaveLength(0);
    expect(probe.pendingFlipCount).toBe(1);
    probe.stop();
  });

  it('counts a rejected ingest without inventing a measurement', async () => {
    const target = new FakeAnchorTarget();
    target.failIngest = true;
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's' });
    const errors: unknown[] = [];
    probe.on('flip-error', ({ error }: { error: unknown }) => errors.push(error));

    expect(await probe.flipOnce()).toBeNull();
    expect(errors).toHaveLength(1);
    expect(probeFlipsCounter.get({ outcome: 'rejected' })).toBe(1);
    expect(sentinelRoundTripHistogram.collect()).toHaveLength(0);
  });

  it('bounds the pending-flip map when nothing ever confirms', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's', maxPendingFlips: 3 });
    for (let i = 0; i < 10; i++) await probe.flipOnce();
    expect(probe.pendingFlipCount).toBe(3);
    expect(probeFlipsCounter.get({ outcome: 'ingested' })).toBe(10);
  });

  it('detaches from the pipeline on stop', async () => {
    const target = new FakeAnchorTarget();
    const probe = new ControlLoopLatencyProbe(target, { siteId: 's' });
    probe.start();
    expect(target.listenerCount('anchor-latency')).toBe(1);
    probe.stop();
    expect(target.listenerCount('anchor-latency')).toBe(0);
    expect(probe.isRunning()).toBe(false);
  });
});

describe('sentinel probe against the real anchor pipeline', () => {
  const pipelines: AnchorPipeline[] = [];

  beforeEach(() => {
    registry.reset();
  });

  afterEach(async () => {
    while (pipelines.length) await pipelines.pop()!.stop();
  });

  it('drives the real pipeline so the stage series exist on an otherwise idle plant', async () => {
    const contract: AnchorContractLike = {
      anchor: Object.assign(
        async () => {
          await sleep(20);
          return { wait: async () => ({ hash: '0xabc', blockNumber: 10, gasUsed: 21000n }) };
        },
        { estimateGas: async () => 100000n },
      ),
    };
    const provider = {
      getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
      getBlockNumber: async () => 12,
    } as unknown as JsonRpcProvider;

    const pipeline = new AnchorPipeline({
      // One sentinel flip is enough to close a batch, so the probe alone keeps
      // the pipeline (and therefore the telemetry) alive.
      pipeline: { maxBatchSize: 1 },
      relayerDeps: { contract, provider },
      latencySource: 'probe-driven',
    });
    pipelines.push(pipeline);
    await pipeline.start();

    const probe = new ControlLoopLatencyProbe(pipeline, { siteId: 'sentinel-site' });
    probe.start();

    const confirmed = new Promise<AnchorLatencyEvent>((resolve) =>
      pipeline.once('anchor-latency', resolve),
    );
    const eventId = await probe.flipOnce();
    const anchorEvent = await confirmed;
    probe.stop();

    // The pipeline anchored the sentinel flip and measured every stage of it.
    expect(anchorEvent.eventIds).toContain(eventId);
    expect(anchorEvent.outcome).toBe('confirmed');
    expect(anchorEvent.measurement.stages.map((s) => s.stage)).toEqual([
      'batch',
      'sign',
      'anchor',
      'confirm',
    ]);

    const scrape = registry.metrics();
    expect(scrape).toContain(
      'scada_control_loop_stage_latency_seconds_count{stage="confirm",source="probe-driven"} 1',
    );
    expect(scrape).toContain(
      'scada_control_loop_roundtrip_latency_seconds_count{source="probe-driven"} 1',
    );
    // And the probe's own sentinel round-trip was measured from the real flip.
    expect(sentinelRoundTripHistogram.collect()).toHaveLength(1);
    expect(probeFlipsCounter.get({ outcome: 'confirmed' })).toBe(1);
  }, 20_000);
});
