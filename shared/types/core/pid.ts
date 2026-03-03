/**
 * P&ID (Process & Instrumentation Diagram) Type Definitions
 */

export interface PIDPoint {
  x: number;
  y: number;
}

export interface PIDSize {
  width: number;
  height: number;
}

export interface PIDElement {
  id: string;
  type: PIDElementType;
  position: PIDPoint;
  size: PIDSize;
  name?: string;
  tag?: string;
  properties?: Record<string, any>;
  connections?: PIDConnection[];
}

export interface PIDConnection {
  id: string;
  from: string; // element ID
  to: string;   // element ID
  fromPort?: string;
  toPort?: string;
  type?: PIDConnectionType;
  path?: PIDPoint[];
}

export interface PIDDiagram {
  id: string;
  name: string;
  elements: PIDElement[];
  connections: PIDConnection[];
  symbols?: PIDElement[]; // alias for elements
  canvasSize?: PIDSize;
  gridSize?: number;
  drawingNumber?: string;
  revision?: string;
  metadata?: {
    version?: string;
    author?: string;
    description?: string;
    tags?: string[];
  };
}

export type PIDElementType = 
  | 'valve'
  | 'pump' 
  | 'tank'
  | 'heat-exchanger'
  | 'motor'
  | 'pipe'
  | 'instrument'
  | 'junction';

export type PIDConnectionType = 
  | 'process'
  | 'signal'
  | 'pneumatic'
  | 'electric';

// Symbol-specific interfaces
export interface ValveProps {
  valveType: 'gate' | 'ball' | 'butterfly' | 'control';
  position?: number; // 0-100%
  setpoint?: number;
}

export interface PumpProps {
  pumpType: 'centrifugal' | 'positive-displacement';
  speed?: number;
  flow?: number;
}

export interface TankProps {
  tankType: 'storage' | 'reactor' | 'separator';
  level?: number; // 0-100%
  capacity?: number;
}

export interface InstrumentProps {
  instrumentType: 'pressure' | 'temperature' | 'flow' | 'level' | 'analyzer';
  value?: number;
  units?: string;
  range?: [number, number];
}

// Animation and interaction types
export interface PIDAnimationState {
  running?: boolean;
  flow?: {
    [connectionId: string]: {
      rate: number;
      direction: 'forward' | 'reverse';
      material?: string;
    };
  };
  elements?: {
    [elementId: string]: {
      active?: boolean;
      alarm?: boolean;
      value?: number;
      status?: 'ok' | 'warning' | 'error';
    };
  };
}

export interface PIDEditorState {
  selectedElements: string[];
  mode: 'view' | 'edit' | 'connect';
  clipboard?: PIDElement[];
  snapToGrid?: boolean;
  gridSize?: number;
}

// Additional missing types
export type OperationalState = 'normal' | 'alarm' | 'warning' | 'offline';
export type AlarmState = 'active' | 'acknowledged' | 'cleared' | 'shelved';
export type PIDSymbol = PIDElement; // alias
export type PipeConnection = PIDConnection; // alias
export type Point = PIDPoint; // alias

// Variant types
export type ValveVariant = 'gate' | 'ball' | 'butterfly' | 'control' | 'check';
export type PumpVariant = 'centrifugal' | 'positive-displacement' | 'gear' | 'screw';
export type TankVariant = 'storage' | 'reactor' | 'separator' | 'buffer';
export type JunctionVariant = 'tee' | 'cross' | 'elbow' | 'reducer';

// Connection types
export type InstrumentConnectionType = 'pneumatic' | 'electric' | 'digital' | 'wireless';

// Data binding types
export interface PIDTagValue {
  tagId: string;
  value: number | string | boolean;
  timestamp: Date;
  quality: 'good' | 'bad' | 'uncertain';
}

export interface PIDDataSnapshot {
  timestamp: Date;
  values: Record<string, PIDTagValue>;
  alarms: Record<string, AlarmState>;
}