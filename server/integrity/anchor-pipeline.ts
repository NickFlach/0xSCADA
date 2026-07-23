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
 * @see ADR-0021
 * @closes #489 (partial — see the issue for the remaining live-anvil e2e)
 */

import { EventEmitter } from 'events';
import { EventIntegrityPipeline, type SCADAEvent, type EventBatch, type PipelineConfig } from './pipeline';
import { MerkleTreeBuilder } from './merkle';
import { MerkleRootSigner, type HSMConfig } from './hsm';
import { AnchorRelayerService, type RelayerConfig, type RelayerDeps } from './relayer';

export interface AnchorPipelineConfig {
  pipeline?: Partial<PipelineConfig>;
  hsm?: HSMConfig;
  relayer?: Partial<RelayerConfig>;
  /** Injected relayer deps (provider/contract) — omit in prod, provide in tests. */
  relayerDeps?: Omit<RelayerDeps, 'signatureVerifier'>;
}

const DEFAULT_HSM: HSMConfig = { mode: 'software', algorithm: 'RS256' };

export class AnchorPipeline extends EventEmitter {
  readonly pipeline: EventIntegrityPipeline;
  readonly signer: MerkleRootSigner;
  readonly relayer: AnchorRelayerService;

  private batchCounter = 0;
  private started = false;

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

    this.pipeline.on('batch-created', (batch: EventBatch) => {
      this.anchorBatch(batch).catch(err => this.emit('error', { error: err, context: 'anchor-batch' }));
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
   */
  async anchorBatch(batch: EventBatch): Promise<{ batchId: number; merkleRoot: string; eventCount: number }> {
    // bytes32 form for the on-chain anchor + the signed payload (same string on
    // both sides so the relayer's structural check matches). Normalized via the
    // shared MerkleTreeBuilder.rootBytes32 so it can't drift from resilience.ts.
    const merkleRoot = MerkleTreeBuilder.rootBytes32(batch.events.map(e => e.hash), batch.batchHash);

    const signature = await this.signer.signMerkleRoot(merkleRoot);
    const batchId = ++this.batchCounter;

    await this.relayer.submitAnchor(merkleRoot, batchId, batch.events.length, signature, 'urgent');
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
    };
  }

  async stop(): Promise<void> {
    await this.pipeline.stop();
    await this.relayer.shutdown();
    await this.signer.cleanup();
    this.started = false;
    this.emit('stopped');
  }
}

export default AnchorPipeline;
