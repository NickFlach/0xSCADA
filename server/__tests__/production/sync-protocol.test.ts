import { describe, it, expect } from 'vitest';
import { CRDTStore } from '../../federation/sync-protocol';

describe('CRDTStore', () => {
  it('should set and get LWW registers', () => {
    const store = new CRDTStore('site-a');
    store.setRegister('config.name', 'Plant A');
    expect(store.getRegister('config.name')).toBe('Plant A');
  });

  it('should increment and read G-Counters', () => {
    const store = new CRDTStore('site-a');
    store.incrementCounter('events', 5);
    store.incrementCounter('events', 3);
    expect(store.getCounter('events')).toBe(8);
  });

  it('should add to and read OR-Sets', () => {
    const store = new CRDTStore('site-a');
    store.addToSet('tags', 'temp-1');
    store.addToSet('tags', 'temp-2');
    expect(store.getSet('tags')).toHaveLength(2);
  });

  it('should merge LWW registers from remote sites', () => {
    const storeA = new CRDTStore('site-a');
    const storeB = new CRDTStore('site-b');

    const op = storeA.setRegister('setting', 'value-a');
    storeB.applyRemoteOp(op);

    expect(storeB.getRegister('setting')).toBe('value-a');
  });

  it('should merge G-Counters from remote sites', () => {
    const storeA = new CRDTStore('site-a');
    const storeB = new CRDTStore('site-b');

    storeA.incrementCounter('total', 10);
    storeB.incrementCounter('total', 5);

    const opA = storeA.getOperationsSince({})[0];
    storeB.applyRemoteOp(opA);

    // site-b has its own 5 + site-a's 10
    expect(storeB.getCounter('total')).toBeGreaterThanOrEqual(10);
  });

  it('should track vector clocks', () => {
    const store = new CRDTStore('site-a');
    store.setRegister('x', 1);
    store.setRegister('y', 2);

    const vc = store.getVectorClock();
    expect(vc['site-a']).toBe(2);
  });

  it('should get operations since vector clock', () => {
    const store = new CRDTStore('site-a');
    store.setRegister('a', 1);
    store.setRegister('b', 2);
    store.setRegister('c', 3);

    const ops = store.getOperationsSince({ 'site-a': 1 });
    expect(ops.length).toBeGreaterThanOrEqual(2);
  });
});
