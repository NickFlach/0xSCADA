import { describe, expect, it, vi } from "vitest";
import {
  ConsistentHashRing,
  PartitionedEventFanout,
  PartitionedHistorian,
  ServerLoadBalancer,
  type HistorianPartition,
  type HistorianPoint,
  type HistorianQuery,
} from "../horizontal";

describe("horizontal scaling primitives (#222)", () => {
  it("rebalances a consistent-hash ring with minimal movement on join/leave", () => {
    const tags = Array.from({ length: 2_000 }, (_, index) => `site:area/tag-${index}`);
    const ring = new ConsistentHashRing([{ id: "gw-a" }, { id: "gw-b" }], 128);
    const original = ring.assign(tags);

    ring.add({ id: "gw-c" });
    const joined = ring.rebalance(tags, original);
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.length).toBeLessThan(tags.length * 0.5);
    expect(joined.every((change) => change.to === "gw-c")).toBe(true);

    const withThird = ring.assign(tags);
    ring.remove("gw-c");
    const left = ring.rebalance(tags, withThird);
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((change) => change.from === "gw-c")).toBe(true);
    expect(ring.assign(tags)).toEqual(original);
  });

  it("is deterministic regardless of node insertion order", () => {
    const first = new ConsistentHashRing(
      [{ id: "gw-c" }, { id: "gw-a" }, { id: "gw-b" }],
      32,
    );
    const second = new ConsistentHashRing(
      [{ id: "gw-b" }, { id: "gw-c" }, { id: "gw-a" }],
      32,
    );
    const keys = Array.from({ length: 100 }, (_, index) => `tag-${index}`);
    expect(first.assign(keys)).toEqual(second.assign(keys));
  });

  it("supports round-robin, weighted, and least-connections selection", () => {
    const roundRobin = new ServerLoadBalancer([
      { id: "a" },
      { id: "b", healthy: false },
      { id: "c" },
    ]);
    const rr = Array.from({ length: 4 }, () => {
      const lease = roundRobin.acquire();
      const id = lease.target.id;
      lease.release();
      lease.release();
      return id;
    });
    expect(rr).toEqual(["a", "c", "a", "c"]);
    expect(roundRobin.snapshot().map((target) => target.activeConnections)).toEqual([
      0,
      0,
      0,
    ]);

    const weighted = new ServerLoadBalancer(
      [
        { id: "a", weight: 1 },
        { id: "b", weight: 2 },
      ],
      "weighted",
    );
    const weightedIds = Array.from({ length: 6 }, () => {
      const lease = weighted.acquire();
      lease.release();
      return lease.target.id;
    });
    expect(weightedIds.filter((id) => id === "a")).toHaveLength(2);
    expect(weightedIds.filter((id) => id === "b")).toHaveLength(4);

    const least = new ServerLoadBalancer(
      [
        { id: "small", weight: 1, activeConnections: 2 },
        { id: "large", weight: 4, activeConnections: 4 },
      ],
      "least-connections",
    );
    expect(least.acquire().target.id).toBe("large");
  });

  it("keeps active leases attached when a target is refreshed", () => {
    const balancer = new ServerLoadBalancer(
      [{ id: "api-a", weight: 1 }],
      "least-connections",
    );
    const lease = balancer.acquire();

    balancer.upsert({ id: "api-a", weight: 4, healthy: true });
    lease.release();

    expect(balancer.snapshot()).toEqual([
      {
        id: "api-a",
        weight: 4,
        healthy: true,
        activeConnections: 0,
      },
    ]);
    expect(() =>
      balancer.upsert({ id: "api-a", activeConnections: -1 }),
    ).toThrow(/non-negative integer/);
  });

  it("routes historian writes and federates sorted reads with explicit failures", async () => {
    const partitions = ["a", "b", "c"].map(
      (id): HistorianPartition & { writes: HistorianPoint[]; querySpy: ReturnType<typeof vi.fn> } => {
        const writes: HistorianPoint[] = [];
        const querySpy = vi.fn(async (_query: HistorianQuery) => writes);
        return {
          id,
          writes,
          querySpy,
          async write(point) {
            writes.push(point);
          },
          query: querySpy,
        };
      },
    );
    const historian = new PartitionedHistorian(partitions);
    const first = {
      tag: "area/temp",
      timestamp: new Date("2026-01-01T00:00:02Z"),
      value: 20,
    };
    const second = {
      tag: "area/pressure",
      timestamp: new Date("2026-01-01T00:00:01Z"),
      value: 4,
    };
    await historian.write(first);
    await historian.write(second);

    const routed = historian.route(first.tag);
    expect(partitions.find((partition) => partition.id === routed.id)!.writes).toContain(first);
    const selected = await historian.query({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-01T00:01:00Z"),
      tags: [first.tag],
    });
    expect(selected.failures).toEqual([]);
    expect(partitions.filter((partition) => partition.querySpy.mock.calls.length)).toHaveLength(1);

    partitions.forEach((partition) => partition.querySpy.mockClear());
    partitions[1].querySpy.mockRejectedValueOnce(new Error("shard unavailable"));
    const federated = await historian.query({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-01-01T00:01:00Z"),
    });
    expect(federated.points.map((point) => point.timestamp.toISOString())).toEqual(
      [...federated.points]
        .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
        .map((point) => point.timestamp.toISOString()),
    );
    expect(federated.failures).toEqual([
      { partitionId: "b", error: "shard unavailable" },
    ]);
  });

  it("moves historian tags only to a joining partition during scale-out", () => {
    const partition = (id: string): HistorianPartition => ({
      id,
      write: async () => undefined,
      query: async () => [],
    });
    const before = new PartitionedHistorian([partition("a"), partition("b")]);
    const after = new PartitionedHistorian([
      partition("a"),
      partition("b"),
      partition("c"),
    ]);
    const tags = Array.from({ length: 1_000 }, (_, index) => `tag-${index}`);
    const changes = tags.filter(
      (tag) => before.route(tag).id !== after.route(tag).id,
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.length).toBeLessThan(tags.length * 0.5);
    expect(changes.every((tag) => after.route(tag).id === "c")).toBe(true);
  });

  it("fans out only to a key's partition and isolates subscriber failures", async () => {
    const bus = new PartitionedEventFanout(8);
    const partition = bus.partitionFor("tag-7");
    const delivered: string[] = [];
    bus.subscribe(
      "telemetry",
      "partition-owner",
      async () => {
        delivered.push("partition-owner");
      },
      [partition],
    );
    bus.subscribe(
      "telemetry",
      "other-partition",
      async () => {
        delivered.push("other");
      },
      [(partition + 1) % 8],
    );
    bus.subscribe("telemetry", "failed-replica", async () => {
      throw new Error("consumer stopped");
    });

    const receipt = await bus.publish({
      topic: "telemetry",
      key: "tag-7",
      payload: { value: 42 },
    });
    expect(delivered).toEqual(["partition-owner"]);
    expect(receipt).toEqual({
      partition,
      delivered: 1,
      failures: [
        { subscriberId: "failed-replica", error: "consumer stopped" },
      ],
    });
  });

  it("preserves publish order within a topic partition", async () => {
    const bus = new PartitionedEventFanout(1);
    const seen: number[] = [];
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    bus.subscribe("events", "ordered-consumer", async (event) => {
      const sequence = (event.payload as { sequence: number }).sequence;
      seen.push(sequence);
      if (sequence === 1) {
        markEntered();
        await firstGate;
      }
    });
    const first = bus.publish({
      topic: "events",
      key: "same-partition",
      payload: { sequence: 1 },
    });
    await entered;
    const second = bus.publish({
      topic: "events",
      key: "same-partition",
      payload: { sequence: 2 },
    });
    await Promise.resolve();
    expect(seen).toEqual([1]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });
});
