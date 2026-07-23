/**
 * Live-chain end-to-end test for issue #505.
 *
 * The regular AnchorPipeline tests inject a contract double. This suite deploys
 * the real EventAnchor bytecode to Anvil, sends a real signed pipeline batch
 * through AnchorRelayerService, and reads the committed root back over JSON-RPC.
 *
 * It is intentionally opt-in so the normal unit suite does not require Foundry.
 * `.github/workflows/anchor-pipeline-anvil.yml` is the required CI entry point.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  type InterfaceAbi,
} from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { AnchorPipeline } from '../../server/integrity/anchor-pipeline';
import { MerkleTreeBuilder } from '../../server/integrity/merkle';
import type { SCADAEvent } from '../../server/integrity/pipeline';

interface FoundryArtifact {
  abi: InterfaceAbi;
  bytecode: { object: string };
}

interface AnchorSuccess {
  request: {
    merkleRoot: string;
    batchId: number;
    eventCount: number;
  };
  result: {
    success: boolean;
    transactionHash?: string;
  };
}

const liveE2E = process.env.ANCHOR_LIVE_E2E === '1' ? describe : describe.skip;
const pipelines: AnchorPipeline[] = [];

function requiredEnvironment(name: 'ANVIL_RPC_URL' | 'ANVIL_PRIVATE_KEY'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when ANCHOR_LIVE_E2E=1`);
  }
  return value;
}

function scadaEvent(index: number, timestamp: number): SCADAEvent {
  return {
    id: `live-event-${index}`,
    timestamp,
    type: 'reading',
    source: 'anvil-e2e-sensor',
    data: { value: 100 + index, quality: 'good' },
  };
}

function expectedMerkleRoot(events: SCADAEvent[]): string {
  const hashes = events.map((event) => {
    const canonical = JSON.stringify({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      source: event.source,
      data: event.data,
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  });
  return `0x${MerkleTreeBuilder.buildFromEventHashes(hashes).root}`;
}

function waitForAnchor(pipeline: AnchorPipeline): Promise<AnchorSuccess> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for AnchorPipeline confirmation')),
      30_000,
    );

    pipeline.relayer.once('anchorSuccess', (event: AnchorSuccess) => {
      clearTimeout(timeout);
      resolvePromise(event);
    });
    pipeline.relayer.once('anchorFailed', (event: unknown) => {
      clearTimeout(timeout);
      reject(new Error(`AnchorPipeline failed: ${JSON.stringify(event)}`));
    });
  });
}

afterEach(async () => {
  while (pipelines.length > 0) {
    await pipelines.pop()!.stop();
  }
});

liveE2E('AnchorPipeline → live EventAnchor', () => {
  it('deploys, anchors the ingested batch root, and verifies it on-chain', async () => {
    const rpcUrl = requiredEnvironment('ANVIL_RPC_URL');
    const privateKey = requiredEnvironment('ANVIL_PRIVATE_KEY');
    const provider = new JsonRpcProvider(rpcUrl);
    const deployer = new Wallet(privateKey, provider);

    const artifactPath = resolve('out/EventAnchor.sol/EventAnchor.json');
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as FoundryArtifact;
    const bytecode = artifact.bytecode.object.startsWith('0x')
      ? artifact.bytecode.object
      : `0x${artifact.bytecode.object}`;

    const factory = new ContractFactory(artifact.abi, bytecode, deployer);
    const deployed = await factory.deploy(deployer.address);
    await deployed.waitForDeployment();
    const contractAddress = await deployed.getAddress();

    const pipeline = new AnchorPipeline({
      pipeline: {
        windowSizeMs: 60_000,
        maxBatchSize: 3,
      },
      relayer: {
        rpcUrl,
        chainId: 31_337,
        contractAddress,
        privateKey,
        confirmationBlocks: 1,
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 100,
      },
    });
    pipelines.push(pipeline);
    await pipeline.start();

    const anchored = waitForAnchor(pipeline);
    const baseTimestamp = 1_700_000_000_000;
    const events = [0, 1, 2].map((index) => scadaEvent(index, baseTimestamp + index));
    for (const event of events) {
      await pipeline.ingestEvent(event);
    }
    const success = await anchored;

    const expectedRoot = expectedMerkleRoot(events);
    expect(success.result.success).toBe(true);
    expect(success.result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(success.request).toMatchObject({
      merkleRoot: expectedRoot,
      batchId: 1,
      eventCount: events.length,
    });

    const eventAnchor = new Contract(contractAddress, artifact.abi, provider);
    const [exists, batchId] = await eventAnchor.verify(expectedRoot);
    expect(exists).toBe(true);
    expect(batchId).toBe(1n);

    const stored = await eventAnchor.getAnchor(1);
    expect(stored.merkleRoot).toBe(expectedRoot);
    expect(stored.eventCount).toBe(BigInt(events.length));
    expect(stored.exists).toBe(true);
  }, 45_000);
});
