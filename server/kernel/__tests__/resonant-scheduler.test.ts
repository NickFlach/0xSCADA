import { describe, it, expect, vi } from 'vitest';
import { ResonantScheduler } from '../resonant-scheduler';

describe('ResonantScheduler', () => {
  it('adds and removes tasks', () => {
    const scheduler = new ResonantScheduler();
    scheduler.addTask({ id: 't1', naturalFrequency: 1, group: 'a', weight: 1, execute: () => {} });
    expect(scheduler.getMetrics().taskCount).toBe(1);
    scheduler.removeTask('t1');
    expect(scheduler.getMetrics().taskCount).toBe(0);
  });

  it('computes order parameter', () => {
    const scheduler = new ResonantScheduler();
    scheduler.addTask({ id: 't1', naturalFrequency: 1, group: 'a', weight: 1, execute: () => {} });
    scheduler.addTask({ id: 't2', naturalFrequency: 1, group: 'a', weight: 1, execute: () => {} });
    const metrics = scheduler.getMetrics();
    // Order parameter should be between 0 and 1
    expect(metrics.orderParameter).toBeGreaterThanOrEqual(0);
    expect(metrics.orderParameter).toBeLessThanOrEqual(1);
  });

  it('starts and stops without error', () => {
    const scheduler = new ResonantScheduler({ tickIntervalMs: 50 });
    scheduler.addTask({ id: 't1', naturalFrequency: 10, group: 'a', weight: 1, execute: () => {} });
    scheduler.start();
    scheduler.stop();
  });

  it('emits task:added and task:removed', () => {
    const scheduler = new ResonantScheduler();
    const added = vi.fn();
    const removed = vi.fn();
    scheduler.on('task:added', added);
    scheduler.on('task:removed', removed);
    scheduler.addTask({ id: 'x', naturalFrequency: 1, group: 'g', weight: 1, execute: () => {} });
    expect(added).toHaveBeenCalledWith('x');
    scheduler.removeTask('x');
    expect(removed).toHaveBeenCalledWith('x');
  });
});
