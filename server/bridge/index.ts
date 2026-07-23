/**
 * Bridge modules and canonical anchor-backend runtime routing.
 */

export {
  eventAnchorBridge,
  type AnchorableEvent,
  type AnchorBatch,
  type EventAnchorConfig,
} from "./event-anchor";
export {
  stateSyncBridge,
  type StateChange,
  type SyncTarget,
  type StateSyncConfig,
} from "./state-sync";
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
} from "./anchor-backend";
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
} from "./anchor-switch";

import { eventAnchorBridge } from "./event-anchor";
import { stateSyncBridge } from "./state-sync";
import {
  anchorsToL2,
  getAnchorBackend,
  type AnchorBackend,
} from "./anchor-backend";
import { AnchorPipeline } from "../integrity/anchor-pipeline";
import { log, logError } from "../logger";
import { natsPublisher } from "../services/nats";

let anchorPipeline: AnchorPipeline | null = null;
let anchorPipelineStart: Promise<AnchorPipeline | null> | null = null;

type AnchorRuntimePipeline = Pick<
  AnchorPipeline,
  "getStats" | "ingestEvent"
> & {
  relayer: Pick<AnchorPipeline["relayer"], "getHealth">;
};

export interface AnchorControlEvent {
  id: string;
  timestamp: Date | string;
  eventType: string;
  siteId: string;
  severity: "info" | "warning" | "alarm" | "critical";
  message: string;
  data?: Record<string, unknown>;
}

function createAnchorPipeline(): AnchorPipeline {
  const pipeline = new AnchorPipeline({
    hsm: {
      mode: "software",
      algorithm: "RS256",
      keyPath: process.env.ANCHOR_HSM_KEY_PATH || undefined,
    },
    relayer: {
      rpcUrl: process.env.ANCHOR_RPC_URL || "http://localhost:8545",
      chainId: process.env.ANCHOR_CHAIN_ID
        ? Number(process.env.ANCHOR_CHAIN_ID)
        : 31337,
      contractAddress: process.env.EVENT_ANCHOR_CONTRACT || "",
      privateKey: process.env.ANCHOR_PRIVATE_KEY || "",
    },
  });
  pipeline.on("error", (event) => {
    log(`Anchor pipeline error: ${JSON.stringify(event)}`, "anchor");
  });
  return pipeline;
}

async function ensureAnchorPipelineStarted(): Promise<AnchorPipeline | null> {
  if (anchorPipeline) return anchorPipeline;
  if (anchorPipelineStart) return anchorPipelineStart;

  anchorPipelineStart = (async () => {
    let pipeline: AnchorPipeline | null = null;
    try {
      pipeline = createAnchorPipeline();
      await pipeline.start();
      anchorPipeline = pipeline;
      log(
        `Real L2 anchor pipeline prepared (ANCHOR_BACKEND=${getAnchorBackend()})`,
        "anchor",
      );
      return pipeline;
    } catch (error) {
      logError(error, "Failed to start L2 anchor pipeline");
      if (pipeline) await pipeline.stop().catch(() => undefined);
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
  return anchorsToL2() ? pipeline : null;
}

export async function isAnchorBackendRuntimeReady(
  backend: AnchorBackend,
  pipeline: AnchorRuntimePipeline | null = anchorPipeline,
  nodeReady: boolean = natsPublisher.isConnected(),
): Promise<boolean> {
  if (backend === "node") return nodeReady;

  let l2Ready = false;
  try {
    if (pipeline?.getStats().started === true) {
      const health = await pipeline.relayer.getHealth();
      l2Ready = health.connected;
    }
  } catch {
    l2Ready = false;
  }

  return backend === "l2" ? l2Ready : nodeReady && l2Ready;
}

export interface AnchorRuntimePreparationDependencies {
  ensureL2Pipeline?: () => Promise<AnchorRuntimePipeline | null>;
  pipeline?: AnchorRuntimePipeline | null;
  nodeReady?: () => boolean;
}

export async function prepareAnchorBackendRuntime(
  backend: AnchorBackend,
  dependencies: AnchorRuntimePreparationDependencies = {},
): Promise<boolean> {
  const nodeReady = (
    dependencies.nodeReady ?? (() => natsPublisher.isConnected())
  )();
  if (backend === "node") return nodeReady;

  const usesSingletonInitializer =
    dependencies.pipeline === undefined &&
    dependencies.ensureL2Pipeline === undefined;
  const hadSingletonPipeline = anchorPipeline !== null;
  let pipeline =
    dependencies.pipeline === undefined
      ? anchorPipeline
      : dependencies.pipeline;
  if (!pipeline) {
    pipeline = await (
      dependencies.ensureL2Pipeline ?? ensureAnchorPipelineStarted
    )();
  }

  const l2Ready = await isAnchorBackendRuntimeReady("l2", pipeline, true);
  if (
    !l2Ready &&
    usesSingletonInitializer &&
    !hadSingletonPipeline &&
    pipeline &&
    pipeline === anchorPipeline
  ) {
    anchorPipeline = null;
    await (pipeline as AnchorPipeline).stop().catch(() => undefined);
  }
  return backend === "l2" ? l2Ready : nodeReady && l2Ready;
}

export interface AnchorAuditDispatchResult {
  targetBackend: AnchorBackend;
  auditQueueId: string;
  auditStatus: "queued";
  nodeQueued: boolean;
  l2Queued: boolean;
}

function toNodeWireEvent(event: AnchorControlEvent): Record<string, unknown> {
  return {
    asset: "anchor-backend-control",
    event_type: event.eventType,
    site_id: event.siteId,
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : event.timestamp,
    payload: {
      ...(event.data ?? {}),
      severity: event.severity,
      id: event.id,
    },
    details: event.message,
  };
}

function toL2Event(event: AnchorControlEvent): {
  id: string;
  timestamp: number;
  type: string;
  source: string;
  data: Record<string, unknown>;
} {
  return {
    id: event.id,
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp.getTime()
        : Date.parse(event.timestamp),
    type: event.eventType,
    source: "anchor-backend-control",
    data: {
      siteId: event.siteId,
      severity: event.severity,
      message: event.message,
      ...(event.data ?? {}),
    },
  };
}

/**
 * Queue an authorized switch intent through an explicit target backend.
 *
 * A successful return means every selected backend accepted the event into its
 * local/NATS queue. It does not claim durable storage or chain confirmation.
 */
export async function dispatchAnchorAuditEvent(
  targetBackend: AnchorBackend,
  event: AnchorControlEvent,
  dependencies: {
    nodePublisher?: Pick<typeof natsPublisher, "publish">;
    l2Pipeline?: Pick<AnchorPipeline, "ingestEvent"> | null;
  } = {},
): Promise<AnchorAuditDispatchResult> {
  const nodePublisher = dependencies.nodePublisher ?? natsPublisher;
  const l2Pipeline =
    dependencies.l2Pipeline === undefined
      ? anchorPipeline
      : dependencies.l2Pipeline;
  let nodeQueued = false;
  let l2Queued = false;

  if (targetBackend === "node" || targetBackend === "both") {
    nodeQueued = nodePublisher.publish(
      "scada.events",
      toNodeWireEvent(event),
    );
    if (!nodeQueued) {
      throw new Error(
        "NATS/node anchor backend did not accept the audit event",
      );
    }
  }

  if (targetBackend === "l2" || targetBackend === "both") {
    if (!l2Pipeline) {
      throw new Error("L2 anchor pipeline is unavailable for the audit event");
    }
    await l2Pipeline.ingestEvent(toL2Event(event));
    l2Queued = true;
  }

  return {
    targetBackend,
    auditQueueId: event.id,
    auditStatus: "queued",
    nodeQueued,
    l2Queued,
  };
}

/** Route a normal event through the currently selected production backend(s). */
export function dispatchAnchorEvent(
  event: AnchorControlEvent,
): Promise<AnchorAuditDispatchResult> {
  return dispatchAnchorAuditEvent(getAnchorBackend(), event);
}

export async function initializeBridges(): Promise<void> {
  if (anchorsToL2()) {
    await ensureAnchorPipelineStarted();
  } else {
    log(
      `Anchor pipeline not started (ANCHOR_BACKEND=${getAnchorBackend()}); anchoring via node`,
      "anchor",
    );
  }
  await stateSyncBridge.initialize();
}

export async function getActiveAnchorHealthStatus(
  backend: AnchorBackend = getAnchorBackend(),
  pipeline: AnchorRuntimePipeline | null = anchorPipeline,
  nodeReady: boolean = natsPublisher.isConnected(),
): Promise<{ healthy: boolean; message: string }> {
  const messages: string[] = [];
  let healthy = true;

  if (backend === "node" || backend === "both") {
    healthy = healthy && nodeReady;
    messages.push(
      nodeReady
        ? "NATS/node anchor queue connected"
        : "NATS/node anchor queue disconnected",
    );
  }

  if (backend === "l2" || backend === "both") {
    if (!pipeline) {
      healthy = false;
      messages.push("L2 anchor pipeline unavailable");
    } else {
      try {
        if (pipeline.getStats().started !== true) {
          healthy = false;
          messages.push("L2 anchor pipeline stopped");
        } else {
          const relayerHealth = await pipeline.relayer.getHealth();
          healthy = healthy && relayerHealth.connected;
          messages.push(
            relayerHealth.connected
              ? `L2 anchor relayer connected (block ${relayerHealth.blockNumber ?? "unknown"})`
              : `L2 anchor relayer disconnected (${relayerHealth.error ?? "unreachable"})`,
          );
        }
      } catch (error) {
        healthy = false;
        messages.push(
          `L2 anchor relayer health check failed (${(error as Error).message})`,
        );
      }
    }
  }

  return { healthy, message: messages.join("; ") };
}

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
