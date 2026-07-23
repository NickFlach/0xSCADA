/**
 * Twin Solver — component step functions
 * ADR-0013 [13.3] — Issue #214
 *
 * Fixed-timestep explicit-Euler process dynamics. Step functions are
 * registered by name so ProcessModel stays JSON-serializable; an unknown
 * name is a hard error, never a silent no-op.
 *
 * Flow semantics (fixes the Wave-2 accumulating-inflow bug): flows are
 * recomputed from sources and connections every tick — tank inflow is
 * derived state, zeroed and re-aggregated each step, never carried over.
 */

import type { ProcessComponent, ProcessModel } from '@shared/types/digital-twin';

export type ComponentStates = Record<string, Record<string, number>>;

export type StepFunction = (
  model: ProcessModel,
  states: ComponentStates,
  dtMs: number,
  warnings: string[]
) => ComponentStates;

const registry = new Map<string, StepFunction>();

export function registerStepFunction(name: string, fn: StepFunction): void {
  registry.set(name, fn);
}

export function getStepFunction(name: string): StepFunction {
  const fn = registry.get(name);
  if (!fn) {
    throw new Error(
      `Unknown step function "${name}" — registered: ${[...registry.keys()].join(', ') || '(none)'}`
    );
  }
  return fn;
}

export function listStepFunctions(): string[] {
  return [...registry.keys()];
}

/** Seed each component's state from initialState (config stays separate) */
export function seedStates(model: ProcessModel): ComponentStates {
  const states: ComponentStates = {};
  for (const comp of model.components) {
    states[comp.id] = { ...comp.initialState };
  }
  return states;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 'basic-flow': tanks, valves, pumps, pipes, heaters, P-controllers.
 *
 * Pass 1 — sources: valves/pumps compute currentFlow from config + state.
 * Pass 2 — controllers: P-control output drives connected actuators
 *          (valve position / pump speed) inside the simulation.
 * Pass 3 — aggregation: propagate source flow through the pipe DAG, then
 *          sum it into tanks (recomputed from zero every tick).
 * Pass 4 — integration: tank levels and heater temperatures advance by dt.
 */
export const basicFlowStep: StepFunction = (model, states, dtMs, warnings) => {
  const dt = dtMs / 1000;
  const next: ComponentStates = {};
  const byId = new Map<string, ProcessComponent>(model.components.map((c) => [c.id, c]));

  for (const comp of model.components) {
    next[comp.id] = { ...(states[comp.id] ?? comp.initialState) };
  }

  // Pass 1 — actuator/source flows
  for (const comp of model.components) {
    const s = next[comp.id];
    switch (comp.type) {
      case 'valve': {
        const maxFlow = comp.config.maxFlow ?? 0;
        const position = clamp(s.position ?? 0, 0, 100);
        s.position = position;
        s.currentFlow = maxFlow * (position / 100);
        break;
      }
      case 'pump': {
        const maxFlow = comp.config.maxFlow ?? 0;
        const running = (s.running ?? 1) > 0 ? 1 : 0;
        const speed = clamp(s.speed ?? 100, 0, 100);
        s.speed = speed;
        s.currentFlow = running * maxFlow * (speed / 100);
        break;
      }
      case 'pipe': {
        // Pipes relay the flow of whatever feeds them; resolved in pass 3.
        s.currentFlow = 0;
        break;
      }
      default:
        break;
    }
  }

  // Pass 2 — P-controllers drive connected actuators
  for (const comp of model.components) {
    if (comp.type !== 'controller') continue;
    const s = next[comp.id];
    const kp = comp.config.kp ?? 1;
    const setpoint = comp.config.setpoint ?? s.setpoint ?? 0;
    let pv = s.processVariable ?? 0;
    if (comp.pvSource) {
      const source = next[comp.pvSource];
      if (source) {
        pv = source.level ?? source.temperature ?? pv;
      } else {
        warnings.push(`controller "${comp.id}" pvSource "${comp.pvSource}" not found`);
      }
    }
    const output = clamp(kp * (setpoint - pv), 0, 100);
    s.processVariable = pv;
    s.output = output;

    for (const targetId of comp.connections) {
      const target = byId.get(targetId);
      if (!target) {
        warnings.push(`controller "${comp.id}" connects to unknown component "${targetId}"`);
        continue;
      }
      if (target.type === 'valve') next[targetId].position = output;
      else if (target.type === 'pump') next[targetId].speed = output;
    }
  }

  // Pass 3 — aggregate flows into tanks (inflow recomputed from zero).
  // Sources are applied first, then pipes are processed topologically so
  // valve→pipe→…→tank flow never depends on component declaration order.
  for (const comp of model.components) {
    if (comp.type === 'tank') next[comp.id].inflow = 0;
    if (comp.type === 'pipe') next[comp.id].currentFlow = 0;
  }

  const pipeIds = new Set(
    model.components.filter((component) => component.type === 'pipe').map((component) => component.id)
  );
  const pipeIndegree = new Map<string, number>(
    [...pipeIds].map((pipeId) => [pipeId, 0])
  );
  for (const component of model.components) {
    if (component.type !== 'pipe') continue;
    for (const targetId of component.connections) {
      if (pipeIds.has(targetId)) {
        pipeIndegree.set(targetId, (pipeIndegree.get(targetId) ?? 0) + 1);
      }
    }
  }

  const forwardFlow = (source: ProcessComponent, flow: number) => {
    for (const targetId of source.connections) {
      const target = byId.get(targetId);
      if (!target) {
        warnings.push(`component "${source.id}" connects to unknown component "${targetId}"`);
        continue;
      }
      if (target.type === 'tank') {
        next[targetId].inflow = (next[targetId].inflow ?? 0) + flow;
      } else if (target.type === 'pipe') {
        next[targetId].currentFlow = (next[targetId].currentFlow ?? 0) + flow;
      }
    }
  };

  for (const comp of model.components) {
    if (comp.type === 'valve' || comp.type === 'pump') {
      forwardFlow(comp, next[comp.id].currentFlow ?? 0);
    }
  }

  const pipeQueue = [...pipeIndegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([pipeId]) => pipeId);
  let visitedPipes = 0;
  while (pipeQueue.length > 0) {
    const pipeId = pipeQueue.shift()!;
    visitedPipes++;
    const pipe = byId.get(pipeId)!;
    forwardFlow(pipe, next[pipeId].currentFlow ?? 0);
    for (const targetId of pipe.connections) {
      if (!pipeIds.has(targetId)) continue;
      const degree = (pipeIndegree.get(targetId) ?? 0) - 1;
      pipeIndegree.set(targetId, degree);
      if (degree === 0) pipeQueue.push(targetId);
    }
  }
  if (visitedPipes !== pipeIds.size) {
    warnings.push('pipe flow graph contains a cycle');
  }

  // Pass 4 — integrate tank levels and heater temperatures
  for (const comp of model.components) {
    const s = next[comp.id];
    switch (comp.type) {
      case 'tank': {
        const capacity = comp.config.capacity ?? Number.MAX_SAFE_INTEGER;
        const outflow = s.outflow ?? comp.config.outflow ?? 0;
        const level = clamp((s.level ?? 0) + ((s.inflow ?? 0) - outflow) * dt, 0, capacity);
        if (level === 0 && (s.level ?? 0) + ((s.inflow ?? 0) - outflow) * dt < 0) {
          warnings.push(`tank "${comp.id}" ran empty`);
        }
        if (level === capacity) {
          warnings.push(`tank "${comp.id}" reached capacity`);
        }
        s.level = level;
        s.fillPercent = capacity > 0 ? (level / capacity) * 100 : 0;
        break;
      }
      case 'heater': {
        const power = s.power ?? comp.config.power ?? 0;
        const heatRate = comp.config.heatRate ?? 0.1;
        const ambient = comp.config.ambient ?? 20;
        const lossRate = comp.config.lossRate ?? 0.01;
        const temp = s.temperature ?? ambient;
        s.temperature = temp + (power * heatRate - (temp - ambient) * lossRate) * dt;
        break;
      }
      default:
        break;
    }
  }

  return next;
};

registerStepFunction('basic-flow', basicFlowStep);
