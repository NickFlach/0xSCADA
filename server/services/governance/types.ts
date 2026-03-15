/**
 * Governance Gate Types
 * Issue #345: Implement governance gate pattern
 * 
 * Defines the gate state machine and audit trail types for
 * controlling progression of changes through approval stages.
 */

import type { EntityId, Timestamp, Metadata } from '../../../shared/types';
import type { PipelineResult, VerificationPipelineConfig } from '../verification/types';

// ─── Gate State Machine ─────────────────────────────────────────────────────

export type GateState = 'pending' | 'approved' | 'rejected' | 'timed_out' | 'cancelled';

export type GateType = 'automated' | 'manual' | 'hybrid';

export type GateTransition =
  | 'submit'        // → pending
  | 'approve'       // pending → approved
  | 'reject'        // pending → rejected
  | 'timeout'       // pending → timed_out
  | 'cancel'        // pending → cancelled
  | 'override';     // any → approved (admin override)

/** Valid state transitions */
export const VALID_TRANSITIONS: Record<GateState, GateTransition[]> = {
  pending: ['approve', 'reject', 'timeout', 'cancel', 'override'],
  approved: [],
  rejected: ['override'],
  timed_out: ['override'],
  cancelled: ['override'],
};

// ─── Gate Definition ────────────────────────────────────────────────────────

export interface GateCondition {
  id: string;
  type: 'verification' | 'approval_count' | 'custom';
  /** For verification type: pipeline config to run */
  verificationConfig?: Partial<VerificationPipelineConfig>;
  /** For approval_count type: minimum approvals needed */
  requiredApprovals?: number;
  /** For custom type: predicate function name */
  customPredicate?: string;
  /** Human description */
  description?: string;
}

export interface GateDefinition {
  id: EntityId;
  name: string;
  description?: string;
  type: GateType;
  /** Conditions that must be met for the gate to pass */
  conditions: GateCondition[];
  /** Timeout in milliseconds; 0 = no timeout */
  timeoutMs: number;
  /** Users/roles that can approve */
  approvers: string[];
  /** Minimum number of approvals needed for manual gates */
  requiredApprovals: number;
  /** Whether admin can override */
  allowOverride: boolean;
  metadata?: Metadata;
}

// ─── Gate Instance ──────────────────────────────────────────────────────────

export interface GateApproval {
  approver: string;
  action: 'approve' | 'reject';
  comment?: string;
  timestamp: Timestamp;
}

export interface GateInstance {
  id: EntityId;
  definitionId: EntityId;
  state: GateState;
  /** The subject being gated (command, change request, etc.) */
  subject: {
    id: EntityId;
    type: string;
    data: Record<string, unknown>;
  };
  /** Verification result if verification condition was run */
  verificationResult?: PipelineResult;
  /** Approvals received */
  approvals: GateApproval[];
  /** Full audit trail */
  auditTrail: AuditEntry[];
  /** When the gate was created */
  createdAt: Timestamp;
  /** When the gate reached a terminal state */
  resolvedAt?: Timestamp;
  /** Timeout deadline */
  expiresAt?: Timestamp;
  metadata?: Metadata;
}

// ─── Audit Trail ────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: EntityId;
  gateId: EntityId;
  transition: GateTransition;
  fromState: GateState | 'initial';
  toState: GateState;
  actor: string;
  reason?: string;
  timestamp: Timestamp;
  metadata?: Metadata;
}

// ─── Gate Manager Interface ─────────────────────────────────────────────────

export interface IGateManager {
  /** Register a gate definition */
  registerGate(definition: GateDefinition): void;
  /** Create a new gate instance for a subject */
  createInstance(definitionId: EntityId, subject: GateInstance['subject'], actor: string): Promise<GateInstance>;
  /** Submit approval/rejection */
  submitDecision(instanceId: EntityId, approver: string, action: 'approve' | 'reject', comment?: string): Promise<GateInstance>;
  /** Admin override */
  override(instanceId: EntityId, actor: string, reason: string): Promise<GateInstance>;
  /** Cancel a pending gate */
  cancel(instanceId: EntityId, actor: string, reason?: string): Promise<GateInstance>;
  /** Get instance by ID */
  getInstance(instanceId: EntityId): GateInstance | undefined;
  /** Get all instances for a definition */
  getInstances(definitionId: EntityId): GateInstance[];
  /** Check for timed-out gates */
  checkTimeouts(): Promise<GateInstance[]>;
}
