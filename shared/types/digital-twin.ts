/**
 * Digital Twin Runtime Types
 * ADR-0013 [13.3] — Issue #214
 *
 * Component-model process simulation: tanks, pipes, valves, pumps,
 * controllers. Models are plain JSON (step functions referenced by name),
 * so they can be persisted and transported. The twin is strictly
 * read-only toward the real plant: it consumes live tag data and produces
 * predictions — it never writes control outputs (ADR-0009).
 */

export type ComponentType =
  | 'tank'
  | 'pipe'
  | 'valve'
  | 'pump'
  | 'controller'
  | 'sensor'
  | 'heater'
  | 'mixer';

/**
 * A process component. `config` is static configuration (capacity, maxFlow,
 * kp); `initialState` seeds the mutable simulation state (level, position).
 * The two are deliberately separate — the Wave-2 twin conflated them.
 *
 * `connections` are DIRECTED downstream edges (this component feeds the
 * listed components): valve/pump/pipe flow pushes into connected tanks,
 * controller output drives connected valve position / pump speed.
 */
export interface ProcessComponent {
  id: string;
  type: ComponentType;
  name: string;
  config: Record<string, number>;
  initialState: Record<string, number>;
  connections: string[];
  /**
   * Controllers only: id of the component whose level/temperature is the
   * process variable this controller regulates.
   */
  pvSource?: string;
}

/**
 * Explicit tag → (component, parameter) binding. Live values assimilate
 * into exactly this parameter, and predictions for the tag read exactly
 * this parameter — never "the first property of the state object".
 */
export interface TagBinding {
  tagId: string;
  componentId: string;
  parameter: string;
}

export interface ProcessModel {
  id: string;
  name: string;
  description?: string;
  components: ProcessComponent[];
  tagBindings: TagBinding[];
  /** Name of a registered step function — keeps models JSON-serializable */
  stepFunction: string;
  timeStepMs: number;
}

export type SimulationStatus = 'idle' | 'running' | 'error';

export interface SimulationState {
  modelId: string;
  tick: number;
  timeMs: number;
  componentStates: Record<string, Record<string, number>>;
  status: SimulationStatus;
  error?: string;
  /** Wall-clock ms of the last live-data assimilation, if any */
  lastSyncAt?: number;
}

export interface ScenarioModification {
  componentId: string;
  parameter: string;
  value: number;
  /** Whether the parameter lives in config (default) or mutable state */
  target?: 'config' | 'state';
}

export interface WhatIfScenario {
  id: string;
  name: string;
  baseModelId: string;
  modifications: ScenarioModification[];
  durationTicks: number;
  /**
   * Fork from the current (live-synced) simulation state — the default.
   * false replays from the model's authored initial conditions instead.
   */
  fromLiveState?: boolean;
}

export interface SimulationResult {
  scenarioId: string;
  baseModelId: string;
  ticks: number;
  /** Predicted series per bound tag, one value per tick */
  predictions: Record<string, number[]>;
  finalState: Record<string, Record<string, number>>;
  warnings: string[];
}

export interface TwinComparison {
  tagId: string;
  predicted: number | null;
  actual: number | null;
  divergence: number | null;
  withinTolerance: boolean;
}

/** Result of simulating the reversal of already-applied modifications */
export interface RollbackSimulationResult {
  modelId: string;
  /** The parameter values the rollback would restore */
  restoredValues: ScenarioModification[];
  result: SimulationResult;
}
