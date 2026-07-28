/**
 * Tag-store bridge tests (#464).
 *
 * The review noted `setControlSink()` had no caller outside tests and nothing
 * fed `updateTag`, so a running outstation would have answered every control
 * NOT_SUPPORTED and reported placeholder values. These cover the two production
 * pieces that close that: the poller that makes reads live, and the sink that
 * makes controls land — including everything it refuses.
 */
import { describe, it, expect, vi } from "vitest";
import {
  Dnp3TagStorePoller,
  InMemoryDnp3TagStore,
  createTagStoreControlSink,
  toPointQuality,
  type Dnp3TagStorePort,
} from "../tag-store-bridge";
import { Dnp3PointMap, type PointSample } from "../point-map";
import { DNP3_COMMAND_STATUS } from "../app-objects";
import type { Dnp3ControlCommand } from "../controls";

const POINTS = {
  points: [
    { tagId: "pump.run", type: "binaryInput" as const, index: 0, eventClass: 1 as const },
    { tagId: "tank.level", type: "analogInput" as const, index: 0, eventClass: 2 as const },
    // Same tag feeding two points: the poller must read it once.
    { tagId: "tank.level", type: "analogInput" as const, index: 1 },
    { tagId: "valve.cmd", type: "binaryOutput" as const, index: 0, writable: true },
    { tagId: "vent.cmd", type: "binaryOutput" as const, index: 1 },
    { tagId: "setpoint", type: "analogOutput" as const, index: 0, writable: true },
  ],
};

/** Records what the poller pushed. */
function recorder(): { updateTag(tagId: string, sample: PointSample): void; calls: Array<[string, PointSample]> } {
  const calls: Array<[string, PointSample]> = [];
  return {
    calls,
    updateTag(tagId: string, sample: PointSample): void {
      calls.push([tagId, sample]);
    },
  };
}

describe("toPointQuality", () => {
  it("maps the tag cache's quality enum onto DNP3 flag inputs", () => {
    expect(toPointQuality("GOOD")).toBe("good");
    expect(toPointQuality("UNCERTAIN")).toBe("uncertain");
    expect(toPointQuality("BAD")).toBe("bad");
  });
});

describe("Dnp3TagStorePoller", () => {
  const map = (): Dnp3PointMap => new Dnp3PointMap(POINTS);

  it("reads each mapped tag exactly once per cycle", () => {
    const sink = recorder();
    const poller = new Dnp3TagStorePoller(sink, new InMemoryDnp3TagStore(), map(), 1000);
    expect([...poller.mappedTagIds].sort()).toEqual([
      "pump.run",
      "setpoint",
      "tank.level",
      "valve.cmd",
      "vent.cmd",
    ]);
  });

  it("pushes what the store has and skips tags it has never seen", async () => {
    const store = new InMemoryDnp3TagStore();
    store.seed("pump.run", { value: true, quality: "good", timestamp: 1000 });
    store.seed("tank.level", { value: 7.25, quality: "uncertain", timestamp: 2000 });
    const sink = recorder();

    const poller = new Dnp3TagStorePoller(sink, store, map(), 1000);
    expect(await poller.pollOnce()).toBe(2);
    expect(sink.calls).toEqual([
      ["pump.run", { value: true, quality: "good", timestamp: 1000 }],
      ["tank.level", { value: 7.25, quality: "uncertain", timestamp: 2000 }],
    ]);
  });

  it("only pushes a tag again once its value or quality changes", async () => {
    const store = new InMemoryDnp3TagStore();
    store.seed("pump.run", { value: false, quality: "good", timestamp: 1 });
    const sink = recorder();
    const poller = new Dnp3TagStorePoller(sink, store, map(), 1000);

    expect(await poller.pollOnce()).toBe(1);
    // Same value, later timestamp: not a change, and pushing it would enqueue a
    // duplicate DNP3 event at the poll rate.
    store.seed("pump.run", { value: false, quality: "good", timestamp: 2 });
    expect(await poller.pollOnce()).toBe(0);

    store.seed("pump.run", { value: true, quality: "good", timestamp: 3 });
    expect(await poller.pollOnce()).toBe(1);

    // Quality alone changing is a change: the DNP3 flag octet differs.
    store.seed("pump.run", { value: true, quality: "bad", timestamp: 4 });
    expect(await poller.pollOnce()).toBe(1);

    expect(sink.calls.map(([, s]) => [s.value, s.quality])).toEqual([
      [false, "good"],
      [true, "good"],
      [true, "bad"],
    ]);
  });

  it("keeps polling the remaining tags when one read throws", async () => {
    const store: Dnp3TagStorePort = {
      async read(tagId: string): Promise<PointSample | undefined> {
        if (tagId === "pump.run") throw new Error("redis down");
        return { value: 1, quality: "good", timestamp: 5 };
      },
      async write(): Promise<void> {},
    };
    const sink = recorder();
    const poller = new Dnp3TagStorePoller(sink, store, map(), 1000);
    expect(await poller.pollOnce()).toBe(4);
    expect(sink.calls.some(([tagId]) => tagId === "pump.run")).toBe(false);
  });

  it("starts, stops, and does not leave a timer behind", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryDnp3TagStore();
      store.seed("pump.run", { value: true, quality: "good", timestamp: 1 });
      const sink = recorder();
      const poller = new Dnp3TagStorePoller(sink, store, map(), 50);

      expect(poller.isRunning).toBe(false);
      poller.start();
      expect(poller.isRunning).toBe(true);
      poller.start(); // idempotent
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(120);
      expect(sink.calls.length).toBeGreaterThan(0);

      poller.stop();
      expect(poller.isRunning).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      poller.stop(); // idempotent
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createTagStoreControlSink", () => {
  const map = (): Dnp3PointMap => new Dnp3PointMap(POINTS);

  const crob = (index: number, value = true): Dnp3ControlCommand => ({
    kind: "binaryOutput",
    group: 12,
    variation: 1,
    index,
    tagId: index === 0 ? "valve.cmd" : "vent.cmd",
    value,
    crob: { opType: 3, tcc: 0, clear: false, queue: false, count: 1, onTimeMs: 0, offTimeMs: 0 },
  });

  it("writes an output the point map marks writable", async () => {
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: map(), store });

    expect(sink(crob(0))).toEqual({ ok: true });
    await sink.settled();
    expect(store.peek("valve.cmd")?.value).toBe(true);
    expect(sink.pendingWrites).toBe(0);
  });

  it("refuses a mapped output that is not marked writable", async () => {
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: map(), store });

    expect(sink(crob(1))).toEqual({
      ok: false,
      status: DNP3_COMMAND_STATUS.NOT_SUPPORTED,
    });
    await sink.settled();
    expect(store.peek("vent.cmd")).toBeUndefined();
  });

  it("refuses an index the point map does not know", async () => {
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: map(), store });
    expect(sink({ ...crob(0), index: 99 })).toEqual({
      ok: false,
      status: DNP3_COMMAND_STATUS.NOT_SUPPORTED,
    });
    await sink.settled();
  });

  it("writes analog outputs through the same writable gate", async () => {
    const store = new InMemoryDnp3TagStore();
    const sink = createTagStoreControlSink({ pointMap: map(), store });
    expect(
      sink({ kind: "analogOutput", group: 41, variation: 1, index: 0, tagId: "setpoint", value: 42.5 }),
    ).toEqual({ ok: true });
    await sink.settled();
    expect(store.peek("setpoint")?.value).toBe(42.5);
  });

  it("applies writes to one tag in request order", async () => {
    const order: Array<number | boolean> = [];
    const store: Dnp3TagStorePort = {
      async read(): Promise<PointSample | undefined> {
        return undefined;
      },
      async write(_tagId: string, value: number | boolean): Promise<void> {
        // A slow first write must still land before the second.
        await new Promise((resolve) => setTimeout(resolve, order.length === 0 ? 25 : 0));
        order.push(value);
      },
    };
    const sink = createTagStoreControlSink({ pointMap: map(), store });
    sink(crob(0, true));
    sink(crob(0, false));
    expect(sink.pendingWrites).toBe(2);
    await sink.settled();
    expect(order).toEqual([true, false]);
  });

  it("surfaces a write that fails after the master was told SUCCESS", async () => {
    const failures: Array<{ tagId: string; err: unknown }> = [];
    const store: Dnp3TagStorePort = {
      async read(): Promise<PointSample | undefined> {
        return undefined;
      },
      async write(): Promise<void> {
        throw new Error("tag store unavailable");
      },
    };
    const sink = createTagStoreControlSink({
      pointMap: map(),
      store,
      onWriteError: (command, err) => failures.push({ tagId: command.tagId, err }),
    });

    // This is the honest limitation: the sink is synchronous because DNP3 needs
    // a CommandStatus in the response, so SUCCESS means "accepted for writing",
    // not "written".
    expect(sink(crob(0))).toEqual({ ok: true });
    await sink.settled();
    expect(failures).toHaveLength(1);
    expect(failures[0].tagId).toBe("valve.cmd");
    expect((failures[0].err as Error).message).toBe("tag store unavailable");
    // A failed write must not wedge the queue.
    expect(sink.pendingWrites).toBe(0);
    expect(sink(crob(0))).toEqual({ ok: true });
    await sink.settled();
  });
});
