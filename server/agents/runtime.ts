/**
 * Agent runtime module
 */

export interface AgentHealth {
  totalAgents: number;
  activeAgents: number;
  errors: string[];
}

export const getAgentHealth = async (): Promise<AgentHealth> => {
  // Report marketplace plugins as the agent population (#217). Lazy import
  // keeps this module dependency-free for callers that only need the shape.
  try {
    const { marketplaceService } = await import('../services/marketplace');
    const status = marketplaceService.marketplace.getStatus();
    const errors = marketplaceService.marketplace
      .getAllHealth()
      .filter((h) => h.status === 'error' && h.lastError)
      .map((h) => `${h.pluginId}: ${h.lastError}`);
    return {
      totalAgents: status.installed,
      activeAgents: status.running,
      errors,
    };
  } catch {
    return { totalAgents: 0, activeAgents: 0, errors: [] };
  }
};

// Export runtime as expected by health/index.ts
export const agentRuntime = {
  getHealth: getAgentHealth,
  isRunning: () => true
};