/**
 * Admin Anchor-Backend shared routing-state tests (#455).
 *
 * HTTP authentication, public-token removal, and audit identity binding are
 * covered by control-plane-auth.test.ts. These tests prove the application
 * singleton updates the production source consumed by both anchor paths.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetAnchorBackendState,
  anchorsToL2,
  anchorsToNode,
  getAnchorBackendCoordinationStatus,
  getAnchorBackend,
  getAnchorBackendSnapshot,
  setAnchorBackend,
} from "../bridge/anchor-backend";
import { AnchorSwitch, anchorSwitch } from "../bridge/anchor-switch";
import {
  dispatchAnchorAuditEvent,
  getActiveAnchorHealthStatus,
  getAnchorPipeline,
  isAnchorBackendRuntimeReady,
  prepareAnchorBackendRuntime,
} from "../bridge";

const originalBackend = process.env.ANCHOR_BACKEND;

afterEach(() => {
  if (originalBackend === undefined) delete process.env.ANCHOR_BACKEND;
  else process.env.ANCHOR_BACKEND = originalBackend;
  _resetAnchorBackendState();
});

describe("admin anchor switch production binding", () => {
  it("requires connected node and L2 backends for the selected target", async () => {
    const startedPipeline = {
      getStats: () => ({ started: true }),
      relayer: { getHealth: async () => ({ connected: true }) },
    } as never;
    const stoppedPipeline = {
      getStats: () => ({ started: false }),
      relayer: { getHealth: async () => ({ connected: false }) },
    } as never;
    const disconnectedPipeline = {
      getStats: () => ({ started: true }),
      relayer: { getHealth: async () => ({ connected: false }) },
    } as never;

    await expect(isAnchorBackendRuntimeReady("node", null, true)).resolves.toBe(true);
    await expect(isAnchorBackendRuntimeReady("node", null, false)).resolves.toBe(false);
    await expect(isAnchorBackendRuntimeReady("l2", null, true)).resolves.toBe(false);
    await expect(isAnchorBackendRuntimeReady("both", stoppedPipeline, true)).resolves.toBe(false);
    await expect(isAnchorBackendRuntimeReady("l2", disconnectedPipeline, true)).resolves.toBe(false);
    await expect(isAnchorBackendRuntimeReady("l2", startedPipeline, false)).resolves.toBe(true);
    await expect(isAnchorBackendRuntimeReady("both", startedPipeline, true)).resolves.toBe(true);
    await expect(isAnchorBackendRuntimeReady("both", startedPipeline, false)).resolves.toBe(false);
  });

  it("prepares L2 from a node-only boot without changing routing until commit", async () => {
    setAnchorBackend("node");
    const ensureL2Pipeline = vi.fn().mockResolvedValue({
      getStats: () => ({ started: true }),
      relayer: { getHealth: async () => ({ connected: true, blockNumber: 42 }) },
    });

    await expect(prepareAnchorBackendRuntime("l2", {
      pipeline: null,
      ensureL2Pipeline,
      nodeReady: () => true,
    })).resolves.toBe(true);

    expect(ensureL2Pipeline).toHaveBeenCalledOnce();
    expect(getAnchorBackend()).toBe("node");
    expect(anchorsToL2()).toBe(false);
  });

  it("requires every selected backend in active anchor health", async () => {
    const connectedPipeline = {
      getStats: () => ({ started: true }),
      relayer: {
        getHealth: async () => ({ connected: true, blockNumber: 42 }),
      },
    } as never;
    const disconnectedPipeline = {
      getStats: () => ({ started: true }),
      relayer: {
        getHealth: async () => ({ connected: false, error: "RPC unavailable" }),
      },
    } as never;

    await expect(getActiveAnchorHealthStatus("node", null, false)).resolves.toMatchObject({
      healthy: false,
    });
    await expect(getActiveAnchorHealthStatus("l2", disconnectedPipeline, true)).resolves.toMatchObject({
      healthy: false,
    });
    await expect(getActiveAnchorHealthStatus("both", connectedPipeline, false)).resolves.toMatchObject({
      healthy: false,
    });
    await expect(getActiveAnchorHealthStatus("both", connectedPipeline, true)).resolves.toMatchObject({
      healthy: true,
    });
  });

  it("serializes complete switch commit operations and releases after failure", async () => {
    const isolatedSwitch = new AnchorSwitch({ backend: "node" });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = isolatedSwitch.runCommitExclusive(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      throw new Error("first failed");
    });
    const second = isolatedSwitch.runCommitExclusive(async () => {
      order.push("second:start");
      isolatedSwitch.setBackend("l2");
      order.push("second:end");
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    releaseFirst();
    await expect(first).rejects.toThrow("first failed");
    await second;

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(isolatedSwitch.getBackend()).toBe("l2");
  });

  it("holds process-local switching for multi-replica deployments", () => {
    expect(getAnchorBackendCoordinationStatus({
      OXSCADA_REPLICA_COUNT: "2",
    })).toMatchObject({ ready: false, replicas: 2 });
    expect(getAnchorBackendCoordinationStatus({
      OXSCADA_REPLICA_COUNT: "1",
    })).toEqual({ ready: true, replicas: 1 });
    expect(getAnchorBackendCoordinationStatus({
      OXSCADA_REPLICA_COUNT: "not-a-number",
    })).toMatchObject({ ready: false, replicas: 0 });
    expect(getAnchorBackendCoordinationStatus({
      NODE_ENV: "production",
    })).toMatchObject({ ready: false, replicas: 0 });
  });

  it("updates the same source consumed by production node/L2 routing", () => {
    process.env.ANCHOR_BACKEND = "node";
    _resetAnchorBackendState();

    expect(anchorSwitch.getBackend()).toBe("node");
    expect(anchorsToNode()).toBe(true);
    expect(anchorsToL2()).toBe(false);

    expect(anchorSwitch.setBackend("both")).toEqual({
      previous: "node",
      current: "both",
    });

    expect(getAnchorBackend()).toBe("both");
    expect(anchorsToNode()).toBe(true);
    expect(anchorsToL2()).toBe(true);
  });

  it("advances the backend revision on every runtime mutation, including ABA writes", () => {
    process.env.ANCHOR_BACKEND = "node";
    _resetAnchorBackendState();

    expect(getAnchorBackendSnapshot()).toEqual({ backend: "node", revision: 0 });
    setAnchorBackend("l2");
    expect(getAnchorBackendSnapshot()).toEqual({ backend: "l2", revision: 1 });
    setAnchorBackend("node");
    expect(getAnchorBackendSnapshot()).toEqual({ backend: "node", revision: 2 });
  });

  it("keeps the authenticated runtime override authoritative over boot config", () => {
    process.env.ANCHOR_BACKEND = "node";
    _resetAnchorBackendState();

    anchorSwitch.setBackend("l2");
    process.env.ANCHOR_BACKEND = "node";

    expect(anchorSwitch.getBackend()).toBe("l2");
    expect(getAnchorBackend()).toBe("l2");
    expect(anchorsToNode()).toBe(false);
    expect(anchorsToL2()).toBe(true);
  });

  it("stops exposing a warm L2 pipeline while routing is node-only", () => {
    const warmPipeline = {} as never;

    setAnchorBackend("both");
    expect(getAnchorPipeline(warmPipeline)).toBe(warmPipeline);

    setAnchorBackend("node");
    expect(getAnchorPipeline(warmPipeline)).toBeNull();
  });

  it("queues switch audits through every selected production backend", async () => {
    const nodeEvents: unknown[] = [];
    const l2Events: unknown[] = [];
    // The explicit target must win even though mutable global state still says
    // node-only at this pre-commit point.
    setAnchorBackend("node");

    const result = await dispatchAnchorAuditEvent(
      "both",
      {
        id: "switch-1",
        timestamp: new Date("2026-07-23T12:00:00.000Z"),
        eventType: "anchor-backend-switch-intent",
        siteId: "system",
        severity: "warning",
        message: "authorized backend switch intent",
        data: { previous: "node", requestedBackend: "both" },
      },
      {
        nodePublisher: {
          publish: (subject, event) => {
            nodeEvents.push({ subject, event });
            return true;
          },
        },
        l2Pipeline: {
          ingestEvent: async (event) => {
            l2Events.push(event);
          },
        },
      },
    );

    expect(result).toEqual({
      targetBackend: "both",
      auditQueueId: "switch-1",
      auditStatus: "queued",
      nodeQueued: true,
      l2Queued: true,
    });
    expect(nodeEvents).toHaveLength(1);
    expect(nodeEvents[0]).toMatchObject({ subject: "scada.events" });
    expect(l2Events).toHaveLength(1);
  });

  it("fails audit dispatch when the selected node backend cannot queue it", async () => {
    setAnchorBackend("l2");

    await expect(dispatchAnchorAuditEvent(
      "node",
      {
        id: "switch-2",
        timestamp: new Date("2026-07-23T12:00:00.000Z"),
        eventType: "anchor-backend-switch-intent",
        siteId: "system",
        severity: "warning",
        message: "authorized backend switch intent",
      },
      {
        nodePublisher: { publish: () => false },
        l2Pipeline: null,
      },
    )).rejects.toThrow("did not accept the audit event");

    expect(getAnchorBackend()).toBe("l2");
  });
});
