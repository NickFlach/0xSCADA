/**
 * OPC-UA Address Space Browsing Service
 *
 * Issue #11 child: 6.1.2 - OPC-UA Address Space Browsing Service
 *
 * Features:
 * - Browse OPC-UA server address space (list nodes, folders, variables)
 * - Recursive browsing with configurable depth
 * - Node info retrieval (data type, access level, description)
 * - Caching of browse results for performance
 */

// =============================================================================
// TYPES
// =============================================================================

export enum OpcUaNodeClass {
  Object = 1,
  Variable = 2,
  Method = 4,
  ObjectType = 8,
  VariableType = 16,
  ReferenceType = 32,
  DataType = 64,
  View = 128,
}

export enum OpcUaAccessLevel {
  CurrentRead = 1,
  CurrentWrite = 2,
  HistoryRead = 4,
  HistoryWrite = 8,
}

export interface BrowseResult {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: OpcUaNodeClass;
  children?: BrowseResult[];
}

export interface NodeInfo {
  nodeId: string;
  displayName: string;
  description?: string;
  nodeClass: OpcUaNodeClass;
  dataType?: string;
  accessLevel?: number;
}

export interface BrowserOptions {
  /** Cache time-to-live in milliseconds. Default: 60000 (1 min) */
  cacheTtlMs?: number;
}

/** Minimal OPC-UA session interface we depend on */
export interface OpcUaSession {
  browse(nodeId: string | { nodeId: string }): Promise<{
    references: Array<{
      nodeId: { toString(): string };
      browseName: { name: string };
      displayName: { text: string };
      nodeClass: number;
      isForward: boolean;
    }> | null;
  }>;
  read(attrs: unknown[]): Promise<Array<{ value: { value: unknown } }>>;
}

// =============================================================================
// CACHE
// =============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class OpcUaAddressSpaceBrowser {
  private session: OpcUaSession;
  private cacheTtlMs: number;
  private browseCache = new Map<string, CacheEntry<BrowseResult[]>>();
  private nodeInfoCache = new Map<string, CacheEntry<NodeInfo>>();

  constructor(session: OpcUaSession, options?: BrowserOptions) {
    this.session = session;
    this.cacheTtlMs = options?.cacheTtlMs ?? 60_000;
  }

  /**
   * Browse direct children of a node. Returns only forward references.
   */
  async browse(nodeId: string): Promise<BrowseResult[]> {
    // Check cache
    const cached = this.browseCache.get(nodeId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const response = await this.session.browse(nodeId);
    const refs = response.references ?? [];

    const results: BrowseResult[] = refs
      .filter((r) => r.isForward)
      .map((r) => ({
        nodeId: r.nodeId.toString(),
        browseName: r.browseName.name,
        displayName: r.displayName.text,
        nodeClass: r.nodeClass as OpcUaNodeClass,
      }));

    this.browseCache.set(nodeId, { data: results, timestamp: Date.now() });
    return results;
  }

  /**
   * Browse recursively with configurable depth.
   * depth=1 returns only immediate children (no recursion into them).
   * depth=2 returns children + their children, etc.
   */
  async browseRecursive(nodeId: string, depth: number = 1): Promise<BrowseResult[]> {
    const children = await this.browse(nodeId);

    if (depth <= 1) {
      return children;
    }

    // Recurse into Object nodes
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeClass === OpcUaNodeClass.Object) {
        children[i].children = await this.browseRecursive(children[i].nodeId, depth - 1);
      }
    }

    return children;
  }

  /**
   * Get detailed information about a single node.
   */
  async getNodeInfo(nodeId: string): Promise<NodeInfo> {
    const cached = this.nodeInfoCache.get(nodeId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const attrs = [
      { nodeId, attributeId: 4 },  // DisplayName
      { nodeId, attributeId: 5 },  // Description
      { nodeId, attributeId: 2 },  // NodeClass
      { nodeId, attributeId: 14 }, // DataType
      { nodeId, attributeId: 17 }, // AccessLevel
    ];

    const results = await this.session.read(attrs);

    const info: NodeInfo = {
      nodeId,
      displayName: results[0].value.value as string,
      description: results[1].value.value as string | undefined || undefined,
      nodeClass: results[2].value.value as OpcUaNodeClass,
      dataType: results[3].value.value as string | undefined || undefined,
      accessLevel: results[4].value.value as number | undefined || undefined,
    };

    this.nodeInfoCache.set(nodeId, { data: info, timestamp: Date.now() });
    return info;
  }

  /**
   * Clear all cached browse and node info results.
   */
  clearCache(): void {
    this.browseCache.clear();
    this.nodeInfoCache.clear();
  }
}
