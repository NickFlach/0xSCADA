/**
 * Digital Twin Runtime
 * ADR-0013 [13.3] — Issue #214
 *
 * Maintains per-model simulation state, assimilates live tag data through
 * explicit tag bindings, and answers what-if / rollback questions by
 * forking the current state into isolated scenario runs. The runtime is
 * strictly read-only toward the plant: it never emits control writes
 * (ADR-0009 — twins are the sandbox, not the actuator).
 */

import { EventEmitter } from 'events';
import type {
  ProcessModel,
  RollbackSimulationResult,
  ScenarioModification,
  SimulationResult,
  SimulationState,
  TwinComparison,
  WhatIfScenario,
} from '@shared/types/digital-twin';
import { getStepFunction, seedStates, type ComponentStates } from './solver';

export interface TwinRuntimeOptions {
  /** Max models registered at once */
  maxModels?: number;
  /** Max ticks a single scenario run may simulate */
  maxScenarioTicks?: number;
  /** Relative divergence below which predicted ≈ actual */
  divergenceTolerance?: number;
}

interface ModelEntry {
  model: ProcessModel;
  state: SimulationState;
  /** Latest live values per bound tag */
  actuals: Map<string, { value: number; timestamp: number }>;
}

export class TwinRuntime extends EventEmitter {
  private readonly maxModels: number;
  private readonly maxScenarioTicks: number;
  private readonly divergenceTolerance: number;

  private entries: Map<string, ModelEntry> = new Map();

  constructor(options: TwinRuntimeOptions = {}) {
    super();
    this.maxModels = options.maxModels ?? 100;
    this.maxScenarioTicks = options.maxScenarioTicks ?? 100_000;
    this.divergenceTolerance = options.divergenceTolerance ?? 0.05;
  }

  // ── Model registry ───────────────────────────────────────────────────

  registerModel(model: ProcessModel): SimulationState {
    this.validateModel(model);
    if (!this.entries.has(model.id) && this.entries.size >= this.maxModels) {
      throw new Error(`Model limit (${this.maxModels}) reached`);
    }
    const state: SimulationState = {
      modelId: model.id,
      tick: 0,
      timeMs: 0,
      componentStates: seedStates(model),
      status: 'idle',
    };
    this.entries.set(model.id, { model, state, actuals: new Map() });
    return state;
  }

  getModel(modelId: string): ProcessModel | undefined {
    return this.entries.get(modelId)?.model;
  }

  listModels(): Array<{ model: ProcessModel; state: SimulationState }> {
    return Array.from(this.entries.values()).map((e) => ({ model: e.model, state: e.state }));
  }

  removeModel(modelId: string): boolean {
    return this.entries.delete(modelId);
  }

  getState(modelId: string): SimulationState | undefined {
    return this.entries.get(modelId)?.state;
  }

  setRunning(modelId: string, running: boolean): SimulationState {
    const entry = this.require(modelId);
    if (entry.state.status !== 'error') {
      entry.state.status = running ? 'running' : 'idle';
    } else if (running) {
      // Explicit restart clears a previous solver error
      entry.state.status = 'running';
      entry.state.error = undefined;
    }
    return entry.state;
  }

  resetModel(modelId: string): SimulationState {
    const entry = this.require(modelId);
    entry.state = {
      modelId,
      tick: 0,
      timeMs: 0,
      componentStates: seedStates(entry.model),
      status: 'idle',
    };
    return entry.state;
  }

  // ── Live data assimilation ───────────────────────────────────────────

  /**
   * Record a live tag value. It is applied to bound component parameters
   * on the next sync, so the twin tracks the real plant.
   */
  ingestActual(tagId: string, value: number, timestamp: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(timestamp)) return;
    for (const entry of this.entries.values()) {
      if (entry.model.tagBindings.some((b) => b.tagId === tagId)) {
        entry.actuals.set(tagId, { value, timestamp });
      }
    }
  }

  /** Write recorded actuals into the simulation state via tag bindings */
  syncFromLive(modelId: string, nowMs: number): SimulationState {
    const entry = this.require(modelId);
    for (const binding of entry.model.tagBindings) {
      const actual = entry.actuals.get(binding.tagId);
      if (!actual) continue;
      const componentState = entry.state.componentStates[binding.componentId];
      if (componentState) {
        componentState[binding.parameter] = actual.value;
      }
    }
    entry.state.lastSyncAt = nowMs;
    return entry.state;
  }

  // ── Simulation stepping ──────────────────────────────────────────────

  /** Advance the live simulation state by n ticks */
  step(modelId: string, ticks = 1): SimulationState {
    const entry = this.require(modelId);
    const warnings: string[] = [];
    try {
      const stepFn = getStepFunction(entry.model.stepFunction);
      for (let i = 0; i < ticks; i++) {
        entry.state.componentStates = stepFn(
          entry.model,
          entry.state.componentStates,
          entry.model.timeStepMs,
          warnings
        );
        entry.state.tick++;
        entry.state.timeMs += entry.model.timeStepMs;
      }
    } catch (error) {
      entry.state.status = 'error';
      entry.state.error = error instanceof Error ? error.message : String(error);
      this.emit('model-error', { modelId, error: entry.state.error });
      return entry.state;
    }
    if (warnings.length > 0) {
      this.emit('model-warnings', { modelId, warnings });
    }
    return entry.state;
  }

  /** Step every running model — the service's periodic driver */
  stepRunning(): void {
    for (const [modelId, entry] of this.entries) {
      if (entry.state.status === 'running') {
        this.step(modelId, 1);
      }
    }
  }

  // ── What-if, prediction, rollback ────────────────────────────────────

  /**
   * Run a scenario in an isolated fork. By default the fork starts from
   * the CURRENT (live-synced) state — predicting "what happens if we make
   * this change now", not "what would happen from authored initial
   * conditions" (the Wave-2 flaw). The live state is never touched.
   */
  runScenario(scenario: WhatIfScenario): SimulationResult {
    const entry = this.require(scenario.baseModelId);
    if (scenario.durationTicks < 1 || scenario.durationTicks > this.maxScenarioTicks) {
      throw new Error(`durationTicks must be 1..${this.maxScenarioTicks}`);
    }

    const warnings: string[] = [];
    const fromLive = scenario.fromLiveState !== false;
    let states: ComponentStates = fromLive
      ? structuredClone(entry.state.componentStates)
      : seedStates(entry.model);

    // Apply modifications to a scenario-local model clone (config) and the
    // forked states (state) — the registered model must stay pristine.
    const model: ProcessModel = structuredClone(entry.model);
    for (const mod of scenario.modifications) {
      const component = model.components.find((c) => c.id === mod.componentId);
      if (!component) {
        warnings.push(`modification targets unknown component "${mod.componentId}"`);
        continue;
      }
      if (mod.target === 'state') {
        states[mod.componentId] = { ...states[mod.componentId], [mod.parameter]: mod.value };
      } else {
        component.config[mod.parameter] = mod.value;
      }
    }

    const stepFn = getStepFunction(model.stepFunction);
    const predictions: Record<string, number[]> = {};
    for (const binding of model.tagBindings) {
      predictions[binding.tagId] = [];
    }

    for (let tick = 0; tick < scenario.durationTicks; tick++) {
      states = stepFn(model, states, model.timeStepMs, warnings);
      for (const binding of model.tagBindings) {
        predictions[binding.tagId].push(
          states[binding.componentId]?.[binding.parameter] ?? NaN
        );
      }
    }

    return {
      scenarioId: scenario.id,
      baseModelId: scenario.baseModelId,
      ticks: scenario.durationTicks,
      predictions,
      finalState: states,
      warnings: [...new Set(warnings)],
    };
  }

  /**
   * Simulate reverting already-applied modifications: restores each listed
   * parameter to the registered model's value and runs forward from the
   * current live-synced state.
   */
  simulateRollback(
    modelId: string,
    applied: ScenarioModification[],
    durationTicks: number
  ): RollbackSimulationResult {
    const entry = this.require(modelId);
    const restoredValues: ScenarioModification[] = [];
    for (const mod of applied) {
      const component = entry.model.components.find((c) => c.id === mod.componentId);
      if (!component) continue;
      const original =
        mod.target === 'state'
          ? component.initialState[mod.parameter]
          : component.config[mod.parameter];
      if (original !== undefined) {
        restoredValues.push({ ...mod, value: original });
      }
    }

    const result = this.runScenario({
      id: `rollback-${modelId}`,
      name: `Rollback simulation for ${modelId}`,
      baseModelId: modelId,
      modifications: restoredValues,
      durationTicks,
      fromLiveState: true,
    });

    return { modelId, restoredValues, result };
  }

  /** Compare current simulated values against the latest live actuals */
  compare(modelId: string): TwinComparison[] {
    const entry = this.require(modelId);
    return entry.model.tagBindings.map((binding) => {
      const predicted =
        entry.state.componentStates[binding.componentId]?.[binding.parameter] ?? null;
      const actual = entry.actuals.get(binding.tagId)?.value ?? null;
      let divergence: number | null = null;
      if (predicted !== null && actual !== null) {
        const scale = Math.max(Math.abs(actual), Math.abs(predicted), 1e-9);
        divergence = Math.abs(predicted - actual) / scale;
      }
      return {
        tagId: binding.tagId,
        predicted,
        actual,
        divergence,
        withinTolerance: divergence !== null && divergence <= this.divergenceTolerance,
      };
    });
  }

  getStatus(): {
    models: number;
    running: number;
    boundTags: number;
  } {
    let running = 0;
    let boundTags = 0;
    for (const entry of this.entries.values()) {
      if (entry.state.status === 'running') running++;
      boundTags += entry.model.tagBindings.length;
    }
    return { models: this.entries.size, running, boundTags };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private require(modelId: string): ModelEntry {
    const entry = this.entries.get(modelId);
    if (!entry) throw new Error(`Unknown model "${modelId}"`);
    return entry;
  }

  private validateModel(model: ProcessModel): void {
    getStepFunction(model.stepFunction); // throws on unknown solver
    if (model.timeStepMs <= 0) throw new Error('timeStepMs must be positive');
    const ids = new Set<string>();
    for (const comp of model.components) {
      if (ids.has(comp.id)) throw new Error(`Duplicate component id "${comp.id}"`);
      ids.add(comp.id);
    }
    for (const comp of model.components) {
      for (const target of comp.connections) {
        if (!ids.has(target)) {
          throw new Error(`Component "${comp.id}" connects to unknown component "${target}"`);
        }
      }
      if (comp.pvSource && !ids.has(comp.pvSource)) {
        throw new Error(`Controller "${comp.id}" pvSource "${comp.pvSource}" does not exist`);
      }
    }
    for (const binding of model.tagBindings) {
      if (!ids.has(binding.componentId)) {
        throw new Error(`Tag binding "${binding.tagId}" references unknown component`);
      }
    }
  }
}
