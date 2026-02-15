import { describe, it, expect } from 'vitest';
import { ShardManager } from '../../scaling/shard-manager';
import type { GatewayNode } from '../../../shared/types/scaling';

function makeGateway(id: string): GatewayNode {
  return {
    id,
    host: `gw-${id}.local`,
    port: 4840,
    weight: 1,
    status: 'active',
    currentLoad: 0.5,
    maxCapacity: 50000,
    shards: [],
    lastHeartbeat: Date.now(),
  };
}

describe('ShardManager', () => {
  it('should add gateways and build hash ring', () => {
    const sm = new ShardManager({ virtualNodes: 10 });
    sm.addGateway(makeGateway('gw-1'));

    expect(sm.getGateways().size).toBe(1);
    expect(sm.getRingSize()).toBe(10);
  });

  it('should assign tags to gateways', () => {
    const sm = new ShardManager({ virtualNodes: 50 });
    sm.addGateway(makeGateway('gw-1'));
    sm.addGateway(makeGateway('gw-2'));

    const gw = sm.getGatewayForTag('sensor-42');
    expect(['gw-1', 'gw-2']).toContain(gw);
  });

  it('should distribute tags across gateways', () => {
    const sm = new ShardManager({ virtualNodes: 100 });
    sm.addGateway(makeGateway('gw-1'));
    sm.addGateway(makeGateway('gw-2'));

    const assignments = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const gw = sm.getGatewayForTag(`tag-${i}`)!;
      assignments.set(gw, (assignments.get(gw) ?? 0) + 1);
    }

    // Both gateways should get some tags
    expect(assignments.get('gw-1')).toBeGreaterThan(100);
    expect(assignments.get('gw-2')).toBeGreaterThan(100);
  });

  it('should rebalance on gateway removal', () => {
    const sm = new ShardManager({ virtualNodes: 50 });
    sm.addGateway(makeGateway('gw-1'));
    sm.addGateway(makeGateway('gw-2'));

    sm.removeGateway('gw-2');

    // All tags should go to gw-1
    for (let i = 0; i < 10; i++) {
      expect(sm.getGatewayForTag(`tag-${i}`)).toBe('gw-1');
    }
  });

  it('should report metrics', () => {
    const sm = new ShardManager();
    sm.addGateway(makeGateway('gw-1'));
    sm.addGateway(makeGateway('gw-2'));

    const metrics = sm.getMetrics();
    expect(metrics.totalGateways).toBe(2);
    expect(metrics.totalShards).toBeGreaterThan(0);
  });
});
