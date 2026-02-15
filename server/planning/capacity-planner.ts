/**
 * Capacity Planner — ADR-0014 [14.8]
 *
 * Resource estimation, cloud cost projections, growth forecasting,
 * and scaling recommendations.
 */

import { EventEmitter } from 'events';

export interface ResourceEstimate {
  cpuCores: number;
  memoryGB: number;
  storageGB: number;
  bandwidthMbps: number;
  gatewayInstances: number;
  serverInstances: number;
}

export interface CostProjection {
  provider: 'aws' | 'azure' | 'gcp';
  monthlyCompute: number;
  monthlyStorage: number;
  monthlyNetwork: number;
  monthlyTotal: number;
  currency: string;
  instanceType: string;
  notes: string[];
}

export interface GrowthForecast {
  currentTags: number;
  projectedTags: { month: number; tags: number }[];
  growthRate: number; // monthly percentage
  capacityExhaustedMonth: number | null;
  recommendation: string;
}

export interface ScalingRecommendation {
  tagCount: number;
  tier: 'starter' | 'professional' | 'enterprise' | 'hyperscale';
  resources: ResourceEstimate;
  costs: CostProjection[];
  notes: string[];
}

// Per-tag resource constants (empirically derived baselines)
const RESOURCE_PER_TAG = {
  cpuMicrocores: 50, // 0.05 cores per 1000 tags
  memoryKB: 2,
  storageKBPerDay: 10, // 10KB/day/tag for historian
  bandwidthBytesPerSec: 50,
};

// Cloud pricing (simplified, USD/month)
const CLOUD_PRICING = {
  aws: {
    instanceType: 'm6i.xlarge',
    vcpus: 4,
    memoryGB: 16,
    pricePerHour: 0.192,
    storagePerGB: 0.08,
    networkPerGB: 0.09,
  },
  azure: {
    instanceType: 'D4s_v5',
    vcpus: 4,
    memoryGB: 16,
    pricePerHour: 0.192,
    storagePerGB: 0.08,
    networkPerGB: 0.087,
  },
  gcp: {
    instanceType: 'n2-standard-4',
    vcpus: 4,
    memoryGB: 16,
    pricePerHour: 0.1942,
    storagePerGB: 0.04,
    networkPerGB: 0.12,
  },
};

const TIER_THRESHOLDS = {
  starter: 10000,
  professional: 100000,
  enterprise: 500000,
  hyperscale: Infinity,
};

export class CapacityPlanner extends EventEmitter {
  private historicalTagCounts: { timestamp: number; count: number }[] = [];

  constructor() {
    super();
  }

  estimateResources(tagCount: number, retentionDays = 90): ResourceEstimate {
    const cpuCores = Math.max(1, Math.ceil((tagCount * RESOURCE_PER_TAG.cpuMicrocores) / 1000000));
    const memoryGB = Math.max(1, Math.ceil((tagCount * RESOURCE_PER_TAG.memoryKB) / 1024 / 1024));
    const storageGB = Math.max(
      10,
      Math.ceil((tagCount * RESOURCE_PER_TAG.storageKBPerDay * retentionDays) / 1024 / 1024)
    );
    const bandwidthMbps = Math.max(
      1,
      Math.ceil((tagCount * RESOURCE_PER_TAG.bandwidthBytesPerSec * 8) / 1000000)
    );

    // Instance sizing
    const gatewayInstances = Math.max(1, Math.ceil(tagCount / 50000));
    const serverInstances = Math.max(1, Math.ceil(tagCount / 100000));

    return { cpuCores, memoryGB, storageGB, bandwidthMbps, gatewayInstances, serverInstances };
  }

  projectCosts(tagCount: number, retentionDays = 90): CostProjection[] {
    const resources = this.estimateResources(tagCount, retentionDays);

    return (['aws', 'azure', 'gcp'] as const).map((provider) => {
      const pricing = CLOUD_PRICING[provider];
      const instances = Math.max(resources.gatewayInstances + resources.serverInstances, Math.ceil(resources.cpuCores / pricing.vcpus));
      const monthlyCompute = instances * pricing.pricePerHour * 730; // 730 hours/month
      const monthlyStorage = resources.storageGB * pricing.storagePerGB;
      const monthlyNetwork = ((tagCount * RESOURCE_PER_TAG.bandwidthBytesPerSec * 2592000) / 1024 / 1024 / 1024) * pricing.networkPerGB;

      return {
        provider,
        monthlyCompute: Math.round(monthlyCompute * 100) / 100,
        monthlyStorage: Math.round(monthlyStorage * 100) / 100,
        monthlyNetwork: Math.round(monthlyNetwork * 100) / 100,
        monthlyTotal: Math.round((monthlyCompute + monthlyStorage + monthlyNetwork) * 100) / 100,
        currency: 'USD',
        instanceType: pricing.instanceType,
        notes: [
          `${instances}x ${pricing.instanceType}`,
          `${resources.storageGB}GB storage (${retentionDays}d retention)`,
        ],
      };
    });
  }

  recordTagCount(count: number): void {
    this.historicalTagCounts.push({ timestamp: Date.now(), count });
    // Keep last 365 entries
    if (this.historicalTagCounts.length > 365) {
      this.historicalTagCounts = this.historicalTagCounts.slice(-365);
    }
  }

  forecastGrowth(currentTags: number, maxCapacity?: number): GrowthForecast {
    let growthRate = 0.05; // default 5% monthly

    if (this.historicalTagCounts.length >= 2) {
      const first = this.historicalTagCounts[0];
      const last = this.historicalTagCounts[this.historicalTagCounts.length - 1];
      const months = (last.timestamp - first.timestamp) / (30 * 24 * 60 * 60 * 1000);
      if (months > 0) {
        growthRate = Math.pow(last.count / first.count, 1 / months) - 1;
      }
    }

    const projectedTags: { month: number; tags: number }[] = [];
    let capacityExhaustedMonth: number | null = null;

    for (let month = 1; month <= 24; month++) {
      const tags = Math.round(currentTags * Math.pow(1 + growthRate, month));
      projectedTags.push({ month, tags });

      if (maxCapacity && tags > maxCapacity && !capacityExhaustedMonth) {
        capacityExhaustedMonth = month;
      }
    }

    const recommendation = capacityExhaustedMonth
      ? `Current capacity will be exhausted in ~${capacityExhaustedMonth} months. Plan scaling now.`
      : `Current growth rate of ${(growthRate * 100).toFixed(1)}%/month is sustainable for 24+ months.`;

    return { currentTags, projectedTags, growthRate, capacityExhaustedMonth, recommendation };
  }

  recommend(tagCount: number): ScalingRecommendation {
    let tier: ScalingRecommendation['tier'] = 'starter';
    for (const [t, threshold] of Object.entries(TIER_THRESHOLDS)) {
      if (tagCount <= threshold) {
        tier = t as ScalingRecommendation['tier'];
        break;
      }
    }

    const resources = this.estimateResources(tagCount);
    const costs = this.projectCosts(tagCount);
    const notes: string[] = [];

    if (tier === 'enterprise' || tier === 'hyperscale') {
      notes.push('Consider multi-site federation for geographic distribution');
      notes.push('Enable horizontal scaling with sharded gateways');
    }
    if (tagCount > 50000) {
      notes.push('Enable store-and-forward for edge resilience');
    }
    if (tagCount > 10000) {
      notes.push('Enable automated benchmarking for regression detection');
    }

    return { tagCount, tier, resources, costs, notes };
  }
}
