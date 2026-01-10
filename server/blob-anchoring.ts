import { createHash } from "crypto";
import { ethers } from "ethers";

export interface BlobConfig {
  enabled: boolean;
  maxBlobSize: number;
  compressionEnabled: boolean;
}

export interface BlobPayload {
  blobId: string;
  events: any[];
  merkleRoot: string;
  compressedSize: number;
  originalSize: number;
  timestamp: Date;
}

export interface BlobCommitment {
  blobId: string;
  versionedHash: string;
  commitment: string;
  proof: string;
}

export class BlobAnchoringService {
  private config: BlobConfig;
  private pendingBlobs: Map<string, BlobPayload> = new Map();

  constructor(config: Partial<BlobConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      maxBlobSize: config.maxBlobSize ?? 128 * 1024,
      compressionEnabled: config.compressionEnabled ?? true,
    };

    console.log("🔮 BlobAnchoringService initialized (EIP-4844 prototype)");
    console.log(`   Enabled: ${this.config.enabled}`);
    console.log(`   Max blob size: ${this.config.maxBlobSize} bytes`);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  updateConfig(config: Partial<BlobConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BlobConfig {
    return { ...this.config };
  }

  serializeEvents(events: any[]): Buffer {
    const jsonData = JSON.stringify(events);
    return Buffer.from(jsonData, "utf-8");
  }

  compressPayload(data: Buffer): Buffer {
    if (!this.config.compressionEnabled) {
      return data;
    }

    const chunks: string[] = [];
    const seen = new Map<string, number>();
    let pos = 0;

    const str = data.toString("utf-8");
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (seen.has(char)) {
        continue;
      }
      seen.set(char, pos++);
    }

    return data;
  }

  prepareBlobPayload(events: any[]): BlobPayload {
    const serialized = this.serializeEvents(events);
    const compressed = this.compressPayload(serialized);

    const eventHashes = events.map(e => 
      createHash("sha256").update(JSON.stringify(e)).digest("hex")
    );

    let layer = eventHashes;
    while (layer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = layer[i + 1] || left;
        nextLayer.push(createHash("sha256").update(left + right).digest("hex"));
      }
      layer = nextLayer;
    }
    const merkleRoot = "0x" + (layer[0] || createHash("sha256").update("").digest("hex"));

    const blobId = createHash("sha256")
      .update(merkleRoot + Date.now().toString())
      .digest("hex")
      .substring(0, 16);

    const payload: BlobPayload = {
      blobId,
      events,
      merkleRoot,
      compressedSize: compressed.length,
      originalSize: serialized.length,
      timestamp: new Date(),
    };

    this.pendingBlobs.set(blobId, payload);

    return payload;
  }

  computeKZGCommitment(data: Buffer): BlobCommitment {
    const blobId = createHash("sha256")
      .update(data)
      .digest("hex")
      .substring(0, 16);

    const commitment = createHash("sha256")
      .update("commitment:" + data.toString("hex"))
      .digest("hex");

    const versionedHash = "0x01" + createHash("sha256")
      .update(commitment)
      .digest("hex")
      .substring(2);

    const proof = createHash("sha256")
      .update("proof:" + commitment)
      .digest("hex");

    return {
      blobId,
      versionedHash,
      commitment: "0x" + commitment,
      proof: "0x" + proof,
    };
  }

  async submitBlobTransaction(
    payload: BlobPayload,
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet
  ): Promise<{ txHash: string; blobCommitment: BlobCommitment } | null> {
    if (!this.config.enabled) {
      console.warn("⚠️  Blob anchoring is disabled");
      return null;
    }

    const serialized = this.serializeEvents(payload.events);
    const commitment = this.computeKZGCommitment(serialized);

    console.log("🔮 Simulating EIP-4844 blob transaction");
    console.log(`   Blob ID: ${payload.blobId}`);
    console.log(`   Versioned Hash: ${commitment.versionedHash}`);
    console.log(`   Event Count: ${payload.events.length}`);
    console.log(`   Blob Size: ${payload.compressedSize} bytes`);

    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0,
      data: ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify({
        type: "blob_anchor",
        blobId: payload.blobId,
        merkleRoot: payload.merkleRoot,
        versionedHash: commitment.versionedHash,
        eventCount: payload.events.length,
      }))),
    });

    const receipt = await tx.wait();

    console.log(`✅ Blob transaction submitted: ${receipt?.hash}`);

    return {
      txHash: receipt?.hash || "",
      blobCommitment: commitment,
    };
  }

  estimateBlobCost(eventCount: number, gasPrice: bigint): {
    blobCost: bigint;
    calldataCost: bigint;
    savings: string;
  } {
    const avgEventSize = 200;
    const totalSize = eventCount * avgEventSize;

    const blobGas = BigInt(131072);
    const blobGasPrice = gasPrice / BigInt(16);
    const blobCost = blobGas * blobGasPrice;

    const calldataGas = BigInt(Math.ceil(totalSize / 31)) * BigInt(16);
    const calldataCost = calldataGas * gasPrice;

    const savingsPercent = calldataCost > BigInt(0) 
      ? ((calldataCost - blobCost) * BigInt(100)) / calldataCost
      : BigInt(0);

    return {
      blobCost,
      calldataCost,
      savings: `${savingsPercent}%`,
    };
  }

  getPendingBlobs(): BlobPayload[] {
    return Array.from(this.pendingBlobs.values());
  }

  getBlobById(blobId: string): BlobPayload | undefined {
    return this.pendingBlobs.get(blobId);
  }

  clearBlob(blobId: string): boolean {
    return this.pendingBlobs.delete(blobId);
  }
}

export const blobAnchoringService = new BlobAnchoringService({
  enabled: process.env.BLOB_ANCHORING_ENABLED === "true",
  compressionEnabled: process.env.BLOB_COMPRESSION_ENABLED !== "false",
});
