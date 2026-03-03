// PID System Types

export interface Point {
  x: number;
  y: number;
}

export type OperationalState = 'running' | 'stopped' | 'maintenance' | 'fault' | 'startup' | 'shutdown' | 'alarm' | 'offline';

export type AlarmState = 'normal' | 'warning' | 'alarm' | 'critical' | 'acknowledged' | 'low' | 'high';

export interface PIDTagValue {
  tagName: string;
  value: number | string | boolean;
  timestamp: Date;
  quality: 'good' | 'bad' | 'uncertain';
  unit?: string;
}

export interface PIDDataSnapshot {
  timestamp: Date;
  tags: PIDTagValue[];
  alarms: Array<{
    tagName: string;
    state: AlarmState;
    message: string;
  }>;
}

export interface PipeConnection {
  id: string;
  fromSymbol: string;
  toSymbol: string;
  fromPoint: Point;
  toPoint: Point;
  path?: Point[];
  diameter?: number;
  medium?: string;
  from?: {
    symbolId: string;
  };
  to?: {
    symbolId: string;
  };
  waypoints?: Point[];
}

export interface PIDSymbol {
  id: string;
  type: 'valve' | 'pump' | 'tank' | 'motor' | 'instrument' | 'junction' | 'heat-exchanger' | 'pipe';
  position: Point;
  size: { width: number; height: number };
  rotation?: number;
  variant?: string;
  properties?: Record<string, any>;
  tagName?: string;
  operationalState?: OperationalState;
  alarmState?: AlarmState;
  // Additional properties found in usage
  dataBinding?: PIDDataBinding;
  transform?: PIDTransform;
  label?: string;
  tagNumber?: string;
  functionLetters?: string;
  loopNumber?: string;
  connectionType?: InstrumentConnectionType;
  location?: InstrumentLocation;
  rating?: string;
  exchangerType?: ExchangerType;
  points?: Point[];
  showFlow?: boolean;
  spec?: string;
}

export interface PIDDiagram {
  id: string;
  name: string;
  symbols: PIDSymbol[];
  connections: PipeConnection[];
  metadata?: {
    version?: string;
    author?: string;
    created?: Date;
    modified?: Date;
    description?: string;
  };
}

// Variants for specific symbol types
export type ValveVariant = 'gate' | 'globe' | 'ball' | 'check' | 'butterfly' | 'control' | 'safety';

export type PumpVariant = 'centrifugal' | 'positive-displacement' | 'gear' | 'screw' | 'peristaltic';

export type TankVariant = 'atmospheric' | 'pressure' | 'vacuum' | 'spherical' | 'horizontal' | 'vertical';

export type JunctionVariant = 'tee' | 'cross' | 'reducer' | 'elbow' | 'wye';

export type InstrumentConnectionType = 'pneumatic' | 'electrical' | 'wireless' | 'digital' | 'analog';

export type InstrumentLocation = 'control-room' | 'field' | 'local-panel';

export type ExchangerType = 'shell-tube' | 'plate' | 'air-cooled';

// Data binding types
export interface PIDTagBinding {
  tagId: string;
  property: string;
  units?: string;
}

export interface PIDDataBinding {
  tags?: PIDTagBinding[];
}

export interface PIDTransform {
  position: Point;
  rotation: number;
  scale: number;
}