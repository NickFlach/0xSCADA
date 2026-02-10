/**
 * OPC-UA Subscription Manager
 *
 * Issue #11 child: 6.1.4 - OPC-UA Subscription and Monitored Items
 *
 * Features:
 * - Create/delete OPC-UA subscriptions
 * - Add/remove monitored items with configurable sampling interval and queue size
 * - Data change notifications via EventEmitter
 * - Deadband filtering (absolute and percent)
 * - Subscription keep-alive and lifetime management
 * - Bulk subscribe/unsubscribe operations
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

// =============================================================================
// TYPES
// =============================================================================

export enum DeadbandType {
  None = 0,
  Absolute = 1,
  Percent = 2,
}

export interface SubscriptionConfig {
  publishingInterval?: number;
  lifetimeCount?: number;
  maxKeepAliveCount?: number;
  maxNotificationsPerPublish?: number;
  publishingEnabled?: boolean;
  priority?: number;
}

export interface MonitoredItemConfig {
  nodeId: string;
  samplingInterval?: number;
  queueSize?: number;
  deadbandType?: DeadbandType;
  deadbandValue?: number;
}

export interface MonitoredItemInfo {
  itemId: string;
  nodeId: string;
  samplingInterval: number;
  queueSize: number;
  deadbandType: DeadbandType;
  deadbandValue: number;
}

export interface SubscriptionInfo {
  subscriptionId: string;
  publishingInterval: number;
  lifetimeCount: number;
  maxKeepAliveCount: number;
  maxNotificationsPerPublish: number;
  publishingEnabled: boolean;
  priority: number;
  monitoredItemCount: number;
}

export interface DataChangeEvent {
  subscriptionId: string;
  nodeId: string;
  value: any;
  quality: "GOOD" | "BAD" | "UNCERTAIN";
  sourceTimestamp: Date;
  serverTimestamp: Date;
}

// Internal tracking
interface SubscriptionEntry {
  id: string;
  config: Required<SubscriptionConfig>;
  opcuaSubscription: any;
  monitoredItems: Map<string, { config: MonitoredItemInfo; opcuaItem: any }>;
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

const DEFAULT_SUBSCRIPTION_CONFIG: Required<SubscriptionConfig> = {
  publishingInterval: 1000,
  lifetimeCount: 60,
  maxKeepAliveCount: 10,
  maxNotificationsPerPublish: 0,
  publishingEnabled: true,
  priority: 1,
};

const DEFAULT_SAMPLING_INTERVAL = 1000;
const DEFAULT_QUEUE_SIZE = 1;

// =============================================================================
// SUBSCRIPTION MANAGER
// =============================================================================

export class OpcUaSubscriptionManager extends EventEmitter {
  private subscriptions: Map<string, SubscriptionEntry> = new Map();

  // ===========================================================================
  // Subscription Lifecycle
  // ===========================================================================

  async createSubscription(
    session: any,
    config?: SubscriptionConfig
  ): Promise<string> {
    const mergedConfig = { ...DEFAULT_SUBSCRIPTION_CONFIG, ...config };
    const id = randomUUID();

    const opcuaSubscription = await session.createSubscription2({
      requestedPublishingInterval: mergedConfig.publishingInterval,
      requestedLifetimeCount: mergedConfig.lifetimeCount,
      requestedMaxKeepAliveCount: mergedConfig.maxKeepAliveCount,
      maxNotificationsPerPublish: mergedConfig.maxNotificationsPerPublish,
      publishingEnabled: mergedConfig.publishingEnabled,
      priority: mergedConfig.priority,
    });

    const entry: SubscriptionEntry = {
      id,
      config: mergedConfig,
      opcuaSubscription,
      monitoredItems: new Map(),
    };

    // Wire up keep-alive and terminated events
    opcuaSubscription.on("keepalive", () => {
      this.emit("keepAlive", id);
    });

    opcuaSubscription.on("terminated", () => {
      this.emit("terminated", id);
      this.subscriptions.delete(id);
    });

    this.subscriptions.set(id, entry);
    return id;
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    // Terminate all monitored items
    for (const [, item] of entry.monitoredItems) {
      await item.opcuaItem.terminate();
    }

    await entry.opcuaSubscription.terminate();
    this.subscriptions.delete(subscriptionId);
  }

  // ===========================================================================
  // Monitored Items
  // ===========================================================================

  async addMonitoredItem(
    subscriptionId: string,
    config: MonitoredItemConfig
  ): Promise<string> {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    const samplingInterval = config.samplingInterval ?? DEFAULT_SAMPLING_INTERVAL;
    const queueSize = config.queueSize ?? DEFAULT_QUEUE_SIZE;
    const deadbandType = config.deadbandType ?? DeadbandType.None;
    const deadbandValue = config.deadbandValue ?? 0;

    const monitoringParams: any = {
      samplingInterval,
      queueSize,
      discardOldest: true,
    };

    if (deadbandType !== DeadbandType.None) {
      monitoringParams.filter = {
        deadbandType,
        deadbandValue,
      };
    }

    const opcuaItem = await entry.opcuaSubscription.monitor(
      { nodeId: config.nodeId },
      monitoringParams
    );

    const itemId = randomUUID();
    const info: MonitoredItemInfo = {
      itemId,
      nodeId: config.nodeId,
      samplingInterval,
      queueSize,
      deadbandType,
      deadbandValue,
    };

    // Wire up data change events
    opcuaItem.on("changed", (dataValue: any) => {
      const statusCode = dataValue.statusCode?.value ?? 0;
      let quality: "GOOD" | "BAD" | "UNCERTAIN" = "GOOD";
      if (statusCode & 0x80000000) quality = "BAD";
      else if (statusCode & 0x40000000) quality = "UNCERTAIN";

      const event: DataChangeEvent = {
        subscriptionId,
        nodeId: config.nodeId,
        value: dataValue.value?.value,
        quality,
        sourceTimestamp: dataValue.sourceTimestamp ?? new Date(),
        serverTimestamp: dataValue.serverTimestamp ?? new Date(),
      };

      this.emit("dataChange", event);
    });

    entry.monitoredItems.set(itemId, { config: info, opcuaItem });
    return itemId;
  }

  async removeMonitoredItem(
    subscriptionId: string,
    itemId: string
  ): Promise<void> {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) {
      throw new Error(`Subscription not found: ${subscriptionId}`);
    }

    const item = entry.monitoredItems.get(itemId);
    if (!item) {
      throw new Error(`Monitored item not found: ${itemId}`);
    }

    await item.opcuaItem.terminate();
    entry.monitoredItems.delete(itemId);
  }

  // ===========================================================================
  // Bulk Operations
  // ===========================================================================

  async addMonitoredItems(
    subscriptionId: string,
    configs: MonitoredItemConfig[]
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const config of configs) {
      ids.push(await this.addMonitoredItem(subscriptionId, config));
    }
    return ids;
  }

  async removeMonitoredItems(
    subscriptionId: string,
    itemIds: string[]
  ): Promise<void> {
    for (const itemId of itemIds) {
      await this.removeMonitoredItem(subscriptionId, itemId);
    }
  }

  async destroyAll(): Promise<void> {
    const ids = [...this.subscriptions.keys()];
    for (const id of ids) {
      await this.deleteSubscription(id);
    }
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  getSubscriptionIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  getSubscriptionInfo(subscriptionId: string): SubscriptionInfo | undefined {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) return undefined;

    return {
      subscriptionId: entry.id,
      publishingInterval: entry.config.publishingInterval,
      lifetimeCount: entry.config.lifetimeCount,
      maxKeepAliveCount: entry.config.maxKeepAliveCount,
      maxNotificationsPerPublish: entry.config.maxNotificationsPerPublish,
      publishingEnabled: entry.config.publishingEnabled,
      priority: entry.config.priority,
      monitoredItemCount: entry.monitoredItems.size,
    };
  }

  getMonitoredItemInfo(
    subscriptionId: string,
    itemId: string
  ): MonitoredItemInfo | undefined {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) return undefined;
    return entry.monitoredItems.get(itemId)?.config;
  }

  getMonitoredItems(subscriptionId: string): MonitoredItemInfo[] {
    const entry = this.subscriptions.get(subscriptionId);
    if (!entry) return [];
    return [...entry.monitoredItems.values()].map((v) => v.config);
  }
}
