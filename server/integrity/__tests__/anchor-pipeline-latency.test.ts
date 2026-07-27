/**
 * Control-loop latency telemetry has a REAL producer (#460).
 *
 * The defect this file exists to prevent regressing: the scada_control_loop_*
 * series used to be emitted by nothing, so the dashboards and the probe-down
 * alert referenced metrics that never existed.
 *
 * Everything below drives the genuine integrity chain — real SHA-256 hashing,
 * a real Merkle root, a real RSA signature, and the real relayer verifying that
 * signature — against a mock contract (anvil is not in CI, see
 * anchor-pipeline.test.ts). The stage durations are measured, never injected,
 * and the assertions scrape the actual Prometheus endpoint the server exposes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { JsonRpcProvider } from 'ethers';

import { AnchorPipeline, type AnchorLatencyEvent } from '../anchor-pipeline';
import type { AnchorContractLike } from '../relayer';
import type { SCADAEvent } from '../pipeline';
import { registry } from '../../metrics/prometheus.js';
import { metricsHandler } from '../../metrics/index.js';
import { STAGE_SLO_MS } from '../stage-timestamps.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A mock chain whose `anchor` call takes a little real time, so the
 * confirmation genuinely lands after the submit call returns — exactly the
 * ordering a real chain produces.
 */
function mockChain(anchorDelayMs = 25) {
  const submitted: Array<{ root: string; batchId: number }> = [];
  const contract: AnchorContractLike = {
    anchor: Object.assign(
      async (root: string, batchId: number) => {
        submitted.push({ root, batchId });
        await sleep(anchorDelayMs);
        return { wait: async () => ({ hash: '0xabc', blockNumber: 10, gasUsed: 21000n }) };
      },
      { estimateGas: async () => 100000n },
    ),
  };
  const provider = {
    getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
    getBlockNumber: async () => 12,
  } as unknown as JsonRpcProvider;
  return { contract, provider, submitted };
}

function scadaEvent(i: number, ts: number): SCADAEvent {
  return { id: `evt-${i}`, timestamp: ts, type: 'reading', source: 'sensor-1', data: { value: i } };
}

const BASE_TS = 1_700_000_000_000;

const pipelines: AnchorPipeline[] = [];

function makePipeline(overrides: {
  anchorDelayMs?: number;
  latencySource: string;
  maxBatchSize?: number;
  maxRetries?: number;
}): { pipeline: AnchorPipeline; submitted: Array<{ root: string; batchId: number }> } {
  const { contract, provider, submitted } = mockChain(overrides.anchorDelayMs);
  const pipeline = new AnchorPipeline({
    pipeline: { windowSizeMs: 60_000, maxBatchSize: overrides.maxBatchSize ?? 2 },
    relayer: { maxRetries: overrides.maxRetries ?? 1 },
    relayerDeps: { contract, provider },
    latencySource: overrides.latencySource,
  });
  pipelines.push(pipeline);
  return { pipeline, submitted };
}

/** Wait for the pipeline to close the latency trace of its next batch. */
function nextLatencyEvent(pipeline: AnchorPipeline): Promise<AnchorLatencyEvent> {
  return new Promise((resolve) => pipeline.once('anchor-latency', resolve));
}

/** Serve the real /metrics handler and scrape it over HTTP. */
async function scrapeMetricsEndpoint(): Promise<string> {
  const app = express();
  app.get('/api/metrics', metricsHandler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    expect(response.status).toBe(200);
    return await response.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('AnchorPipeline emits control-loop latency telemetry (#460)', () => {
  beforeEach(() => {
    registry.reset();
  });

  afterEach(async () => {
    while (pipelines.length) await pipelines.pop()!.stop();
  });

  it('measures every stage of a real anchored batch and exposes it on /metrics', async () => {
    const { pipeline, submitted } = makePipeline({ latencySource: 'test-confirmed' });
    await pipeline.start();

    const latency = nextLatencyEvent(pipeline);
    await pipeline.ingestEvent(scadaEvent(0, BASE_TS));
    await pipeline.ingestEvent(scadaEvent(1, BASE_TS + 1));
    const event = await latency;

    // The real chain ran: a root was submitted and confirmed.
    expect(submitted).toHaveLength(1);
    expect(event.outcome).toBe('confirmed');
    expect(event.eventIds).toEqual(['evt-0', 'evt-1']);

    // Every stage that exists on this branch was measured.
    const stages = event.measurement.stages.map((s) => s.stage);
    expect(stages).toEqual(['batch', 'sign', 'anchor', 'confirm']);
    expect(event.measurement.unmeasured).toEqual([]);
    expect(event.measurement.complete).toBe(true);
    // Measured, not fabricated: signing is real RSA and takes real time, and the
    // confirm stage spans the mock chain's real 25ms delay.
    expect(event.measurement.stages.find((s) => s.stage === 'sign')!.durationMs).toBeGreaterThan(0);
    expect(
      event.measurement.stages.find((s) => s.stage === 'confirm')!.durationMs,
    ).toBeGreaterThanOrEqual(20);
    expect(event.measurement.total!.durationMs).toBeGreaterThanOrEqual(20);

    // ...and the series are actually on the shared registry's scrape output.
    const scrape = await scrapeMetricsEndpoint();
    for (const stage of ['batch', 'sign', 'anchor', 'confirm']) {
      expect(scrape).toContain(
        `scada_control_loop_stage_latency_seconds_count{stage="${stage}",source="test-confirmed"}`,
      );
      expect(scrape).toContain(
        `scada_control_loop_stage_slo_ok{stage="${stage}",source="test-confirmed"}`,
      );
    }
    expect(scrape).toContain(
      'scada_control_loop_roundtrip_latency_seconds_count{source="test-confirmed"} 1',
    );
    expect(scrape).toContain(
      'scada_control_loop_cycles_total{source="test-confirmed",outcome="confirmed"} 1',
    );
    // The unmeasurable `tick` stage must appear nowhere in the exposition.
    expect(scrape).not.toContain('stage="tick"');
  }, 20_000);

  it('injecting a 200ms delay at the sign stage shifts the sign histogram and trips its SLO', async () => {
    // The issue's verification scenario, run against the real pipeline: the
    // delay is added to the actual signing call and is *measured*, not asserted.
    const { pipeline } = makePipeline({ latencySource: 'test-slowsign' });
    await pipeline.start();

    const originalSign = pipeline.signer.signMerkleRoot.bind(pipeline.signer);
    pipeline.signer.signMerkleRoot = async (root: string) => {
      await sleep(200);
      return originalSign(root);
    };

    const latency = nextLatencyEvent(pipeline);
    await pipeline.ingestEvent(scadaEvent(0, BASE_TS));
    await pipeline.ingestEvent(scadaEvent(1, BASE_TS + 1));
    const event = await latency;

    const sign = event.measurement.stages.find((s) => s.stage === 'sign')!;
    expect(sign.durationMs).toBeGreaterThanOrEqual(180);
    expect(STAGE_SLO_MS.sign).toBeLessThan(200);
    expect(sign.withinSlo).toBe(false);

    const scrape = await scrapeMetricsEndpoint();
    // The observation lands above the 0.1s bucket and at/below the 0.25s bucket.
    expect(scrape).toContain(
      'scada_control_loop_stage_latency_seconds_bucket{stage="sign",source="test-slowsign",le="0.1"} 0',
    );
    expect(scrape).toContain(
      'scada_control_loop_stage_latency_seconds_bucket{stage="sign",source="test-slowsign",le="0.25"} 1',
    );
    // The gauge the >5min budget alert is written against actually reads 0.
    expect(scrape).toContain(
      'scada_control_loop_stage_slo_ok{stage="sign",source="test-slowsign"} 0',
    );
  }, 20_000);

  it('leaves confirm and the round-trip unreported when the anchor fails', async () => {
    const { pipeline, submitted } = makePipeline({ latencySource: 'test-failed' });
    await pipeline.start();

    // Corrupt the signature so the relayer's cryptographic verification rejects
    // it — a real, permanent anchor failure rather than a simulated one.
    const originalSign = pipeline.signer.signMerkleRoot.bind(pipeline.signer);
    pipeline.signer.signMerkleRoot = async (root: string) => {
      const sig = await originalSign(root);
      return { ...sig, signature: sig.signature.replace(/^../, 'ff') };
    };

    const latency = nextLatencyEvent(pipeline);
    await pipeline.ingestEvent(scadaEvent(0, BASE_TS));
    await pipeline.ingestEvent(scadaEvent(1, BASE_TS + 1));
    const event = await latency;

    expect(submitted).toHaveLength(0); // nothing reached the chain
    expect(event.outcome).toBe('failed');
    expect(event.measurement.unmeasured).toContain('confirm');
    expect(event.measurement.total).toBeNull();

    const scrape = await scrapeMetricsEndpoint();
    expect(scrape).toContain('scada_control_loop_cycles_total{source="test-failed",outcome="failed"} 1');
    // No invented confirm/round-trip numbers for a batch that never confirmed.
    expect(scrape).not.toContain('stage="confirm",source="test-failed"');
    expect(scrape).not.toContain('scada_control_loop_roundtrip_latency_seconds_count{source="test-failed"}');
  }, 20_000);

  it('closes abandoned traces as unconfirmed instead of leaking them', async () => {
    const { contract, provider } = mockChain();
    // A relayer whose submission never completes: the batch is enqueued, no
    // outcome is ever emitted, and the trace must be reaped by the timeout.
    const pipeline = new AnchorPipeline({
      pipeline: { maxBatchSize: 1 },
      relayerDeps: { contract, provider },
      latencySource: 'test-abandoned',
      anchorConfirmTimeoutMs: 40,
    });
    pipelines.push(pipeline);
    await pipeline.start();
    // Silence the relayer's outcome events so nothing settles the trace.
    pipeline.relayer.removeAllListeners('anchorSuccess');
    pipeline.relayer.removeAllListeners('anchorFailed');

    const latency = nextLatencyEvent(pipeline);
    await pipeline.ingestEvent(scadaEvent(0, BASE_TS));
    const event = await latency;

    expect(event.outcome).toBe('unconfirmed');
    expect(event.measurement.total).toBeNull();
    expect(pipeline.getStats().pendingLatencyTraces).toBe(0);
    expect(registry.metrics()).toContain(
      'scada_control_loop_cycles_total{source="test-abandoned",outcome="unconfirmed"} 1',
    );
  }, 20_000);
});
