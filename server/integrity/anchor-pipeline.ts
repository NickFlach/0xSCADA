/**
 * Anchor Pipeline — the real integrity chain (#489)
 *
 * Replaces the Math.random() simulation (server/bridge/event-anchor.ts) with the
 * genuine chain that already existed as disconnected libraries:
 *
 *   SCADAEvent → EventIntegrityPipeline (SHA-256 hash + time-window batch)
 *              → MerkleTreeBuilder (real Merkle root over event hashes)
 *              → MerkleRootSigner (HSM/software signature)
 *              → AnchorRelayerService (verify signature → submit to EventAnchor)
 *
 * The relayer is wired with the signer as its cryptographic signature verifier,
 * so a root that wasn't validly signed is never anchored.
 *
 * This is the L2 anchor backend. It is gated by ANCHOR_BACKEND (#443): the
 * bootstrap only starts it on the `l2`/`both` path; the default `node` path
 * anchors via NATS → 0xSCADA-node and never constructs this.
 *
 * LATENCY TELEMETRY (#460)
 * ------------------------
 * This class is the PRODUCER of the scada_control_loop_* series. Every batch it
 * anchors is timed at the seams that already existed — Merkle build, signing,
 * the hand-off into the relayer's submission queue, and the wait for the
 * relayer's per-batch confirmation event (which is where the asynchronous
 * verification/gas-estimation/transaction work actually lands) — and
 * the durations are published to the shared Prometheus registry. The
 * instrumentation only reads clocks around work that was already happening: it
 * adds no stage, changes no behaviour, and never invents a number. Stages that
 * cannot be measured (e.g. a batch that is never confirmed) are left out of the
 * series entirely rather than reported as zero.
 *
 * @see ADR-0021
 * @closes #489 (partial — see the issue for the remaining live-anvil e2e)
 */

import { EventEmitter } from 'events';
import { EventIntegrityPipeline, type SCADAEvent, type EventBatch, type PipelineConfig } from './pipeline';
import { MerkleTreeBuilder } from './merkle';
import { MerkleRootSigner, type HSMConfig } from './hsm';
import { AnchorRelayerService, type RelayerConfig, type RelayerDeps } from './relayer';
import {
  LatencyTrace,
  observeCycleOutcome,
  type CycleOutcome,
  type LatencyMeasurement,
} from './stage-timestamps';

export interface AnchorPipelineConfig {
  pipeline?: Partial<PipelineConfig>;
  hsm?: HSMConfig;
  relayer?: Partial<RelayerConfig>;
  /** Injected relayer deps (provider/contract) — omit in prod, provide in tests. */
  relayerDeps?: Omit<RelayerDeps, 'signatureVerifier'>;
  /**
   * Value of the `source` label on the control-loop latency series (#460).
   * Defaults to 'anchor-pipeline'; override when running more than one pipeline
   * so their series stay distinguishable.
   */
  latencySource?: string;
  /**
   * How long a batch may wait for the relayer's confirmation event before its
   * trace is closed as `unconfirmed`. This bounds the pending-trace map; it does
   * NOT cancel the anchor itself (the relayer keeps its own retry policy).
   * Defaults to 15 minutes.
   */
  anchorConfirmTimeoutMs?: number;
}

const DEFAULT_HSM: HSMConfig = { mode: 'software', algorithm: 'RS256' };
const DEFAULT_LATENCY_SOURCE = 'anchor-pipeline';
const DEFAULT_ANCHOR_CONFIRM_TIMEOUT_MS = 15 * 60_000;

/** Emitted once per anchored batch when its trace closes. */
export interface AnchorLatencyEvent {
  batchId: number;
  /** Ids of the events in the anchored batch (lets producers correlate). */
  eventIds: string[];
  outcome: CycleOutcome;
  measurement: LatencyMeasurement;
}

interface PendingTrace {
  trace: LatencyTrace;
  eventIds: string[];
  /** True once the submit call has returned and `confirm-enter` was stamped. */
  armed: boolean;
  /** Set when the relayer reported an outcome for this batch. */
  settled: { outcome: CycleOutcome; at: number } | null;
  timer: NodeJS.Timeout;
}

export class AnchorPipeline extends EventEmitter {
  readonly pipeline: EventIntegrityPipeline;
  readonly signer: MerkleRootSigner;
  readonly relayer: AnchorRelayerService;

  /** `source` label used for this pipeline's control-loop latency series. */
  readonly latencySource: string;

  private batchCounter = 0;
  private started = false;
  private readonly anchorConfirmTimeoutMs: number;
  private readonly pendingTraces = new Map<number, PendingTrace>();

  constructor(config: AnchorPipelineConfig = {}) {
    super();
    this.pipeline = new EventIntegrityPipeline(config.pipeline);
    this.signer = new MerkleRootSigner(config.hsm ?? DEFAULT_HSM);
    // The signer doubles as the relayer's signature verifier — the root is
    // verified against the signing key's public half before anchoring.
    this.relayer = new AnchorRelayerService(config.relayer, {
      ...config.relayerDeps,
      signatureVerifier: this.signer,
    });
    this.latencySource = config.latencySource ?? DEFAULT_LATENCY_SOURCE;
    this.anchorConfirmTimeoutMs = config.anchorConfirmTimeoutMs ?? DEFAULT_ANCHOR_CONFIRM_TIMEOUT_MS;

    this.pipeline.on('batch-created', (batch: EventBatch) => {
      this.anchorBatch(batch).catch(err => this.emit('error', { error: err, context: 'anchor-batch' }));
    });

    // Confirmation seam for the `confirm` stage (#460). Registered once, in the
    // constructor, so a confirmation can never arrive before we are listening.
    this.relayer.on('anchorSuccess', (payload: { request?: { batchId?: number } }) => {
      this.settleTrace(payload?.request?.batchId, 'confirmed');
    });
    this.relayer.on('anchorFailed', (payload: { request?: { batchId?: number } }) => {
      this.settleTrace(payload?.request?.batchId, 'failed');
    });
  }

  /** Initialize the signer and mark the pipeline ready. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.signer.initialize();
    this.started = true;
    this.emit('started');
  }

  /** Ingest a SCADA event into the integrity pipeline. */
  async ingestEvent(event: SCADAEvent): Promise<void> {
    if (!this.started) throw new Error('AnchorPipeline not started');
    await this.pipeline.ingestEvent(event);
  }

  /**
   * Build the Merkle root for a batch, sign it, and submit it for anchoring.
   * Exposed for tests and for callers that batch externally.
   *
   * Each seam is timed for the control-loop latency instrument (#460); the
   * `confirm` stage is closed later by settleTrace() when the relayer reports
   * this batch's outcome.
   */
  async anchorBatch(batch: EventBatch): Promise<{ batchId: number; merkleRoot: string; eventCount: number }> {
    // Claim the batch id up front so concurrent anchorBatch calls can never
    // collide on it (and so the latency trace can be keyed by it).
    const batchId = ++this.batchCounter;
    const trace = new LatencyTrace({ traceId: `${batch.id}#${batchId}`, source: this.latencySource });

    // bytes32 form for the on-chain anchor + the signed payload (same string on
    // both sides so the relayer's structural check matches). Normalized via the
    // shared MerkleTreeBuilder.rootBytes32 so it can't drift from resilience.ts.
    trace.mark('batch-enter');
    const merkleRoot = MerkleTreeBuilder.rootBytes32(batch.events.map(e => e.hash), batch.batchHash);
    trace.mark('batch-exit');

    trace.mark('sign-enter');
    const signature = await this.signer.signMerkleRoot(merkleRoot);
    trace.mark('sign-exit');

    // Register BEFORE submitting: the relayer can emit the outcome for this
    // batch while submitAnchor is still awaiting.
    const pending = this.trackTrace(batchId, trace, batch.events.map(e => e.id));

    trace.mark('anchor-enter');
    try {
      await this.relayer.submitAnchor(merkleRoot, batchId, batch.events.length, signature, 'urgent');
    } catch (err) {
      // Submission itself threw: close the trace with what was measured
      // (batch + sign) rather than leaving it pending until timeout.
      this.closeTrace(batchId, 'failed');
      throw err;
    }
    trace.mark('anchor-exit');
    trace.mark('confirm-enter');
    pending.armed = true;
    if (pending.settled) this.closeTrace(batchId, pending.settled.outcome, pending.settled.at);

    // 'enqueued' not 'confirmed': submitAnchor queues the request; on-chain
    // confirmation is signalled by the relayer's 'anchorSuccess' event.
    const info = { batchId, merkleRoot, eventCount: batch.events.length };
    this.emit('anchor-enqueued', info);
    return info;
  }

  getStats() {
    return {
      pipeline: this.pipeline.getStats(),
      relayer: this.relayer.getStats(),
      batchesAnchored: this.batchCounter,
      started: this.started,
      pendingLatencyTraces: this.pendingTraces.size,
    };
  }

  async stop(): Promise<void> {
    await this.pipeline.stop();
    await this.relayer.shutdown();
    await this.signer.cleanup();
    // Close every still-open trace so no timer outlives the pipeline.
    for (const batchId of [...this.pendingTraces.keys()]) {
      this.closeTrace(batchId, 'unconfirmed');
    }
    this.started = false;
    this.emit('stopped');
  }

  // ==========================================================================
  // LATENCY TRACE BOOKKEEPING (#460)
  // ==========================================================================

  private trackTrace(batchId: number, trace: LatencyTrace, eventIds: string[]): PendingTrace {
    const timer = setTimeout(() => this.closeTrace(batchId, 'unconfirmed'), this.anchorConfirmTimeoutMs);
    // Telemetry must never be the reason the process stays alive.
    timer.unref?.();
    const pending: PendingTrace = { trace, eventIds, armed: false, settled: null, timer };
    this.pendingTraces.set(batchId, pending);
    return pending;
  }

  /**
   * Record the relayer's outcome for a batch. The confirmation timestamp is
   * captured here, at the moment the event actually arrived, but the trace is
   * only closed once `confirm-enter` has been stamped — otherwise the confirm
   * interval would be measured from a stamp that does not exist yet.
   */
  private settleTrace(batchId: number | undefined, outcome: CycleOutcome): void {
    if (typeof batchId !== 'number') return;
    const pending = this.pendingTraces.get(batchId);
    if (!pending || pending.settled) return;
    const at = pending.trace.now();
    pending.settled = { outcome, at };
    if (pending.armed) this.closeTrace(batchId, outcome, at);
  }

  private closeTrace(batchId: number, outcome: CycleOutcome, at?: number): void {
    const pending = this.pendingTraces.get(batchId);
    if (!pending) return;
    this.pendingTraces.delete(batchId);
    clearTimeout(pending.timer);

    // Only a confirmed anchor closes the `confirm` stage; a failed or abandoned
    // batch leaves confirm (and therefore the round-trip) unmeasured, which is
    // exactly what the dashboard and alerts expect to see.
    if (outcome === 'confirmed') {
      pending.trace.mark('confirm-exit', at);
    }

    const measurement = pending.trace.finalize();
    observeCycleOutcome(this.latencySource, outcome);
    const event: AnchorLatencyEvent = {
      batchId,
      eventIds: pending.eventIds,
      outcome,
      measurement,
    };
    this.emit('anchor-latency', event);
  }
}

export default AnchorPipeline;
