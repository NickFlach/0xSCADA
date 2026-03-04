/**
 * SingularisPrime SCADA Event Types
 * 
 * SCADA-specific block types for the SingularisPrime protocol,
 * used when publishing SCADA events to Flux.
 * 
 * Based on the SingularisPrime block pattern from SpaceChildCollective's
 * singularis-protocol.ts — extended for industrial control system events.
 */

// ===== Base SingularisPrime types (matching SpaceChildCollective pattern) =====

export type SingularisScadaBlockType =
  | 'SCADA_TRACE'
  | 'SCADA_ALARM'
  | 'SCADA_COMMAND'
  | 'SCADA_VERIFY';

export type ScadaConfidence = 'low' | 'rising' | 'stable' | 'high' | 'certain';
export type ScadaPriority = 'low' | 'medium' | 'high' | 'urgent' | 'critical';

// ===== SCADA_TRACE: Sensor readings with full metadata =====

export interface ScadaTraceBlock {
  type: 'SCADA_TRACE';
  /** Device/sensor ID */
  deviceId: string;
  /** Tag address (e.g., "PLC1.TT100.PV") */
  tag: string;
  /** Current reading value */
  value: number | boolean | string;
  /** Engineering unit (e.g., "°C", "PSI", "m³/h") */
  unit?: string;
  /** Reading confidence */
  confidence: ScadaConfidence;
  /** Sensor drift from last calibration (0-1, 0 = no drift) */
  drift: number;
  /** Calibration status */
  calibration: {
    lastCalibrated: Date;
    nextDue: Date;
    driftTrend: 'stable' | 'increasing' | 'decreasing';
    withinSpec: boolean;
  };
  /** Data quality (OPC-UA compatible) */
  quality: 'good' | 'bad' | 'uncertain';
  /** Source timestamp from the device */
  sourceTimestamp: Date;
  /** Server timestamp when received */
  serverTimestamp: Date;
  /** Region where this reading originated */
  region?: string;
}

// ===== SCADA_ALARM: Alert with severity and GR::LISTEN filter rules =====

export interface ScadaAlarmBlock {
  type: 'SCADA_ALARM';
  /** Unique alarm ID */
  alarmId: string;
  /** Alarm source device */
  deviceId: string;
  /** Alarm tag/point */
  tag: string;
  /** Current alarm state */
  state: 'active' | 'acknowledged' | 'cleared' | 'shelved' | 'suppressed';
  /** ISA-18.2 alarm priority */
  severity: ScadaPriority;
  /** Alarm class */
  alarmClass: 'process' | 'equipment' | 'safety' | 'environmental' | 'security';
  /** Alarm message */
  message: string;
  /** Current value that triggered the alarm */
  triggerValue: any;
  /** Alarm setpoint/limit */
  limit: any;
  /** Timestamp when alarm became active */
  activeAt: Date;
  /** Who acknowledged (if acknowledged) */
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  /** GR::LISTEN filter rules for this alarm (SingularisPrime pattern) */
  grListen: {
    /** Signal patterns to detect/match */
    detect: string[];
    /** Signal patterns to reject/filter out */
    reject: string[];
  };
  /** Recommended actions */
  recommendedActions?: string[];
}

// ===== SCADA_COMMAND: Control action with approval chain =====

export interface ScadaCommandBlock {
  type: 'SCADA_COMMAND';
  /** Unique command ID */
  commandId: string;
  /** Target device */
  deviceId: string;
  /** Target tag to write */
  tag: string;
  /** Commanded value */
  value: any;
  /** Command priority */
  priority: ScadaPriority;
  /** Command state */
  state: 'pending' | 'approved' | 'executing' | 'completed' | 'rejected' | 'rolled_back';
  /** Approval chain — ordered list of required approvals */
  approvalChain: CommandApproval[];
  /** Rollback plan if command fails or needs reversal */
  rollbackPlan: {
    /** Previous value to restore */
    previousValue: any;
    /** Timeout before auto-rollback (ms), 0 = no auto-rollback */
    autoRollbackMs: number;
    /** Conditions that trigger automatic rollback */
    rollbackConditions: string[];
    /** Status of rollback */
    status: 'ready' | 'triggered' | 'completed' | 'failed';
  };
  /** Who/what initiated the command */
  initiatedBy: string;
  initiatedAt: Date;
  /** When command was executed */
  executedAt?: Date;
  /** Reason for the command */
  reason: string;
}

export interface CommandApproval {
  /** Approver user ID or system ID */
  approverId: string;
  /** Role required for this approval */
  requiredRole: string;
  /** Approval status */
  status: 'pending' | 'approved' | 'rejected';
  /** Timestamp of approval/rejection */
  timestamp?: Date;
  /** Comment from approver */
  comment?: string;
}

// ===== SCADA_VERIFY: Verification pipeline result =====

export interface ScadaVerifyBlock {
  type: 'SCADA_VERIFY';
  /** What was verified */
  targetId: string;
  targetType: 'event' | 'command' | 'reading' | 'alarm' | 'batch';
  /** Overall verification result */
  verified: boolean;
  /** Overall confidence */
  confidence: ScadaConfidence;
  /** Each verification layer and its result */
  layers: VerificationLayer[];
  /** Merkle proof (if blockchain-anchored) */
  merkleProof?: {
    root: string;
    path: string[];
    leaf: string;
    batchId: number;
  };
  /** Timestamp */
  verifiedAt: Date;
  /** Verifier identity */
  verifiedBy: string;
}

export interface VerificationLayer {
  /** Layer name */
  name: string;
  /** Layer category */
  category: 'cryptographic' | 'consensus' | 'plausibility' | 'compliance' | 'audit';
  /** Did this layer pass? */
  passed: boolean;
  /** Layer-specific score (0-1) */
  score: number;
  /** Layer execution time (ms) */
  executionTimeMs: number;
  /** Details */
  details?: string;
}

// ===== Unified SCADA SingularisPrime Block =====

export type ScadaSingularisBlock =
  | ScadaTraceBlock
  | ScadaAlarmBlock
  | ScadaCommandBlock
  | ScadaVerifyBlock;

// ===== SCADA SingularisPrime Message (for Flux publishing) =====

export interface ScadaSingularisMessage {
  /** Message ID */
  id: string;
  /** Source entity (e.g., "0xscada-gateway-01") */
  fromEntityId: string;
  /** Target entity or undefined for broadcast */
  toEntityId?: string;
  /** Blocks in this message */
  blocks: ScadaSingularisBlock[];
  /** Raw formatted text (human-readable SingularisPrime format) */
  rawText: string;
  /** Timestamp */
  timestamp: Date;
  /** Region of origin */
  region?: string;
  /** Flux entity ID for publishing */
  fluxEntityId?: string;
}

// ===== Formatter (SingularisPrime text format) =====

export function formatScadaBlock(block: ScadaSingularisBlock): string {
  switch (block.type) {
    case 'SCADA_TRACE':
      return `🔷SCADA_TRACE🔷 :: ${block.deviceId}
tag: ${block.tag}
value: ${block.value}${block.unit ? ` ${block.unit}` : ''}
confidence: ${block.confidence}
drift: ${block.drift.toFixed(4)}
quality: ${block.quality}
calibration: ${block.calibration.withinSpec ? 'IN_SPEC' : 'OUT_OF_SPEC'} (drift_trend: ${block.calibration.driftTrend})
source_time: ${block.sourceTimestamp instanceof Date ? block.sourceTimestamp.toISOString() : block.sourceTimestamp}`;

    case 'SCADA_ALARM':
      return `🔷SCADA_ALARM🔷 :: ${block.alarmId}
device: ${block.deviceId}
tag: ${block.tag}
state: ${block.state}
severity: ${block.severity}
class: ${block.alarmClass}
message: ${block.message}
trigger_value: ${block.triggerValue}
limit: ${block.limit}
GR::LISTEN {
  detect: ${block.grListen.detect.join(', ')}
  reject: ${block.grListen.reject.join(', ')}
}`;

    case 'SCADA_COMMAND':
      return `🔷SCADA_COMMAND🔷 :: ${block.commandId}
device: ${block.deviceId}
tag: ${block.tag}
value: ${block.value}
state: ${block.state}
priority: ${block.priority}
initiated_by: ${block.initiatedBy}
reason: ${block.reason}
approvals: ${block.approvalChain.map(a => `${a.approverId}:${a.status}`).join(', ')}
rollback: ${block.rollbackPlan.status} (auto: ${block.rollbackPlan.autoRollbackMs}ms)`;

    case 'SCADA_VERIFY':
      const layerSummary = block.layers.map(l => `${l.name}:${l.passed ? 'PASS' : 'FAIL'}(${l.score.toFixed(2)})`).join(', ');
      return `🔷SCADA_VERIFY🔷 :: ${block.targetId}
target_type: ${block.targetType}
verified: ${block.verified}
confidence: ${block.confidence}
layers: [${layerSummary}]
verified_by: ${block.verifiedBy}
verified_at: ${block.verifiedAt instanceof Date ? block.verifiedAt.toISOString() : block.verifiedAt}`;

    default:
      return JSON.stringify(block, null, 2);
  }
}

export function formatScadaMessage(message: ScadaSingularisMessage): string {
  return message.blocks.map(formatScadaBlock).join('\n\n');
}
