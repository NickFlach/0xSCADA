import { describe, it, expect, beforeEach } from 'vitest';
import {
  ValidatorHealthMonitor,
  parseOxscadaStatus,
  DEFAULT_THRESHOLDS,
  type FetchLike,
  type OxscadaStatus,
  type ValidatorAlert,
} from '../validator-health';
import { registry } from '../../metrics/prometheus';

/** Representative payload captured from oxscada `GET /status` (0xSCADA-node/src/rpc.rs). */
function oxscadaStatusFixture(overrides: Partial<OxscadaStatus> = {}): OxscadaStatus {
  return {
    node_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    height: 1042,
    role: 'validator',
    order_parameter: 0.97,
    mean_phase: 1.234,
    local_phase: 1.229,
    peer_phases: [
      { node_id: 'ffee', phase: 1.24, natural_freq: 0.5, last_updated: 1748810000 },
      { node_id: 'ddcc', phase: 1.22, natural_freq: 0.5, last_updated: 1748810001 },
    ],
    peers: 2,
    mempool: 7,
    uptime_ticks: 123456,
    ...overrides,
  };
}

function fetchReturning(payload: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}

function fetchFailing(): FetchLike {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

describe('parseOxscadaStatus', () => {
  it('accepts a representative oxscada /status payload', () => {
    const parsed = parseOxscadaStatus(oxscadaStatusFixture());
    expect(parsed.height).toBe(1042);
    expect(parsed.order_parameter).toBeCloseTo(0.97);
    expect(parsed.peer_phases).toHaveLength(2);
    expect(parsed.peer_phases[0].node_id).toBe('ffee');
  });

  it('rejects a Tendermint-style :26657 status payload', () => {
    // The shape ValidatorHealthMonitor used to (incorrectly) target — issue #442
    const tendermint = {
      jsonrpc: '2.0',
      id: -1,
      result: {
        node_info: { id: 'abc', network: 'test' },
        sync_info: { latest_block_height: '100', catching_up: false },
      },
    };
    expect(() => parseOxscadaStatus(tendermint)).toThrow(/peer_phases|node_id/);
  });

  it('rejects payloads with missing or mistyped fields', () => {
    expect(() => parseOxscadaStatus(null)).toThrow(/not an object/);
    expect(() => parseOxscadaStatus({ ...oxscadaStatusFixture(), height: '1042' })).toThrow(
      /"height" is not a number/
    );
    expect(() => parseOxscadaStatus({ ...oxscadaStatusFixture(), peer_phases: 'none' })).toThrow(
      /peer_phases/
    );
    const badPeer = oxscadaStatusFixture();
    (badPeer.peer_phases as unknown[])[0] = { node_id: 1, phase: 0, natural_freq: 0, last_updated: 0 };
    expect(() => parseOxscadaStatus(badPeer)).toThrow(/peer_phases\[0\]/);
  });
});

describe('ValidatorHealthMonitor', () => {
  let alerts: Array<{ alert: ValidatorAlert; node: string }>;

  beforeEach(() => {
    alerts = [];
  });

  function collect(monitor: ValidatorHealthMonitor): void {
    monitor.onAlert((alert, node) => alerts.push({ alert, node }));
  }

  it('marks a healthy node healthy and populates Prometheus gauges', async () => {
    const monitor = new ValidatorHealthMonitor(fetchReturning(oxscadaStatusFixture()));
    collect(monitor);
    monitor.addNode({ name: 'v1', rpcUrl: 'http://localhost:9090' });

    const status = await monitor.checkNode('v1');

    expect(status.healthy).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.status?.height).toBe(1042);
    expect(alerts).toHaveLength(0);

    // Issue #442 verification: gauges hold non-default values after a poll
    const label = { validator: 'v1' };
    expect(registry.gauge('blockchain_validator_up', '').get(label)).toBe(1);
    expect(registry.gauge('blockchain_validator_height', '').get(label)).toBe(1042);
    expect(registry.gauge('blockchain_validator_peers', '').get(label)).toBe(2);
    expect(registry.gauge('blockchain_validator_mempool_size', '').get(label)).toBe(7);
    expect(registry.gauge('blockchain_validator_order_parameter', '').get(label)).toBeCloseTo(0.97);
    expect(registry.gauge('blockchain_validator_last_seen_timestamp_seconds', '').get(label)).toBeGreaterThan(0);
  });

  it('raises a critical unreachable alert and zeroes the up gauge on connection failure', async () => {
    const monitor = new ValidatorHealthMonitor(fetchFailing());
    collect(monitor);
    monitor.addNode({ name: 'down', rpcUrl: 'http://localhost:9090' });

    const status = await monitor.checkNode('down');

    expect(status.healthy).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.consecutiveFailures).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert.severity).toBe('critical');
    expect(alerts[0].alert.code).toBe('unreachable');
    expect(registry.gauge('blockchain_validator_up', '').get({ validator: 'down' })).toBe(0);
  });

  it('flags an unexpected /status shape distinctly from unreachability', async () => {
    const monitor = new ValidatorHealthMonitor(fetchReturning({ totally: 'wrong' }));
    collect(monitor);
    monitor.addNode({ name: 'drifted', rpcUrl: 'http://localhost:9090' });

    await monitor.checkNode('drifted');

    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert.code).toBe('bad-status-shape');
  });

  it('alerts critical on zero peers and warning below minPeers', async () => {
    const zeroPeers = new ValidatorHealthMonitor(fetchReturning(oxscadaStatusFixture({ peers: 0 })));
    collect(zeroPeers);
    zeroPeers.addNode({ name: 'isolated', rpcUrl: 'http://x:9090' });
    await zeroPeers.checkNode('isolated');
    expect(alerts.some(a => a.alert.code === 'no-peers' && a.alert.severity === 'critical')).toBe(true);

    alerts = [];
    const lowPeers = new ValidatorHealthMonitor(fetchReturning(oxscadaStatusFixture({ peers: 1 })));
    collect(lowPeers);
    lowPeers.addNode({ name: 'sparse', rpcUrl: 'http://x:9090', thresholds: { minPeers: 3 } });
    await lowPeers.checkNode('sparse');
    expect(alerts.some(a => a.alert.code === 'low-peers' && a.alert.severity === 'warning')).toBe(true);
  });

  it('alerts when the Kuramoto order parameter drops below threshold', async () => {
    const monitor = new ValidatorHealthMonitor(
      fetchReturning(oxscadaStatusFixture({ order_parameter: 0.42 }))
    );
    collect(monitor);
    monitor.addNode({ name: 'decoherent', rpcUrl: 'http://x:9090' });

    const status = await monitor.checkNode('decoherent');

    expect(status.healthy).toBe(false);
    expect(alerts.some(a => a.alert.code === 'decoherent')).toBe(true);
    expect(DEFAULT_THRESHOLDS.minOrderParameter).toBeGreaterThan(0.42);
  });

  it('flags a node trailing the highest observed cluster height', async () => {
    let calls = 0;
    const fetchPerNode: FetchLike = async url => {
      calls++;
      const payload = url.includes('ahead')
        ? oxscadaStatusFixture({ height: 500 })
        : oxscadaStatusFixture({ height: 100 });
      return { ok: true, status: 200, json: async () => payload };
    };
    const monitor = new ValidatorHealthMonitor(fetchPerNode);
    collect(monitor);
    monitor.addNode({ name: 'ahead', rpcUrl: 'http://ahead:9090' });
    monitor.addNode({ name: 'behind', rpcUrl: 'http://behind:9090' });

    await monitor.checkNode('ahead');
    const behind = await monitor.checkNode('behind');

    expect(calls).toBe(2);
    expect(behind.healthy).toBe(false);
    expect(alerts.some(a => a.node === 'behind' && a.alert.code === 'height-lag')).toBe(true);
  });

  it('flags a stalled height after maxStalledChecks unchanged polls', async () => {
    const monitor = new ValidatorHealthMonitor(
      fetchReturning(oxscadaStatusFixture({ height: 777 }))
    );
    collect(monitor);
    monitor.addNode({
      name: 'stalled',
      rpcUrl: 'http://x:9090',
      thresholds: { maxStalledChecks: 2 },
    });

    await monitor.checkNode('stalled'); // establishes baseline height
    await monitor.checkNode('stalled'); // stalledChecks = 1
    const third = await monitor.checkNode('stalled'); // stalledChecks = 2 → alert

    expect(third.stalledChecks).toBe(2);
    expect(alerts.some(a => a.alert.code === 'height-stalled')).toBe(true);
  });

  it('emits a recovery info alert when a node returns to health', async () => {
    let failing = true;
    const flappingFetch: FetchLike = async () => {
      if (failing) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => oxscadaStatusFixture() };
    };
    const monitor = new ValidatorHealthMonitor(flappingFetch);
    collect(monitor);
    monitor.addNode({ name: 'flappy', rpcUrl: 'http://x:9090' });

    failing = false;
    await monitor.checkNode('flappy'); // healthy baseline (lastSeenHealthy set)
    failing = true;
    await monitor.checkNode('flappy'); // outage
    failing = false;
    const recovered = await monitor.checkNode('flappy');

    expect(recovered.healthy).toBe(true);
    expect(alerts.some(a => a.alert.code === 'recovered' && a.alert.severity === 'info')).toBe(true);
  });

  it('summarizes healthy and unhealthy nodes', async () => {
    const fetchPerNode: FetchLike = async url => {
      if (url.includes('bad')) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => oxscadaStatusFixture() };
    };
    const monitor = new ValidatorHealthMonitor(fetchPerNode);
    monitor.addNode({ name: 'good', rpcUrl: 'http://good:9090' });
    monitor.addNode({ name: 'bad', rpcUrl: 'http://bad:9090' });

    await monitor.checkNode('good');
    await monitor.checkNode('bad');

    expect(monitor.getSummary()).toEqual({ total: 2, healthy: 1, unhealthy: 1 });
    expect(monitor.getUnhealthyNodes().map(s => s.name)).toEqual(['bad']);
  });

  it('rejects duplicate registration and unknown node checks', async () => {
    const monitor = new ValidatorHealthMonitor(fetchReturning(oxscadaStatusFixture()));
    monitor.addNode({ name: 'v1', rpcUrl: 'http://x:9090' });
    expect(() => monitor.addNode({ name: 'v1', rpcUrl: 'http://y:9090' })).toThrow(/already registered/);
    await expect(monitor.checkNode('nope')).rejects.toThrow(/unknown validator/);
  });
});
