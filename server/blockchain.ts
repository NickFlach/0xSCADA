/**
 * Blockchain integration module
 */

export interface BlockchainHealth {
  connected: boolean;
  blockNumber?: number;
  networkId?: string;
  error?: string;
}

export const getBlockchainHealth = async (): Promise<BlockchainHealth> => {
  // TODO: Implement actual blockchain health check
  return {
    connected: false,
    error: 'Not implemented'
  };
};

// Export service as expected by health/index.ts
export const blockchainService = {
  isConnected: () => false,
  getHealth: getBlockchainHealth
};