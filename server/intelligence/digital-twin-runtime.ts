/**
 * Digital Twin Runtime
 * ADR-0013 [13.3] — Process simulation with what-if analysis
 */

import type {
  ProcessComponent,
  ProcessModel,
  SimulationState,
  WhatIfScenario,
  SimulationResult,
  TwinComparison,
  SimulationStatus,
} from '../../shared/types/digital-twin';

// ── Built-in Step Functions ───────────────────────────────────────

type StepFn = (
  components: ProcessComponent[],
  state: Record<string, Record<string, number>>,
  dt: number
) => Record<string, Record<string, number>>;

const stepFunctions: Record<string, StepFn> = {
  'basic-flow': (components, state, dt) => {
    const next: Record<string, Record<string, number>> = {};

    for (const comp of components) {
      const s = state[comp.id] ?? comp.parameters;
      next[comp.id] = { ...s };

      switch (comp.type) {
        case 'tank': {
          const inflow = s.inflow ?? 0;
          const outflow = s.outflow ?? 0;
          const level = (s.level ?? 0) + (inflow - outflow) * (dt / 1000);
          const capacity = s.capacity ?? 100;
          next[comp.id].level = Math.max(0, Math.min(level, capacity));
          next[comp.id].fillPercent = (next[comp.id].level / capacity) * 100;
          break;
        }
        case 'valve': {
          const position = s.position ?? 0; // 0-100%
          const maxFlow = s.maxFlow ?? 10;
          next[comp.id].currentFlow = maxFlow * (position / 100);
          break;
        }
        case 'pump': {
          const running = s.running ?? 0;
          const speed = s.speed ?? 0;
          const maxFlow = s.maxFlow ?? 20;
          next[comp.id].currentFlow = running ? maxFlow * (speed / 100) : 0;
          break;
        }
        case 'heater': {
          const power = s.power ?? 0;
          const temp = s.temperature ?? 20;
          const heatRate = s.heatRate ?? 0.1;
          const ambientLoss = (temp - 20) * 0.01;
          next[comp.id].temperature = temp + (power * heatRate - ambientLoss) * (dt / 1000);
          break;
        }
        case 'controller': {
          const setpoint = s.setpoint ?? 50;
          const pv = s.processVariable ?? 0;
          const kp = s.kp ?? 1;
          const error = setpoint - pv;
          next[comp.id].output = Math.max(0, Math.min(100, kp * error));
          next[comp.id].error = error;
          break;
        }
        default:
          // sensor, pipe, mixer — pass through
          break;
      }
    }

    // Propagate connections
    for (const comp of components) {
      if (comp.type === 'valve' || comp.type === 'pump') {
        const flow = next[comp.id]?.currentFlow ?? 0;
        for (const connId of comp.connections) {
          const connComp = components.find((c) => c.id === connId);
          if (connComp?.type === 'tank') {
            next[connId] = next[connId] ?? { ...state[connId] };
            next[connId].inflow = (next[connId].inflow ?? 0) + flow;
          }
        }
      }
    }

    return next;
  },
};

// ── Digital Twin Runtime ──────────────────────────────────────────

export class DigitalTwinRuntime {
  private models: Map<string, ProcessModel> = new Map();
  private simulations: Map<string, SimulationState> = new Map();
  private actuals: Map<string, number> = new Map(); // tagId -> latest actual value

  registerModel(model: ProcessModel): void {
    this.models.set(model.id, model);
  }

  getModel(modelId: string): ProcessModel | undefined {
    return this.models.get(modelId);
  }

  initSimulation(modelId: string): SimulationState | null {
    const model = this.models.get(modelId);
    if (!model) return null;

    const componentStates: Record<string, Record<string, number>> = {};
    for (const comp of model.components) {
      componentStates[comp.id] = { ...comp.parameters };
    }

    const state: SimulationState = {
      modelId,
      tick: 0,
      timeMs: 0,
      componentStates,
      status: 'idle' as SimulationStatus,
    };

    this.simulations.set(modelId, state);
    return state;
  }

  step(modelId: string): SimulationState | null {
    const model = this.models.get(modelId);
    const state = this.simulations.get(modelId);
    if (!model || !state) return null;

    const stepFn = stepFunctions[model.stepFunction];
    if (!stepFn) return null;

    state.status = 'running';
    state.componentStates = stepFn(model.components, state.componentStates, model.timeStepMs);
    state.tick++;
    state.timeMs += model.timeStepMs;

    return { ...state };
  }

  runSteps(modelId: string, count: number): SimulationState[] {
    const states: SimulationState[] = [];
    for (let i = 0; i < count; i++) {
      const s = this.step(modelId);
      if (!s) break;
      states.push(s);
    }
    if (states.length > 0) {
      const last = this.simulations.get(modelId);
      if (last) last.status = 'completed';
    }
    return states;
  }

  // ── What-If Analysis ────────────────────────────────────────────

  runScenario(scenario: WhatIfScenario): SimulationResult | null {
    const model = this.models.get(scenario.baseModelId);
    if (!model) return null;

    // Clone model with modifications
    const modifiedComponents = model.components.map((comp) => {
      const mods = scenario.modifications.filter((m) => m.componentId === comp.id);
      if (mods.length === 0) return comp;
      const newParams = { ...comp.parameters };
      for (const mod of mods) {
        newParams[mod.parameter] = mod.value;
      }
      return { ...comp, parameters: newParams };
    });

    const tempModel: ProcessModel = {
      ...model,
      id: `${model.id}__scenario_${scenario.id}`,
      components: modifiedComponents,
    };

    this.registerModel(tempModel);
    this.initSimulation(tempModel.id);
    const states = this.runSteps(tempModel.id, scenario.duration);

    // Compute predictions & divergence
    const predictions: Record<string, number[]> = {};
    const divergence: Record<string, number> = {};
    const warnings: string[] = [];

    for (const comp of modifiedComponents) {
      for (const tagId of comp.tags) {
        predictions[tagId] = states.map((s) => {
          const cs = s.componentStates[comp.id];
          return cs ? Object.values(cs)[0] ?? 0 : 0;
        });

        const actual = this.actuals.get(tagId);
        if (actual !== undefined && predictions[tagId].length > 0) {
          const predicted = predictions[tagId][predictions[tagId].length - 1];
          divergence[tagId] = Math.abs(predicted - actual);
          if (divergence[tagId] > actual * 0.2) {
            warnings.push(`Tag ${tagId}: predicted diverges >20% from actual`);
          }
        }
      }
    }

    // Cleanup temp model
    this.models.delete(tempModel.id);
    this.simulations.delete(tempModel.id);

    return { scenarioId: scenario.id, states, predictions, divergence, warnings };
  }

  // ── Actual Data Feed ────────────────────────────────────────────

  updateActual(tagId: string, value: number): void {
    this.actuals.set(tagId, value);
  }

  compare(modelId: string): TwinComparison[] {
    const model = this.models.get(modelId);
    const state = this.simulations.get(modelId);
    if (!model || !state) return [];

    const comparisons: TwinComparison[] = [];
    for (const comp of model.components) {
      for (const tagId of comp.tags) {
        const actual = this.actuals.get(tagId);
        if (actual === undefined) continue;

        const compState = state.componentStates[comp.id];
        if (!compState) continue;

        const predicted = Object.values(compState)[0] ?? 0;
        const div = Math.abs(predicted - actual);
        const tolerance = Math.abs(actual) * 0.1 || 1;

        comparisons.push({
          tagId,
          predicted,
          actual,
          divergence: div,
          withinTolerance: div <= tolerance,
        });
      }
    }

    return comparisons;
  }

  getState(modelId: string): SimulationState | undefined {
    return this.simulations.get(modelId);
  }

  reset(modelId: string): void {
    this.simulations.delete(modelId);
  }
}
