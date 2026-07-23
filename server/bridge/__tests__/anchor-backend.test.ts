import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAnchorBackend,
  anchorsToL2,
  anchorsToNode,
  _resetWarningLatch,
} from '../anchor-backend';
import { EventAnchorBridge } from '../event-anchor';
import { natsPublisher } from '../../services/nats';

const ORIGINAL = process.env.ANCHOR_BACKEND;

function setBackend(value: string | undefined) {
  if (value === undefined) delete process.env.ANCHOR_BACKEND;
  else process.env.ANCHOR_BACKEND = value;
}

afterEach(() => {
  setBackend(ORIGINAL);
  _resetWarningLatch();
  vi.restoreAllMocks();
});

describe('getAnchorBackend (#443)', () => {
  it('defaults to the canonical node backend', () => {
    setBackend(undefined);
    expect(getAnchorBackend()).toBe('node');
    expect(anchorsToNode()).toBe(true);
    expect(anchorsToL2()).toBe(false);
  });

  it('honors l2, node, and both (case-insensitive)', () => {
    setBackend('l2');
    expect(anchorsToL2()).toBe(true);
    expect(anchorsToNode()).toBe(false);

    setBackend('BOTH');
    expect(anchorsToL2()).toBe(true);
    expect(anchorsToNode()).toBe(true);

    setBackend('node');
    expect(anchorsToL2()).toBe(false);
    expect(anchorsToNode()).toBe(true);
  });

  it('falls back to node on garbage, warning once', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setBackend('sidechain');
    expect(getAnchorBackend()).toBe('node');
    getAnchorBackend();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('exactly one backend receives events per config', () => {
  let publishSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    publishSpy = vi.spyOn(natsPublisher, 'publish').mockImplementation(() => {});
  });

  const wireEvent = {
    asset: 'TR-MAIN-01',
    event_type: 'BREAKER_TRIP',
    site_id: 'site-1',
    timestamp: '2026-03-15T22:00:00Z',
  };

  it('ANCHOR_BACKEND=node: node path publishes, L2 bridge refuses to initialize', async () => {
    setBackend('node');

    natsPublisher.publishScadaEvent(wireEvent);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    const bridge = new EventAnchorBridge({ enabled: true });
    await bridge.initialize();
    expect(bridge.getStatus().enabled).toBe(false);
    expect(bridge.getStatus().isHealthy).toBe(false);
  });

  it('ANCHOR_BACKEND=l2: node path is silent, L2 bridge may initialize', async () => {
    setBackend('l2');

    natsPublisher.publishScadaEvent(wireEvent);
    expect(publishSpy).not.toHaveBeenCalled();

    process.env.EVENT_ANCHOR_CONTRACT = '0x' + '1'.repeat(40);
    try {
      const bridge = new EventAnchorBridge({ enabled: true });
      await bridge.initialize();
      expect(bridge.getStatus().enabled).toBe(true);
    } finally {
      delete process.env.EVENT_ANCHOR_CONTRACT;
    }
  });

  it('ANCHOR_BACKEND=both: both paths active (migration window only)', async () => {
    setBackend('both');

    natsPublisher.publishScadaEvent(wireEvent);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    process.env.EVENT_ANCHOR_CONTRACT = '0x' + '1'.repeat(40);
    try {
      const bridge = new EventAnchorBridge({ enabled: true });
      await bridge.initialize();
      expect(bridge.getStatus().enabled).toBe(true);
    } finally {
      delete process.env.EVENT_ANCHOR_CONTRACT;
    }
  });
});
