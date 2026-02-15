import { describe, it, expect } from 'vitest';
import { DigitalTwinRuntime } from '../../intelligence/digital-twin-runtime';
import type { ProcessModel } from '../../../shared/types/digital-twin';

const testModel: ProcessModel = {
  id: 'test-process',
  name: 'Test Process',
  description: 'A simple tank + valve model',
  components: [
    { id: 'valve-1', type: 'valve', name: 'Inlet Valve', parameters: { position: 50, maxFlow: 10 }, connections: ['tank-1'], tags: ['valve1.flow'] },
    { id: 'tank-1', type: 'tank', name: 'Main Tank', parameters: { level: 20, capacity: 100, inflow: 0, outflow: 2 }, connections: [], tags: ['tank1.level'] },
  ],
  stepFunction: 'basic-flow',
  timeStepMs: 1000,
};

describe('DigitalTwinRuntime', () => {
  it('registers and retrieves models', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);
    expect(twin.getModel('test-process')).toBeDefined();
  });

  it('initializes simulation', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);
    const state = twin.initSimulation('test-process');
    expect(state).not.toBeNull();
    expect(state!.tick).toBe(0);
    expect(state!.componentStates['tank-1'].level).toBe(20);
  });

  it('steps simulation forward', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);
    twin.initSimulation('test-process');

    const state = twin.step('test-process');
    expect(state).not.toBeNull();
    expect(state!.tick).toBe(1);
    // Tank level should change due to inflow from valve and outflow
    expect(state!.componentStates['tank-1'].level).not.toBe(20);
  });

  it('runs multiple steps', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);
    twin.initSimulation('test-process');

    const states = twin.runSteps('test-process', 10);
    expect(states.length).toBe(10);
    expect(states[9].tick).toBe(10);
  });

  it('compares predicted vs actual', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);
    twin.initSimulation('test-process');
    twin.runSteps('test-process', 5);

    twin.updateActual('tank1.level', 25);
    const comparisons = twin.compare('test-process');
    expect(comparisons.length).toBeGreaterThan(0);
    expect(comparisons[0]).toHaveProperty('divergence');
  });

  it('runs what-if scenarios', () => {
    const twin = new DigitalTwinRuntime();
    twin.registerModel(testModel);

    const result = twin.runScenario({
      id: 'open-valve-full',
      name: 'Open Valve 100%',
      baseModelId: 'test-process',
      modifications: [{ componentId: 'valve-1', parameter: 'position', value: 100 }],
      duration: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.states.length).toBe(10);
  });
});
