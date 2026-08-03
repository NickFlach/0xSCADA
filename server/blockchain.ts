/**
 * Blockchain integration module
 *
 * Health probing for the (opt-in) on-chain anchoring integration. The probe
 * reuses the integrity layer's connection config (ANCHOR_RPC_URL — the same
 * variable server/bridge/index.ts feeds the AnchorRelayerService) rather than
 * opening a second configuration path, and mirrors the relayer's own
 * getHealth() probe shape (see server/integrity/relayer.ts).
 */

import { ethers } from 'ethers';

export interface BlockchainHealth {
  connected: boolean;
  blockNumber?: number;
  networkId?: string;
  error?: string;
}

/** Structural subset of the ethers provider the probe calls (for injection). */
export interface HealthProbeProvider {
  getBlockNumber(): Promise<number>;
  getNetwork(): Promise<{ chainId: bigint }>;
}

/** Disabled is not a failure state: not connected, and no error to report. */
const DISABLED_HEALTH: BlockchainHealth = { connected: false };

/** Health endpoints get polled; probes are cached so polling stays cheap. */
const DEFAULT_CACHE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;

interface ProbeState {
  provider?: HealthProbeProvider;
  lastHealth: BlockchainHealth;
  lastProbeAt: number;
  cacheMs: number;
  timeoutMs: number;
}

const state: ProbeState = {
  lastHealth: DISABLED_HEALTH,
  lastProbeAt: 0,
  cacheMs: DEFAULT_CACHE_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/**
 * Lazily build the probe provider from the integrity layer's connection
 * config. Constructed only on an enabled probe path — a disabled deployment
 * never opens a connection or generates network traffic.
 */
function probeProvider(): HealthProbeProvider {
  if (!state.provider) {
    const rpcUrl =
      process.env.ANCHOR_RPC_URL ||
      process.env.BLOCKCHAIN_RPC_URL ||
      'http://localhost:8545';
    state.provider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return state.provider;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Blockchain health probe timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function probe(): Promise<BlockchainHealth> {
  try {
    const provider = probeProvider();
    const [blockNumber, network] = await withTimeout(
      Promise.all([provider.getBlockNumber(), provider.getNetwork()]),
      state.timeoutMs,
    );
    return {
      connected: true,
      blockNumber,
      networkId: network.chainId.toString(),
    };
  } catch (error) {
    return { connected: false, error: (error as Error).message };
  }
}

export const getBlockchainHealth = async (): Promise<BlockchainHealth> => {
  if (!blockchainService.isEnabled()) {
    state.lastHealth = DISABLED_HEALTH;
    return state.lastHealth;
  }
  const now = Date.now();
  if (state.lastProbeAt !== 0 && now - state.lastProbeAt < state.cacheMs) {
    return state.lastHealth;
  }
  // Stamp before awaiting so concurrent pollers don't stampede the RPC node.
  state.lastProbeAt = now;
  state.lastHealth = await probe();
  return state.lastHealth;
};

/**
 * Test hook: inject a probe provider and/or shrink the cache/timeout windows,
 * and reset the cached probe state. Calling with no arguments restores the
 * production defaults (and a lazily-built real provider).
 */
export function configureBlockchainHealthProbe(
  overrides: {
    provider?: HealthProbeProvider;
    cacheMs?: number;
    timeoutMs?: number;
  } = {},
): void {
  state.provider = overrides.provider;
  state.cacheMs = overrides.cacheMs ?? DEFAULT_CACHE_MS;
  state.timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  state.lastHealth = DISABLED_HEALTH;
  state.lastProbeAt = 0;
}

// Export service as expected by health/index.ts
export const blockchainService = {
  /** Reflects the most recent probe result (false until a probe succeeds). */
  isConnected: () => state.lastHealth.connected,
  /**
   * Whether on-chain anchoring is enabled. Blockchain integration is optional
   * and opt-in via configuration; disabled by default.
   */
  isEnabled: () =>
    process.env.ENABLE_BLOCKCHAIN === 'true' || process.env.BLOCKCHAIN_ENABLED === 'true',
  getHealth: getBlockchainHealth
};
