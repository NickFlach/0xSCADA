import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonFileEdgeQueue,
  MemoryEdgeQueue,
  QueueCapacityError,
  QueueIntegrityError,
  StoreAndForwardService,
  mergeConfigurationConflict,
  resolveTelemetryConflict,
  type EdgeUpstreamTransport,
  type ForwardBatch,
} from "../store-and-forward";

const services: StoreAndForwardService[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function unavailableTransport(): EdgeUpstreamTransport {
  return {
    isReachable: async () => false,
    forward: async () => {
      throw new Error("offline");
    },
  };
}

function service(
  options: ConstructorParameters<typeof StoreAndForwardService>[0] = {},
  dependencies: ConstructorParameters<typeof StoreAndForwardService>[1] = {},
): StoreAndForwardService {
  const created = new StoreAndForwardService(
    {
      heartbeatInterval: 60_000,
      retryInterval: 10,
      maxRetryInterval: 40,
      ...options,
    },
    {
      queue: new MemoryEdgeQueue(),
      transport: unavailableTransport(),
      ...dependencies,
    },
  );
  services.push(created);
  return created;
}

describe("durable edge resilience (#224)", () => {
  it("restores committed records after process restart", async () => {
    const queue = new MemoryEdgeQueue();
    const first = service(
      {},
      {
        queue,
        transport: unavailableTransport(),
        idFactory: () => "record-1",
        now: () => new Date("2026-07-28T12:00:00Z"),
      },
    );
    await first.initialize();
    await first.store({ value: 42 }, "driver-1");
    expect(first.getStatus().pendingRecords).toBe(1);
    await first.shutdown();

    const second = service(
      {},
      { queue, transport: unavailableTransport() },
    );
    await second.initialize();
    expect(second.pending()).toEqual([
      expect.objectContaining({
        id: "record-1",
        data: { value: 42 },
        driverId: "driver-1",
      }),
    ]);
  });

  it("persists an atomic JSON queue and rejects tampering on recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "0xscada-edge-"));
    temporaryDirectories.push(directory);
    const storagePath = join(directory, "queue.json");
    const first = service(
      { storagePath },
      {
        queue: new JsonFileEdgeQueue(storagePath),
        transport: unavailableTransport(),
        idFactory: () => "protected",
      },
    );
    await first.initialize();
    await first.store({ pressure: 12 }, "plc");
    await first.shutdown();

    const payload = JSON.parse(await readFile(storagePath, "utf8")) as {
      records: Array<{ data: unknown }>;
    };
    payload.records[0].data = { pressure: 999 };
    await writeFile(storagePath, JSON.stringify(payload), "utf8");

    const recovered = service(
      { storagePath },
      {
        queue: new JsonFileEdgeQueue(storagePath),
        transport: unavailableTransport(),
      },
    );
    await expect(recovered.initialize()).rejects.toBeInstanceOf(
      QueueIntegrityError,
    );
  });

  it("round-trips JSON data losslessly and rejects values JSON would coerce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "0xscada-edge-json-"));
    temporaryDirectories.push(directory);
    const storagePath = join(directory, "queue.json");
    const dependencies = {
      queue: new JsonFileEdgeQueue(storagePath),
      transport: unavailableTransport(),
      idFactory: () => "json-safe",
    };
    const first = service({ storagePath }, dependencies);
    await first.initialize();
    await expect(first.store({ reading: Number.NaN })).rejects.toThrow(
      /finite JSON numbers/,
    );
    await expect(
      first.store({ observedAt: new Date("2026-07-28T12:00:00Z") }),
    ).rejects.toThrow(/plain JSON objects/);
    const expected = {
      readings: [0, 12.5, null, true],
      labels: { area: "north", unit: "psi" },
    };
    await first.store(expected);
    await first.shutdown();

    const recovered = service(
      { storagePath },
      {
        queue: new JsonFileEdgeQueue(storagePath),
        transport: unavailableTransport(),
      },
    );
    await recovered.initialize();
    expect(recovered.pending()[0].data).toEqual(expected);
  });

  it("uses capped exponential reconnect backoff", async () => {
    const fixedNow = new Date("2026-07-28T12:00:00Z");
    const edge = service(
      {},
      {
        transport: unavailableTransport(),
        now: () => new Date(fixedNow),
      },
    );
    await edge.initialize();
    expect(edge.getStatus()).toMatchObject({
      consecutiveFailures: 1,
      nextRetryAt: new Date(fixedNow.getTime() + 10),
    });
    await edge.runConnectivityCycle();
    expect(edge.getStatus()).toMatchObject({
      consecutiveFailures: 2,
      nextRetryAt: new Date(fixedNow.getTime() + 20),
    });
    await edge.runConnectivityCycle();
    expect(edge.getStatus()).toMatchObject({
      consecutiveFailures: 3,
      nextRetryAt: new Date(fixedNow.getTime() + 40),
    });
    await edge.runConnectivityCycle();
    expect(edge.getStatus().nextRetryAt).toEqual(
      new Date(fixedNow.getTime() + 40),
    );
  });

  it("automatically drains verified batches after reconnect", async () => {
    let reachable = false;
    const forwarded: ForwardBatch[] = [];
    const transport: EdgeUpstreamTransport = {
      isReachable: async () => reachable,
      forward: async (batch) => {
        forwarded.push(batch);
        return {
          acknowledgedIds: batch.records.map((record) => record.id),
          verifiedMerkleRoot: batch.merkleRoot,
        };
      },
    };
    let id = 0;
    const edge = service(
      { forwardBatchSize: 2 },
      {
        transport,
        idFactory: () => `record-${++id}`,
      },
    );
    await edge.initialize();
    await edge.store({ value: 1 });
    await edge.store({ value: 2 });
    await edge.store({ value: 3 });
    reachable = true;

    expect(await edge.runConnectivityCycle()).toBe(true);
    expect(edge.getStatus()).toMatchObject({
      isConnected: true,
      pendingRecords: 0,
      consecutiveFailures: 0,
    });
    expect(forwarded.map((batch) => batch.records.length)).toEqual([2, 1]);
    expect(forwarded.every((batch) => /^[0-9a-f]{64}$/.test(batch.merkleRoot))).toBe(
      true,
    );
  });

  it("keeps every record when upstream integrity verification disagrees", async () => {
    const transport: EdgeUpstreamTransport = {
      isReachable: async () => true,
      forward: async (batch) => ({
        acknowledgedIds: batch.records.map((record) => record.id),
        verifiedMerkleRoot: "tampered-root",
      }),
    };
    const edge = service({}, { transport, idFactory: () => "record-1" });
    const divergences = vi.fn();
    edge.on("divergence", divergences);
    await edge.initialize();
    await edge.store({ value: 7 });

    expect(edge.getStatus()).toMatchObject({
      isConnected: false,
      pendingRecords: 1,
      divergenceCount: 1,
    });
    expect(divergences).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "integrity",
        resolution: "retry-local",
      }),
    );
  });

  it("continues local processing while offline", async () => {
    const process = vi.fn(async () => undefined);
    const edge = service(
      {},
      {
        transport: unavailableTransport(),
        localProcessors: [{ process }],
      },
    );
    await edge.initialize();
    await edge.store({ alarm: "high temperature" });
    expect(process).toHaveBeenCalledOnce();
    expect(edge.getStatus()).toMatchObject({
      isConnected: false,
      pendingRecords: 1,
    });
  });

  it("fails closed at capacity rather than deleting older industrial data", async () => {
    let id = 0;
    const edge = service(
      { maxLocalStorage: 1 },
      { idFactory: () => `record-${++id}` },
    );
    await edge.initialize();
    await edge.store({ value: "first" });
    await expect(edge.store({ value: "second" })).rejects.toBeInstanceOf(
      QueueCapacityError,
    );
    expect(edge.pending().map((record) => record.data)).toEqual([
      { value: "first" },
    ]);
  });

  it("resolves telemetry by LWW and configuration per field", () => {
    const older = {
      data: { value: 1 },
      timestamp: new Date("2026-07-28T11:00:00Z"),
      origin: "edge",
    };
    const newer = {
      data: { value: 2 },
      timestamp: new Date("2026-07-28T12:00:00Z"),
      origin: "cloud",
    };
    expect(resolveTelemetryConflict(older, newer)).toEqual(newer);

    const merged = mergeConfigurationConflict(
      {
        data: { alarm: { high: 90, low: 5 } },
        timestamp: new Date("2026-07-28T12:00:00Z"),
        origin: "edge",
        fieldVersions: {
          "alarm.high": {
            timestamp: new Date("2026-07-28T12:00:00Z"),
            origin: "edge",
          },
          "alarm.low": {
            timestamp: new Date("2026-07-28T10:00:00Z"),
            origin: "edge",
          },
        },
      },
      {
        data: { alarm: { high: 80, low: 10 }, display: { units: "C" } },
        timestamp: new Date("2026-07-28T11:00:00Z"),
        origin: "cloud",
      },
    );
    expect(merged.data).toEqual({
      alarm: { high: 90, low: 10 },
      display: { units: "C" },
    });
  });

  it("rejects ambiguous and prototype-mutating configuration fields", () => {
    const malicious = JSON.parse(
      '{"__proto__":{"edgePolluted":"yes"}}',
    ) as Record<string, unknown>;
    expect(() =>
      mergeConfigurationConflict(
        {
          data: {},
          timestamp: new Date("2026-07-28T11:00:00Z"),
          origin: "edge",
        },
        {
          data: malicious,
          timestamp: new Date("2026-07-28T12:00:00Z"),
          origin: "cloud",
        },
      ),
    ).toThrow(/forbidden key|invalid configuration field/);
    expect(({} as { edgePolluted?: string }).edgePolluted).toBeUndefined();

    expect(() =>
      mergeConfigurationConflict(
        {
          data: { "alarm.high": 90 },
          timestamp: new Date("2026-07-28T11:00:00Z"),
          origin: "edge",
        },
        {
          data: { alarm: { high: 80 } },
          timestamp: new Date("2026-07-28T12:00:00Z"),
          origin: "cloud",
        },
      ),
    ).toThrow(/invalid configuration field/);
  });
});
