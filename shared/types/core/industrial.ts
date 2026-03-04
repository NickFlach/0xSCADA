/**
 * Industrial Core Types
 * 
 * Industrial automation and SCADA-specific types.
 * Builds on common types to provide industrial domain models.
 * 
 * Dependencies: ./common.ts
 */

import {
  EntityId,
  Timestamp,
  Point3D,
  DataValue,
  OperationalState,
  ConnectionStatus,
  Metadata,
  EventSeverity,
  BaseEvent,
  TagValue
} from './common';

// ─── Site & Asset Hierarchy ─────────────────────────────────────────────────

export type SiteStatus = 'online' | 'offline' | 'maintenance';
export type AssetStatus = 'ok' | 'warning' | 'critical' | 'offline';
export type AssetType = 
  | 'transformer' | 'breaker' | 'mcc' | 'feeder' | 'inverter' 
  | 'plc' | 'sensor' | 'pump' | 'valve' | 'motor' | 'tank'
  | 'heat-exchanger' | 'instrument';

export interface Site {
  id: EntityId;
  name: string;
  location?: string;
  owner?: string;
  status: SiteStatus;
  metadata?: Metadata;
}

export interface Asset {
  id: EntityId;
  siteId: EntityId;
  type: AssetType;
  name: string;
  tag?: string;
  critical: boolean;
  status: AssetStatus;
  position?: Point3D;
  metadata?: Metadata;
}

// ─── Process & Instrumentation ──────────────────────────────────────────────

export type InstrumentType = 'pressure' | 'temperature' | 'flow' | 'level' | 'analyzer' | 'valve' | 'pump';
export type ProcessVariableType = 'analog' | 'digital' | 'calculated' | 'setpoint';

export interface ProcessVariable {
  id: EntityId;
  assetId: EntityId;
  name: string;
  address: string;
  type: ProcessVariableType;
  instrumentType?: InstrumentType;
  units?: string;
  range?: [number, number];
  alarmLimits?: {
    low?: number;
    high?: number;
    lowLow?: number;
    highHigh?: number;
  };
  value?: DataValue;
}

// ─── Alarms ─────────────────────────────────────────────────────────────────

export type AlarmState = 'active' | 'acknowledged' | 'cleared' | 'shelved';
export type AlarmType = 'process' | 'system' | 'security' | 'communication';

export interface AlarmCondition {
  type: 'high' | 'low' | 'deviation' | 'rate' | 'digital' | 'custom';
  setpoint?: number;
  deadband?: number;
  delay?: number; // milliseconds
  expression?: string; // For custom conditions
}

export interface Alarm {
  id: EntityId;
  assetId?: EntityId;
  tagId?: string;
  name: string;
  description?: string;
  type: AlarmType;
  severity: EventSeverity;
  condition: AlarmCondition;
  enabled: boolean;
  state: AlarmState;
  acknowledgedBy?: string;
  acknowledgedAt?: Timestamp;
  lastTriggered?: Timestamp;
}

// ─── Protocols & Drivers ────────────────────────────────────────────────────

export type ProtocolType = 
  | 'opcua' | 'modbus-tcp' | 'modbus-rtu' | 'dnp3-tcp' | 'dnp3-serial'
  | 'iec61850' | 'bacnet' | 'ethernet-ip' | 'profinet' | 'mqtt';

export interface ProtocolEndpoint {
  protocol: ProtocolType;
  host?: string;
  port?: number;
  devicePath?: string; // For serial connections
  connectionString: string;
  authentication?: {
    type: 'none' | 'basic' | 'certificate';
    username?: string;
    password?: string;
    certificate?: string;
  };
  options?: Record<string, unknown>;
}

export interface Driver {
  id: EntityId;
  name: string;
  protocol: ProtocolType;
  endpoint: ProtocolEndpoint;
  status: ConnectionStatus;
  tags: ProcessVariable[];
  lastUpdate: Timestamp;
  diagnostics?: {
    packetsReceived: number;
    packetsSent: number;
    errors: number;
    latency: number;
  };
}

// ─── Recipes & Batch Processing ─────────────────────────────────────────────

export type RecipeStatus = 'draft' | 'approved' | 'active' | 'completed' | 'aborted';

export interface RecipeParameter {
  name: string;
  value: unknown;
  units?: string;
  description?: string;
  validation?: {
    min?: number;
    max?: number;
    required?: boolean;
  };
}

export interface Recipe {
  id: EntityId;
  name: string;
  version: number;
  description?: string;
  assetId?: EntityId;
  parameters: RecipeParameter[];
  setpoints: Record<string, unknown>;
  status: RecipeStatus;
  approvedBy?: string;
  approvedAt?: Timestamp;
}

// ─── Maintenance ────────────────────────────────────────────────────────────

export type MaintenanceType = 'preventive' | 'corrective' | 'predictive' | 'emergency';
export type MaintenanceStatus = 'scheduled' | 'in-progress' | 'completed' | 'cancelled' | 'overdue';

export interface MaintenanceRecord {
  id: EntityId;
  assetId: EntityId;
  type: MaintenanceType;
  status: MaintenanceStatus;
  workOrderId?: string;
  performedBy?: string;
  scheduledAt: Timestamp;
  performedAt?: Timestamp;
  nextDueAt?: Timestamp;
  description: string;
  notes?: string;
  attachments?: string[];
}

// ─── Industrial Events ──────────────────────────────────────────────────────

export type IndustrialEventType = 
  | 'process-deviation' | 'alarm-state-change' | 'equipment-fault'
  | 'maintenance-required' | 'recipe-executed' | 'operator-action'
  | 'system-startup' | 'system-shutdown' | 'communication-loss';

export interface IndustrialEvent {
  type: IndustrialEventType;
  assetId?: EntityId;
  tagId?: string;
  operatorId?: string;
  processValue?: DataValue;
  setpoint?: number;
  deviation?: number;
  alarmState?: AlarmState;
}

// ─── Control Loops ──────────────────────────────────────────────────────────

export type ControllerMode = 'manual' | 'automatic' | 'cascade' | 'remote' | 'local';
export type ControllerType = 'pid' | 'on-off' | 'mpc' | 'fuzzy' | 'neural';

export interface ControlLoop {
  id: EntityId;
  name: string;
  assetId?: EntityId;
  processVariable: ProcessVariable;
  setpoint: DataValue;
  output: DataValue;
  mode: ControllerMode;
  type: ControllerType;
  tuning?: {
    kp?: number;
    ki?: number;
    kd?: number;
    setpointWeight?: number;
    outputLimits?: [number, number];
  };
  enabled: boolean;
}

// ─── Batch & Sequence Control ───────────────────────────────────────────────

export type StepType = 'action' | 'condition' | 'parallel' | 'selection' | 'loop';
export type StepStatus = 'idle' | 'active' | 'held' | 'complete' | 'aborted' | 'stopped';

export interface SequenceStep {
  id: EntityId;
  name: string;
  type: StepType;
  status: StepStatus;
  description?: string;
  parameters?: Record<string, unknown>;
  conditions?: string[];
  actions?: string[];
  timeout?: number;
  retries?: number;
}

export interface Sequence {
  id: EntityId;
  name: string;
  steps: SequenceStep[];
  currentStep?: EntityId;
  status: StepStatus;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

// ─── Safety & Interlocks ────────────────────────────────────────────────────

export type InterlockType = 'safety' | 'process' | 'equipment';
export type InterlockAction = 'stop' | 'shutdown' | 'alarm' | 'redirect' | 'limit';

export interface SafetyInterlock {
  id: EntityId;
  name: string;
  type: InterlockType;
  condition: string; // Boolean expression
  action: InterlockAction;
  priority: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  bypassable: boolean;
  bypassedBy?: string;
  bypassedAt?: Timestamp;
  bypassReason?: string;
}

// ─── Historian & Trends ─────────────────────────────────────────────────────

export interface HistorianQuery {
  tagIds: string[];
  startTime: Timestamp;
  endTime: Timestamp;
  aggregation?: 'raw' | 'average' | 'min' | 'max' | 'interpolated';
  interval?: number; // seconds
  maxPoints?: number;
}

export interface TrendData {
  tagId: string;
  timestamps: Timestamp[];
  values: number[];
  quality: ('good' | 'bad' | 'uncertain')[];
}

// ─── P&ID Integration ───────────────────────────────────────────────────────

// Re-export P&ID types with industrial context
export type PIDElementType = AssetType | 'junction' | 'pipe';
export type PIDConnectionType = 'process' | 'signal' | 'pneumatic' | 'electric';

// export { 
//   // Re-export specific P&ID types that are useful in industrial context
//   type PIDPoint as IndustrialPoint,
//   type PIDSize as IndustrialSize
// } from '../pid';

// ─── Type Guards ────────────────────────────────────────────────────────────

export const isValidAssetType = (type: string): type is AssetType => {
  const validTypes: AssetType[] = [
    'transformer', 'breaker', 'mcc', 'feeder', 'inverter', 
    'plc', 'sensor', 'pump', 'valve', 'motor', 'tank',
    'heat-exchanger', 'instrument'
  ];
  return validTypes.includes(type as AssetType);
};

export const isValidProtocolType = (protocol: string): protocol is ProtocolType => {
  const validProtocols: ProtocolType[] = [
    'opcua', 'modbus-tcp', 'modbus-rtu', 'dnp3-tcp', 'dnp3-serial',
    'iec61850', 'bacnet', 'ethernet-ip', 'profinet', 'mqtt'
  ];
  return validProtocols.includes(protocol as ProtocolType);
};