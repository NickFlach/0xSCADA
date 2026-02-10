/**
 * OPC-UA Address Space Browser - Tests
 *
 * Issue #11 child: 6.1.2 - OPC-UA Address Space Browsing Service
 * TDD: Tests written first, then implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpcUaAddressSpaceBrowser,
  BrowseResult,
  NodeInfo,
  OpcUaNodeClass,
  OpcUaAccessLevel,
} from "../gateway/opcua-address-space-browser";

// =============================================================================
// MOCK SESSION
// =============================================================================

function createMockSession() {
  const session = {
    browse: vi.fn(),
    read: vi.fn(),
  };
  return session;
}

function makeBrowseReference(opts: {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: number;
  isForward?: boolean;
}) {
  return {
    nodeId: { toString: () => opts.nodeId },
    browseName: { name: opts.browseName },
    displayName: { text: opts.displayName },
    nodeClass: opts.nodeClass,
    isForward: opts.isForward ?? true,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("OpcUaAddressSpaceBrowser", () => {
  let browser: OpcUaAddressSpaceBrowser;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    mockSession = createMockSession();
    browser = new OpcUaAddressSpaceBrowser(mockSession as any);
  });

  afterEach(() => {
    browser.clearCache();
  });

  // ---------------------------------------------------------------------------
  // browse()
  // ---------------------------------------------------------------------------

  describe("browse()", () => {
    it("should browse root node and return child references", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=0;i=85",
            browseName: "Objects",
            displayName: "Objects",
            nodeClass: OpcUaNodeClass.Object,
          }),
          makeBrowseReference({
            nodeId: "ns=0;i=86",
            browseName: "Types",
            displayName: "Types",
            nodeClass: OpcUaNodeClass.Object,
          }),
        ],
      });

      const result = await browser.browse("ns=0;i=84"); // Root
      expect(result).toHaveLength(2);
      expect(result[0].nodeId).toBe("ns=0;i=85");
      expect(result[0].browseName).toBe("Objects");
      expect(result[0].nodeClass).toBe(OpcUaNodeClass.Object);
      expect(result[1].nodeId).toBe("ns=0;i=86");
    });

    it("should return empty array when no references", async () => {
      mockSession.browse.mockResolvedValue({ references: [] });
      const result = await browser.browse("ns=0;i=999");
      expect(result).toEqual([]);
    });

    it("should handle null references", async () => {
      mockSession.browse.mockResolvedValue({ references: null });
      const result = await browser.browse("ns=0;i=999");
      expect(result).toEqual([]);
    });

    it("should filter forward references only by default", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=0;i=85",
            browseName: "Objects",
            displayName: "Objects",
            nodeClass: OpcUaNodeClass.Object,
            isForward: true,
          }),
          makeBrowseReference({
            nodeId: "ns=0;i=1",
            browseName: "Parent",
            displayName: "Parent",
            nodeClass: OpcUaNodeClass.Object,
            isForward: false,
          }),
        ],
      });

      const result = await browser.browse("ns=0;i=50");
      expect(result).toHaveLength(1);
      expect(result[0].browseName).toBe("Objects");
    });
  });

  // ---------------------------------------------------------------------------
  // browseRecursive()
  // ---------------------------------------------------------------------------

  describe("browseRecursive()", () => {
    it("should browse recursively to specified depth", async () => {
      // Depth 0: root has one child folder
      mockSession.browse.mockResolvedValueOnce({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=Folder1",
            browseName: "Folder1",
            displayName: "Folder1",
            nodeClass: OpcUaNodeClass.Object,
          }),
        ],
      });
      // Depth 1: Folder1 has a variable
      mockSession.browse.mockResolvedValueOnce({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=Var1",
            browseName: "Var1",
            displayName: "Variable 1",
            nodeClass: OpcUaNodeClass.Variable,
          }),
        ],
      });

      const result = await browser.browseRecursive("ns=0;i=85", 2);
      expect(result).toHaveLength(1);
      expect(result[0].nodeId).toBe("ns=1;s=Folder1");
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].nodeId).toBe("ns=1;s=Var1");
    });

    it("should stop at max depth", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=Deep",
            browseName: "Deep",
            displayName: "Deep",
            nodeClass: OpcUaNodeClass.Object,
          }),
        ],
      });

      const result = await browser.browseRecursive("ns=0;i=85", 1);
      // depth=1 means only browse the root, don't recurse into children
      expect(result).toHaveLength(1);
      expect(result[0].children).toBeUndefined();
      // session.browse called only once (for the root)
      expect(mockSession.browse).toHaveBeenCalledTimes(1);
    });

    it("should default depth to 1 if not specified", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=Child",
            browseName: "Child",
            displayName: "Child",
            nodeClass: OpcUaNodeClass.Object,
          }),
        ],
      });

      await browser.browseRecursive("ns=0;i=85");
      expect(mockSession.browse).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getNodeInfo()
  // ---------------------------------------------------------------------------

  describe("getNodeInfo()", () => {
    it("should retrieve detailed node information", async () => {
      mockSession.read.mockResolvedValue([
        { value: { value: "Temperature" } },   // DisplayName
        { value: { value: "A temperature sensor" } }, // Description
        { value: { value: OpcUaNodeClass.Variable } }, // NodeClass
        { value: { value: "Double" } },         // DataType
        { value: { value: 3 } },                // AccessLevel (CurrentRead | CurrentWrite)
      ]);

      const info = await browser.getNodeInfo("ns=1;s=Temp");
      expect(info.nodeId).toBe("ns=1;s=Temp");
      expect(info.displayName).toBe("Temperature");
      expect(info.description).toBe("A temperature sensor");
      expect(info.nodeClass).toBe(OpcUaNodeClass.Variable);
      expect(info.dataType).toBe("Double");
      expect(info.accessLevel).toBe(3);
    });

    it("should handle missing optional attributes gracefully", async () => {
      mockSession.read.mockResolvedValue([
        { value: { value: "MyNode" } },
        { value: { value: null } },
        { value: { value: OpcUaNodeClass.Object } },
        { value: { value: null } },
        { value: { value: null } },
      ]);

      const info = await browser.getNodeInfo("ns=1;s=Obj");
      expect(info.displayName).toBe("MyNode");
      expect(info.description).toBeUndefined();
      expect(info.dataType).toBeUndefined();
      expect(info.accessLevel).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  describe("caching", () => {
    it("should cache browse results and not re-query", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=Cached",
            browseName: "Cached",
            displayName: "Cached",
            nodeClass: OpcUaNodeClass.Variable,
          }),
        ],
      });

      const r1 = await browser.browse("ns=0;i=85");
      const r2 = await browser.browse("ns=0;i=85");
      expect(r1).toEqual(r2);
      expect(mockSession.browse).toHaveBeenCalledTimes(1);
    });

    it("should return fresh results after clearCache()", async () => {
      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=A",
            browseName: "A",
            displayName: "A",
            nodeClass: OpcUaNodeClass.Variable,
          }),
        ],
      });

      await browser.browse("ns=0;i=85");
      browser.clearCache();
      await browser.browse("ns=0;i=85");
      expect(mockSession.browse).toHaveBeenCalledTimes(2);
    });

    it("should cache node info results", async () => {
      mockSession.read.mockResolvedValue([
        { value: { value: "X" } },
        { value: { value: null } },
        { value: { value: OpcUaNodeClass.Variable } },
        { value: { value: "Int32" } },
        { value: { value: 1 } },
      ]);

      await browser.getNodeInfo("ns=1;s=X");
      await browser.getNodeInfo("ns=1;s=X");
      expect(mockSession.read).toHaveBeenCalledTimes(1);
    });

    it("should respect cache TTL", async () => {
      const shortTtlBrowser = new OpcUaAddressSpaceBrowser(mockSession as any, { cacheTtlMs: 50 });

      mockSession.browse.mockResolvedValue({
        references: [
          makeBrowseReference({
            nodeId: "ns=1;s=T",
            browseName: "T",
            displayName: "T",
            nodeClass: OpcUaNodeClass.Variable,
          }),
        ],
      });

      await shortTtlBrowser.browse("ns=0;i=85");
      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 60));
      await shortTtlBrowser.browse("ns=0;i=85");
      expect(mockSession.browse).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("should throw when session.browse fails", async () => {
      mockSession.browse.mockRejectedValue(new Error("Connection lost"));
      await expect(browser.browse("ns=0;i=85")).rejects.toThrow("Connection lost");
    });

    it("should throw when session.read fails", async () => {
      mockSession.read.mockRejectedValue(new Error("Timeout"));
      await expect(browser.getNodeInfo("ns=1;s=X")).rejects.toThrow("Timeout");
    });
  });
});
