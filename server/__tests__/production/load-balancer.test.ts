import { describe, it, expect } from 'vitest';
import { LoadBalancer } from '../../scaling/load-balancer';
import type { GatewayNode } from '../../../shared/types/scaling';

function makeNode(id: string, weight = 1): GatewayNode {
  return {
    id, host: 'localhost', port: 3000, weight,
    status: 'active', currentLoad: 0.5, maxCapacity: 10000,
    shards: [], lastHeartbeat: Date.now(),
  };
}

describe('LoadBalancer', () => {
  it('should round-robin across nodes', () => {
    const lb = new LoadBalancer({ strategy: 'round-robin' });
    lb.addNode(makeNode('a'));
    lb.addNode(makeNode('b'));

    expect(lb.selectNode()?.id).toBe('a');
    expect(lb.selectNode()?.id).toBe('b');
    expect(lb.selectNode()?.id).toBe('a');
  });

  it('should select least-connections node', () => {
    const lb = new LoadBalancer({ strategy: 'least-connections' });
    lb.addNode(makeNode('a'));
    lb.addNode(makeNode('b'));

    lb.recordConnection('a');
    lb.recordConnection('a');
    lb.recordConnection('b');

    expect(lb.selectNode()?.id).toBe('b');
  });

  it('should respect weighted selection', () => {
    const lb = new LoadBalancer({ strategy: 'weighted' });
    lb.addNode(makeNode('heavy', 100));
    lb.addNode(makeNode('light', 1));

    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[lb.selectNode()!.id as 'heavy' | 'light']++;
    }

    expect(counts.heavy).toBeGreaterThan(counts.light * 5);
  });

  it('should return null with no active nodes', () => {
    const lb = new LoadBalancer();
    expect(lb.selectNode()).toBeNull();
  });

  it('should track connections', () => {
    const lb = new LoadBalancer();
    lb.addNode(makeNode('a'));
    lb.recordConnection('a');
    lb.recordConnection('a');
    expect(lb.getConnectionCount('a')).toBe(2);
    lb.releaseConnection('a');
    expect(lb.getConnectionCount('a')).toBe(1);
  });
});
