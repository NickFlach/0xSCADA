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

const MAX_AUTHORED_PARAMETER_FIELDS = 128;
const MAX_RUNTIME_STATE_FIELDS = 136;

export interface TwinRuntimeOptions {
  /** Max models registered at once */
  maxModels?: number;
  /** Max synchronous manual-step work, weighted by model size */
  maxStepWorkUnits?: number;
  /** Max ticks a single scenario run may simulate */
  maxScenarioTicks?: number;
  /** Max synchronous scenario work, weighted by model size */
  maxScenarioWorkUnits?: number;
  /** Relative divergence below which predicted ≈ actual */
  divergenceTolerance?: number;
}

interface ModelEntry {
  model: ProcessModel;
  state: SimulationState;
  /** Latest live values per bound tag */
  actuals: Map<string, { value: number; timestamp: number }>;
  /** Latest sample timestamp already assimilated per tag */
  appliedActualTimestamps: Map<string, number>;
  /** Wall-clock deadline for the next running-model tick */
  nextStepAt?: number;
}

export class TwinRuntime extends EventEmitter {
  private readonly maxModels: number;
  private readonly maxStepWorkUnits: number;
  private readonly maxScenarioTicks: number;
  private readonly maxScenarioWorkUnits: number;
  private readonly divergenceTolerance: number;

  private entries: Map<string, ModelEntry> = new Map();

  constructor(options: TwinRuntimeOptions = {}) {
    super();
    this.maxModels = options.maxModels ?? 100;
    this.maxStepWorkUnits = options.maxStepWorkUnits ?? 100_000;
    this.maxScenarioTicks = options.maxScenarioTicks ?? 100_000;
    this.maxScenarioWorkUnits = options.maxScenarioWorkUnits ?? 100_000;
    this.divergenceTolerance = options.divergenceTolerance ?? 0.05;
  }

  // ── Model registry ───────────────────────────────────────────────────

  registerModel(model: ProcessModel): SimulationState {
    const storedModel = structuredClone(model);
    this.validateModel(storedModel);
    if (!this.entries.has(storedModel.id) && this.entries.size >= this.maxModels) {
      throw new Error(`Model limit (${this.maxModels}) reached`);
    }
    const state: SimulationState = {
      modelId: storedModel.id,
      tick: 0,
      timeMs: 0,
      componentStates: seedStates(storedModel),
      status: 'idle',
    };
    this.entries.set(storedModel.id, {
      model: storedModel,
      state,
      actuals: new Map(),
      appliedActualTimestamps: new Map(),
    });
    return structuredClone(state);
  }

  getModel(modelId: string): ProcessModel | undefined {
    const model = this.entries.get(modelId)?.model;
    return model ? structuredClone(model) : undefined;
  }

  listModels(): Array<{ model: ProcessModel; state: SimulationState }> {
    return Array.from(this.entries.values()).map((entry) => ({
      model: structuredClone(entry.model),
      state: structuredClone(entry.state),
    }));
  }

  removeModel(modelId: string): boolean {
    return this.entries.delete(modelId);
  }

  getState(modelId: string): SimulationState | undefined {
    const state = this.entries.get(modelId)?.state;
    return state ? structuredClone(state) : undefined;
  }

  setRunning(modelId: string, running: boolean, nowMs = Date.now()): SimulationState {
    const entry = this.require(modelId);
    const wasRunning = entry.state.status === 'running';
    if (entry.state.status !== 'error') {
      entry.state.status = running ? 'running' : 'idle';
    } else if (running) {
      // Explicit restart clears a previous solver error
      entry.state.status = 'running';
      entry.state.error = undefined;
    }
    if (running && !wasRunning) {
      entry.nextStepAt = nowMs + entry.model.timeStepMs;
    } else if (!running) {
      entry.nextStepAt = undefined;
    }
    return structuredClone(entry.state);
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
    entry.appliedActualTimestamps.clear();
    entry.nextStepAt = undefined;
    return structuredClone(entry.state);
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
        const existing = entry.actuals.get(tagId);
        if (existing && timestamp <= existing.timestamp) continue;
        entry.actuals.set(tagId, { value, timestamp });
      }
    }
  }

  /** Write recorded actuals into the simulation state via tag bindings */
  syncFromLive(modelId: string, nowMs: number): SimulationState {
    const entry = this.require(modelId);
    return structuredClone(this.assimilateFromLive(entry, nowMs));
  }

  syncRunningFromLive(nowMs: number): void {
    for (const entry of this.entries.values()) {
      if (entry.state.status === 'running') {
        this.assimilateFromLive(entry, nowMs);
      }
    }
  }

  private assimilateFromLive(entry: ModelEntry, nowMs: number): SimulationState {
    let assimilated = false;
    for (const binding of entry.model.tagBindings) {
      const actual = entry.actuals.get(binding.tagId);
      if (!actual) continue;
      const appliedTimestamp = entry.appliedActualTimestamps.get(binding.tagId);
      if (appliedTimestamp !== undefined && appliedTimestamp >= actual.timestamp) continue;
      const componentState = entry.state.componentStates[binding.componentId];
      if (componentState) {
        componentState[binding.parameter] = actual.value;
        entry.appliedActualTimestamps.set(binding.tagId, actual.timestamp);
        assimilated = true;
      }
    }
    if (assimilated) entry.state.lastSyncAt = nowMs;
    return entry.state;
  }

  // ── Simulation stepping ──────────────────────────────────────────────

  /** Advance the live simulation state by n ticks */
  step(modelId: string, ticks = 1): SimulationState {
    const entry = this.require(modelId);
    return structuredClone(this.advanceModel(modelId, entry, ticks));
  }

  private advanceModel(modelId: string, entry: ModelEntry, ticks: number): SimulationState {
    if (!Number.isInteger(ticks) || ticks < 1) {
      throw new Error('ticks must be a positive integer');
    }
    const workUnits = ticks * this.modelWorkFactor(entry.model);
    if (workUnits > this.maxStepWorkUnits) {
      throw new Error(
        `step exceeds synchronous work limit (${workUnits} > ${this.maxStepWorkUnits})`
      );
    }
    const warnings: string[] = [];
    let warningsTruncated = false;
    try {
      const stepFn = getStepFunction(entry.model.stepFunction);
      for (let i = 0; i < ticks; i++) {
        const nextStates = stepFn(
          structuredClone(entry.model),
          structuredClone(entry.state.componentStates),
          entry.model.timeStepMs,
          warnings
        );
        this.assertValidStates(entry.model, nextStates);
        const nextTimeMs = entry.state.timeMs + entry.model.timeStepMs;
        if (!Number.isFinite(nextTimeMs)) {
          throw new Error('Non-finite simulation clock');
        }
        entry.state.componentStates = nextStates;
        entry.state.tick++;
        entry.state.timeMs = nextTimeMs;
        if (this.capWarnings(warnings)) warningsTruncated = true;
      }
    } catch (error) {
      entry.state.status = 'error';
      entry.state.error = error instanceof Error ? error.message : String(error);
      entry.nextStepAt = undefined;
      this.emit('model-error', { modelId, error: entry.state.error });
      return entry.state;
    }
    if (warnings.length > 0) {
      const emittedWarnings = [...new Set(warnings)];
      if (warningsTruncated) emittedWarnings.push('additional simulation warnings omitted');
      this.emit('model-warnings', { modelId, warnings: emittedWarnings });
    }
    return entry.state;
  }

  /**
   * Advance each running model according to its own configured time step.
   * Catch-up is bounded so a delayed event loop cannot trigger an unbounded
   * synchronous burst.
   */
  stepRunning(nowMs = Date.now(), maxCatchUpSteps = 100): void {
    for (const [modelId, entry] of this.entries) {
      if (entry.state.status !== 'running') {
        entry.nextStepAt = undefined;
        continue;
      }

      const timeStepMs = entry.model.timeStepMs;
      if (entry.nextStepAt === undefined) {
        entry.nextStepAt = nowMs + timeStepMs;
        continue;
      }
      if (nowMs < entry.nextStepAt) continue;

      const dueSteps = Math.floor((nowMs - entry.nextStepAt) / timeStepMs) + 1;
      const maxStepsByWork = Math.max(
        1,
        Math.floor(this.maxStepWorkUnits / this.modelWorkFactor(entry.model))
      );
      const steps = Math.min(dueSteps, maxCatchUpSteps, maxStepsByWork);
      this.advanceModel(modelId, entry, steps);
      if (entry.state.status !== 'running') continue;

      if (dueSteps > steps) {
        entry.nextStepAt = nowMs + timeStepMs;
        this.emit('model-warnings', {
          modelId,
          warnings: [
            `dropped ${dueSteps - steps} overdue simulation ticks after driver delay`,
          ],
        });
      } else {
        entry.nextStepAt += steps * timeStepMs;
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
    if (
      !Number.isInteger(scenario.durationTicks)
      || scenario.durationTicks < 1
      || scenario.durationTicks > this.maxScenarioTicks
    ) {
      throw new Error(`durationTicks must be an integer from 1 to ${this.maxScenarioTicks}`);
    }
    if (scenario.modifications.length > 100) {
      throw new Error('scenarios may contain at most 100 modifications');
    }
    const workUnits = scenario.durationTicks * this.modelWorkFactor(entry.model);
    if (workUnits > this.maxScenarioWorkUnits) {
      throw new Error(
        `scenario exceeds synchronous work limit (${workUnits} > ${this.maxScenarioWorkUnits})`
      );
    }

    const warnings: string[] = [];
    let warningsTruncated = false;
    const fromLive = scenario.fromLiveState !== false;
    let states: ComponentStates = fromLive
      ? structuredClone(entry.state.componentStates)
      : seedStates(entry.model);

    // Apply modifications to a scenario-local model clone (config) and the
    // forked states (state) — the registered model must stay pristine.
    const model: ProcessModel = structuredClone(entry.model);
    for (const mod of scenario.modifications) {
      this.assertSafeRecordKey(mod.parameter, 'Scenario parameter');
      if (!Number.isFinite(mod.value)) {
        throw new Error(
          `Scenario parameter "${mod.componentId}.${mod.parameter}" must be finite`
        );
      }
      const component = model.components.find((c) => c.id === mod.componentId);
      if (!component) {
        throw new Error(`Modification targets unknown component "${mod.componentId}"`);
      }
      if (mod.target === 'state') {
        const componentState = states[mod.componentId];
        if (!componentState || !Object.hasOwn(componentState, mod.parameter)) {
          throw new Error(
            `State parameter "${mod.componentId}.${mod.parameter}" does not exist`
          );
        }
        states[mod.componentId] = { ...componentState, [mod.parameter]: mod.value };
      } else {
        if (!Object.hasOwn(component.config, mod.parameter)) {
          throw new Error(
            `Config parameter "${mod.componentId}.${mod.parameter}" does not exist`
          );
        }
        component.config[mod.parameter] = mod.value;
      }
    }

    this.validateModel(model);
    const stepFn = getStepFunction(model.stepFunction);
    const predictions: Record<string, number[]> = {};
    for (const binding of model.tagBindings) {
      predictions[binding.tagId] = [];
    }

    for (let tick = 0; tick < scenario.durationTicks; tick++) {
      states = stepFn(structuredClone(model), states, model.timeStepMs, warnings);
      this.assertValidStates(model, states);
      if (this.capWarnings(warnings)) warningsTruncated = true;
      for (const binding of model.tagBindings) {
        const predicted = states[binding.componentId]?.[binding.parameter];
        if (typeof predicted !== 'number' || !Number.isFinite(predicted)) {
          throw new Error(
            `Non-finite prediction at "${binding.componentId}.${binding.parameter}"`
          );
        }
        predictions[binding.tagId].push(predicted);
      }
    }

    return {
      scenarioId: scenario.id,
      baseModelId: scenario.baseModelId,
      ticks: scenario.durationTicks,
      predictions,
      finalState: states,
      warnings: [
        ...new Set(warnings),
        ...(warningsTruncated ? ['additional simulation warnings omitted'] : []),
      ],
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
    if (applied.length < 1 || applied.length > 100) {
      throw new Error('rollback must contain 1..100 modifications');
    }
    const restoredValues: ScenarioModification[] = [];
    for (const mod of applied) {
      this.assertSafeRecordKey(mod.parameter, 'Rollback parameter');
      const component = entry.model.components.find((c) => c.id === mod.componentId);
      if (!component) {
        throw new Error(`Rollback targets unknown component "${mod.componentId}"`);
      }
      const original =
        mod.target === 'state'
          ? component.initialState[mod.parameter]
          : component.config[mod.parameter];
      if (original === undefined) {
        const target = mod.target === 'state' ? 'State' : 'Config';
        throw new Error(
          `${target} parameter "${mod.componentId}.${mod.parameter}" cannot be restored`
        );
      }
      restoredValues.push({ ...mod, value: original });
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
        divergence = Math.abs(predicted / scale - actual / scale);
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

  private modelWorkFactor(model: ProcessModel): number {
    const connections = model.components.reduce(
      (total, component) => total + component.connections.length,
      0
    );
    const parameters = model.components.reduce(
      (total, component) => (
        total
        + Object.keys(component.config).length
        + Object.keys(component.initialState).length
      ),
      0
    );
    return (
      1
      + model.components.length
      + model.tagBindings.length
      + connections
      + parameters
    );
  }

  private capWarnings(warnings: string[]): boolean {
    const maxWarnings = 1_000;
    if (warnings.length <= maxWarnings) return false;
    warnings.splice(maxWarnings);
    return true;
  }

  private assertSafeRecordKey(value: string, label: string): void {
    if (value === '__proto__' || value === 'prototype' || value === 'constructor') {
      throw new Error(`${label} "${value}" is not allowed`);
    }
  }

  private assertValidStates(model: ProcessModel, states: ComponentStates): void {
    if (!states || typeof states !== 'object' || Array.isArray(states)) {
      throw new Error('Simulation state must be a component-state record');
    }
    const expectedComponentIds = new Set(
      model.components.map((component) => component.id)
    );
    for (const componentId of Object.keys(states)) {
      if (!expectedComponentIds.has(componentId)) {
        throw new Error(`Unexpected simulation component state "${componentId}"`);
      }
    }
    for (const component of model.components) {
      if (!Object.hasOwn(states, component.id)) {
        throw new Error(`Missing simulation state for component "${component.id}"`);
      }
      const state = states[component.id];
      if (
        !state
        || typeof state !== 'object'
        || Array.isArray(state)
        || (
          Object.getPrototypeOf(state) !== Object.prototype
          && Object.getPrototypeOf(state) !== null
        )
      ) {
        throw new Error(`Simulation state for component "${component.id}" must be a plain record`);
      }
      if (Object.keys(state).length > MAX_RUNTIME_STATE_FIELDS) {
        throw new Error(
          `Simulation state for component "${component.id}" may contain at most `
          + `${MAX_RUNTIME_STATE_FIELDS} fields`
        );
      }
      for (const [parameter, value] of Object.entries(state)) {
        this.assertSafeRecordKey(parameter, `Simulation parameter for "${component.id}"`);
        if (parameter.length < 1 || parameter.length > 64) {
          throw new Error(
            `Simulation parameter names for "${component.id}" must contain 1..64 characters`
          );
        }
        if (!Number.isFinite(value)) {
          throw new Error(
            `Non-finite simulation state at "${component.id}.${parameter}"`
          );
        }
      }
    }
    for (const binding of model.tagBindings) {
      if (!Object.hasOwn(states[binding.componentId], binding.parameter)) {
        throw new Error(
          `Missing bound simulation parameter "${binding.componentId}.${binding.parameter}"`
        );
      }
    }
  }

  private validateModel(model: ProcessModel): void {
    getStepFunction(model.stepFunction); // throws on unknown solver
    if (model.id.length < 1 || model.id.length > 128) {
      throw new Error('model id must contain 1..128 characters');
    }
    if (
      !Number.isFinite(model.timeStepMs)
      || model.timeStepMs < 10
      || model.timeStepMs > 3_600_000
    ) {
      throw new Error('timeStepMs must be a finite integer from 10 to 3600000');
    }
    if (!Number.isInteger(model.timeStepMs)) {
      throw new Error('timeStepMs must be a finite integer from 10 to 3600000');
    }
    if (model.components.length < 1 || model.components.length > 500) {
      throw new Error('models must contain 1..500 components');
    }
    if (model.tagBindings.length > 1_000) {
      throw new Error('models must contain at most 1000 tag bindings');
    }
    const ids = new Set<string>();
    for (const comp of model.components) {
      this.assertSafeRecordKey(comp.id, 'Component id');
      if (comp.id.length < 1 || comp.id.length > 128) {
        throw new Error('component ids must contain 1..128 characters');
      }
      if (ids.has(comp.id)) throw new Error(`Duplicate component id "${comp.id}"`);
      ids.add(comp.id);
      if (comp.connections.length > 64) {
        throw new Error(`Component "${comp.id}" may contain at most 64 connections`);
      }
      if (
        Object.keys(comp.config).length > MAX_AUTHORED_PARAMETER_FIELDS
        || Object.keys(comp.initialState).length > MAX_AUTHORED_PARAMETER_FIELDS
      ) {
        throw new Error(
          `Component "${comp.id}" parameter records may contain at most `
          + `${MAX_AUTHORED_PARAMETER_FIELDS} fields`
        );
      }
      for (const [parameter, value] of [
        ...Object.entries(comp.config),
        ...Object.entries(comp.initialState),
      ]) {
        this.assertSafeRecordKey(parameter, `Component "${comp.id}" parameter`);
        if (parameter.length < 1 || parameter.length > 64) {
          throw new Error(
            `Component "${comp.id}" parameter names must contain 1..64 characters`
          );
        }
        if (!Number.isFinite(value)) {
          throw new Error(
            `Component "${comp.id}" parameter "${parameter}" must be finite`
          );
        }
      }
      if (comp.type === 'tank') {
        const capacity = comp.config.capacity;
        if (capacity !== undefined && capacity <= 0) {
          throw new Error(`Tank "${comp.id}" capacity must be positive`);
        }
        const outflow = comp.config.outflow;
        if (outflow !== undefined && outflow < 0) {
          throw new Error(`Tank "${comp.id}" outflow must not be negative`);
        }
      }
      if (comp.type === 'valve' || comp.type === 'pump') {
        const maxFlow = comp.config.maxFlow;
        if (maxFlow !== undefined && maxFlow < 0) {
          throw new Error(`${comp.type} "${comp.id}" maxFlow must not be negative`);
        }
      }
      if (comp.type === 'heater') {
        const heatRate = comp.config.heatRate;
        const lossRate = comp.config.lossRate;
        if (heatRate !== undefined && heatRate < 0) {
          throw new Error(`Heater "${comp.id}" heatRate must not be negative`);
        }
        if (lossRate !== undefined && lossRate < 0) {
          throw new Error(`Heater "${comp.id}" lossRate must not be negative`);
        }
      }
    }
    const componentsById = new Map(
      model.components.map((component) => [component.id, component])
    );
    for (const comp of model.components) {
      const connectionTargets = new Set<string>();
      for (const target of comp.connections) {
        if (connectionTargets.has(target)) {
          throw new Error(
            `Component "${comp.id}" contains duplicate connection "${target}"`
          );
        }
        connectionTargets.add(target);
        if (!ids.has(target)) {
          throw new Error(`Component "${comp.id}" connects to unknown component "${target}"`);
        }
        if (model.stepFunction === 'basic-flow') {
          const targetComponent = componentsById.get(target)!;
          const supported = (
            comp.type === 'controller'
              ? targetComponent.type === 'valve' || targetComponent.type === 'pump'
              : (
                comp.type === 'valve'
                || comp.type === 'pump'
                || comp.type === 'pipe'
              )
                ? targetComponent.type === 'tank' || targetComponent.type === 'pipe'
                : false
          );
          if (!supported) {
            throw new Error(
              `basic-flow does not support connection "${comp.id}" (${comp.type}) -> `
              + `"${target}" (${targetComponent.type})`
            );
          }
        }
      }
      if (comp.pvSource && !ids.has(comp.pvSource)) {
        throw new Error(`Controller "${comp.id}" pvSource "${comp.pvSource}" does not exist`);
      }
      if (comp.pvSource && model.stepFunction === 'basic-flow') {
        if (comp.type !== 'controller') {
          throw new Error(`basic-flow pvSource is only valid on controller "${comp.id}"`);
        }
        const source = componentsById.get(comp.pvSource)!;
        if (source.type !== 'tank' && source.type !== 'heater') {
          throw new Error(
            `basic-flow controller "${comp.id}" pvSource must be a tank or heater`
          );
        }
      }
    }
    const tagIds = new Set<string>();
    const bindingTargets = new Set<string>();
    const stateFieldsByComponent = new Map(
      model.components.map((component) => [
        component.id,
        new Set(Object.keys(component.initialState)),
      ])
    );
    for (const binding of model.tagBindings) {
      this.assertSafeRecordKey(binding.tagId, 'Tag id');
      this.assertSafeRecordKey(binding.parameter, `Tag "${binding.tagId}" parameter`);
      if (binding.tagId.length < 1 || binding.tagId.length > 256) {
        throw new Error('tag ids must contain 1..256 characters');
      }
      if (binding.parameter.length < 1 || binding.parameter.length > 64) {
        throw new Error(`Tag "${binding.tagId}" parameters must contain 1..64 characters`);
      }
      if (tagIds.has(binding.tagId)) {
        throw new Error(`Duplicate tag binding "${binding.tagId}"`);
      }
      tagIds.add(binding.tagId);
      const bindingTarget = JSON.stringify([binding.componentId, binding.parameter]);
      if (bindingTargets.has(bindingTarget)) {
        throw new Error(
          `Duplicate tag-binding target "${binding.componentId}.${binding.parameter}"`
        );
      }
      bindingTargets.add(bindingTarget);
      if (!ids.has(binding.componentId)) {
        throw new Error(`Tag binding "${binding.tagId}" references unknown component`);
      }
      const stateFields = stateFieldsByComponent.get(binding.componentId)!;
      stateFields.add(binding.parameter);
      if (stateFields.size > MAX_AUTHORED_PARAMETER_FIELDS) {
        throw new Error(
          `Component "${binding.componentId}" initial and bound state may contain at most `
          + `${MAX_AUTHORED_PARAMETER_FIELDS} fields`
        );
      }
    }

    if (model.stepFunction === 'basic-flow') {
      const pipeIds = new Set(
        model.components
          .filter((component) => component.type === 'pipe')
          .map((component) => component.id)
      );
      const pipeIndegree = new Map<string, number>(
        [...pipeIds].map((pipeId) => [pipeId, 0])
      );
      for (const component of model.components) {
        if (component.type !== 'pipe') continue;
        for (const target of component.connections) {
          if (pipeIds.has(target)) {
            pipeIndegree.set(target, (pipeIndegree.get(target) ?? 0) + 1);
          }
        }
      }
      const queue = [...pipeIndegree.entries()]
        .filter(([, degree]) => degree === 0)
        .map(([pipeId]) => pipeId);
      let visitedPipes = 0;
      while (queue.length > 0) {
        const pipeId = queue.shift()!;
        visitedPipes++;
        const pipe = componentsById.get(pipeId)!;
        for (const target of pipe.connections) {
          if (!pipeIds.has(target)) continue;
          const degree = (pipeIndegree.get(target) ?? 0) - 1;
          pipeIndegree.set(target, degree);
          if (degree === 0) queue.push(target);
        }
      }
      if (visitedPipes !== pipeIds.size) {
        throw new Error('Pipe flow graph must not contain a cycle');
      }
    }
  }
}
