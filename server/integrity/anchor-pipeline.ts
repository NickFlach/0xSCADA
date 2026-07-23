/**
 * Real L2 anchor pipeline used by the runtime anchor-backend switch.
 *
 * This connects the repository's existing event hashing/batching, Merkle-root
 * signer, and relayer services. Queue acceptance is deliberately distinct from
 * on-chain confirmation; the relayer reports confirmation asynchronously.
 */

import { EventEmitter } from "events";
import {
  EventIntegrityPipeline,
  type SCADAEvent,
  type EventBatch,
  type PipelineConfig,
} from "./pipeline";
import { MerkleRootSigner, type HSMConfig } from "./hsm";
import { AnchorRelayerService, type RelayerConfig } from "./relayer";

export interface AnchorPipelineConfig {
  pipeline?: Partial<PipelineConfig>;
  hsm?: HSMConfig;
  relayer?: Partial<RelayerConfig>;
}

const DEFAULT_HSM: HSMConfig = {
  mode: "software",
  algorithm: "RS256",
};

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
    this.relayer = new AnchorRelayerService(config.relayer);

    this.pipeline.on("batch-created", (batch: EventBatch) => {
      this.anchorBatch(batch).catch((error) => {
        this.emit("error", { error, context: "anchor-batch" });
      });
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.signer.initialize();
    this.started = true;
    this.emit("started");
  }

  async ingestEvent(event: SCADAEvent): Promise<void> {
    if (!this.started) throw new Error("AnchorPipeline not started");
    await this.pipeline.ingestEvent(event);
  }

  async anchorBatch(
    batch: EventBatch,
  ): Promise<{ batchId: number; merkleRoot: string; eventCount: number }> {
    // EventIntegrityPipeline already SHA-256 hashes the ordered event hashes.
    // Prefixing its 32-byte batch hash produces the bytes32 form the contract
    // and signer both consume.
    const merkleRoot = `0x${batch.batchHash}`;
    const signature = await this.signer.signMerkleRoot(merkleRoot);
    const verification =
      await this.signer.verifyMerkleRootSignature(merkleRoot, signature);
    if (!verification.valid) {
      throw new Error("Refusing to queue an unverified Merkle-root signature");
    }

    const batchId = ++this.batchCounter;
    await this.relayer.submitAnchor(
      merkleRoot,
      batchId,
      batch.events.length,
      signature,
      "urgent",
    );

    const queued = {
      batchId,
      merkleRoot,
      eventCount: batch.events.length,
    };
    this.emit("anchor-enqueued", queued);
    return queued;
  }

  getStats(): {
    pipeline: ReturnType<EventIntegrityPipeline["getStats"]>;
    relayer: ReturnType<AnchorRelayerService["getStats"]>;
    batchesAnchored: number;
    started: boolean;
  } {
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
    this.emit("stopped");
  }
}

export default AnchorPipeline;
