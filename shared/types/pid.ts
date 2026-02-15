/**
 * P&ID Diagram Type Definitions
 *
 * Epic 8.1 - P&ID Diagram Renderer
 *
 * Scene graph, symbol types, connections, and data bindings
 * for Piping and Instrumentation Diagrams.
 */

// =============================================================================
// SYMBOL TYPES
// =============================================================================

export type ValveVariant = 'gate' | 'globe' | 'ball' | 'butterfly' | 'check' | 'relief';
export type PumpVariant = 'centrifugal' | 'positive-displacement';
export type TankVariant = 'open' | 'closed' | 'pressure-vessel';
export type InstrumentConnectionType = 'direct' | 'pneumatic' | 'electric' | 'hydraulic' | 'capillary' | 'software';
export type JunctionVariant = 'tee' | 'elbow' | 'cross' | 'reducer';

export type PIDSymbolType =
  | 'valve'
  | 'pump'
  | 'tank'
  | 'instrument'
  | 'motor'
  | 'heat-exchanger'
  | 'pipe'
  | 'junction';

// =============================================================================
// ALARM & STATE
// =============================================================================

export type AlarmState = 'normal' | 'low' | 'high' | 'low-low' | 'high-high' | 'alarm' | 'warning';
export type OperationalState = 'running' | 'stopped' | 'alarm' | 'maintenance' | 'offline';

// =============================================================================
// DATA BINDING
// =============================================================================

export interface TagBinding {
  /** Tag ID in the SCADA system */
  tagId: string;
  /** Property on the symbol this tag binds to (e.g., 'value', 'state', 'level') */
  property: string;
  /** Optional format string */
  format?: string;
  /** Engineering units */
  units?: string;
}

export interface DataBinding {
  /** Bindings for this symbol */
  tags: TagBinding[];
  /** Alarm thresholds */
  alarms?: {
    lowLow?: number;
    low?: number;
    high?: number;
    highHigh?: number;
  };
}

// =============================================================================
// GEOMETRY
// =============================================================================

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Transform {
  position: Point;
  rotation?: number;
  scale?: number;
  flipX?: boolean;
  flipY?: boolean;
}

// =============================================================================
// CONNECTIONS
// =============================================================================

export interface ConnectionPort {
  id: string;
  /** Relative position on the symbol (0-1) */
  position: Point;
  /** Direction the port faces */
  direction: 'up' | 'down' | 'left' | 'right';
}

export interface PipeConnection {
  id: string;
  /** Source symbol ID and port */
  from: { symbolId: string; portId: string };
  /** Target symbol ID and port */
  to: { symbolId: string; portId: string };
  /** Intermediate waypoints */
  waypoints?: Point[];
  /** Pipe spec (e.g., "4\"-CS-150#") */
  spec?: string;
  /** Flow direction shown */
  showFlow?: boolean;
  /** Line style */
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** Data binding for flow rate etc. */
  dataBinding?: DataBinding;
}

// =============================================================================
// SYMBOL NODES
// =============================================================================

export interface PIDSymbolBase {
  id: string;
  type: PIDSymbolType;
  transform: Transform;
  size?: Size;
  label?: string;
  tagNumber?: string;
  dataBinding?: DataBinding;
  ports?: ConnectionPort[];
  zIndex?: number;
}

export interface ValveSymbol extends PIDSymbolBase {
  type: 'valve';
  variant: ValveVariant;
  /** Normally open or closed */
  failPosition?: 'open' | 'closed';
}

export interface PumpSymbol extends PIDSymbolBase {
  type: 'pump';
  variant: PumpVariant;
}

export interface TankSymbol extends PIDSymbolBase {
  type: 'tank';
  variant: TankVariant;
  /** Capacity in process units */
  capacity?: number;
}

export interface InstrumentSymbol extends PIDSymbolBase {
  type: 'instrument';
  /** ISA tag letters (e.g., "FIC", "LT", "PT") */
  functionLetters: string;
  /** Loop number */
  loopNumber?: string;
  connectionType: InstrumentConnectionType;
  /** Mounted in field or control room */
  location?: 'field' | 'control-room' | 'local-panel';
}

export interface MotorSymbol extends PIDSymbolBase {
  type: 'motor';
  /** HP or kW rating */
  rating?: string;
}

export interface HeatExchangerSymbol extends PIDSymbolBase {
  type: 'heat-exchanger';
  /** Shell & tube, plate, etc. */
  exchangerType?: 'shell-tube' | 'plate' | 'air-cooled';
}

export interface PipeSymbol extends PIDSymbolBase {
  type: 'pipe';
  /** Path points for the pipe */
  points: Point[];
  showFlow?: boolean;
  spec?: string;
}

export interface JunctionSymbol extends PIDSymbolBase {
  type: 'junction';
  variant: JunctionVariant;
}

export type PIDSymbol =
  | ValveSymbol
  | PumpSymbol
  | TankSymbol
  | InstrumentSymbol
  | MotorSymbol
  | HeatExchangerSymbol
  | PipeSymbol
  | JunctionSymbol;

// =============================================================================
// SCENE GRAPH / DIAGRAM
// =============================================================================

export interface PIDLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  symbols: string[]; // symbol IDs
}

export interface PIDDiagram {
  id: string;
  name: string;
  description?: string;
  /** Drawing number */
  drawingNumber?: string;
  /** Revision */
  revision?: string;
  /** Canvas size */
  canvasSize: Size;
  /** Grid size for snapping */
  gridSize?: number;
  /** All symbols in the diagram */
  symbols: PIDSymbol[];
  /** Pipe connections between symbols */
  connections: PipeConnection[];
  /** Layers for organization */
  layers?: PIDLayer[];
  /** Metadata */
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
}

// =============================================================================
// REAL-TIME DATA
// =============================================================================

export interface PIDTagValue {
  tagId: string;
  value: number | string | boolean;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: string;
  alarmState?: AlarmState;
}

export interface PIDDataSnapshot {
  diagramId: string;
  values: Record<string, PIDTagValue>;
  timestamp: string;
}

// =============================================================================
// API TYPES
// =============================================================================

export interface CreateDiagramRequest {
  name: string;
  description?: string;
  drawingNumber?: string;
  canvasSize?: Size;
}

export interface UpdateDiagramRequest {
  name?: string;
  description?: string;
  drawingNumber?: string;
  revision?: string;
  canvasSize?: Size;
  symbols?: PIDSymbol[];
  connections?: PipeConnection[];
  layers?: PIDLayer[];
}

export interface DiagramListItem {
  id: string;
  name: string;
  drawingNumber?: string;
  revision?: string;
  updatedAt?: string;
}
