import { describe, expect, it } from 'vitest';
import {
  CapacityPlanner,
  DEFAULT_CLOUD_RATE_CARDS,
  type TagCountObservation,
} from '../index';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const now = () => new Date(NOW);

describe('CapacityPlanner resource estimation', () => {
  it('calculates CPU, memory, storage, and bandwidth from transparent per-tag rates', () => {
    const planner = new CapacityPlanner({ now });
    const estimate = planner.estimateResources({
      tagCount: 100_000,
      sampleIntervalSeconds: 1,
      retentionDays: 90,
      headroomPercent: 30,
      highAvailability: true,
      subscriberFanout: 1,
    });

    expect(estimate.perTag).toEqual({
      cpuMillicores: 0.05,
      memoryKiB: 2,
      storageKiBPerDay: 10,
      ingressBytesPerSecond: 50,
      egressBytesPerSecond: 50,
    });
    expect(estimate.totals.cpuCores).toBe(7.15);
    expect(estimate.totals.memoryGiB).toBeCloseTo(1.548, 3);
    expect(estimate.totals.storageGiB).toBeCloseTo(124.58, 3);
    expect(estimate.totals.ingressMbps).toBe(52);
    expect(estimate.topology).toEqual({
      gatewayInstances: 3,
      apiServerInstances: 2,
      historianShards: 1,
    });
  });

  it('scales sample-driven resources while keeping resident tag memory constant', () => {
    const planner = new CapacityPlanner({ now });
    const fast = planner.estimateResources({ tagCount: 10_000, sampleIntervalSeconds: 1 });
    const slow = planner.estimateResources({ tagCount: 10_000, sampleIntervalSeconds: 10 });

    expect(slow.perTag.cpuMillicores).toBe(fast.perTag.cpuMillicores / 10);
    expect(slow.perTag.storageKiBPerDay).toBe(fast.perTag.storageKiBPerDay / 10);
    expect(slow.totals.ingressMbps).toBe(fast.totals.ingressMbps / 10);
    expect(slow.perTag.memoryKiB).toBe(fast.perTag.memoryKiB);
  });

  it('validates unsafe and non-finite inputs', () => {
    const planner = new CapacityPlanner({ now });
    expect(() => planner.estimateResources({ tagCount: 0 })).toThrow(/tagCount/);
    expect(() => planner.estimateResources({
      tagCount: 10,
      sampleIntervalSeconds: Number.NaN,
    })).toThrow(/sampleIntervalSeconds must be finite/);
    expect(() => planner.estimateResources({
      tagCount: 10,
      historianCopies: 0,
    })).toThrow(/historianCopies/);
  });
});

describe('CapacityPlanner cloud cost projections', () => {
  it('projects itemized monthly AWS, Azure, and GCP costs', () => {
    const planner = new CapacityPlanner({ now });
    const estimate = planner.estimateResources({ tagCount: 50_000, subscriberFanout: 0.2 });
    const projections = planner.projectCloudCosts(estimate);

    expect(projections.map(item => item.provider)).toEqual(['aws', 'azure', 'gcp']);
    for (const projection of projections) {
      expect(projection.pricingVersion).toBe('2026-07-reference');
      expect(projection.computeNodes).toBeGreaterThanOrEqual(2);
      expect(projection.monthly.total).toBeCloseTo(
        projection.monthly.compute
          + projection.monthly.storage
          + projection.monthly.networkEgress
          + projection.monthly.loadBalancer,
        2,
      );
      expect(projection.annualTotal).toBeCloseTo(projection.monthly.total * 12, 1);
      expect(projection.assumptions.join(' ')).toMatch(/not a provider quote/i);
    }
  });

  it('uses replaceable contracted rate cards', () => {
    const freeAws = structuredClone(DEFAULT_CLOUD_RATE_CARDS);
    freeAws.aws.compute.hourlyPerNode = 0;
    freeAws.aws.storagePerGiBMonth = 0;
    freeAws.aws.egressPerGiB = 0;
    freeAws.aws.monthlyLoadBalancer = 0;
    const planner = new CapacityPlanner({ rateCards: freeAws, now });

    const [projection] = planner.projectCloudCosts({ tagCount: 1_000 }, ['aws']);
    expect(projection.monthly.total).toBe(0);

    freeAws.aws.compute.hourlyPerNode = 10;
    const [unchanged] = planner.projectCloudCosts({ tagCount: 1_000 }, ['aws']);
    expect(unchanged.monthly.total).toBe(0);
  });
});

describe('CapacityPlanner growth and scaling', () => {
  const linearHistory: TagCountObservation[] = [
    { timestamp: '2026-01-01T00:00:00.000Z', tagCount: 10_000 },
    { timestamp: '2026-02-01T00:00:00.000Z', tagCount: 13_100 },
    { timestamp: '2026-03-01T00:00:00.000Z', tagCount: 15_900 },
    { timestamp: '2026-04-01T00:00:00.000Z', tagCount: 19_000 },
    { timestamp: '2026-05-01T00:00:00.000Z', tagCount: 22_000 },
    { timestamp: '2026-06-01T00:00:00.000Z', tagCount: 25_100 },
  ];

  it('forecasts tag growth with least-squares fit and reports confidence', () => {
    const planner = new CapacityPlanner({ now });
    const forecast = planner.forecastGrowth(linearHistory, 6);

    expect(forecast.method).toBe('linear-least-squares');
    expect(forecast.slopeTagsPerDay).toBeCloseTo(100, 0);
    expect(forecast.projectedTagCount).toBeGreaterThan(43_000);
    expect(forecast.absoluteGrowth).toBe(forecast.projectedTagCount - 25_100);
    expect(forecast.rSquared).toBeGreaterThan(0.999);
    expect(forecast.confidence).toBe('high');
    expect(forecast.monthlyGrowthRate).toBeGreaterThan(0);
  });

  it('rejects inadequate or ambiguous history', () => {
    const planner = new CapacityPlanner({ now });
    expect(() => planner.forecastGrowth([linearHistory[0]])).toThrow(/At least two/);
    expect(() => planner.forecastGrowth([
      linearHistory[0],
      { ...linearHistory[1], timestamp: linearHistory[0].timestamp },
    ])).toThrow(/unique/);
  });

  it('returns explicit cost/performance options and safe scale triggers', () => {
    const planner = new CapacityPlanner({ now });
    const forecast = planner.forecastGrowth(linearHistory, 6);
    const recommendation = planner.recommendScaling({ tagCount: 25_100 }, forecast);

    expect(recommendation.options.map(item => item.strategy)).toEqual([
      'cost-optimized',
      'balanced',
      'performance',
    ]);
    expect(recommendation.options[0].headroomPercent)
      .toBeLessThan(recommendation.options[2].headroomPercent);
    expect(recommendation.options.every(item =>
      Object.keys(item.monthlyCostByProvider).sort().join(',') === 'aws,azure,gcp')).toBe(true);
    expect(recommendation.scaleTriggers.storageUtilizationPercent).toBe(70);
    expect(recommendation.planningTagCount).toBe(forecast.projectedTagCount);
  });

  it('produces one complete deterministic planning artifact', () => {
    const planner = new CapacityPlanner({ now });
    const plan = planner.createPlan({
      workload: { tagCount: 25_100, retentionDays: 180 },
      history: linearHistory,
      horizonMonths: 12,
      providers: ['aws', 'gcp'],
    });

    expect(plan.generatedAt).toBe(NOW.toISOString());
    expect(plan.forecast?.horizonMonths).toBe(12);
    expect(plan.planning.workload.tagCount).toBe(plan.forecast?.projectedTagCount);
    expect(plan.cloudCosts.map(item => item.provider)).toEqual(['aws', 'gcp']);
    expect(plan.scaling.options).toHaveLength(3);
    expect(plan.scaling.options.every(option =>
      Object.keys(option.monthlyCostByProvider).sort().join(',') === 'aws,gcp')).toBe(true);
  });
});
