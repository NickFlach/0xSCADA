/**
 * Horizontal Scaling Types — ADR-0014
 */

export interface ShardAssignment {
  shardId: string;
  gatewayId: string;
  tagRange: { start: number; end: number };
  tagCount: number;
  load: number; // 0-1
}

export interface ShardConfig {
  totalShards: number;
  replicationFactor: number;
  rebalanceThreshold: number; // load imbalance triggering rebalance
  virtualNodes: number; // virtual nodes per physical node in consistent hash ring
}

export interface GatewayNode {
  id: string;
  host: string;
  port: number;
  weight: number;
  status: 'active' | 'draining' | 'offline';
  currentLoad: number;
  maxCapacity: number;
  shards: string[];
  lastHeartbeat: number;
}

export type LoadBalancerStrategy = 'round-robin' | 'weighted' | 'least-connections';

export interface LoadBalancerConfig {
  strategy: LoadBalancerStrategy;
  healthCheckIntervalMs: number;
  unhealthyThreshold: number;
  drainTimeoutMs: number;
}

export interface LoadBalancerState {
  nodes: GatewayNode[];
  activeConnections: Map<string, number>;
  roundRobinIndex: number;
}

export interface ScalingMetrics {
  totalTags: number;
  totalGateways: number;
  totalShards: number;
  avgLoadPerGateway: number;
  maxLoadGateway: { id: string; load: number };
  minLoadGateway: { id: string; load: number };
  rebalanceCount: number;
  lastRebalanceTime: number;
}

export interface PartitionConfig {
  partitionKey: 'time' | 'tag' | 'site';
  partitionCount: number;
  retentionDays: number;
  compactionIntervalMs: number;
}
