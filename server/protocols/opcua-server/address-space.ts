/**
 * OPC-UA Server Mode — Address Space Mapping
 *
 * PURE, dependency-free projection of the 0xSCADA site/tag schema into a UA
 * address-space plan: one Folder per site, one Variable per tag. This module
 * has NO dependency on `node-opcua`, so it is fully unit-testable (see
 * `__tests__/address-space.test.ts`). `index.ts` consumes the plan and
 * instantiates the matching `node-opcua` nodes.
 *
 * NodeId scheme (string identifiers in the application namespace):
 *   - Sites folder root : ns=<i>;s=Sites
 *   - Per-site folder    : ns=<i>;s=Sites/<siteId>
 *   - Per-tag variable   : ns=<i>;s=Tags/<siteId>/<tagId>
 *
 * Implements the address-space acceptance criterion of #461.
 */

import type { DataType } from "@shared/types/core/common";
import {
  UaAccessLevel,
  UaDataType,
  type AddressSpacePlan,
  type SourceSite,
  type SourceTag,
  type UaFolderNode,
  type UaVariableNode,
} from "./types";

/** Default application namespace URI for the 0xSCADA UA server. */
export const DEFAULT_NAMESPACE_URI = "urn:0xscada:server";

/** Namespace index for application nodes (NS0 is the UA base namespace). */
export const APPLICATION_NAMESPACE_INDEX = 1;

/** NodeId of the well-known UA `Objects` folder (NS0, numeric id 85). */
export const OBJECTS_FOLDER_NODE_ID = "ns=0;i=85";

/**
 * Map a 0xSCADA {@link DataType} to a UA built-in DataType. Numbers and
 * booleans map to their concrete UA scalar types; strings to UA String;
 * objects fall back to BaseDataType. The historian has no object schema from
 * which a stable UA StructureDefinition could be synthesized, so their final
 * wire representation remains documented JSON text.
 */
export function mapDataType(dataType: DataType): UaDataType {
  switch (dataType) {
    case "boolean":
      return UaDataType.Boolean;
    case "number":
      return UaDataType.Double;
    case "string":
      return UaDataType.String;
    case "object":
    case "array":
    default:
      return UaDataType.BaseDataType;
  }
}

function mapTagDataType(tag: SourceTag): UaDataType {
  if (tag.dataType !== "array") return mapDataType(tag.dataType);
  if (tag.elementDataType === undefined) {
    throw new Error(
      `Array tag "${tag.tagId}" must declare a scalar elementDataType`,
    );
  }
  return mapDataType(tag.elementDataType);
}

/**
 * Escape a path segment so it is safe inside a string NodeId. UA string
 * NodeIds are opaque, but `/` is our hierarchy separator so we percent-encode
 * it (and `%` itself) to keep round-tripping unambiguous.
 */
export function escapeIdSegment(segment: string): string {
  return segment.replace(/%/g, "%25").replace(/\//g, "%2F");
}

/** Build the NodeId string for the root Sites folder. */
export function sitesRootNodeId(ns = APPLICATION_NAMESPACE_INDEX): string {
  return `ns=${ns};s=Sites`;
}

/** Build the NodeId string for a per-site folder. */
export function siteFolderNodeId(
  siteId: string,
  ns = APPLICATION_NAMESPACE_INDEX,
): string {
  return `ns=${ns};s=Sites/${escapeIdSegment(siteId)}`;
}

/** Build the NodeId string for a per-tag variable. */
export function tagVariableNodeId(
  siteId: string,
  tagId: string,
  ns = APPLICATION_NAMESPACE_INDEX,
): string {
  return `ns=${ns};s=Tags/${escapeIdSegment(siteId)}/${escapeIdSegment(tagId)}`;
}

/** Compute the UA AccessLevel byte for a tag (read-only by default). */
export function accessLevelFor(tag: SourceTag): number {
  let level = UaAccessLevel.CurrentRead;
  if (tag.writable) {
    level |= UaAccessLevel.CurrentWrite;
  }
  return level;
}

export interface BuildAddressSpaceOptions {
  namespaceUri?: string;
  namespaceIndex?: number;
  /**
   * When true (default), tags whose `siteId` does not match any provided site
   * are dropped. When false, an error is thrown for orphan tags. The default
   * is lenient because tag tables (historian_data) may outlive a deleted site.
   */
  dropOrphanTags?: boolean;
}

/**
 * Build the full {@link AddressSpacePlan} from sites and tags.
 *
 * Guarantees (asserted by tests):
 *  - exactly one folder per site, deterministically ordered by site id;
 *  - exactly one variable per surviving tag, ordered by (siteId, tagId);
 *  - NodeIds are unique and stable across runs given the same input;
 *  - duplicate tagIds within the same site collapse to a single variable
 *    (last write wins) so the address space never contains colliding NodeIds.
 */
export function buildAddressSpace(
  sites: readonly SourceSite[],
  tags: readonly SourceTag[],
  options: BuildAddressSpaceOptions = {},
): AddressSpacePlan {
  const namespaceUri = options.namespaceUri ?? DEFAULT_NAMESPACE_URI;
  const namespaceIndex = options.namespaceIndex ?? APPLICATION_NAMESPACE_INDEX;
  const dropOrphanTags = options.dropOrphanTags ?? true;

  // Root "Sites" folder under the standard Objects folder.
  const root: UaFolderNode = {
    kind: "folder",
    nodeId: sitesRootNodeId(namespaceIndex),
    browseName: "Sites",
    displayName: "Sites",
    parentNodeId: OBJECTS_FOLDER_NODE_ID,
  };

  // De-duplicate sites by id (last wins) and sort for determinism.
  const siteById = new Map<string, SourceSite>();
  for (const site of sites) {
    siteById.set(site.id, site);
  }
  const sortedSites = [...siteById.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const folders: UaFolderNode[] = [root];
  for (const site of sortedSites) {
    folders.push({
      kind: "folder",
      nodeId: siteFolderNodeId(site.id, namespaceIndex),
      browseName: site.name || site.id,
      displayName: site.name || site.id,
      parentNodeId: root.nodeId,
    });
  }

  // De-duplicate tags by (siteId, tagId) — last write wins. The composite key
  // uses the escaped segments joined by "/" (the same encoding the NodeId uses)
  // so two distinct (siteId, tagId) pairs can never collide regardless of which
  // characters appear in either part.
  const tagByKey = new Map<string, SourceTag>();
  for (const tag of tags) {
    if (!siteById.has(tag.siteId)) {
      if (dropOrphanTags) continue;
      throw new Error(
        `Tag "${tag.tagId}" references unknown site "${tag.siteId}"`,
      );
    }
    const key = `${escapeIdSegment(tag.siteId)}/${escapeIdSegment(tag.tagId)}`;
    tagByKey.set(key, tag);
  }

  const sortedTags = [...tagByKey.values()].sort((a, b) => {
    if (a.siteId !== b.siteId) return a.siteId < b.siteId ? -1 : 1;
    return a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0;
  });

  const variables: UaVariableNode[] = [];
  const tagIndex = new Map<string, string>();
  for (const tag of sortedTags) {
    const nodeId = tagVariableNodeId(tag.siteId, tag.tagId, namespaceIndex);
    variables.push({
      kind: "variable",
      nodeId,
      browseName: tag.tagId,
      displayName: tag.name || tag.tagId,
      parentNodeId: siteFolderNodeId(tag.siteId, namespaceIndex),
      dataType: mapTagDataType(tag),
      ...(tag.dataType === "array" ? { valueRank: 1 } : {}),
      accessLevel: accessLevelFor(tag),
      units: tag.units,
      tagId: tag.tagId,
    });
    // tagIndex is keyed by bare tagId for value routing on data-change. If the
    // same tagId exists in multiple sites the last sorted site wins; callers
    // that need per-site routing should key on the variable NodeId instead.
    tagIndex.set(tag.tagId, nodeId);
  }

  return { namespaceUri, namespaceIndex, folders, variables, tagIndex };
}

/**
 * Summary counts for logging / health endpoints.
 */
export function summarizePlan(plan: AddressSpacePlan): {
  siteFolders: number;
  variables: number;
} {
  // -1 to exclude the root "Sites" folder from the site count.
  return {
    siteFolders: Math.max(0, plan.folders.length - 1),
    variables: plan.variables.length,
  };
}
