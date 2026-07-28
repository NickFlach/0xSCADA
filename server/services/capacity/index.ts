/**
 * Capacity planning and cloud cost modeling (ADR-0014, issue #228).
 *
 * The planner uses explicit, versioned coefficients and prices.  It never
 * represents its projections as a cloud-provider quote: callers can replace
 * the reference rates with their contracted rates while retaining the same
 * deterministic formulas.
 */
export type CloudProvider = 'aws' | 'azure' | 'gcp';
export type ScalingStrategy = 'cost-optimized' | 'balanced' | 'performance';

export interface ResourceCoefficients {
  baseCpuCores: number;
  baseMemoryGiB: number;
  baseStorageGiB: number;
  cpuMillicoresPerTagAtOneSecond: number;
  memoryKiBPerTag: number;
  storageKiBPerTagDayAtOneSecond: number;
  bandwidthBytesPerSecondPerTagAtOneSecond: number;
  tagsPerGateway: number;
  tagsPerApiServer: number;
  tagsPerHistorianShard: number;
}

export interface CapacityWorkload {
  tagCount: number;
  sampleIntervalSeconds?: number;
  retentionDays?: number;
  headroomPercent?: number;
  highAvailability?: boolean;
  historianCopies?: number;
  /** Average delivered subscriber copies for each ingested update. */
  subscriberFanout?: number;
}

export interface ResourceEstimate {
  workload: Required<CapacityWorkload>;
  perTag: {
    cpuMillicores: number;
    memoryKiB: number;
    storageKiBPerDay: number;
    ingressBytesPerSecond: number;
    egressBytesPerSecond: number;
  };
  totals: {
    cpuCores: number;
    memoryGiB: number;
    storageGiB: number;
    ingressMbps: number;
    egressMbps: number;
    updatesPerSecond: number;
  };
  topology: {
    gatewayInstances: number;
    apiServerInstances: number;
    historianShards: number;
  };
  assumptions: readonly string[];
}

export interface CloudRateCard {
  provider: CloudProvider;
  version: string;
  region: string;
  currency: 'USD';
  compute: {
    vCpuPerNode: number;
    memoryGiBPerNode: number;
    hourlyPerNode: number;
    targetCpuUtilization: number;
    targetMemoryUtilization: number;
  };
  storagePerGiBMonth: number;
  egressPerGiB: number;
  monthlyLoadBalancer: number;
}

export interface CloudCostProjection {
  provider: CloudProvider;
  currency: 'USD';
  pricingVersion: string;
  region: string;
  computeNodes: number;
  billableStorageGiB: number;
  monthlyEgressGiB: number;
  monthly: {
    compute: number;
    storage: number;
    networkEgress: number;
    loadBalancer: number;
    total: number;
  };
  annualTotal: number;
  assumptions: readonly string[];
}

export interface TagCountObservation {
  timestamp: string | Date;
  tagCount: number;
}

export interface GrowthForecast {
  method: 'linear-least-squares';
  historyStart: string;
  historyEnd: string;
  horizonMonths: number;
  forecastDate: string;
  currentTagCount: number;
  projectedTagCount: number;
  absoluteGrowth: number;
  monthlyGrowthRate: number;
  annualizedGrowthRate: number;
  slopeTagsPerDay: number;
  rSquared: number;
  confidence: 'low' | 'medium' | 'high';
  pointsUsed: number;
}

export interface ScalingOption {
  strategy: ScalingStrategy;
  headroomPercent: number;
  resourceEstimate: ResourceEstimate;
  monthlyCostByProvider: Readonly<Partial<Record<CloudProvider, number>>>;
  cheapestProvider: CloudProvider;
  performanceTradeoff: string;
  costTradeoff: string;
}

export interface ScalingRecommendation {
  currentTagCount: number;
  planningTagCount: number;
  forecast?: GrowthForecast;
  recommendedStrategy: ScalingStrategy;
  rationale: readonly string[];
  options: readonly ScalingOption[];
  scaleTriggers: {
    gatewayTagUtilizationPercent: number;
    cpuUtilizationPercent: number;
    memoryUtilizationPercent: number;
    storageUtilizationPercent: number;
  };
}

export interface CapacityPlan {
  generatedAt: string;
  current: ResourceEstimate;
  forecast?: GrowthForecast;
  planning: ResourceEstimate;
  cloudCosts: readonly CloudCostProjection[];
  scaling: ScalingRecommendation;
}

export const DEFAULT_RESOURCE_COEFFICIENTS: Readonly<ResourceCoefficients> = Object.freeze({
  baseCpuCores: 0.5,
  baseMemoryGiB: 1,
  baseStorageGiB: 10,
  cpuMillicoresPerTagAtOneSecond: 0.05,
  memoryKiBPerTag: 2,
  storageKiBPerTagDayAtOneSecond: 10,
  bandwidthBytesPerSecondPerTagAtOneSecond: 50,
  tagsPerGateway: 50_000,
  tagsPerApiServer: 100_000,
  tagsPerHistorianShard: 250_000,
});

function frozenRateCard(card: CloudRateCard): CloudRateCard {
  return Object.freeze({
    ...card,
    compute: Object.freeze({ ...card.compute }),
  });
}

export const DEFAULT_CLOUD_RATE_CARDS: Readonly<Record<CloudProvider, CloudRateCard>> = Object.freeze({
  aws: frozenRateCard({
    provider: 'aws',
    version: '2026-07-reference',
    region: 'us-east-1',
    currency: 'USD',
    compute: {
      vCpuPerNode: 4,
      memoryGiBPerNode: 16,
      hourlyPerNode: 0.192,
      targetCpuUtilization: 0.7,
      targetMemoryUtilization: 0.75,
    },
    storagePerGiBMonth: 0.08,
    egressPerGiB: 0.09,
    monthlyLoadBalancer: 18.25,
  }),
  azure: frozenRateCard({
    provider: 'azure',
    version: '2026-07-reference',
    region: 'eastus',
    currency: 'USD',
    compute: {
      vCpuPerNode: 4,
      memoryGiBPerNode: 16,
      hourlyPerNode: 0.2,
      targetCpuUtilization: 0.7,
      targetMemoryUtilization: 0.75,
    },
    storagePerGiBMonth: 0.09,
    egressPerGiB: 0.087,
    monthlyLoadBalancer: 18.25,
  }),
  gcp: frozenRateCard({
    provider: 'gcp',
    version: '2026-07-reference',
    region: 'us-central1',
    currency: 'USD',
    compute: {
      vCpuPerNode: 4,
      memoryGiBPerNode: 16,
      hourlyPerNode: 0.189,
      targetCpuUtilization: 0.7,
      targetMemoryUtilization: 0.75,
    },
    storagePerGiBMonth: 0.1,
    egressPerGiB: 0.12,
    monthlyLoadBalancer: 18,
  }),
});

const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = 365.25 / 12;
const SECONDS_PER_MONTH = DAYS_PER_MONTH * 24 * 60 * 60;

function rounded(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function requireFinite(
  value: number,
  field: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): void {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be at most ${options.max}`);
  }
}

function normalizeWorkload(workload: CapacityWorkload): Required<CapacityWorkload> {
  const normalized: Required<CapacityWorkload> = {
    tagCount: workload.tagCount,
    sampleIntervalSeconds: workload.sampleIntervalSeconds ?? 1,
    retentionDays: workload.retentionDays ?? 90,
    headroomPercent: workload.headroomPercent ?? 30,
    highAvailability: workload.highAvailability ?? true,
    historianCopies: workload.historianCopies ?? 1,
    subscriberFanout: workload.subscriberFanout ?? 1,
  };
  requireFinite(normalized.tagCount, 'tagCount', { min: 1, max: 100_000_000, integer: true });
  requireFinite(normalized.sampleIntervalSeconds, 'sampleIntervalSeconds', { min: 0.05, max: 86_400 });
  requireFinite(normalized.retentionDays, 'retentionDays', { min: 1, max: 3_650, integer: true });
  requireFinite(normalized.headroomPercent, 'headroomPercent', { min: 0, max: 300 });
  requireFinite(normalized.historianCopies, 'historianCopies', { min: 1, max: 5, integer: true });
  requireFinite(normalized.subscriberFanout, 'subscriberFanout', { min: 0, max: 10_000 });
  return normalized;
}

function validateCoefficients(coefficients: ResourceCoefficients): void {
  for (const [field, value] of Object.entries(coefficients)) {
    requireFinite(value, `coefficients.${field}`, { min: Number.EPSILON });
  }
}

function validateRateCard(card: CloudRateCard): void {
  if (!card.version.trim() || !card.region.trim()) {
    throw new Error(`Rate card ${card.provider} requires a version and region`);
  }
  requireFinite(card.compute.vCpuPerNode, `${card.provider}.compute.vCpuPerNode`, { min: 1 });
  requireFinite(card.compute.memoryGiBPerNode, `${card.provider}.compute.memoryGiBPerNode`, { min: 1 });
  requireFinite(card.compute.hourlyPerNode, `${card.provider}.compute.hourlyPerNode`, { min: 0 });
  requireFinite(card.compute.targetCpuUtilization, `${card.provider}.compute.targetCpuUtilization`, {
    min: 0.01,
    max: 1,
  });
  requireFinite(card.compute.targetMemoryUtilization, `${card.provider}.compute.targetMemoryUtilization`, {
    min: 0.01,
    max: 1,
  });
  requireFinite(card.storagePerGiBMonth, `${card.provider}.storagePerGiBMonth`, { min: 0 });
  requireFinite(card.egressPerGiB, `${card.provider}.egressPerGiB`, { min: 0 });
  requireFinite(card.monthlyLoadBalancer, `${card.provider}.monthlyLoadBalancer`, { min: 0 });
}

export class CapacityPlanner {
  private readonly coefficients: Readonly<ResourceCoefficients>;
  private readonly rateCards: Readonly<Record<CloudProvider, CloudRateCard>>;
  private readonly now: () => Date;

  constructor(options: {
    coefficients?: ResourceCoefficients;
    rateCards?: Record<CloudProvider, CloudRateCard>;
    now?: () => Date;
  } = {}) {
    this.coefficients = Object.freeze({
      ...DEFAULT_RESOURCE_COEFFICIENTS,
      ...(options.coefficients ?? {}),
    });
    const rateCards = {
      ...DEFAULT_CLOUD_RATE_CARDS,
      ...(options.rateCards ?? {}),
    };
    // Never retain references to exported defaults or caller-owned nested
    // objects; later mutation must not silently rewrite a live cost model.
    this.rateCards = Object.freeze({
      aws: structuredClone(rateCards.aws),
      azure: structuredClone(rateCards.azure),
      gcp: structuredClone(rateCards.gcp),
    });
    this.now = options.now ?? (() => new Date());
    validateCoefficients(this.coefficients);
    Object.values(this.rateCards).forEach(validateRateCard);
  }

  getCoefficients(): Readonly<ResourceCoefficients> {
    return { ...this.coefficients };
  }

  getRateCards(): Readonly<Record<CloudProvider, CloudRateCard>> {
    return {
      aws: structuredClone(this.rateCards.aws),
      azure: structuredClone(this.rateCards.azure),
      gcp: structuredClone(this.rateCards.gcp),
    };
  }

  estimateResources(workloadInput: CapacityWorkload): ResourceEstimate {
    const workload = normalizeWorkload(workloadInput);
    const intervalScale = 1 / workload.sampleIntervalSeconds;
    const headroom = 1 + workload.headroomPercent / 100;
    const perTag = {
      cpuMillicores: rounded(this.coefficients.cpuMillicoresPerTagAtOneSecond * intervalScale, 6),
      memoryKiB: this.coefficients.memoryKiBPerTag,
      storageKiBPerDay: rounded(
        this.coefficients.storageKiBPerTagDayAtOneSecond * intervalScale,
        6,
      ),
      ingressBytesPerSecond: rounded(
        this.coefficients.bandwidthBytesPerSecondPerTagAtOneSecond * intervalScale,
        6,
      ),
      egressBytesPerSecond: rounded(
        this.coefficients.bandwidthBytesPerSecondPerTagAtOneSecond
          * intervalScale
          * workload.subscriberFanout,
        6,
      ),
    };
    const cpuCores = (
      this.coefficients.baseCpuCores
      + workload.tagCount * perTag.cpuMillicores / 1_000
    ) * headroom;
    const memoryGiB = (
      this.coefficients.baseMemoryGiB
      + workload.tagCount * perTag.memoryKiB / 1_048_576
    ) * headroom;
    const storageGiB = (
      this.coefficients.baseStorageGiB
      + (
        workload.tagCount
        * perTag.storageKiBPerDay
        * workload.retentionDays
        * workload.historianCopies
      ) / 1_048_576
    ) * headroom;
    const ingressMbps = workload.tagCount * perTag.ingressBytesPerSecond * 8 / 1_000_000;
    const egressMbps = workload.tagCount * perTag.egressBytesPerSecond * 8 / 1_000_000;
    const minimumInstances = workload.highAvailability ? 2 : 1;
    return {
      workload,
      perTag,
      totals: {
        cpuCores: rounded(cpuCores, 3),
        memoryGiB: rounded(memoryGiB, 3),
        storageGiB: rounded(storageGiB, 3),
        ingressMbps: rounded(ingressMbps * headroom, 3),
        egressMbps: rounded(egressMbps * headroom, 3),
        updatesPerSecond: rounded(workload.tagCount * intervalScale, 3),
      },
      topology: {
        gatewayInstances: Math.max(
          minimumInstances,
          Math.ceil(workload.tagCount / this.coefficients.tagsPerGateway * headroom),
        ),
        apiServerInstances: Math.max(
          minimumInstances,
          Math.ceil(workload.tagCount / this.coefficients.tagsPerApiServer * headroom),
        ),
        historianShards: Math.max(
          1,
          Math.ceil(workload.tagCount / this.coefficients.tagsPerHistorianShard * headroom),
        ),
      },
      assumptions: [
        `Resource headroom is ${workload.headroomPercent}%.`,
        `Per-tag rates are normalized to a ${workload.sampleIntervalSeconds}s sample interval.`,
        `${workload.historianCopies} historian data ${
          workload.historianCopies === 1 ? 'copy is' : 'copies are'
        } retained for ${workload.retentionDays} days.`,
        workload.highAvailability
          ? 'Gateway and API topology has a minimum of two instances.'
          : 'High availability is disabled; single-instance failure is possible.',
      ],
    };
  }

  projectCloudCosts(
    estimateOrWorkload: ResourceEstimate | CapacityWorkload,
    providers: readonly CloudProvider[] = ['aws', 'azure', 'gcp'],
  ): readonly CloudCostProjection[] {
    const estimate = 'totals' in estimateOrWorkload
      ? estimateOrWorkload
      : this.estimateResources(estimateOrWorkload);
    const uniqueProviders = [...new Set(providers)];
    if (uniqueProviders.length === 0) throw new Error('At least one cloud provider is required');
    return uniqueProviders.map(provider => {
      const card = this.rateCards[provider];
      if (card === undefined) throw new Error(`Unsupported cloud provider: ${provider}`);
      const resourceNodes = Math.max(
        Math.ceil(
          estimate.totals.cpuCores
          / (card.compute.vCpuPerNode * card.compute.targetCpuUtilization),
        ),
        Math.ceil(
          estimate.totals.memoryGiB
          / (card.compute.memoryGiBPerNode * card.compute.targetMemoryUtilization),
        ),
      );
      // This topology floor ensures that a cost projection does not silently
      // co-locate every critical role on fewer nodes than the model recommends.
      const topologyNodes = Math.max(
        estimate.topology.gatewayInstances,
        estimate.topology.apiServerInstances + estimate.topology.historianShards,
      );
      const computeNodes = Math.max(resourceNodes, topologyNodes);
      const monthlyEgressGiB = estimate.totals.egressMbps
        * 1_000_000
        / 8
        * SECONDS_PER_MONTH
        / (1024 ** 3);
      const compute = computeNodes * card.compute.hourlyPerNode * HOURS_PER_MONTH;
      const storage = estimate.totals.storageGiB * card.storagePerGiBMonth;
      const networkEgress = monthlyEgressGiB * card.egressPerGiB;
      const loadBalancer = estimate.workload.highAvailability ? card.monthlyLoadBalancer : 0;
      const monthly = {
        compute: rounded(compute),
        storage: rounded(storage),
        networkEgress: rounded(networkEgress),
        loadBalancer: rounded(loadBalancer),
        total: 0,
      };
      monthly.total = rounded(
        monthly.compute + monthly.storage + monthly.networkEgress + monthly.loadBalancer,
      );
      return {
        provider,
        currency: card.currency,
        pricingVersion: card.version,
        region: card.region,
        computeNodes,
        billableStorageGiB: rounded(estimate.totals.storageGiB, 3),
        monthlyEgressGiB: rounded(monthlyEgressGiB, 3),
        monthly,
        annualTotal: rounded(monthly.total * 12),
        assumptions: [
          `Reference on-demand rates for ${card.region}, version ${card.version}.`,
          `${HOURS_PER_MONTH} compute hours per month; taxes, support, discounts, and managed-service premiums excluded.`,
          'Internet egress is modeled from subscriber fan-out; private inter-zone transfer is excluded.',
          'This projection is a planning estimate, not a provider quote.',
        ],
      };
    });
  }

  forecastGrowth(
    historyInput: readonly TagCountObservation[],
    horizonMonths = 6,
  ): GrowthForecast {
    requireFinite(horizonMonths, 'horizonMonths', { min: 1, max: 120, integer: true });
    if (historyInput.length < 2) throw new Error('At least two historical tag-count observations are required');
    const history = historyInput
      .map(observation => {
        const timestamp = observation.timestamp instanceof Date
          ? observation.timestamp.getTime()
          : Date.parse(observation.timestamp);
        if (!Number.isFinite(timestamp)) throw new Error(`Invalid history timestamp: ${observation.timestamp}`);
        requireFinite(observation.tagCount, 'history.tagCount', {
          min: 0,
          max: 100_000_000,
          integer: true,
        });
        return { timestamp, tagCount: observation.tagCount };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].timestamp === history[index - 1].timestamp) {
        throw new Error('Historical tag-count timestamps must be unique');
      }
    }
    const firstTimestamp = history[0].timestamp;
    const x = history.map(point => (point.timestamp - firstTimestamp) / (24 * 60 * 60 * 1000));
    const y = history.map(point => point.tagCount);
    const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
    const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
    const covariance = x.reduce(
      (sum, value, index) => sum + (value - meanX) * (y[index] - meanY),
      0,
    );
    const varianceX = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
    const slope = varianceX === 0 ? 0 : covariance / varianceX;
    const intercept = meanY - slope * meanX;
    const residual = y.reduce(
      (sum, value, index) => sum + (value - (intercept + slope * x[index])) ** 2,
      0,
    );
    const totalVariance = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
    const rSquared = totalVariance === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / totalVariance));
    const last = history.at(-1)!;
    const horizonDays = horizonMonths * DAYS_PER_MONTH;
    const forecastTimestamp = last.timestamp + horizonDays * 24 * 60 * 60 * 1000;
    const forecastX = (forecastTimestamp - firstTimestamp) / (24 * 60 * 60 * 1000);
    const projectedTagCount = Math.max(0, Math.round(intercept + slope * forecastX));
    const currentTagCount = last.tagCount;
    const absoluteGrowth = projectedTagCount - currentTagCount;
    const monthlyGrowthRate = currentTagCount === 0
      ? 0
      : ((projectedTagCount / currentTagCount) ** (1 / horizonMonths) - 1);
    const annualizedGrowthRate = (1 + monthlyGrowthRate) ** 12 - 1;
    const spanDays = (last.timestamp - firstTimestamp) / (24 * 60 * 60 * 1000);
    const confidence: GrowthForecast['confidence'] = history.length >= 6
      && spanDays >= 90
      && rSquared >= 0.8
      ? 'high'
      : history.length >= 3 && spanDays >= 30 && rSquared >= 0.5
        ? 'medium'
        : 'low';
    return {
      method: 'linear-least-squares',
      historyStart: new Date(firstTimestamp).toISOString(),
      historyEnd: new Date(last.timestamp).toISOString(),
      horizonMonths,
      forecastDate: new Date(forecastTimestamp).toISOString(),
      currentTagCount,
      projectedTagCount,
      absoluteGrowth,
      monthlyGrowthRate: rounded(monthlyGrowthRate, 6),
      annualizedGrowthRate: rounded(annualizedGrowthRate, 6),
      slopeTagsPerDay: rounded(slope, 6),
      rSquared: rounded(rSquared, 6),
      confidence,
      pointsUsed: history.length,
    };
  }

  recommendScaling(
    workloadInput: CapacityWorkload,
    forecast?: GrowthForecast,
    providers: readonly CloudProvider[] = ['aws', 'azure', 'gcp'],
  ): ScalingRecommendation {
    const current = normalizeWorkload(workloadInput);
    const planningTagCount = Math.max(current.tagCount, forecast?.projectedTagCount ?? current.tagCount);
    const strategyHeadroom: Readonly<Record<ScalingStrategy, number>> = {
      'cost-optimized': 20,
      balanced: 35,
      performance: 60,
    };
    const options = (Object.entries(strategyHeadroom) as Array<[ScalingStrategy, number]>)
      .map(([strategy, headroomPercent]): ScalingOption => {
        const resourceEstimate = this.estimateResources({
          ...current,
          tagCount: planningTagCount,
          headroomPercent,
        });
        const costs = this.projectCloudCosts(resourceEstimate, providers);
        const monthlyCostByProvider = Object.fromEntries(
          costs.map(cost => [cost.provider, cost.monthly.total]),
        ) as Partial<Record<CloudProvider, number>>;
        const cheapestProvider = costs.reduce((best, candidate) =>
          candidate.monthly.total < best.monthly.total ? candidate : best).provider;
        const tradeoffs: Record<ScalingStrategy, [string, string]> = {
          'cost-optimized': [
            'Higher target utilization; suitable for stable workloads with slower scale-out.',
            'Lowest modeled spend, but the smallest burst and failover reserve.',
          ],
          balanced: [
            'Moderate reserve for failover and forecast error without extensive over-provisioning.',
            'Mid-range spend and the default choice for production OT workloads.',
          ],
          performance: [
            'Largest burst reserve and lowest resource contention for rapidly growing workloads.',
            'Highest modeled spend and greater idle capacity during steady demand.',
          ],
        };
        return {
          strategy,
          headroomPercent,
          resourceEstimate,
          monthlyCostByProvider,
          cheapestProvider,
          performanceTradeoff: tradeoffs[strategy][0],
          costTradeoff: tradeoffs[strategy][1],
        };
      });
    const monthlyGrowth = forecast?.monthlyGrowthRate ?? 0;
    const recommendedStrategy: ScalingStrategy = monthlyGrowth >= 0.05
      || forecast?.confidence === 'low'
      ? 'performance'
      : monthlyGrowth <= 0.005 && forecast?.confidence === 'high'
        ? 'cost-optimized'
        : 'balanced';
    const rationale = [
      forecast === undefined
        ? 'No historical forecast was supplied; the current tag count is used.'
        : `Plan covers ${planningTagCount.toLocaleString('en-US')} tags at the ${forecast.forecastDate} horizon.`,
      forecast?.confidence === 'low'
        ? 'Forecast confidence is low, so additional performance reserve is recommended.'
        : `Forecast confidence is ${forecast?.confidence ?? 'not available'}.`,
      `The ${recommendedStrategy} option preserves high availability and explicit utilization triggers.`,
    ];
    return {
      currentTagCount: current.tagCount,
      planningTagCount,
      forecast,
      recommendedStrategy,
      rationale,
      options,
      scaleTriggers: {
        gatewayTagUtilizationPercent: 70,
        cpuUtilizationPercent: 70,
        memoryUtilizationPercent: 75,
        storageUtilizationPercent: 70,
      },
    };
  }

  createPlan(input: {
    workload: CapacityWorkload;
    history?: readonly TagCountObservation[];
    horizonMonths?: number;
    providers?: readonly CloudProvider[];
  }): CapacityPlan {
    const current = this.estimateResources(input.workload);
    const forecast = input.history === undefined
      ? undefined
      : this.forecastGrowth(input.history, input.horizonMonths ?? 6);
    const planningTagCount = Math.max(input.workload.tagCount, forecast?.projectedTagCount ?? 0);
    const planning = this.estimateResources({
      ...input.workload,
      tagCount: planningTagCount,
      headroomPercent: input.workload.headroomPercent ?? 35,
    });
    return {
      generatedAt: this.now().toISOString(),
      current,
      forecast,
      planning,
      cloudCosts: this.projectCloudCosts(planning, input.providers),
      scaling: this.recommendScaling(input.workload, forecast, input.providers),
    };
  }
}

export const capacityPlanner = new CapacityPlanner();
