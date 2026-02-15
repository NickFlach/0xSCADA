/**
 * Digital Twin Runtime Types
 * ADR-0013 [13.3]
 */

export type ComponentType = 'tank' | 'pipe' | 'valve' | 'pump' | 'controller' | 'sensor' | 'heater' | 'mixer';
export type SimulationStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';

export interface ProcessComponent {
  id: string;
  type: ComponentType;
  name: string;
  parameters: Record<string, number>;
  connections: string[]; // IDs of connected components
  tags: string[]; // mapped SCADA tags
}

export interface ProcessModel {
  id: string;
  name: string;
  description: string;
  components: ProcessComponent[];
  stepFunction: string; // serialized function name for simulation step
  timeStepMs: number;
}

export interface SimulationState {
  modelId: string;
  tick: number;
  timeMs: number;
  componentStates: Record<string, Record<string, number>>;
  status: SimulationStatus;
}

export interface WhatIfScenario {
  id: string;
  name: string;
  baseModelId: string;
  modifications: Array<{
    componentId: string;
    parameter: string;
    value: number;
  }>;
  duration: number; // simulation ticks
}

export interface SimulationResult {
  scenarioId: string;
  states: SimulationState[];
  predictions: Record<string, number[]>; // tagId -> predicted values
  divergence: Record<string, number>; // tagId -> divergence from actual
  warnings: string[];
}

export interface TwinComparison {
  tagId: string;
  predicted: number;
  actual: number;
  divergence: number;
  withinTolerance: boolean;
}
