/**
 * Digital Twin Runtime tests
 * ADR-0013 [13.3] — Issue #214
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProcessModel } from '@shared/types/digital-twin';
import { TwinRuntime } from '../engine';
import { DigitalTwinService, registerStepFunction, listStepFunctions } from '../index';

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
});

describe('DigitalTwinService', () => {
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
