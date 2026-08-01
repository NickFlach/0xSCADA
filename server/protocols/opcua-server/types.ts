/**
 * OPC-UA Server Mode — Shared Types
 *
 * Type contracts for the 0xSCADA OPC-UA server. These types are deliberately
 * independent of the `node-opcua` runtime so the address-space mapping and
 * security-policy selection can be unit-tested without the external dependency
 * being present (see CROSS-CUTTING RULE #3).
 *
 * Implements part of #461 ([wave:2c] OPC-UA Server Mode).
 */

import type { DataType, Quality, Timestamp } from "@shared/types/core/common";
import type { Site } from "@shared/types/core/industrial";

// ─── Source model (what the server exposes) ──────────────────────────────────

/**
 * A single 0xSCADA tag to be exposed as a UA Variable node.
 *
 * This is a protocol-neutral projection of the various tag-bearing tables in
 * `shared/schema.ts` (historian_data.tagId, alarms.tagId, process variables).
 * Producers populate it from `server/storage.ts`; the address-space mapper only
 * needs these fields.
 */
export interface SourceTag {
  /** Stable tag identifier, e.g. `PT-101.PV`. Used to build the UA NodeId. */
  tagId: string;
  /** Human-readable display name for the UA BrowseName / DisplayName. */
  name?: string;
  /** Site this tag belongs to. Must match a {@link SourceSite.id}. */
  siteId: string;
  /** 0xSCADA data type; mapped to a UA built-in DataType. */
  dataType: DataType;
  /**
   * Scalar element type. {@link buildAddressSpace} rejects an `array` tag when
   * this is absent so the server never silently advertises the wrong UA type.
   */
  elementDataType?: Exclude<DataType, "array" | "object">;
  /** Engineering units (mapped to UA EUInformation when present). */
  units?: string;
  /** Whether UA clients may write this variable. Defaults to read-only. */
  writable?: boolean;
  /**
   * Control-flow direction. Only `input` tags may accept UA writes. Sources
   * with real direction metadata provide it directly; the historian adapter's
   * explicit writable-input allowlist is also its direction assertion.
   */
  direction?: "input" | "output" | "internal";
  /** Optional source address (PLC register, OPC item id, …) for diagnostics. */
  address?: string;
}

/** A site grouping for tags. Subset of {@link Site} the mapper needs. */
export interface SourceSite {
  id: string;
  name: string;
}

/** Current value snapshot pushed into a UA Variable node. */
export interface TagSample {
  tagId: string;
  value: unknown;
  dataType: DataType;
  quality: Quality;
  timestamp: Timestamp;
}

// ─── Address-space model (pure, dependency-free) ─────────────────────────────

/**
 * UA built-in DataType identifiers we map to. Values are the standard
 * OPC-UA numeric NodeIds in Namespace 0 so callers binding to `node-opcua`
 * can pass them straight through, and tests can assert on stable numbers.
 *
 * Ref: OPC-UA Part 6, Annex A (built-in DataType NodeIds).
 */
export enum UaDataType {
  Boolean = 1,
  Double = 11,
  String = 12,
  // BaseDataType (generic Variant) — used for object/array tags we do not
  // further refine in this scaffold.
  BaseDataType = 24,
}

/** UA AccessLevel bit flags (OPC-UA Part 3). */
export enum UaAccessLevel {
  CurrentRead = 0x01,
  CurrentWrite = 0x02,
}

/** A planned UA Folder object node (one per site). */
export interface UaFolderNode {
  kind: "folder";
  /** Fully-qualified NodeId string, e.g. `ns=1;s=Sites/SITE-01`. */
  nodeId: string;
  browseName: string;
  displayName: string;
  /** NodeId of the parent (Objects folder or another site folder). */
  parentNodeId: string;
}

/** A planned UA Variable node (one per tag). */
export interface UaVariableNode {
  kind: "variable";
  /** Fully-qualified NodeId string, e.g. `ns=1;s=Tags/SITE-01/PT-101.PV`. */
  nodeId: string;
  browseName: string;
  displayName: string;
  /** NodeId of the owning site folder. */
  parentNodeId: string;
  dataType: UaDataType;
  /** UA ValueRank (`1` means a one-dimensional array). */
  valueRank?: number;
  accessLevel: number;
  units?: string;
  /** Echo of the originating tag id for value routing. */
  tagId: string;
  siteId: string;
  direction?: SourceTag["direction"];
}

export interface TagWriteRequest {
  tagId: string;
  siteId: string;
  value: unknown;
  username: string;
  timestamp: Date;
}

export type UaNode = UaFolderNode | UaVariableNode;

/**
 * The full planned address space: a flat, ordered list of nodes plus an index
 * from tagId -> variable NodeId for fast value routing on data-change.
 */
export interface AddressSpacePlan {
  /** Application namespace URI registered at index {@link namespaceIndex}. */
  namespaceUri: string;
  namespaceIndex: number;
  folders: UaFolderNode[];
  variables: UaVariableNode[];
  /** tagId -> variable NodeId. */
  tagIndex: Map<string, string>;
}
