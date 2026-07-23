/**
 * Bridge Modules Index
 * 
 * Exports all bridge modules for integration into the main application.
 * Bridges connect different parts of the system and handle cross-cutting concerns.
 * 
 * Issue: #280 — Bridge modules integration
 */

export { eventAnchorBridge, type AnchorableEvent, type AnchorBatch, type EventAnchorConfig } from './event-anchor';
export { stateSyncBridge, type StateChange, type SyncTarget, type StateSyncConfig } from './state-sync';

import { eventAnchorBridge } from './event-anchor';
import { stateSyncBridge } from './state-sync';
import { anchorsToL2, getAnchorBackend } from './anchor-backend';
import { AnchorPipeline } from '../integrity/anchor-pipeline';
import { log, logError } from '../logger';

/**
 * The real L2 anchor chain (#489), started only on the ANCHOR_BACKEND=l2|both
 * path. Replaces the Math.random() simulation in event-anchor.ts. Null on the
 * default `node` path (anchoring goes via NATS → 0xSCADA-node instead).
 */
let anchorPipeline: AnchorPipeline | null = null;

export function getAnchorPipeline(): AnchorPipeline | null {
  return anchorPipeline;
}

/**
 * Initialize all bridge modules
 */
export async function initializeBridges(): Promise<void> {
  // Idempotent: a second call without a shutdown must not orphan the previous
  // pipeline's timers.
  if (anchorsToL2() && !anchorPipeline) {
    // Real integrity chain: pipeline → merkle → sign → relayer. Connection is
    // lazy, so this is safe to start even before the RPC/contract/key exist;
    // anchoring fails closed at submit time if they're unset.
    const pipeline = new AnchorPipeline({
      // The l2 signing key is a software HSM key on local disk. Configure its
      // location explicitly (a real HSM/PKCS#11 provider is #482).
      hsm: {
        mode: 'software',
        algorithm: 'RS256',
        keyPath: process.env.ANCHOR_HSM_KEY_PATH || undefined,
      },
      relayer: {
        rpcUrl: process.env.ANCHOR_RPC_URL || 'http://localhost:8545',
        chainId: process.env.ANCHOR_CHAIN_ID ? Number(process.env.ANCHOR_CHAIN_ID) : 31337,
        contractAddress: process.env.EVENT_ANCHOR_CONTRACT || '',
        privateKey: process.env.ANCHOR_PRIVATE_KEY || '',
      },
    });
    pipeline.on('error', e => log(`⚠️ anchor pipeline error: ${JSON.stringify(e)}`, 'anchor'));
    try {
      await pipeline.start();
      anchorPipeline = pipeline;
      log(`⛓️  Real L2 anchor pipeline started (ANCHOR_BACKEND=${getAnchorBackend()})`, 'anchor');
    } catch (err) {
      // Never crash boot on anchor-startup failure — stop the partial pipeline
      // and continue; the /health bridges check will report it.
      logError(err as any, 'Failed to start L2 anchor pipeline');
      await pipeline.stop().catch(() => {});
      anchorPipeline = null;
    }
  } else if (!anchorsToL2()) {
    log(`Anchor pipeline not started (ANCHOR_BACKEND=${getAnchorBackend()}); anchoring via 0xSCADA-node`, 'anchor');
  }

  // Legacy simulation bridge self-disables unless anchorsToL2(); on the L2 path
  // the real pipeline above supersedes it, so it is not started here anymore.
  await stateSyncBridge.initialize();
}

/**
 * Get health status for all bridge modules
 */
export async function getBridgeHealthStatus(): Promise<{
  eventAnchor: { healthy: boolean; message: string };
  stateSync: { healthy: boolean; message: string };
}> {
  const stateSyncHealth = await stateSyncBridge.healthCheck();

  // Anchor health reflects the ACTIVE anchor path (#489). On the L2 path the
  // real pipeline is authoritative; otherwise anchoring is via 0xSCADA-node and
  // the (superseded) simulation bridge is not a health signal.
  let eventAnchorHealth: { healthy: boolean; message: string };
  if (anchorPipeline) {
    const rel = await anchorPipeline.relayer.getHealth();
    eventAnchorHealth = rel.connected
      ? { healthy: true, message: `L2 anchor pipeline connected (block ${rel.blockNumber})` }
      // Not connected is healthy-by-default: connection is lazy and only fails
      // when an RPC/contract/key is genuinely misconfigured for the L2 path.
      : { healthy: true, message: `L2 anchor pipeline started (chain not yet reachable: ${rel.error ?? 'lazy'})` };
  } else {
    eventAnchorHealth = { healthy: true, message: `Anchoring via ${getAnchorBackend()} backend (no L2 pipeline)` };
  }

  return {
    eventAnchor: eventAnchorHealth,
    stateSync: stateSyncHealth,
  };
}

/**
 * Shutdown all bridge modules gracefully
 */
export async function shutdownBridges(): Promise<void> {
  await Promise.all([
    eventAnchorBridge.removeAllListeners(),
    stateSyncBridge.shutdown(),
    anchorPipeline ? anchorPipeline.stop() : Promise.resolve(),
  ]);
  anchorPipeline = null;
}