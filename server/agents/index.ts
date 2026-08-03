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

// There are deliberately no initialize/start calls here (#37): agents are
// installed marketplace plugins (#217), and their lifecycle is owned by
// services/initializeServices() — surfaced at /api/agents and
// /api/marketplace, with health via ./runtime. Boot must not claim an agent
// layer this module does not start.
