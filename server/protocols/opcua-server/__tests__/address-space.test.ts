/**
 * Tests for OPC-UA address-space mapping (#461).
 *
 * Pure logic: sites/tags -> UA folder/variable plan. No node-opcua required.
 */
import { describe, test, expect } from "vitest";
import {
  buildAddressSpace,
  mapDataType,
  escapeIdSegment,
  siteFolderNodeId,
  tagVariableNodeId,
  sitesRootNodeId,
  accessLevelFor,
  summarizePlan,
  OBJECTS_FOLDER_NODE_ID,
  DEFAULT_NAMESPACE_URI,
} from "../address-space";
import { UaDataType, UaAccessLevel } from "../types";
import type { SourceSite, SourceTag } from "../types";

const sites: SourceSite[] = [
  { id: "SITE-02", name: "North Plant" },
  { id: "SITE-01", name: "South Plant" },
];

const tags: SourceTag[] = [
  { tagId: "PT-101.PV", siteId: "SITE-01", dataType: "number", units: "bar" },
  {
    tagId: "RUN",
    siteId: "SITE-01",
    dataType: "boolean",
    writable: true,
    direction: "input",
  },
  { tagId: "BATCH-ID", siteId: "SITE-02", dataType: "string" },
];

describe("mapDataType", () => {
  test("maps scalar 0xSCADA types to UA built-ins", () => {
    expect(mapDataType("boolean")).toBe(UaDataType.Boolean);
    expect(mapDataType("number")).toBe(UaDataType.Double);
    expect(mapDataType("string")).toBe(UaDataType.String);
  });

  test("falls back to BaseDataType for object/array", () => {
    expect(mapDataType("object")).toBe(UaDataType.BaseDataType);
    expect(mapDataType("array")).toBe(UaDataType.BaseDataType);
  });

  test("plans a typed one-dimensional UA array", () => {
    const plan = buildAddressSpace(sites, [
      {
        tagId: "TEMPERATURES",
        siteId: "SITE-01",
        dataType: "array",
        elementDataType: "number",
      },
    ]);
    expect(plan.variables[0]).toMatchObject({
      dataType: UaDataType.Double,
      valueRank: 1,
    });
  });

  test("rejects an array tag without an explicit scalar element type", () => {
    expect(() =>
      buildAddressSpace(sites, [
        {
          tagId: "UNTYPED_ARRAY",
          siteId: "SITE-01",
          dataType: "array",
        },
      ]),
    ).toThrow(
      'Array tag "UNTYPED_ARRAY" must declare a scalar elementDataType',
    );
  });
});

describe("NodeId builders", () => {
  test("produce the documented string scheme", () => {
    expect(sitesRootNodeId()).toBe("ns=1;s=Sites");
    expect(siteFolderNodeId("SITE-01")).toBe("ns=1;s=Sites/SITE-01");
    expect(tagVariableNodeId("SITE-01", "PT-101.PV")).toBe(
      "ns=1;s=Tags/SITE-01/PT-101.PV",
    );
  });

  test("respect a custom namespace index", () => {
    expect(siteFolderNodeId("S", 3)).toBe("ns=3;s=Sites/S");
  });

  test("escape slashes and percents in id segments", () => {
    expect(escapeIdSegment("a/b%c")).toBe("a%2Fb%25c");
    expect(tagVariableNodeId("S", "a/b")).toBe("ns=1;s=Tags/S/a%2Fb");
  });
});

describe("accessLevelFor", () => {
  test("read-only by default", () => {
    expect(accessLevelFor({ tagId: "t", siteId: "s", dataType: "number" })).toBe(
      UaAccessLevel.CurrentRead,
    );
  });

  test("read+write when writable", () => {
    const level = accessLevelFor({
      tagId: "t",
      siteId: "s",
      dataType: "number",
      writable: true,
      direction: "input",
    });
    expect(level & UaAccessLevel.CurrentRead).toBeTruthy();
    expect(level & UaAccessLevel.CurrentWrite).toBeTruthy();
  });

  test("refuses write access for non-input tags", () => {
    const level = accessLevelFor({
      tagId: "t",
      siteId: "s",
      dataType: "number",
      writable: true,
      direction: "output",
    });
    expect(level).toBe(UaAccessLevel.CurrentRead);
  });
});

describe("buildAddressSpace", () => {
  test("creates a root Sites folder under Objects", () => {
    const plan = buildAddressSpace(sites, tags);
    const root = plan.folders[0];
    expect(root.nodeId).toBe("ns=1;s=Sites");
    expect(root.parentNodeId).toBe(OBJECTS_FOLDER_NODE_ID);
    expect(plan.namespaceUri).toBe(DEFAULT_NAMESPACE_URI);
  });

  test("one folder per site, deterministically sorted by id", () => {
    const plan = buildAddressSpace(sites, tags);
    // folders[0] is root, then SITE-01, SITE-02 (sorted).
    const siteFolders = plan.folders.slice(1);
    expect(siteFolders.map((f) => f.nodeId)).toEqual([
      "ns=1;s=Sites/SITE-01",
      "ns=1;s=Sites/SITE-02",
    ]);
    expect(siteFolders[0].displayName).toBe("South Plant");
  });

  test("one variable per tag, parented to its site folder", () => {
    const plan = buildAddressSpace(sites, tags);
    expect(plan.variables).toHaveLength(3);
    const run = plan.variables.find((v) => v.tagId === "RUN");
    expect(run).toBeDefined();
    expect(run!.parentNodeId).toBe("ns=1;s=Sites/SITE-01");
    expect(run!.dataType).toBe(UaDataType.Boolean);
    expect(run!.accessLevel & UaAccessLevel.CurrentWrite).toBeTruthy();
  });

  test("variables ordered by (siteId, tagId)", () => {
    const plan = buildAddressSpace(sites, tags);
    expect(plan.variables.map((v) => v.tagId)).toEqual([
      "PT-101.PV",
      "RUN",
      "BATCH-ID",
    ]);
  });

  test("tagIndex maps tagId -> variable NodeId", () => {
    const plan = buildAddressSpace(sites, tags);
    expect(plan.tagIndex.get("PT-101.PV")).toBe(
      "ns=1;s=Tags/SITE-01/PT-101.PV",
    );
    expect(plan.tagIndex.size).toBe(3);
  });

  test("units carried through to the variable node", () => {
    const plan = buildAddressSpace(sites, tags);
    expect(plan.variables.find((v) => v.tagId === "PT-101.PV")!.units).toBe(
      "bar",
    );
  });

  test("NodeIds are unique", () => {
    const plan = buildAddressSpace(sites, tags);
    const ids = [
      ...plan.folders.map((f) => f.nodeId),
      ...plan.variables.map((v) => v.nodeId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is deterministic across runs", () => {
    const a = buildAddressSpace(sites, tags);
    const b = buildAddressSpace([...sites].reverse(), [...tags].reverse());
    expect(a.variables.map((v) => v.nodeId)).toEqual(
      b.variables.map((v) => v.nodeId),
    );
    expect(a.folders.map((f) => f.nodeId)).toEqual(
      b.folders.map((f) => f.nodeId),
    );
  });

  test("drops orphan tags by default", () => {
    const plan = buildAddressSpace(sites, [
      ...tags,
      { tagId: "GHOST", siteId: "SITE-NONE", dataType: "number" },
    ]);
    expect(plan.variables.find((v) => v.tagId === "GHOST")).toBeUndefined();
    expect(plan.variables).toHaveLength(3);
  });

  test("throws on orphan tags when dropOrphanTags=false", () => {
    expect(() =>
      buildAddressSpace(
        sites,
        [{ tagId: "GHOST", siteId: "SITE-NONE", dataType: "number" }],
        { dropOrphanTags: false },
      ),
    ).toThrow(/unknown site/);
  });

  test("collapses duplicate (siteId, tagId) — last write wins", () => {
    const plan = buildAddressSpace(sites, [
      { tagId: "DUP", siteId: "SITE-01", dataType: "number" },
      { tagId: "DUP", siteId: "SITE-01", dataType: "boolean", writable: true },
    ]);
    const dup = plan.variables.filter((v) => v.tagId === "DUP");
    expect(dup).toHaveLength(1);
    expect(dup[0].dataType).toBe(UaDataType.Boolean);
  });

  test("distinct (siteId, tagId) pairs never collide under dedup", () => {
    // Regression: a naive `siteId + tagId` (or any single-delimiter) key can
    // collide for boundary-ambiguous inputs. e.g. ("A/B","C") vs ("A","B/C").
    // The escaped composite key must keep them as two separate variables.
    const plan = buildAddressSpace(
      [
        { id: "A/B", name: "AB" },
        { id: "A", name: "A" },
      ],
      [
        { tagId: "C", siteId: "A/B", dataType: "number" },
        { tagId: "B/C", siteId: "A", dataType: "number" },
      ],
    );
    expect(plan.variables).toHaveLength(2);
    const ids = plan.variables.map((v) => v.nodeId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("ns=1;s=Tags/A%2FB/C");
    expect(ids).toContain("ns=1;s=Tags/A/B%2FC");
  });

  test("de-duplicates sites by id", () => {
    const plan = buildAddressSpace(
      [
        { id: "SITE-01", name: "First" },
        { id: "SITE-01", name: "Second" },
      ],
      [],
    );
    expect(plan.folders.slice(1)).toHaveLength(1);
    expect(plan.folders[1].displayName).toBe("Second");
  });

  test("honours a custom namespace index/uri", () => {
    const plan = buildAddressSpace(sites, tags, {
      namespaceIndex: 4,
      namespaceUri: "urn:test",
    });
    expect(plan.namespaceIndex).toBe(4);
    expect(plan.namespaceUri).toBe("urn:test");
    expect(plan.folders[1].nodeId).toBe("ns=4;s=Sites/SITE-01");
  });

  test("falls back to site id when name is empty", () => {
    const plan = buildAddressSpace([{ id: "S-X", name: "" }], []);
    expect(plan.folders[1].browseName).toBe("S-X");
  });

  test("handles empty input", () => {
    const plan = buildAddressSpace([], []);
    expect(plan.folders).toHaveLength(1); // just the root
    expect(plan.variables).toHaveLength(0);
    expect(plan.tagIndex.size).toBe(0);
  });
});

describe("summarizePlan", () => {
  test("counts site folders and variables, excluding root", () => {
    const plan = buildAddressSpace(sites, tags);
    expect(summarizePlan(plan)).toEqual({ siteFolders: 2, variables: 3 });
  });

  test("empty plan summarises to zeroes", () => {
    expect(summarizePlan(buildAddressSpace([], []))).toEqual({
      siteFolders: 0,
      variables: 0,
    });
  });
});
