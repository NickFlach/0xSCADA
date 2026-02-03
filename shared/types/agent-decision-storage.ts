/**
 * 0xSCADA Agent Decision Storage Pattern
 * 
 * VERITY Architecture - Decision Storage Layer
 * 
 * Design Principles:
 * 1. Content-addressed: Decisions are stored by their hash
 * 2. Immutable: Once written, decisions cannot be modified
 * 3. Replayable: All inputs stored in LFS for reconstruction
 * 4. Auditable: Full chain of custody for every decision
 */

import { z } from "zod";
import type { ContentHash } from "../artifact";
import type { 
  AgentDecision, 
  AgentDecisionQuery,
  CreateAgentDecisionInput,
  DecisionReplayResult 
} from "./agent-decision";

// =============================================================================
// STORAGE INTERFACE
// =============================================================================

/**
 * Abstract interface for decision storage
 * Implementations can be:
 * - PostgreSQL (for queryable index)
 * - LFS (for content storage)
 * - Hybrid (index in PG, content in LFS)
 */
export interface IAgentDecisionStorage {
  /**
   * Store a new decision
   * Returns the content-addressed ID
   */
  create(input: CreateAgentDecisionInput): Promise<ContentHash>;
  
  /**
   * Get a decision by ID
   */
  get(id: ContentHash): Promise<AgentDecision | null>;
  
  /**
   * Check if a decision exists
   */
  exists(id: ContentHash): Promise<boolean>;
  
  /**
   * Query decisions
   */
  query(query: AgentDecisionQuery): Promise<AgentDecisionQueryResult>;
  
  /**
   * Get the decision chain (following previousDecision links)
   */
  getChain(startId: ContentHash, maxDepth?: number): Promise<AgentDecision[]>;
  
  /**
   * Get decisions that depend on an artifact
   */
  getDependents(artifactId: ContentHash): Promise<AgentDecision[]>;
  
  /**
   * Update execution status (the only mutable field)
   */
  updateExecutionStatus(
    id: ContentHash,
    status: AgentDecision["execution"]
  ): Promise<void>;
  
  /**
   * Add human approval
   */
  addHumanApproval(
    id: ContentHash,
    approval: NonNullable<AgentDecision["verification"]["humanApprover"]>
  ): Promise<void>;
  
  /**
   * Anchor decision to blockchain
   */
  anchor(
    id: ContentHash,
    anchor: NonNullable<AgentDecision["relatedArtifacts"]>["anchor"]
  ): Promise<void>;
}

/**
 * Query result with pagination
 */
export interface AgentDecisionQueryResult {
  decisions: AgentDecision[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// =============================================================================
// STORAGE STATISTICS
// =============================================================================

export interface AgentDecisionStorageStats {
  /** Total decisions */
  totalDecisions: number;
  
  /** Decisions by agent type */
  byAgentType: Record<string, number>;
  
  /** Decisions by execution status */
  byExecutionStatus: Record<string, number>;
  
  /** Decisions by action type */
  byActionType: Record<string, number>;
  
  /** Average confidence score */
  avgConfidence: number;
  
  /** Average safety score */
  avgSafetyScore: number;
  
  /** Human approval rate */
  humanApprovalRate: number;
  
  /** Decisions pending approval */
  pendingApproval: number;
  
  /** Oldest decision timestamp */
  oldestTimestamp?: string;
  
  /** Newest decision timestamp */
  newestTimestamp?: string;
}

// =============================================================================
// DRIZZLE SCHEMA (PostgreSQL)
// =============================================================================

/**
 * SQL table definition for decision index
 * 
 * The full decision content is stored in LFS (content-addressed).
 * This table provides a queryable index for fast lookups.
 */
export const agentDecisionTableSql = `
-- Agent Decision Index Table
-- Full content stored in LFS, this is the queryable index

CREATE TABLE IF NOT EXISTS agent_decisions (
  -- Primary key is the content hash
  id VARCHAR(64) PRIMARY KEY,
  
  -- Schema version for forward compatibility
  schema_version VARCHAR(10) NOT NULL DEFAULT '1.0.0',
  
  -- Timestamp for ordering and range queries
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- Agent info (denormalized for fast queries)
  agent_id VARCHAR(255) NOT NULL,
  agent_name VARCHAR(255) NOT NULL,
  agent_type VARCHAR(50) NOT NULL,
  agent_version VARCHAR(50) NOT NULL,
  
  -- Context
  site_id VARCHAR(255),
  asset_ids JSONB DEFAULT '[]'::jsonb,
  
  -- Inputs (hashes only - content in LFS)
  input_artifacts JSONB DEFAULT '[]'::jsonb,
  input_context_hash VARCHAR(64) NOT NULL,
  input_constraints_hash VARCHAR(64) NOT NULL,
  
  -- Reasoning summary (full chain in LFS)
  reasoning_cot_hash VARCHAR(64) NOT NULL,
  reasoning_model VARCHAR(255) NOT NULL,
  reasoning_temperature DECIMAL(3,2) NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  
  -- Output
  output_decision TEXT NOT NULL,
  output_action_type VARCHAR(50),
  output_confidence DECIMAL(3,2) NOT NULL,
  
  -- Verification
  verification_human_approved BOOLEAN,
  verification_safety_score DECIMAL(3,2) NOT NULL,
  verification_automated_check_count INTEGER NOT NULL DEFAULT 0,
  verification_failed_checks INTEGER NOT NULL DEFAULT 0,
  
  -- Execution (mutable)
  execution_status VARCHAR(20) DEFAULT 'pending',
  execution_started_at TIMESTAMP WITH TIME ZONE,
  execution_completed_at TIMESTAMP WITH TIME ZONE,
  execution_error TEXT,
  
  -- Signature
  signature_algorithm VARCHAR(20),
  signature_key_id VARCHAR(255),
  
  -- Cross-references
  previous_decision_id VARCHAR(64),
  twin_checkpoint_hash VARCHAR(64),
  anchor_tx_hash VARCHAR(255),
  anchor_block_number INTEGER,
  anchor_anchored_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Indexes will be created separately
  CONSTRAINT fk_previous_decision 
    FOREIGN KEY (previous_decision_id) 
    REFERENCES agent_decisions(id)
    ON DELETE SET NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agent_decisions_timestamp 
  ON agent_decisions(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent_id 
  ON agent_decisions(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent_type 
  ON agent_decisions(agent_type);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_site_id 
  ON agent_decisions(site_id);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_execution_status 
  ON agent_decisions(execution_status);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_human_approved 
  ON agent_decisions(verification_human_approved);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_action_type 
  ON agent_decisions(output_action_type);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_confidence 
  ON agent_decisions(output_confidence);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_safety_score 
  ON agent_decisions(verification_safety_score);

-- GIN index for artifact array searches
CREATE INDEX IF NOT EXISTS idx_agent_decisions_input_artifacts 
  ON agent_decisions USING GIN (input_artifacts);

-- GIN index for asset array searches
CREATE INDEX IF NOT EXISTS idx_agent_decisions_asset_ids 
  ON agent_decisions USING GIN (asset_ids);
`;

// =============================================================================
// LFS STORAGE PATTERN
// =============================================================================

/**
 * LFS path pattern for decision artifacts
 * 
 * Structure:
 * .artifacts/
 *   decisions/
 *     {hash[0:2]}/
 *       {hash[2:4]}/
 *         {hash}.json          # Full decision record
 *         {hash}.cot.md        # Chain-of-thought (readable)
 *         {hash}.cot.json      # Chain-of-thought (structured)
 */
export function getDecisionLfsPath(hash: ContentHash): string {
  return `.artifacts/decisions/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.json`;
}

export function getDecisionCotPath(hash: ContentHash, format: "md" | "json" = "json"): string {
  return `.artifacts/decisions/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.cot.${format}`;
}

/**
 * LFS metadata for decision
 */
export interface DecisionLfsMetadata {
  contentHash: ContentHash;
  size: number;
  storedAt: string;
  paths: {
    decision: string;
    chainOfThought: string;
  };
}

// =============================================================================
// REPLAY STORAGE
// =============================================================================

/**
 * Storage for decision replay results
 */
export const decisionReplayTableSql = `
-- Decision Replay Results
-- Track replay attempts for verification

CREATE TABLE IF NOT EXISTS agent_decision_replays (
  id VARCHAR(64) PRIMARY KEY,
  
  -- Original decision
  original_decision_id VARCHAR(64) NOT NULL REFERENCES agent_decisions(id),
  
  -- Replayed decision (different ID due to timestamp)
  replayed_decision_id VARCHAR(64) NOT NULL REFERENCES agent_decisions(id),
  
  -- Match results
  output_matches BOOLEAN NOT NULL,
  decision_matches BOOLEAN NOT NULL,
  action_matches BOOLEAN NOT NULL,
  confidence_delta DECIMAL(5,4) NOT NULL,
  
  -- Differences
  key_differences JSONB DEFAULT '[]'::jsonb,
  
  -- Metadata
  replayed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  replay_duration_ms INTEGER NOT NULL,
  replay_reason TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_replays_original 
  ON agent_decision_replays(original_decision_id);

CREATE INDEX IF NOT EXISTS idx_decision_replays_output_matches 
  ON agent_decision_replays(output_matches);
`;

// =============================================================================
// VERIFICATION CHECK STORAGE
// =============================================================================

/**
 * Storage for verification check results
 */
export const verificationCheckTableSql = `
-- Verification Check Results
-- Detailed storage of automated checks

CREATE TABLE IF NOT EXISTS agent_decision_checks (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Parent decision
  decision_id VARCHAR(64) NOT NULL REFERENCES agent_decisions(id) ON DELETE CASCADE,
  
  -- Check details
  name VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  message TEXT,
  
  -- Timing
  checked_at TIMESTAMP WITH TIME ZONE NOT NULL,
  duration_ms INTEGER,
  
  -- Additional details (JSONB for flexibility)
  details JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_checks_decision_id 
  ON agent_decision_checks(decision_id);

CREATE INDEX IF NOT EXISTS idx_decision_checks_category 
  ON agent_decision_checks(category);

CREATE INDEX IF NOT EXISTS idx_decision_checks_status 
  ON agent_decision_checks(status);
`;

// =============================================================================
// MIGRATION HELPERS
// =============================================================================

/**
 * Full migration SQL for decision storage
 */
export const agentDecisionMigrationSql = `
-- Agent Decision Storage Migration
-- VERITY Architecture Phase γ.1.1

${agentDecisionTableSql}

${decisionReplayTableSql}

${verificationCheckTableSql}

-- Add comment
COMMENT ON TABLE agent_decisions IS 
  'VERITY Agent Decision Records - Index for content-addressed decision storage';
`;

// =============================================================================
// STORAGE EVENTS
// =============================================================================

/**
 * Events emitted by decision storage
 */
export type DecisionStorageEvent =
  | { type: "decision:created"; decisionId: ContentHash; agentId: string }
  | { type: "decision:approved"; decisionId: ContentHash; approvedBy: string }
  | { type: "decision:rejected"; decisionId: ContentHash; rejectedBy: string }
  | { type: "decision:executed"; decisionId: ContentHash; success: boolean }
  | { type: "decision:anchored"; decisionId: ContentHash; txHash: string }
  | { type: "decision:replayed"; decisionId: ContentHash; matches: boolean };

/**
 * Storage event handler
 */
export type DecisionStorageEventHandler = (event: DecisionStorageEvent) => void | Promise<void>;
