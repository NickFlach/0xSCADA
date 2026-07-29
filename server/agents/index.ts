/**
 * Agents module
 */

// ADR-0013 [13.7]: the concrete multi-agent coordinator lives in services so
// it can consume the canonical event pipeline without creating a parallel
// agent-only data path.
export {
  GhostOSOrchestrator,
  type AgentRegistration,
  type DecisionProposal,
} from "../services/ghostos";

export const initializeDefaultAgents = async () => {
  // TODO: Initialize default agents
  console.log('Initializing default agents...');
};

export const startDefaultAgents = async () => {
  // TODO: Start default agents
  console.log('Starting default agents...');
};
