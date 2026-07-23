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
export {
  getAnchorBackend,
  getAnchorBackendSnapshot,
  getAnchorBackendCoordinationStatus,
  setAnchorBackend,
  anchorsToL2,
  anchorsToNode,
  _resetWarningLatch,
  _resetAnchorBackendState,
  type AnchorBackendCoordinationStatus,
  type AnchorBackendSnapshot,
  type AnchorBackend,
} from './anchor-backend';
// Operator-facing Anchor-Backend Switch control plane (#455). Lives in a
// separate module from #443's production bridge and shares its backend union.
export {
  anchorSwitch,
  AnchorSwitch,
  projectSwitch,
  backendsFor,
  parseBackendEnv,
  DEFAULT_BACKEND_PROFILES,
  type BackendProfile,
  type ProjectionInput,
  type SwitchProjection,
  type BackendRouting,
  type RoutableEvent,
  type DispatchResult,
} from './anchor-switch';

import { eventAnchorBridge } from './event-anchor';
import { stateSyncBridge } from './state-sync';
import {
  anchorsToL2,
  getAnchorBackend,
  type AnchorBackend,
} from './anchor-backend';
import { AnchorPipeline } from '../integrity/anchor-pipeline';
import { log, logError } from '../logger';
import { natsPublisher } from '../services/nats';
import {
  SCADA_EVENTS_SUBJECT,
  fromAnchorableEvent,
  type LegacyAnchorableEvent,
} from '../../shared/wire-schema/scada-event';

/**
 * The real L2 anchor chain (#489). It starts at boot for l2/both or is prepared
 * on demand for an authorized node → L2 switch. Replaces the Math.random()
 * simulation in event-anchor.ts. It remains hidden from ordinary producers
 * while the canonical backend is node-only.
 */
let anchorPipeline: AnchorPipeline | null = null;
let anchorPipelineStart: Promise<AnchorPipeline | null> | null = null;

type AnchorRuntimePipeline = Pick<AnchorPipeline, 'getStats' | 'ingestEvent'> & {
  relayer: Pick<AnchorPipeline['relayer'], 'getHealth'>;
};

function createAnchorPipeline(): AnchorPipeline {
  const pipeline = new AnchorPipeline({
    // The L2 signing key is a software HSM key on local disk. Configure its
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
  return pipeline;
}

/**
 * Start (or reuse) a warm L2 pipeline without changing the selected backend.
 * While the canonical backend is node-only, getAnchorPipeline() continues to
 * hide this pipeline from ordinary event producers.
 */
async function ensureAnchorPipelineStarted(): Promise<AnchorPipeline | null> {
  if (anchorPipeline) return anchorPipeline;
  if (anchorPipelineStart) return anchorPipelineStart;

  anchorPipelineStart = (async () => {
    const pipeline = createAnchorPipeline();
    try {
      await pipeline.start();
      anchorPipeline = pipeline;
      log(`⛓️  Real L2 anchor pipeline prepared (ANCHOR_BACKEND=${getAnchorBackend()})`, 'anchor');
      return pipeline;
    } catch (err) {
      logError(err as Error, 'Failed to start L2 anchor pipeline');
      await pipeline.stop().catch(() => {});
      return null;
    }
  })();

  try {
    return await anchorPipelineStart;
  } finally {
    anchorPipelineStart = null;
  }
}

export function getAnchorPipeline(
  pipeline: AnchorPipeline | null = anchorPipeline,
): AnchorPipeline | null {
  // A pipeline started at boot may remain warm while an operator temporarily
  // switches to node-only routing. Never expose it to event producers unless
  // the current canonical backend still includes L2.
  return anchorsToL2() ? pipeline : null;
}

/**
 * Whether the runtime needed by a target backend is already initialized.
 *
 * The node path is the boot/default NATS route and has no optional in-process
 * pipeline. L2 (and therefore `both`) requires the real AnchorPipeline created
 * by initializeBridges(); an admin request must not disable node routing until
 * that pipeline is actually started.
 */
export async function isAnchorBackendRuntimeReady(
  backend: AnchorBackend,
  pipeline: AnchorRuntimePipeline | null = anchorPipeline,
  nodeReady: boolean = natsPublisher.isConnected(),
): Promise<boolean> {
  if (backend === 'node') return nodeReady;

  let l2Ready = false;
  try {
    if (pipeline?.getStats().started === true) {
      const health = await pipeline.relayer.getHealth();
      l2Ready = health.connected;
    }
  } catch {
    l2Ready = false;
  }

  return backend === 'l2' ? l2Ready : nodeReady && l2Ready;
}

export interface AnchorRuntimePreparationDependencies {
  /**
   * Test seam for the L2 initializer. Production callers omit this and use the
   * singleton pipeline. The initializer must not mutate the backend selection.
   */
  ensureL2Pipeline?: () => Promise<AnchorRuntimePipeline | null>;
  /** Override the initially visible pipeline; undefined uses the singleton. */
  pipeline?: AnchorRuntimePipeline | null;
  nodeReady?: () => boolean;
}

/**
 * Prepare the resources required by an explicitly requested backend while
 * leaving the canonical routing state untouched. This resolves node-boot → L2
 * switching without making an unavailable L2 path visible to event producers.
 */
export async function prepareAnchorBackendRuntime(
  backend: AnchorBackend,
  dependencies: AnchorRuntimePreparationDependencies = {},
): Promise<boolean> {
  const nodeReady = (dependencies.nodeReady ?? (() => natsPublisher.isConnected()))();
  if (backend === 'node') return nodeReady;

  const usesSingletonInitializer =
    dependencies.pipeline === undefined
    && dependencies.ensureL2Pipeline === undefined;
  const hadSingletonPipeline = anchorPipeline !== null;
  let pipeline =
    dependencies.pipeline === undefined
      ? anchorPipeline
      : dependencies.pipeline;
  if (!pipeline) {
    pipeline = await (
      dependencies.ensureL2Pipeline
      ?? ensureAnchorPipelineStarted
    )();
  }

  const l2Ready = await isAnchorBackendRuntimeReady('l2', pipeline, true);
  if (
    !l2Ready
    && usesSingletonInitializer
    && !hadSingletonPipeline
    && pipeline
    && pipeline === anchorPipeline
  ) {
    // A newly prepared but unreachable pipeline remains invisible because the
    // backend was never changed. Tear it down so a later request can retry with
    // fresh configuration and so failed preparations do not leak timers.
    anchorPipeline = null;
    await (pipeline as AnchorPipeline).stop().catch(() => {});
  }

  return backend === 'l2' ? l2Ready : nodeReady && l2Ready;
}

export interface AnchorAuditDispatchResult {
  targetBackend: AnchorBackend;
  auditQueueId: string;
  auditStatus: 'queued';
  nodeQueued: boolean;
  l2Queued: boolean;
}

/**
 * Queue an authorized switch intent through an explicit target backend.
 *
 * The target is an argument rather than a read of mutable global state because
 * this function intentionally runs before the routing mutation. A successful
 * return means only that every selected backend accepted the event into its
 * local/NATS pipeline; it does not claim durable storage or chain confirmation.
 */
export async function dispatchAnchorAuditEvent(
  targetBackend: AnchorBackend,
  event: LegacyAnchorableEvent,
  dependencies: {
    nodePublisher?: Pick<typeof natsPublisher, 'publish'>;
    l2Pipeline?: Pick<AnchorPipeline, 'ingestEvent'> | null;
  } = {},
): Promise<AnchorAuditDispatchResult> {
  const nodePublisher = dependencies.nodePublisher ?? natsPublisher;
  const l2Pipeline =
    dependencies.l2Pipeline === undefined
      ? anchorPipeline
      : dependencies.l2Pipeline;
  let nodeQueued = false;
  let l2Queued = false;

  if (targetBackend === 'node' || targetBackend === 'both') {
    nodeQueued = nodePublisher.publish(
      SCADA_EVENTS_SUBJECT,
      fromAnchorableEvent(event, 'anchor-backend-control'),
    );
    if (!nodeQueued) {
      throw new Error('NATS/node anchor backend did not accept the audit event');
    }
  }

  if (targetBackend === 'l2' || targetBackend === 'both') {
    if (!l2Pipeline) {
      throw new Error('L2 anchor pipeline is unavailable for the audit event');
    }
    await l2Pipeline.ingestEvent({
      id: event.id,
      timestamp:
        event.timestamp instanceof Date
          ? event.timestamp.getTime()
          : Date.parse(event.timestamp),
      type: event.eventType,
      source: 'anchor-backend-control',
      data: {
        siteId: event.siteId,
        severity: event.severity,
        message: event.message,
        ...(event.data ?? {}),
      },
    });
    l2Queued = true;
  }

  return {
    targetBackend,
    auditQueueId: event.id,
    auditStatus: 'queued',
    nodeQueued,
    l2Queued,
  };
}

/**
 * Initialize all bridge modules
 */
export async function initializeBridges(): Promise<void> {
  // Idempotent: a second call without a shutdown must not orphan the previous
  // pipeline's timers.
  if (anchorsToL2()) {
    // Real integrity chain: pipeline → merkle → sign → relayer. Boot continues
    // if preparation fails; bridge health then reports the selected path as
    // unavailable instead of treating a disconnected relayer as healthy.
    await ensureAnchorPipelineStarted();
  } else if (!anchorsToL2()) {
    log(`Anchor pipeline not started (ANCHOR_BACKEND=${getAnchorBackend()}); anchoring via 0xSCADA-node`, 'anchor');
  }

  // Legacy simulation bridge self-disables unless anchorsToL2(); on the L2 path
  // the real pipeline above supersedes it, so it is not started here anymore.
  await stateSyncBridge.initialize();
}

/**
 * Health of the selected anchor fan-out. Every selected backend is required:
 * `both` is healthy only when NATS/node and the L2 relayer are connected.
 */
export async function getActiveAnchorHealthStatus(
  backend: AnchorBackend = getAnchorBackend(),
  pipeline: AnchorRuntimePipeline | null = anchorPipeline,
  nodeReady: boolean = natsPublisher.isConnected(),
): Promise<{ healthy: boolean; message: string }> {
  const messages: string[] = [];
  let healthy = true;

  if (backend === 'node' || backend === 'both') {
    healthy = healthy && nodeReady;
    messages.push(
      nodeReady
        ? 'NATS/node anchor queue connected'
        : 'NATS/node anchor queue disconnected',
    );
  }

  if (backend === 'l2' || backend === 'both') {
    if (!pipeline) {
      healthy = false;
      messages.push('L2 anchor pipeline unavailable');
    } else {
      try {
        if (pipeline.getStats().started !== true) {
          healthy = false;
          messages.push('L2 anchor pipeline stopped');
        } else {
          const relayerHealth = await pipeline.relayer.getHealth();
          healthy = healthy && relayerHealth.connected;
          messages.push(
            relayerHealth.connected
              ? `L2 anchor relayer connected (block ${relayerHealth.blockNumber ?? 'unknown'})`
              : `L2 anchor relayer disconnected (${relayerHealth.error ?? 'unreachable'})`,
          );
        }
      } catch (err) {
        healthy = false;
        messages.push(`L2 anchor relayer health check failed (${(err as Error).message})`);
      }
    }
  }

  return { healthy, message: messages.join('; ') };
}

/**
 * Get health status for all bridge modules.
 */
export async function getBridgeHealthStatus(): Promise<{
  eventAnchor: { healthy: boolean; message: string };
  stateSync: { healthy: boolean; message: string };
}> {
  const [stateSyncHealth, eventAnchorHealth] = await Promise.all([
    stateSyncBridge.healthCheck(),
    getActiveAnchorHealthStatus(),
  ]);

  return {
    eventAnchor: eventAnchorHealth,
    stateSync: stateSyncHealth,
  };
}

/**
 * Shutdown all bridge modules gracefully
 */
export async function shutdownBridges(): Promise<void> {
  if (anchorPipelineStart) {
    await anchorPipelineStart.catch(() => null);
  }
  const pipeline = anchorPipeline;
  await Promise.all([
    eventAnchorBridge.removeAllListeners(),
    stateSyncBridge.shutdown(),
    pipeline ? pipeline.stop() : Promise.resolve(),
  ]);
  anchorPipeline = null;
  anchorPipelineStart = null;
}
