/**
 * Agent runtime module.
 *
 * The export shape (`agentRuntime` with `getHealth`/`isRunning`) is consumed
 * by server/health/index.ts and must not change.
 *
 * Agents are installed marketplace plugins (#217), so the health numbers come
 * from the marketplace engine rather than the hardcoded zeros this module
 * used to return.
 */

export interface AgentHealth {
  totalAgents: number;
  activeAgents: number;
  errors: string[];
}

export const getAgentHealth = async (): Promise<AgentHealth> => {
  // Lazily imported so callers that only need the shape do not pull in the
  // marketplace service graph.
  const { marketplaceService } = await import('../services/marketplace');
  const marketplace = marketplaceService.marketplace;
  const status = marketplace.getStatus();
  const errors: string[] = [];

  for (const health of marketplace.getAllHealth()) {
    if (health.status === 'error') {
      errors.push(`${health.pluginId}: ${health.lastError ?? 'auto-disabled after repeated failures'}`);
    } else if (health.implementationState === 'unavailable') {
      errors.push(`${health.pluginId}: installed but no implementation is registered in this build`);
    }
  }

  return {
    totalAgents: status.installed,
    activeAgents: status.running,
    errors,
  };
};

export const agentRuntime = {
  getHealth: getAgentHealth,
  /**
   * True once the marketplace service has loaded its state and registered the
   * first-party implementations. Reported honestly: before that, nothing can
   * be invoked.
   */
  isRunning: async (): Promise<boolean> => {
    const { marketplaceService } = await import('../services/marketplace');
    return marketplaceService.isInitialized();
  },
};
