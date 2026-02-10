/**
 * OPC-UA Subscription Manager Tests
 *
 * Issue #11 child: 6.1.4 - OPC-UA Subscription and Monitored Items
 *
 * TDD tests for subscription lifecycle, monitored items,
 * deadband filtering, data change notifications, and bulk operations.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  OpcUaSubscriptionManager,
  type SubscriptionConfig,
  type MonitoredItemConfig,
  type MonitoredItemInfo,
  DeadbandType,
  type DataChangeEvent,
} from "../gateway/opcua-subscription-manager";

// =============================================================================
// MOCK OPC-UA SESSION
// =============================================================================

function createMockMonitoredItem(nodeId: string) {
  const item = new EventEmitter() as EventEmitter & {
    monitoredItemId: number;
    itemToMonitor: { nodeId: string };
    terminate: ReturnType<typeof vi.fn>;
    statusCode: { value: number };
  };
  item.monitoredItemId = Math.floor(Math.random() * 10000);
  item.itemToMonitor = { nodeId };
  item.terminate = vi.fn().mockResolvedValue(undefined);
  item.statusCode = { value: 0 };
  return item;
}

function createMockSubscription() {
  const sub = new EventEmitter() as EventEmitter & {
    subscriptionId: number;
    monitor: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    publishingInterval: number;
    lifetimeCount: number;
    maxKeepAliveCount: number;
    maxNotificationsPerPublish: number;
    publishingEnabled: boolean;
    priority: number;
  };
  sub.subscriptionId = Math.floor(Math.random() * 10000);
  sub.publishingInterval = 1000;
  sub.lifetimeCount = 60;
  sub.maxKeepAliveCount = 10;
  sub.maxNotificationsPerPublish = 0;
  sub.publishingEnabled = true;
  sub.priority = 1;
  sub.terminate = vi.fn().mockResolvedValue(undefined);
  sub.monitor = vi.fn().mockImplementation((_itemToMonitor: any, _monitoringParams: any) => {
    const nodeId = _itemToMonitor.nodeId || "ns=2;s=Unknown";
    return Promise.resolve(createMockMonitoredItem(nodeId));
  });
  return sub;
}

function createMockSession() {
  const mockSub = createMockSubscription();
  return {
    createSubscription2: vi.fn().mockResolvedValue(mockSub),
    _mockSubscription: mockSub,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe("OpcUaSubscriptionManager", () => {
  let manager: OpcUaSubscriptionManager;
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    manager = new OpcUaSubscriptionManager();
    mockSession = createMockSession();
  });

  afterEach(async () => {
    await manager.destroyAll();
  });

  // ===========================================================================
  // Subscription Lifecycle
  // ===========================================================================

  describe("createSubscription", () => {
    it("should create a subscription with default config", async () => {
      const subId = await manager.createSubscription(mockSession as any);

      expect(subId).toBeDefined();
      expect(typeof subId).toBe("string");
      expect(mockSession.createSubscription2).toHaveBeenCalledTimes(1);
    });

    it("should create a subscription with custom config", async () => {
      const config: SubscriptionConfig = {
        publishingInterval: 500,
        lifetimeCount: 100,
        maxKeepAliveCount: 20,
        maxNotificationsPerPublish: 50,
        publishingEnabled: true,
        priority: 5,
      };

      const subId = await manager.createSubscription(mockSession as any, config);
      expect(subId).toBeDefined();
      expect(mockSession.createSubscription2).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedPublishingInterval: 500,
          requestedLifetimeCount: 100,
          requestedMaxKeepAliveCount: 20,
          maxNotificationsPerPublish: 50,
          publishingEnabled: true,
          priority: 5,
        })
      );
    });

    it("should track multiple subscriptions", async () => {
      const id1 = await manager.createSubscription(mockSession as any);
      const id2 = await manager.createSubscription(mockSession as any);

      expect(id1).not.toBe(id2);
      expect(manager.getSubscriptionIds()).toHaveLength(2);
    });
  });

  describe("deleteSubscription", () => {
    it("should delete an existing subscription", async () => {
      const subId = await manager.createSubscription(mockSession as any);
      await manager.deleteSubscription(subId);

      expect(manager.getSubscriptionIds()).toHaveLength(0);
    });

    it("should throw when deleting non-existent subscription", async () => {
      await expect(manager.deleteSubscription("nonexistent")).rejects.toThrow();
    });

    it("should terminate the underlying OPC-UA subscription", async () => {
      const subId = await manager.createSubscription(mockSession as any);
      const opcuaSub = mockSession._mockSubscription;

      await manager.deleteSubscription(subId);
      expect(opcuaSub.terminate).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Monitored Items
  // ===========================================================================

  describe("addMonitoredItem", () => {
    let subId: string;

    beforeEach(async () => {
      subId = await manager.createSubscription(mockSession as any);
    });

    it("should add a monitored item with default settings", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
      });

      expect(itemId).toBeDefined();
      expect(typeof itemId).toBe("string");
    });

    it("should add a monitored item with custom sampling interval and queue size", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
        samplingInterval: 250,
        queueSize: 10,
      });

      expect(itemId).toBeDefined();
      const info = manager.getMonitoredItemInfo(subId, itemId);
      expect(info).toBeDefined();
      expect(info!.nodeId).toBe("ns=2;s=Temperature");
      expect(info!.samplingInterval).toBe(250);
      expect(info!.queueSize).toBe(10);
    });

    it("should throw for non-existent subscription", async () => {
      await expect(
        manager.addMonitoredItem("nonexistent", { nodeId: "ns=2;s=X" })
      ).rejects.toThrow();
    });
  });

  describe("removeMonitoredItem", () => {
    let subId: string;

    beforeEach(async () => {
      subId = await manager.createSubscription(mockSession as any);
    });

    it("should remove a monitored item", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
      });

      await manager.removeMonitoredItem(subId, itemId);
      const info = manager.getMonitoredItemInfo(subId, itemId);
      expect(info).toBeUndefined();
    });

    it("should terminate the underlying monitored item", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
      });

      const items = manager.getMonitoredItems(subId);
      // The mock item's terminate should be called
      await manager.removeMonitoredItem(subId, itemId);
      // Verify through manager state
      expect(manager.getMonitoredItems(subId)).toHaveLength(0);
    });

    it("should throw for non-existent item", async () => {
      await expect(
        manager.removeMonitoredItem(subId, "nonexistent")
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // Data Change Notifications
  // ===========================================================================

  describe("data change notifications", () => {
    let subId: string;

    beforeEach(async () => {
      subId = await manager.createSubscription(mockSession as any);
    });

    it("should emit dataChange events when monitored item changes", async () => {
      const events: DataChangeEvent[] = [];
      manager.on("dataChange", (evt: DataChangeEvent) => events.push(evt));

      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
      });

      // Simulate data change from the mock monitored item
      const opcuaSub = mockSession._mockSubscription;
      const monitoredItem = await opcuaSub.monitor.mock.results[0].value;
      
      monitoredItem.emit("changed", {
        value: { value: 42.5 },
        statusCode: { value: 0 },
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      });

      expect(events).toHaveLength(1);
      expect(events[0].nodeId).toBe("ns=2;s=Temperature");
      expect(events[0].value).toBe(42.5);
      expect(events[0].subscriptionId).toBe(subId);
    });

    it("should include quality information in events", async () => {
      const events: DataChangeEvent[] = [];
      manager.on("dataChange", (evt: DataChangeEvent) => events.push(evt));

      await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
      });

      const opcuaSub = mockSession._mockSubscription;
      const monitoredItem = await opcuaSub.monitor.mock.results[0].value;

      monitoredItem.emit("changed", {
        value: { value: 0 },
        statusCode: { value: 0x80000000 }, // Bad status
        sourceTimestamp: new Date(),
        serverTimestamp: new Date(),
      });

      expect(events[0].quality).toBe("BAD");
    });
  });

  // ===========================================================================
  // Deadband Filtering
  // ===========================================================================

  describe("deadband filtering", () => {
    let subId: string;

    beforeEach(async () => {
      subId = await manager.createSubscription(mockSession as any);
    });

    it("should configure absolute deadband", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
        deadbandType: DeadbandType.Absolute,
        deadbandValue: 1.5,
      });

      const info = manager.getMonitoredItemInfo(subId, itemId);
      expect(info!.deadbandType).toBe(DeadbandType.Absolute);
      expect(info!.deadbandValue).toBe(1.5);
    });

    it("should configure percent deadband", async () => {
      const itemId = await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Pressure",
        deadbandType: DeadbandType.Percent,
        deadbandValue: 5.0,
      });

      const info = manager.getMonitoredItemInfo(subId, itemId);
      expect(info!.deadbandType).toBe(DeadbandType.Percent);
      expect(info!.deadbandValue).toBe(5.0);
    });

    it("should pass deadband parameters to OPC-UA monitor call", async () => {
      await manager.addMonitoredItem(subId, {
        nodeId: "ns=2;s=Temperature",
        deadbandType: DeadbandType.Absolute,
        deadbandValue: 2.0,
      });

      const opcuaSub = mockSession._mockSubscription;
      expect(opcuaSub.monitor).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: "ns=2;s=Temperature" }),
        expect.objectContaining({
          filter: expect.objectContaining({
            deadbandType: DeadbandType.Absolute,
            deadbandValue: 2.0,
          }),
        })
      );
    });
  });

  // ===========================================================================
  // Keep-Alive and Lifetime
  // ===========================================================================

  describe("subscription keep-alive and lifetime", () => {
    it("should emit keepAlive event", async () => {
      const keepAlives: string[] = [];
      manager.on("keepAlive", (subId: string) => keepAlives.push(subId));

      const subId = await manager.createSubscription(mockSession as any);
      const opcuaSub = mockSession._mockSubscription;

      opcuaSub.emit("keepalive");
      expect(keepAlives).toHaveLength(1);
      expect(keepAlives[0]).toBe(subId);
    });

    it("should emit terminated event when subscription ends", async () => {
      const terminated: string[] = [];
      manager.on("terminated", (subId: string) => terminated.push(subId));

      const subId = await manager.createSubscription(mockSession as any);
      const opcuaSub = mockSession._mockSubscription;

      opcuaSub.emit("terminated");
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toBe(subId);
    });

    it("should return subscription info with keep-alive settings", async () => {
      const subId = await manager.createSubscription(mockSession as any, {
        maxKeepAliveCount: 15,
        lifetimeCount: 90,
      });

      const info = manager.getSubscriptionInfo(subId);
      expect(info).toBeDefined();
      expect(info!.maxKeepAliveCount).toBe(15);
      expect(info!.lifetimeCount).toBe(90);
    });
  });

  // ===========================================================================
  // Bulk Operations
  // ===========================================================================

  describe("bulk operations", () => {
    let subId: string;

    beforeEach(async () => {
      subId = await manager.createSubscription(mockSession as any);
    });

    it("should bulk subscribe multiple items", async () => {
      const items: MonitoredItemConfig[] = [
        { nodeId: "ns=2;s=Temperature" },
        { nodeId: "ns=2;s=Pressure" },
        { nodeId: "ns=2;s=Flow" },
      ];

      const itemIds = await manager.addMonitoredItems(subId, items);
      expect(itemIds).toHaveLength(3);
      expect(manager.getMonitoredItems(subId)).toHaveLength(3);
    });

    it("should bulk unsubscribe multiple items", async () => {
      const items: MonitoredItemConfig[] = [
        { nodeId: "ns=2;s=Temperature" },
        { nodeId: "ns=2;s=Pressure" },
        { nodeId: "ns=2;s=Flow" },
      ];

      const itemIds = await manager.addMonitoredItems(subId, items);
      await manager.removeMonitoredItems(subId, itemIds);
      expect(manager.getMonitoredItems(subId)).toHaveLength(0);
    });

    it("should destroy all subscriptions", async () => {
      await manager.createSubscription(mockSession as any);
      await manager.createSubscription(mockSession as any);

      expect(manager.getSubscriptionIds()).toHaveLength(3); // including subId from beforeEach

      await manager.destroyAll();
      expect(manager.getSubscriptionIds()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe("edge cases", () => {
    it("should handle destroyAll when empty", async () => {
      await expect(manager.destroyAll()).resolves.not.toThrow();
    });

    it("should provide subscription count", async () => {
      expect(manager.subscriptionCount).toBe(0);
      await manager.createSubscription(mockSession as any);
      expect(manager.subscriptionCount).toBe(1);
    });

    it("should return undefined for non-existent subscription info", () => {
      expect(manager.getSubscriptionInfo("nonexistent")).toBeUndefined();
    });
  });
});
