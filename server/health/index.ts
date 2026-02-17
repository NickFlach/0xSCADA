/**
 * [12.8] Service Health & Readiness — Wiring
 *
 * Creates a singleton HealthManager, registers concrete checks for
 * every backend dependency, and exports the Express router.
 */

import { HealthManager, createDatabaseCheck, createBlockchainCheck, createGatewayCheck } from './health-manager';
import { storage } from '../storage';
import { blockchainService } from '../blockchain';

// ── Singleton ────────────────────────────────────────────────────────────────
export const healthManager = new HealthManager(/* cacheTtlMs */ 10_000);

// ── Register checks ──────────────────────────────────────────────────────────

// 1. Database (required) — must be healthy before anything else
healthManager.register(
  createDatabaseCheck(async () => {
    const h = await storage.healthCheck();
    if (!h.connected) throw new Error('Database not connected');
    return h;
  })
);

// 2. Blockchain RPC (optional, depends on database)
const rpcUrl = process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:8545';
healthManager.register(createBlockchainCheck(rpcUrl));

// 3. OPC-UA / Field gateway (optional)
healthManager.register(
  createGatewayCheck(() => {
    // Gateway is healthy if the blockchain service bootstrapped (lightweight proxy)
    return blockchainService.isEnabled();
  })
);

// 4. Simulator (optional, non-required)
healthManager.registerSimple(
  'simulator',
  async () => {
    // Just verify the import resolves — the simulator self-reports via events
    const { fieldSimulator } = await import('../simulator');
    return fieldSimulator != null;
  },
  /* required */ false,
);

// 5. Agent runtime (optional)
healthManager.registerSimple(
  'agent-runtime',
  async () => {
    try {
      const { agentRuntime } = await import('../agents/runtime');
      return agentRuntime != null;
    } catch {
      return false;
    }
  },
  false,
);

// ── Export the pre-built router ──────────────────────────────────────────────
export const healthRouter = healthManager.createRouter();
