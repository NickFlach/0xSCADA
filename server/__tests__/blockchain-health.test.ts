/**
 * Blockchain health probe tests (#38).
 *
 * getBlockchainHealth() was a hardcoded `{ connected: false, error: 'Not
 * implemented' }` and blockchainService.isConnected() always returned false —
 * so the health surface lied precisely when anchoring was enabled. These tests
 * pin the honest contract: disabled is not a failure state (no error field),
 * an enabled probe reports real chain fields via the injected provider, a
 * failing or hanging provider yields an error shape without throwing, and
 * probes are cached so polled health endpoints don't stampede the RPC node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockchainService,
  configureBlockchainHealthProbe,
  getBlockchainHealth,
  type HealthProbeProvider,
} from '../blockchain';

const ENV_KEYS = ['ENABLE_BLOCKCHAIN', 'BLOCKCHAIN_ENABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};

function mockProvider(overrides: Partial<HealthProbeProvider> = {}): {
  provider: HealthProbeProvider;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
} {
  const getBlockNumber = vi.fn(async () => 1234);
  const getNetwork = vi.fn(async () => ({ chainId: 31337n }));
  const provider: HealthProbeProvider = {
    getBlockNumber: overrides.getBlockNumber ?? getBlockNumber,
    getNetwork: overrides.getNetwork ?? getNetwork,
  };
  return { provider, getBlockNumber, getNetwork };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  configureBlockchainHealthProbe();
});

describe('getBlockchainHealth — disabled', () => {
  it('reports an honest disabled shape: not connected, and NO error field', async () => {
    const health = await getBlockchainHealth();
    expect(health).toEqual({ connected: false });
    expect('error' in health).toBe(false);
    expect(blockchainService.isConnected()).toBe(false);
  });

  it('never touches the provider while disabled', async () => {
    const { provider, getBlockNumber, getNetwork } = mockProvider();
    configureBlockchainHealthProbe({ provider });
    await getBlockchainHealth();
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getNetwork).not.toHaveBeenCalled();
  });
});

describe('getBlockchainHealth — enabled', () => {
  beforeEach(() => {
    process.env.ENABLE_BLOCKCHAIN = 'true';
  });

  it('probes the provider and reports real chain fields', async () => {
    const { provider } = mockProvider();
    configureBlockchainHealthProbe({ provider });

    const health = await getBlockchainHealth();

    expect(health).toEqual({
      connected: true,
      blockNumber: 1234,
      networkId: '31337',
    });
    expect(blockchainService.isConnected()).toBe(true);
  });

  it('honors the BLOCKCHAIN_ENABLED alias too', async () => {
    delete process.env.ENABLE_BLOCKCHAIN;
    process.env.BLOCKCHAIN_ENABLED = 'true';
    const { provider } = mockProvider();
    configureBlockchainHealthProbe({ provider });

    const health = await getBlockchainHealth();
    expect(health.connected).toBe(true);
  });

  it('returns an error shape without throwing when the provider fails', async () => {
    const { provider } = mockProvider({
      getBlockNumber: vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8545');
      }),
    });
    configureBlockchainHealthProbe({ provider });

    const health = await getBlockchainHealth();

    expect(health.connected).toBe(false);
    expect(health.error).toContain('ECONNREFUSED');
    expect(blockchainService.isConnected()).toBe(false);
  });

  it('times out a hanging provider instead of hanging the health endpoint', async () => {
    const { provider } = mockProvider({
      getBlockNumber: vi.fn(() => new Promise<number>(() => {})),
    });
    configureBlockchainHealthProbe({ provider, timeoutMs: 10 });

    const health = await getBlockchainHealth();

    expect(health.connected).toBe(false);
    expect(health.error).toContain('timed out');
  });

  it('caches the probe result so polled health endpoints stay cheap', async () => {
    const { provider, getBlockNumber } = mockProvider();
    configureBlockchainHealthProbe({ provider, cacheMs: 60_000 });

    const first = await getBlockchainHealth();
    const second = await getBlockchainHealth();

    expect(second).toEqual(first);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the cache window has passed', async () => {
    const { provider, getBlockNumber } = mockProvider();
    configureBlockchainHealthProbe({ provider, cacheMs: 0 });

    await getBlockchainHealth();
    await getBlockchainHealth();

    expect(getBlockNumber).toHaveBeenCalledTimes(2);
  });

  it('isConnected() flips back to false after a failed re-probe', async () => {
    let fail = false;
    const { provider } = mockProvider({
      getBlockNumber: vi.fn(async () => {
        if (fail) throw new Error('node went away');
        return 1234;
      }),
    });
    configureBlockchainHealthProbe({ provider, cacheMs: 0 });

    await getBlockchainHealth();
    expect(blockchainService.isConnected()).toBe(true);

    fail = true;
    await getBlockchainHealth();
    expect(blockchainService.isConnected()).toBe(false);
  });
});
