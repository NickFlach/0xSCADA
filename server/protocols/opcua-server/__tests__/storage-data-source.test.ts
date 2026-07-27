/**
 * Tests for the storage-backed TagDataSource (#461).
 *
 * Exercises the pure parts: data-type inference, latest-value caching, and the
 * subscribe/push fan-out that drives UA DataChangeNotifications. No node-opcua
 * or database required (definitions are injected).
 */
import { describe, test, expect, vi } from "vitest";
import {
  StorageTagDataSource,
  inferDataType,
} from "../storage-data-source";
import type { SourceSite, SourceTag, TagSample } from "../types";

describe("inferDataType", () => {
  test("infers scalar types", () => {
    expect(inferDataType(true)).toBe("boolean");
    expect(inferDataType(42)).toBe("number");
    expect(inferDataType("hi")).toBe("string");
    expect(inferDataType([1, 2])).toBe("array");
    expect(inferDataType({ a: 1 })).toBe("object");
  });

  test("defaults to string for unknown", () => {
    expect(inferDataType(undefined)).toBe("string");
  });
});

function makeSource() {
  const sites: SourceSite[] = [{ id: "SITE-01", name: "Plant" }];
  const tagDefs: SourceTag[] = [
    { tagId: "PT-101.PV", siteId: "SITE-01", dataType: "number" },
  ];
  return new StorageTagDataSource({
    loadSites: async () => sites,
    loadTagDefs: async () => tagDefs,
  });
}

describe("StorageTagDataSource", () => {
  test("loadSites / loadTags delegate to injected loaders", async () => {
    const src = makeSource();
    expect(await src.loadSites()).toHaveLength(1);
    expect((await src.loadTags())[0].tagId).toBe("PT-101.PV");
  });

  test("readTag returns undefined until an update arrives", async () => {
    const src = makeSource();
    expect(await src.readTag("PT-101.PV")).toBeUndefined();
  });

  test("pushTagUpdate caches latest value and infers type", async () => {
    const src = makeSource();
    src.pushTagUpdate({
      tagName: "PT-101.PV",
      value: 12.5,
      quality: "good",
      timestamp: "2026-06-22T00:00:00Z",
    });
    const sample = await src.readTag("PT-101.PV");
    expect(sample).toMatchObject({
      tagId: "PT-101.PV",
      value: 12.5,
      dataType: "number",
      quality: "good",
    });
  });

  test("subscribe receives pushed updates; unsubscribe stops them", () => {
    const src = makeSource();
    const received: TagSample[] = [];
    const unsub = src.subscribe((s) => received.push(s));

    src.pushTagUpdate({
      tagName: "RUN",
      value: true,
      quality: "good",
      timestamp: "t1",
    });
    expect(received).toHaveLength(1);
    expect(received[0].dataType).toBe("boolean");

    unsub();
    src.pushTagUpdate({
      tagName: "RUN",
      value: false,
      quality: "good",
      timestamp: "t2",
    });
    expect(received).toHaveLength(1); // no further deliveries
  });

  test("a throwing listener does not break fan-out to others", () => {
    const src = makeSource();
    const good = vi.fn();
    src.subscribe(() => {
      throw new Error("boom");
    });
    src.subscribe(good);
    src.pushTagUpdate({
      tagName: "X",
      value: 1,
      quality: "good",
      timestamp: "t",
    });
    expect(good).toHaveBeenCalledOnce();
  });
});
