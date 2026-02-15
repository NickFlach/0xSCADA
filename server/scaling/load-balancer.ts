/**
 * Load Balancer — ADR-0014 [14.2]
 *
 * Round-robin, weighted, and least-connections strategies.
 */

import { EventEmitter } from 'events';
import type { GatewayNode, LoadBalancerConfig, LoadBalancerStrategy } from '../../shared/types/scaling';

export class LoadBalancer extends EventEmitter {
  private config: LoadBalancerConfig;
  private nodes: GatewayNode[] = [];
  private connections: Map<string, number> = new Map();
  private roundRobinIndex = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<LoadBalancerConfig> = {}) {
    super();
    this.config = {
      strategy: config.strategy ?? 'least-connections',
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 10000,
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      drainTimeoutMs: config.drainTimeoutMs ?? 30000,
    };
  }

  addNode(node: GatewayNode): void {
    this.nodes.push(node);
    this.connections.set(node.id, 0);
    this.emit('node-added', node.id);
  }

  removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== nodeId);
    this.connections.delete(nodeId);
    this.emit('node-removed', nodeId);
  }

  selectNode(): GatewayNode | null {
    const active = this.nodes.filter((n) => n.status === 'active');
    if (active.length === 0) return null;

    switch (this.config.strategy) {
      case 'round-robin':
        return this.roundRobin(active);
      case 'weighted':
        return this.weighted(active);
      case 'least-connections':
        return this.leastConnections(active);
      default:
        return this.roundRobin(active);
    }
  }

  recordConnection(nodeId: string): void {
    const current = this.connections.get(nodeId) ?? 0;
    this.connections.set(nodeId, current + 1);
  }

  releaseConnection(nodeId: string): void {
    const current = this.connections.get(nodeId) ?? 0;
    this.connections.set(nodeId, Math.max(0, current - 1));
  }

  setStrategy(strategy: LoadBalancerStrategy): void {
    this.config.strategy = strategy;
    this.emit('strategy-changed', strategy);
  }

  getActiveNodeCount(): number {
    return this.nodes.filter((n) => n.status === 'active').length;
  }

  getConnectionCount(nodeId: string): number {
    return this.connections.get(nodeId) ?? 0;
  }

  startHealthChecks(): void {
    this.healthCheckTimer = setInterval(() => {
      for (const node of this.nodes) {
        const timeSinceHeartbeat = Date.now() - node.lastHeartbeat;
        if (timeSinceHeartbeat > this.config.healthCheckIntervalMs * this.config.unhealthyThreshold) {
          if (node.status === 'active') {
            node.status = 'offline';
            this.emit('node-unhealthy', node.id);
          }
        }
      }
    }, this.config.healthCheckIntervalMs);
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private roundRobin(nodes: GatewayNode[]): GatewayNode {
    const node = nodes[this.roundRobinIndex % nodes.length];
    this.roundRobinIndex++;
    return node;
  }

  private weighted(nodes: GatewayNode[]): GatewayNode {
    const totalWeight = nodes.reduce((sum, n) => sum + n.weight, 0);
    let random = Math.random() * totalWeight;
    for (const node of nodes) {
      random -= node.weight;
      if (random <= 0) return node;
    }
    return nodes[nodes.length - 1];
  }

  private leastConnections(nodes: GatewayNode[]): GatewayNode {
    let minConns = Infinity;
    let selected = nodes[0];
    for (const node of nodes) {
      const conns = this.connections.get(node.id) ?? 0;
      if (conns < minConns) {
        minConns = conns;
        selected = node;
      }
    }
    return selected;
  }
}
