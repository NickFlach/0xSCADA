/**
 * Shard Manager — ADR-0014 [14.2]
 *
 * Consistent hashing for tag-to-gateway assignment with
 * automatic rebalancing on node add/remove.
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import type { ShardConfig, ShardAssignment, GatewayNode, ScalingMetrics } from '../../shared/types/scaling';

interface HashRingNode {
  hash: number;
  gatewayId: string;
  virtualIndex: number;
}

export class ShardManager extends EventEmitter {
  private config: ShardConfig;
  private ring: HashRingNode[] = [];
  private gateways: Map<string, GatewayNode> = new Map();
  private assignments: Map<string, ShardAssignment> = new Map();
  private rebalanceCount = 0;
  private lastRebalanceTime = 0;

  constructor(config: Partial<ShardConfig> = {}) {
    super();
    this.config = {
      totalShards: config.totalShards ?? 256,
      replicationFactor: config.replicationFactor ?? 2,
      rebalanceThreshold: config.rebalanceThreshold ?? 0.3,
      virtualNodes: config.virtualNodes ?? 150,
    };
  }

  addGateway(gateway: GatewayNode): void {
    this.gateways.set(gateway.id, gateway);
    this.addToRing(gateway.id);
    this.emit('gateway-added', gateway.id);

    if (this.gateways.size > 1) {
      this.rebalance();
    }
  }

  removeGateway(gatewayId: string): void {
    this.gateways.delete(gatewayId);
    this.removeFromRing(gatewayId);
    this.emit('gateway-removed', gatewayId);
    this.rebalance();
  }

  getGatewayForTag(tagId: string): string | null {
    if (this.ring.length === 0) return null;

    const hash = this.hash(tagId);
    let idx = this.ring.findIndex((n) => n.hash >= hash);
    if (idx === -1) idx = 0;

    return this.ring[idx].gatewayId;
  }

  getAssignment(shardId: string): ShardAssignment | undefined {
    return this.assignments.get(shardId);
  }

  getMetrics(): ScalingMetrics {
    const loads = Array.from(this.gateways.values()).map((g) => ({
      id: g.id,
      load: g.currentLoad,
    }));

    const sorted = [...loads].sort((a, b) => a.load - b.load);

    return {
      totalTags: Array.from(this.assignments.values()).reduce((sum, a) => sum + a.tagCount, 0),
      totalGateways: this.gateways.size,
      totalShards: this.assignments.size,
      avgLoadPerGateway:
        loads.length > 0 ? loads.reduce((sum, l) => sum + l.load, 0) / loads.length : 0,
      maxLoadGateway: sorted.length > 0 ? sorted[sorted.length - 1] : { id: '', load: 0 },
      minLoadGateway: sorted.length > 0 ? sorted[0] : { id: '', load: 0 },
      rebalanceCount: this.rebalanceCount,
      lastRebalanceTime: this.lastRebalanceTime,
    };
  }

  private rebalance(): void {
    if (this.gateways.size === 0) return;

    const loads = Array.from(this.gateways.values());
    const avgLoad = loads.reduce((s, g) => s + g.currentLoad, 0) / loads.length;
    const maxDeviation = Math.max(...loads.map((g) => Math.abs(g.currentLoad - avgLoad)));

    if (maxDeviation > this.config.rebalanceThreshold || this.assignments.size === 0) {
      // Redistribute shards across gateways
      const gatewayIds = Array.from(this.gateways.keys());
      const shardsPerGateway = Math.ceil(this.config.totalShards / gatewayIds.length);

      this.assignments.clear();
      for (let i = 0; i < this.config.totalShards; i++) {
        const gwIdx = Math.floor(i / shardsPerGateway) % gatewayIds.length;
        const shardId = `shard-${i}`;
        this.assignments.set(shardId, {
          shardId,
          gatewayId: gatewayIds[gwIdx],
          tagRange: { start: i * 1000, end: (i + 1) * 1000 - 1 },
          tagCount: 0,
          load: 0,
        });
      }

      this.rebalanceCount++;
      this.lastRebalanceTime = Date.now();
      this.emit('rebalanced', { shards: this.assignments.size, gateways: gatewayIds.length });
    }
  }

  private addToRing(gatewayId: string): void {
    for (let i = 0; i < this.config.virtualNodes; i++) {
      const hash = this.hash(`${gatewayId}-vn-${i}`);
      this.ring.push({ hash, gatewayId, virtualIndex: i });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  private removeFromRing(gatewayId: string): void {
    this.ring = this.ring.filter((n) => n.gatewayId !== gatewayId);
  }

  hash(key: string): number {
    const h = createHash('md5').update(key).digest();
    return h.readUInt32BE(0);
  }

  getGateways(): Map<string, GatewayNode> {
    return new Map(this.gateways);
  }

  getRingSize(): number {
    return this.ring.length;
  }
}
