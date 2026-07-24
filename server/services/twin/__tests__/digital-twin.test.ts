/**
 * Digital Twin Runtime tests
 * ADR-0013 [13.3] — Issue #214
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProcessModel } from '@shared/types/digital-twin';
import { TwinRuntime } from '../engine';
import { DigitalTwinService, registerStepFunction, listStepFunctions } from '../index';
import { TagStreamServer } from '../../../websocket/tag-stream';

/** Valve (maxFlow 10, position 50 → flow 5) feeding a tank draining at 2 */
function valveTankModel(overrides: Partial<ProcessModel> = {}): ProcessModel {
  return {
    id: 'm1',
    name: 'valve-tank',
    components: [
      {
        id: 'valve-1',
        type: 'valve',
        name: 'Feed valve',
        config: { maxFlow: 10 },
        initialState: { position: 50 },
        connections: ['tank-1'],
      },
      {
        id: 'tank-1',
        type: 'tank',
        name: 'Buffer tank',
        // capacity deliberately declared before level — predictions must
        // come from tag bindings, never from property order
        config: { capacity: 100, outflow: 2 },
        initialState: { level: 20 },
        connections: [],
      },
    ],
    tagBindings: [{ tagId: 'TK-1.LEVEL', componentId: 'tank-1', parameter: 'level' }],
    stepFunction: 'basic-flow',
    timeStepMs: 1000,
    ...overrides,
  };
}

describe('basic-flow solver', () => {
  it('fills the tank linearly — inflow is recomputed each tick, never accumulated', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());

    // flow 5 in, 2 out → +3/tick, strictly linear (the Wave-2 twin grew
    // quadratically because inflow accumulated across ticks)
    const levels: number[] = [];
    for (let i = 0; i < 5; i++) {
      const state = runtime.step('m1');
      levels.push(state.componentStates['tank-1'].level);
    }
    expect(levels).toEqual([23, 26, 29, 32, 35]);
  });

  it('propagates multi-hop pipe flow independent of component order', () => {
    const components: ProcessModel['components'] = [
      {
        id: 'valve',
        type: 'valve',
        name: 'Valve',
        config: { maxFlow: 10 },
        initialState: { position: 100 },
        connections: ['pipe-1'],
      },
      {
        id: 'pipe-1',
        type: 'pipe',
        name: 'Pipe 1',
        config: {},
        initialState: {},
        connections: ['pipe-2'],
      },
      {
        id: 'pipe-2',
        type: 'pipe',
        name: 'Pipe 2',
        config: {},
        initialState: {},
        connections: ['tank'],
      },
      {
        id: 'tank',
        type: 'tank',
        name: 'Tank',
        config: { capacity: 100 },
        initialState: { level: 0 },
        connections: [],
      },
    ];

    for (const order of [
      ['valve', 'pipe-1', 'pipe-2', 'tank'],
      ['tank', 'pipe-2', 'pipe-1', 'valve'],
      ['pipe-2', 'valve', 'tank', 'pipe-1'],
    ]) {
      const runtime = new TwinRuntime();
      runtime.registerModel({
        id: `pipes-${order.join('-')}`,
        name: 'ordered pipes',
        components: order.map((id) => components.find((component) => component.id === id)!),
        tagBindings: [],
        stepFunction: 'basic-flow',
        timeStepMs: 1000,
      });

      const state = runtime.step(`pipes-${order.join('-')}`);
      expect(state.componentStates.tank.level).toBe(10);
    }
  });

  it('sums fan-in from multiple sources before propagating through a pipe', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel({
      id: 'fan-in',
      name: 'fan-in',
      components: [
        {
          id: 'pipe',
          type: 'pipe',
          name: 'Pipe',
          config: {},
          initialState: {},
          connections: ['tank'],
        },
        {
          id: 'tank',
          type: 'tank',
          name: 'Tank',
          config: { capacity: 100 },
          initialState: { level: 0 },
          connections: [],
        },
        {
          id: 'valve-a',
          type: 'valve',
          name: 'Valve A',
          config: { maxFlow: 4 },
          initialState: { position: 100 },
          connections: ['pipe'],
        },
        {
          id: 'valve-b',
          type: 'valve',
          name: 'Valve B',
          config: { maxFlow: 6 },
          initialState: { position: 100 },
          connections: ['pipe'],
        },
      ],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });

    expect(runtime.step('fan-in').componentStates.tank.level).toBe(10);
  });

  it('clamps tank level at capacity and warns', () => {
    const runtime = new TwinRuntime();
    const warnings = vi.fn();
    runtime.on('model-warnings', warnings);
    runtime.registerModel(valveTankModel());
    runtime.step('m1', 60); // +3/tick from 20 → hits capacity 100 within 27 ticks

    const state = runtime.getState('m1')!;
    expect(state.componentStates['tank-1'].level).toBe(100);
    expect(warnings).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: expect.arrayContaining([expect.stringContaining('capacity')]),
      })
    );
  });

  it('a P-controller drives its valve to hold the tank at setpoint', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel({
      id: 'ctl',
      name: 'level control',
      components: [
        {
          id: 'lc-1',
          type: 'controller',
          name: 'Level controller',
          config: { kp: 5, setpoint: 50 },
          initialState: {},
          connections: ['valve-1'],
          pvSource: 'tank-1',
        },
        {
          id: 'valve-1',
          type: 'valve',
          name: 'Feed valve',
          config: { maxFlow: 10 },
          initialState: { position: 0 },
          connections: ['tank-1'],
        },
        {
          id: 'tank-1',
          type: 'tank',
          name: 'Tank',
          config: { capacity: 100, outflow: 3 },
          initialState: { level: 10 },
          connections: [],
        },
      ],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });

    runtime.step('ctl', 200);
    const level = runtime.getState('ctl')!.componentStates['tank-1'].level;
    // P-control steady state: flow == outflow → 50 − outflow/(kp·maxFlow/100)
    // = 50 − 3/0.5 = 44 (the classic proportional-only offset)
    expect(level).toBeCloseTo(44, 1);
  });

  it('heater temperature rises with power and settles toward equilibrium', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel({
      id: 'h',
      name: 'heater',
      components: [
        {
          id: 'htr-1',
          type: 'heater',
          name: 'Heater',
          config: { power: 5, heatRate: 0.5, ambient: 20, lossRate: 0.05 },
          initialState: { temperature: 20 },
          connections: [],
        },
      ],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });
    runtime.step('h', 200);
    // Equilibrium: power*heatRate/lossRate + ambient = 2.5/0.05 + 20 = 70
    const temp = runtime.getState('h')!.componentStates['htr-1'].temperature;
    expect(temp).toBeGreaterThan(60);
    expect(temp).toBeLessThanOrEqual(70.5);
  });
});

describe('model validation', () => {
  it('keeps registered state private from returned snapshots', () => {
    const runtime = new TwinRuntime();
    const registered = runtime.registerModel(valveTankModel());
    registered.componentStates['tank-1'].level = Number.POSITIVE_INFINITY;
    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(20);

    const snapshot = runtime.getState('m1')!;
    snapshot.componentStates['tank-1'].level = -100;
    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(20);
  });

  it('rejects unknown step functions at registration, not silently at step time', () => {
    const runtime = new TwinRuntime();
    expect(() =>
      runtime.registerModel(valveTankModel({ stepFunction: 'no-such-solver' }))
    ).toThrow(/Unknown step function/);
  });

  it('rejects duplicate component ids and dangling connections', () => {
    const runtime = new TwinRuntime();
    const model = valveTankModel();
    model.components[0].connections = ['ghost'];
    expect(() => runtime.registerModel(model)).toThrow(/unknown component "ghost"/);

    const dup = valveTankModel();
    dup.components[1].id = 'valve-1';
    expect(() => runtime.registerModel(dup)).toThrow(/Duplicate/);

    const duplicateDirectEdge = valveTankModel();
    duplicateDirectEdge.components[0].connections = ['tank-1', 'tank-1'];
    expect(() => runtime.registerModel(duplicateDirectEdge)).toThrow(/duplicate connection/i);

    const duplicatePipeEdge = valveTankModel();
    duplicatePipeEdge.components[0].connections = ['pipe'];
    duplicatePipeEdge.components.splice(1, 0, {
      id: 'pipe',
      type: 'pipe',
      name: 'Pipe',
      config: {},
      initialState: {},
      connections: ['tank-1', 'tank-1'],
    });
    expect(() => runtime.registerModel(duplicatePipeEdge)).toThrow(/duplicate connection/i);
  });

  it('rejects topology that the basic-flow solver would silently ignore', () => {
    const runtime = new TwinRuntime();
    const tankToValve = valveTankModel();
    tankToValve.components[1].connections = ['valve-1'];
    expect(() => runtime.registerModel(tankToValve)).toThrow(/basic-flow does not support/);

    const controllerToTank = valveTankModel();
    controllerToTank.components.unshift({
      id: 'controller',
      type: 'controller',
      name: 'Controller',
      config: { kp: 1, setpoint: 50 },
      initialState: {},
      connections: ['tank-1'],
      pvSource: 'tank-1',
    });
    expect(() => runtime.registerModel(controllerToTank)).toThrow(
      /basic-flow does not support/
    );

    const invalidPvSource = valveTankModel();
    invalidPvSource.components.unshift(
      {
        id: 'controller',
        type: 'controller',
        name: 'Controller',
        config: { kp: 1, setpoint: 50 },
        initialState: {},
        connections: ['valve-1'],
        pvSource: 'sensor',
      },
      {
        id: 'sensor',
        type: 'sensor',
        name: 'Sensor',
        config: {},
        initialState: { value: 50 },
        connections: [],
      },
    );
    expect(() => runtime.registerModel(invalidPvSource)).toThrow(
      /pvSource must be a tank or heater/
    );
  });

  it('rejects pipe cycles and non-finite authored parameters', () => {
    const runtime = new TwinRuntime();
    const cyclic = valveTankModel();
    cyclic.components.splice(1, 0,
      {
        id: 'pipe-1',
        type: 'pipe',
        name: 'Pipe 1',
        config: {},
        initialState: {},
        connections: ['pipe-2'],
      },
      {
        id: 'pipe-2',
        type: 'pipe',
        name: 'Pipe 2',
        config: {},
        initialState: {},
        connections: ['pipe-1'],
      },
    );
    expect(() => runtime.registerModel(cyclic)).toThrow(/pipe flow graph.*cycle/i);

    const nonFinite = valveTankModel();
    nonFinite.components[0].config.maxFlow = Number.NaN;
    expect(() => runtime.registerModel(nonFinite)).toThrow(/must be finite/);

    const negativeCapacity = valveTankModel();
    negativeCapacity.components[1].config.capacity = -10;
    expect(() => runtime.registerModel(negativeCapacity)).toThrow(/capacity must be positive/);
  });

  it('allows cyclic topology for a custom solver that owns those semantics', () => {
    registerStepFunction('cycle-aware', (_model, states) => states);
    const runtime = new TwinRuntime();
    expect(() => runtime.registerModel({
      id: 'custom-cycle',
      name: 'custom cycle',
      components: [
        {
          id: 'pipe-1',
          type: 'pipe',
          name: 'Pipe 1',
          config: {},
          initialState: {},
          connections: ['pipe-2'],
        },
        {
          id: 'pipe-2',
          type: 'pipe',
          name: 'Pipe 2',
          config: {},
          initialState: {},
          connections: ['pipe-1'],
        },
      ],
      tagBindings: [],
      stepFunction: 'cycle-aware',
      timeStepMs: 1000,
    })).not.toThrow();
  });

  it('rejects ambiguous duplicate tag bindings', () => {
    const runtime = new TwinRuntime();
    const model = valveTankModel();
    model.tagBindings.push({
      tagId: 'TK-1.LEVEL',
      componentId: 'valve-1',
      parameter: 'position',
    });
    expect(() => runtime.registerModel(model)).toThrow(/duplicate tag binding/i);

    const duplicateTarget = valveTankModel();
    duplicateTarget.tagBindings.push({
      tagId: 'TK-1.LEVEL.BACKUP',
      componentId: 'tank-1',
      parameter: 'level',
    });
    expect(() => runtime.registerModel(duplicateTarget)).toThrow(/duplicate tag-binding target/i);
  });

  it('rejects record keys that would corrupt plain-object state or predictions', () => {
    const runtime = new TwinRuntime();
    const unsafeComponent = valveTankModel();
    unsafeComponent.components[0].id = '__proto__';
    unsafeComponent.components[0].connections = [];
    expect(() => runtime.registerModel(unsafeComponent)).toThrow(/component id.*not allowed/i);

    const unsafeTag = valveTankModel();
    unsafeTag.tagBindings[0].tagId = '__proto__';
    expect(() => runtime.registerModel(unsafeTag)).toThrow(/tag id.*not allowed/i);
  });

  it('bounds wide component records and counts their fields as simulation work', () => {
    const tooWide = valveTankModel();
    tooWide.components[0].initialState = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`field-${index}`, index])
    );
    expect(() => new TwinRuntime().registerModel(tooWide)).toThrow(/at most 128 fields/);

    const longKey = valveTankModel();
    longKey.components[0].initialState = { ['x'.repeat(65)]: 1 };
    expect(() => new TwinRuntime().registerModel(longKey)).toThrow(/1\.\.64 characters/);

    const wideButValid = valveTankModel();
    wideButValid.components[0].initialState = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field-${index}`, index])
    );
    const runtime = new TwinRuntime({ maxScenarioWorkUnits: 100 });
    runtime.registerModel(wideButValid);
    expect(() => runtime.runScenario({
      id: 'wide',
      name: 'wide',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: 1,
    })).toThrow(/synchronous work limit/);
  });

  it('reserves runtime-state headroom for solver-derived fields', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel({
      id: 'wide-valve',
      name: 'wide valve',
      components: [{
        id: 'valve',
        type: 'valve',
        name: 'Valve',
        config: { maxFlow: 10 },
        initialState: Object.fromEntries(
          Array.from({ length: 128 }, (_, index) => [`field-${index}`, index])
        ),
        connections: [],
      }],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });

    const state = runtime.step('wide-valve');
    expect(state.status).not.toBe('error');
    expect(state.componentStates.valve.currentFlow).toBe(0);
    expect(Object.keys(state.componentStates.valve)).toHaveLength(130);
  });

  it('bounds the union of authored and tag-bound state fields per component', () => {
    const model: ProcessModel = {
      id: 'bound-fields',
      name: 'bound fields',
      components: [{
        id: 'sensor',
        type: 'sensor',
        name: 'Sensor',
        config: {},
        initialState: {},
        connections: [],
      }],
      tagBindings: Array.from({ length: 129 }, (_, index) => ({
        tagId: `SENSOR.P${index}`,
        componentId: 'sensor',
        parameter: `p${index}`,
      })),
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    };
    expect(() => new TwinRuntime().registerModel(model)).toThrow(
      /initial and bound state may contain at most 128 fields/
    );

    model.tagBindings.pop();
    const runtime = new TwinRuntime();
    runtime.registerModel(model);
    for (let index = 0; index < 128; index++) {
      runtime.ingestActual(`SENSOR.P${index}`, index, 1000);
    }
    runtime.syncFromLive('bound-fields', 2000);
    const state = runtime.step('bound-fields');
    expect(state.status).not.toBe('error');
    expect(Object.keys(state.componentStates.sensor)).toHaveLength(128);
  });

  it('fails the model closed when a solver derives non-finite state', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel({
      id: 'overflow',
      name: 'overflowing heater',
      components: [{
        id: 'heater',
        type: 'heater',
        name: 'Heater',
        config: {
          power: Number.MAX_VALUE,
          heatRate: 2,
          ambient: 20,
          lossRate: 0,
        },
        initialState: { temperature: 20 },
        connections: [],
      }],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });

    const state = runtime.step('overflow');
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/non-finite simulation state/i);
    expect(state.componentStates.heater.temperature).toBe(20);
  });

  it('does not expose live state to a mutating custom solver before validation', () => {
    registerStepFunction('mutating-overflow', (_model, states) => {
      states['tank-1'].level = Number.POSITIVE_INFINITY;
      return states;
    });
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel({ stepFunction: 'mutating-overflow' }));

    const state = runtime.step('m1');
    expect(state.status).toBe('error');
    expect(state.componentStates['tank-1'].level).toBe(20);
  });

  it('rejects custom solver output that omits registered component state', () => {
    registerStepFunction('empty-state', () => ({}));
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel({ stepFunction: 'empty-state' }));

    const state = runtime.step('m1');
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/missing simulation state for component/i);
    expect(state.componentStates['tank-1'].level).toBe(20);
  });

  it('does not expose the registered model to a mutating custom solver', () => {
    registerStepFunction('mutating-model', (model, states) => {
      model.components[1].config.capacity = -10;
      model.components[0].connections.length = 0;
      return states;
    });
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel({ stepFunction: 'mutating-model' }));

    runtime.step('m1');
    const model = runtime.getModel('m1')!;
    expect(model.components[1].config.capacity).toBe(100);
    expect(model.components[0].connections).toEqual(['tank-1']);
  });

  it('marks the model errored when a custom solver throws mid-run', () => {
    registerStepFunction('exploding', () => {
      throw new Error('numerical instability');
    });
    const runtime = new TwinRuntime();
    const onError = vi.fn();
    runtime.on('model-error', onError);
    runtime.registerModel(valveTankModel({ stepFunction: 'exploding' }));

    const state = runtime.step('m1');
    expect(state.status).toBe('error');
    expect(state.error).toMatch(/instability/);
    expect(onError).toHaveBeenCalled();
    expect(listStepFunctions()).toContain('basic-flow');
  });
});

describe('live assimilation and what-if', () => {
  it('does not let an older sensor sample overwrite a newer one', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    runtime.syncFromLive('m1', 500);
    expect(runtime.getState('m1')!.lastSyncAt).toBeUndefined();

    runtime.ingestActual('TK-1.LEVEL', 90, 2000);
    runtime.ingestActual('TK-1.LEVEL', 10, 1000);
    runtime.syncFromLive('m1', 3000);

    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(90);
    expect(runtime.getState('m1')!.lastSyncAt).toBe(3000);

    runtime.step('m1');
    runtime.syncFromLive('m1', 9000);
    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(93);
    expect(runtime.getState('m1')!.lastSyncAt).toBe(3000);

    runtime.resetModel('m1');
    runtime.syncFromLive('m1', 10_000);
    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(90);
    expect(runtime.getState('m1')!.lastSyncAt).toBe(10_000);
  });

  it('predictions read the bound parameter, not the first state property', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    const result = runtime.runScenario({
      id: 's1',
      name: 'baseline',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: 3,
      fromLiveState: false,
    });
    // level (bound) rises 23, 26, 29 — capacity (first-declared config key)
    // would have been 100
    expect(result.predictions['TK-1.LEVEL']).toEqual([23, 26, 29]);
  });

  it('what-if forks from the live-synced state by default', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    // Live plant reports the tank at 80, not the authored initial 20
    runtime.ingestActual('TK-1.LEVEL', 80, 1000);
    runtime.syncFromLive('m1', 1000);

    const result = runtime.runScenario({
      id: 's2',
      name: 'close the valve',
      baseModelId: 'm1',
      modifications: [{ componentId: 'valve-1', parameter: 'position', value: 0, target: 'state' }],
      durationTicks: 3,
    });
    // From live level 80 with valve shut: only outflow 2 → 78, 76, 74
    expect(result.predictions['TK-1.LEVEL']).toEqual([78, 76, 74]);
  });

  it('scenario runs never mutate the live model or state', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    runtime.step('m1', 2); // live level 26

    runtime.runScenario({
      id: 's3',
      name: 'wide open',
      baseModelId: 'm1',
      modifications: [
        { componentId: 'valve-1', parameter: 'maxFlow', value: 1000 },
        { componentId: 'valve-1', parameter: 'position', value: 100, target: 'state' },
      ],
      durationTicks: 10,
    });

    expect(runtime.getState('m1')!.componentStates['tank-1'].level).toBe(26);
    expect(runtime.getModel('m1')!.components[0].config.maxFlow).toBe(10);
  });

  it('rejects unknown scenario fields instead of silently running a no-op', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());

    expect(() => runtime.runScenario({
      id: 'typo',
      name: 'typo',
      baseModelId: 'm1',
      modifications: [{
        componentId: 'valve-1',
        parameter: 'positoin',
        value: 0,
        target: 'state',
      }],
      durationTicks: 1,
    })).toThrow(/does not exist/);
    expect(runtime.getState('m1')!.componentStates['valve-1'].position).toBe(50);
  });

  it('rejects a scenario whose binding cannot produce a finite prediction', () => {
    const runtime = new TwinRuntime();
    const model = valveTankModel();
    model.tagBindings = [{
      tagId: 'TK-1.MISSING',
      componentId: 'tank-1',
      parameter: 'missing',
    }];
    runtime.registerModel(model);

    expect(() => runtime.runScenario({
      id: 'missing-binding',
      name: 'missing binding',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: 1,
    })).toThrow(/missing bound simulation parameter|non-finite prediction/i);
  });

  it('revalidates semantic model invariants after scenario config changes', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    for (const modification of [
      { componentId: 'tank-1', parameter: 'capacity', value: 0 },
      { componentId: 'tank-1', parameter: 'outflow', value: -1 },
      { componentId: 'valve-1', parameter: 'maxFlow', value: -1 },
    ]) {
      expect(() => runtime.runScenario({
        id: `invalid-${modification.parameter}`,
        name: 'invalid config',
        baseModelId: 'm1',
        modifications: [modification],
        durationTicks: 1,
      })).toThrow();
    }

    runtime.registerModel({
      id: 'scenario-heater',
      name: 'scenario heater',
      components: [{
        id: 'heater',
        type: 'heater',
        name: 'Heater',
        config: { power: 5, heatRate: 2, ambient: 20, lossRate: 0.1 },
        initialState: { temperature: 20 },
        connections: [],
      }],
      tagBindings: [{
        tagId: 'HEATER.TEMP',
        componentId: 'heater',
        parameter: 'temperature',
      }],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });
    for (const modification of [
      { componentId: 'heater', parameter: 'heatRate', value: -1 },
      { componentId: 'heater', parameter: 'lossRate', value: -1 },
    ]) {
      expect(() => runtime.runScenario({
        id: `invalid-${modification.parameter}`,
        name: 'invalid heater config',
        baseModelId: 'scenario-heater',
        modifications: [modification],
        durationTicks: 1,
      })).toThrow();
    }
    expect(() => runtime.runScenario({
      id: 'overflow',
      name: 'overflow',
      baseModelId: 'scenario-heater',
      modifications: [{ componentId: 'heater', parameter: 'power', value: Number.MAX_VALUE }],
      durationTicks: 1,
    })).toThrow(/non-finite simulation state/i);
  });

  it('keeps scenario model validation independent from custom-solver mutation', () => {
    registerStepFunction('mutating-scenario-model', (model) => {
      model.components.length = 0;
      return {};
    });
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel({ stepFunction: 'mutating-scenario-model' }));

    expect(() => runtime.runScenario({
      id: 'mutating-model',
      name: 'mutating model',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: 1,
    })).toThrow(/missing simulation state for component/i);
    expect(runtime.getModel('m1')!.components).toHaveLength(2);
  });

  it('bounds synchronous scenario work by model complexity', () => {
    const runtime = new TwinRuntime({ maxScenarioWorkUnits: 100 });
    runtime.registerModel(valveTankModel());

    expect(() => runtime.runScenario({
      id: 'too-expensive',
      name: 'too expensive',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: 21,
    })).toThrow(/synchronous work limit/);
  });

  it('rejects non-integer and non-finite scenario durations at the engine boundary', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    const scenario = {
      id: 'bad-duration',
      name: 'bad duration',
      baseModelId: 'm1',
      modifications: [],
      durationTicks: Number.NaN,
    };
    expect(() => runtime.runScenario(scenario)).toThrow(/must be an integer/);
    expect(() => runtime.runScenario({ ...scenario, durationTicks: 1.5 })).toThrow(
      /must be an integer/
    );
  });

  it('bounds manual stepping and caps repeated solver warnings', () => {
    const runtime = new TwinRuntime({
      maxStepWorkUnits: 100,
      maxScenarioWorkUnits: 10_000,
    });
    runtime.registerModel(valveTankModel());
    expect(() => runtime.step('m1', 21)).toThrow(/synchronous work limit/);

    runtime.registerModel({
      id: 'warning-model',
      name: 'warning model',
      components: [{
        id: 'tank',
        type: 'tank',
        name: 'Full tank',
        config: { capacity: 1 },
        initialState: { level: 1 },
        connections: [],
      }],
      tagBindings: [],
      stepFunction: 'basic-flow',
      timeStepMs: 1000,
    });
    const result = runtime.runScenario({
      id: 'warnings',
      name: 'warnings',
      baseModelId: 'warning-model',
      modifications: [],
      durationTicks: 2_000,
    });
    expect(result.warnings).toContain('additional simulation warnings omitted');
    expect(result.warnings.length).toBeLessThanOrEqual(2);
  });

  it('simulates rollback by restoring registered-model values from live state', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());
    // Operator opened the valve wide (applied change); tank is now at 60
    runtime.ingestActual('TK-1.LEVEL', 60, 1000);
    runtime.syncFromLive('m1', 1000);

    const rollback = runtime.simulateRollback(
      'm1',
      [{ componentId: 'valve-1', parameter: 'position', value: 100, target: 'state' }],
      3
    );
    // Restores position to the authored initialState value (50) → +3/tick
    expect(rollback.restoredValues).toEqual([
      { componentId: 'valve-1', parameter: 'position', value: 50, target: 'state' },
    ]);
    expect(rollback.result.predictions['TK-1.LEVEL']).toEqual([63, 66, 69]);
  });

  it('rejects a rollback atomically when any requested field is not restorable', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel());

    expect(() => runtime.simulateRollback('m1', [
      { componentId: 'valve-1', parameter: 'position', value: 100, target: 'state' },
      { componentId: 'valve-1', parameter: 'positoin', value: 100, target: 'state' },
    ], 1)).toThrow(/cannot be restored/);
  });

  it('compares predicted vs actual with relative divergence', () => {
    const runtime = new TwinRuntime({ divergenceTolerance: 0.05 });
    runtime.registerModel(valveTankModel());
    runtime.step('m1'); // predicted level 23

    runtime.ingestActual('TK-1.LEVEL', 23.5, 2000);
    let [comparison] = runtime.compare('m1');
    expect(comparison.predicted).toBe(23);
    expect(comparison.actual).toBe(23.5);
    expect(comparison.withinTolerance).toBe(true);

    runtime.ingestActual('TK-1.LEVEL', 60, 3000);
    [comparison] = runtime.compare('m1');
    expect(comparison.withinTolerance).toBe(false);
  });

  it('computes finite divergence for opposite extreme finite values', () => {
    const runtime = new TwinRuntime();
    const model = valveTankModel();
    model.components[1].config.capacity = Number.MAX_VALUE;
    model.components[1].initialState.level = Number.MAX_VALUE;
    runtime.registerModel(model);
    runtime.ingestActual('TK-1.LEVEL', -Number.MAX_VALUE, 1000);

    const [comparison] = runtime.compare('m1');
    expect(comparison.divergence).toBe(2);
    expect(Number.isFinite(comparison.divergence)).toBe(true);
  });
});

describe('DigitalTwinService', () => {
  it('schedules running models by each model timeStepMs', () => {
    const runtime = new TwinRuntime();
    runtime.registerModel(valveTankModel({ id: 'fast', timeStepMs: 100 }));
    runtime.registerModel(valveTankModel({ id: 'slow', timeStepMs: 250 }));
    runtime.setRunning('fast', true, 0);
    runtime.setRunning('slow', true, 0);

    runtime.stepRunning(99);
    expect(runtime.getState('fast')!.tick).toBe(0);
    expect(runtime.getState('slow')!.tick).toBe(0);

    runtime.stepRunning(250);
    expect(runtime.getState('fast')!.tick).toBe(2);
    expect(runtime.getState('slow')!.tick).toBe(1);

    runtime.stepRunning(500);
    expect(runtime.getState('fast')!.tick).toBe(5);
    expect(runtime.getState('slow')!.tick).toBe(2);
  });

  it('bounds delayed catch-up and resets the schedule across pause/resume', () => {
    const runtime = new TwinRuntime();
    const warnings = vi.fn();
    runtime.on('model-warnings', warnings);
    runtime.registerModel(valveTankModel({ timeStepMs: 100 }));
    runtime.setRunning('m1', true, 0);

    runtime.stepRunning(1000, 2);
    expect(runtime.getState('m1')!.tick).toBe(2);
    expect(warnings).toHaveBeenCalledWith(expect.objectContaining({
      warnings: expect.arrayContaining([expect.stringMatching(/dropped 8 overdue/)]),
    }));

    runtime.setRunning('m1', false, 1000);
    runtime.stepRunning(5000);
    expect(runtime.getState('m1')!.tick).toBe(2);

    runtime.setRunning('m1', true, 5000);
    runtime.stepRunning(5099);
    expect(runtime.getState('m1')!.tick).toBe(2);
    runtime.stepRunning(5100);
    expect(runtime.getState('m1')!.tick).toBe(3);
  });

  it('stops scheduled stepping on shutdown', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const service = new DigitalTwinService(10);
      service.runtime.registerModel(valveTankModel({ timeStepMs: 10 }));
      service.runtime.setRunning('m1', true, 0);
      await service.initialize();

      await vi.advanceTimersByTimeAsync(25);
      expect(service.runtime.getState('m1')!.tick).toBe(2);
      await service.shutdown();
      await vi.advanceTimersByTimeAsync(100);
      expect(service.runtime.getState('m1')!.tick).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters non-numeric and non-good tag updates', () => {
    const service = new DigitalTwinService();
    service.runtime.registerModel(valveTankModel());

    service.ingestTagUpdate({ tagName: 'TK-1.LEVEL', value: 42, timestamp: 1000, quality: 'bad' });
    service.ingestTagUpdate({ tagName: 'TK-1.LEVEL', value: 'running', timestamp: 2000 });
    service.ingestTagUpdate({ tagName: 'TK-1.LEVEL', value: '', timestamp: 2500 });
    service.runtime.syncFromLive('m1', 3000);
    expect(service.runtime.getState('m1')!.componentStates['tank-1'].level).toBe(20);

    service.ingestTagUpdate({ tagName: 'TK-1.LEVEL', value: '55.5', timestamp: 4000, quality: 'good' });
    service.runtime.syncFromLive('m1', 5000);
    expect(service.runtime.getState('m1')!.componentStates['tank-1'].level).toBe(55.5);
  });

  it('reports health based on initialization', async () => {
    const service = new DigitalTwinService();
    expect((await service.healthCheck()).healthy).toBe(false);
    await service.initialize();
    expect((await service.healthCheck()).healthy).toBe(true);
    await service.shutdown();
    expect((await service.healthCheck()).healthy).toBe(false);
  });
});

describe('tag-stream listener lifecycle', () => {
  const update = {
    tagName: 'TK-1.LEVEL',
    value: 42,
    quality: 'good' as const,
    timestamp: '2026-07-23T00:00:00.000Z',
  };

  it('supports explicit unsubscribe and clears listeners on destroy', () => {
    const stream = new TagStreamServer();
    const listener = vi.fn();
    const unsubscribe = stream.onTagUpdate(listener);
    stream.broadcastTagUpdate(update);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    stream.broadcastTagUpdate(update);
    expect(listener).toHaveBeenCalledTimes(1);

    const afterDestroy = vi.fn();
    stream.onTagUpdate(afterDestroy);
    stream.destroy();
    stream.broadcastTagUpdate(update);
    expect(afterDestroy).not.toHaveBeenCalled();
  });
});
