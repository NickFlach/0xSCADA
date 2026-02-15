import { describe, it, expect } from 'vitest';
import { CapacityPlanner } from '../../planning/capacity-planner';

describe('CapacityPlanner', () => {
  it('should estimate resources for tag counts', () => {
    const planner = new CapacityPlanner();

    const small = planner.estimateResources(1000);
    expect(small.cpuCores).toBeGreaterThanOrEqual(1);
    expect(small.gatewayInstances).toBe(1);

    const large = planner.estimateResources(100000);
    expect(large.cpuCores).toBeGreaterThan(small.cpuCores);
    expect(large.gatewayInstances).toBe(2);
  });

  it('should project costs for all cloud providers', () => {
    const planner = new CapacityPlanner();
    const costs = planner.projectCosts(50000);

    expect(costs).toHaveLength(3);
    expect(costs.map((c) => c.provider)).toEqual(['aws', 'azure', 'gcp']);
    for (const cost of costs) {
      expect(cost.monthlyTotal).toBeGreaterThan(0);
      expect(cost.currency).toBe('USD');
    }
  });

  it('should forecast growth', () => {
    const planner = new CapacityPlanner();
    const forecast = planner.forecastGrowth(10000, 100000);

    expect(forecast.currentTags).toBe(10000);
    expect(forecast.projectedTags).toHaveLength(24);
    expect(forecast.projectedTags[0].tags).toBeGreaterThan(10000);
    expect(forecast.recommendation).toBeDefined();
  });

  it('should detect capacity exhaustion', () => {
    const planner = new CapacityPlanner();
    const forecast = planner.forecastGrowth(50000, 60000);

    // With 5% growth, should exhaust soon
    expect(forecast.capacityExhaustedMonth).toBeDefined();
    expect(forecast.capacityExhaustedMonth).toBeGreaterThan(0);
  });

  it('should recommend tiers', () => {
    const planner = new CapacityPlanner();

    expect(planner.recommend(5000).tier).toBe('starter');
    expect(planner.recommend(50000).tier).toBe('professional');
    expect(planner.recommend(200000).tier).toBe('enterprise');
    expect(planner.recommend(1000000).tier).toBe('hyperscale');
  });

  it('should track historical tag counts for forecasting', () => {
    const planner = new CapacityPlanner();
    planner.recordTagCount(1000);
    planner.recordTagCount(1100);

    const forecast = planner.forecastGrowth(1100);
    expect(forecast.growthRate).toBeGreaterThanOrEqual(0);
  });
});
