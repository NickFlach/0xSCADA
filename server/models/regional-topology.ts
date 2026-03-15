/**
 * Regional Topology Model
 * 
 * Extracted from SIN's East-West-NULL_ISLAND regional topology.
 * Defines geographic regions for SCADA facility organization,
 * cross-region synchronization, governance boundaries, routing,
 * failover paths, and latency modeling.
 */

// ─── Region Definitions ──────────────────────────────────────────────

export const REGIONS = {
  EAST: 'east',
  WEST: 'west',
  NULL_ISLAND: 'null_island',
} as const;

export type Region = typeof REGIONS[keyof typeof REGIONS];

// ─── Facility Model ──────────────────────────────────────────────────

export interface RegionalFacility {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  region: Region;
  tier: 'primary' | 'secondary' | 'edge';
  capabilities: FacilityCapability[];
  maxConnections: number;
}

export type FacilityCapability = 'scada-gateway' | 'historian' | 'alarm-server' | 'engineering-station' | 'dmz-proxy' | 'safety-sis' | 'coordinator';

export const REGIONAL_FACILITIES: RegionalFacility[] = [
  // WEST REGION - Americas and Western Europe
  { id: 'us-east-cpp', name: 'Central Processing Plant', country: 'United States', lat: 40.7128, lng: -74.0060, region: REGIONS.WEST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'engineering-station'], maxConnections: 500 },
  { id: 'us-gulf-ops', name: 'Gulf Coast Operations', country: 'United States', lat: 29.7604, lng: -95.3698, region: REGIONS.WEST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'safety-sis'], maxConnections: 400 },
  { id: 'eu-france-cc', name: 'European Control Center', country: 'France', lat: 48.8566, lng: 2.3522, region: REGIONS.WEST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'engineering-station'], maxConnections: 350 },
  { id: 'eu-nordic-pc', name: 'Nordic Processing Center', country: 'Sweden', lat: 59.3293, lng: 18.0686, region: REGIONS.WEST, tier: 'secondary', capabilities: ['scada-gateway', 'historian'], maxConnections: 200 },
  { id: 'eu-swiss-mrs', name: 'Mountain Research Station', country: 'Switzerland', lat: 46.6863, lng: 7.8632, region: REGIONS.WEST, tier: 'secondary', capabilities: ['scada-gateway', 'engineering-station'], maxConnections: 100 },
  { id: 'sa-chile-cms', name: 'Coastal Monitoring Station', country: 'Chile', lat: -53.1638, lng: -70.9171, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 50 },
  { id: 'eu-iceland-ics', name: 'Island Control Station', country: 'Iceland', lat: 65.6835, lng: -18.0878, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 50 },
  { id: 'sa-brazil-rrp', name: 'Rainforest Research Post', country: 'Brazil', lat: -3.7436, lng: -73.2516, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 30 },
  { id: 'na-canada-tob', name: 'Tundra Operations Base', country: 'Canada', lat: 68.3607, lng: -133.7230, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 30 },
  { id: 'eu-greece-mo', name: 'Mediterranean Outpost', country: 'Greece', lat: 36.4072, lng: 25.4567, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 50 },
  { id: 'sa-peru-arc', name: 'Andean Research Center', country: 'Peru', lat: -13.1631, lng: -72.5450, region: REGIONS.WEST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 30 },

  // EAST REGION - Asia, Eastern Europe, Africa, Oceania
  { id: 'eu-germany-epf', name: 'Eastern Production Facility', country: 'Germany', lat: 52.5200, lng: 13.4050, region: REGIONS.EAST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'engineering-station'], maxConnections: 400 },
  { id: 'asia-japan-amh', name: 'Asia Manufacturing Hub', country: 'Japan', lat: 35.6762, lng: 139.6503, region: REGIONS.EAST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'safety-sis'], maxConnections: 450 },
  { id: 'asia-sg-prf', name: 'Pacific Rim Facility', country: 'Singapore', lat: 1.3521, lng: 103.8198, region: REGIONS.EAST, tier: 'primary', capabilities: ['scada-gateway', 'historian', 'alarm-server', 'dmz-proxy'], maxConnections: 350 },
  { id: 'oc-australia-doh', name: 'Desert Operations Hub', country: 'Australia', lat: -23.6980, lng: 133.8807, region: REGIONS.EAST, tier: 'secondary', capabilities: ['scada-gateway', 'historian'], maxConnections: 200 },
  { id: 'eu-norway-arf', name: 'Arctic Research Facility', country: 'Norway', lat: 78.2232, lng: 15.6267, region: REGIONS.EAST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 50 },
  { id: 'asia-india-rpc', name: 'Rural Processing Center', country: 'India', lat: 34.1526, lng: 77.5771, region: REGIONS.EAST, tier: 'secondary', capabilities: ['scada-gateway', 'historian'], maxConnections: 150 },
  { id: 'af-kenya-gmh', name: 'Grasslands Monitoring Hub', country: 'Kenya', lat: 0.5142, lng: 35.2728, region: REGIONS.EAST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 80 },
  { id: 'oc-nz-adc', name: 'Alpine Data Center', country: 'New Zealand', lat: -45.0312, lng: 168.6626, region: REGIONS.EAST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 60 },
  { id: 'af-morocco-sms', name: 'Sahara Monitoring Station', country: 'Morocco', lat: 31.5085, lng: -5.1294, region: REGIONS.EAST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 50 },
  { id: 'asia-mongolia-spu', name: 'Steppe Processing Unit', country: 'Mongolia', lat: 47.9200, lng: 106.9177, region: REGIONS.EAST, tier: 'edge', capabilities: ['scada-gateway'], maxConnections: 40 },

  // NULL ISLAND - Global/shared resources
  { id: 'global-imh', name: 'International Management Hub', country: 'International Waters', lat: 0, lng: 0, region: REGIONS.NULL_ISLAND, tier: 'primary', capabilities: ['coordinator', 'historian', 'dmz-proxy'], maxConnections: 1000 },
  { id: 'global-gcc', name: 'Global Coordination Center', country: 'International', lat: 0, lng: 0, region: REGIONS.NULL_ISLAND, tier: 'primary', capabilities: ['coordinator', 'alarm-server', 'dmz-proxy'], maxConnections: 1000 },
];

// ─── Region Configuration ────────────────────────────────────────────

export interface RegionConfig {
  id: Region;
  name: string;
  description: string;
  syncPriority: 'primary' | 'secondary' | 'global';
  governanceThreshold: number;
}

export const REGION_CONFIGS: Record<Region, RegionConfig> = {
  [REGIONS.WEST]: {
    id: REGIONS.WEST,
    name: 'West Region',
    description: 'Americas and Western Europe operational zone',
    syncPriority: 'primary',
    governanceThreshold: 0.66,
  },
  [REGIONS.EAST]: {
    id: REGIONS.EAST,
    name: 'East Region',
    description: 'Asia, Eastern Europe, Africa, Oceania operational zone',
    syncPriority: 'primary',
    governanceThreshold: 0.66,
  },
  [REGIONS.NULL_ISLAND]: {
    id: REGIONS.NULL_ISLAND,
    name: 'NULL_ISLAND',
    description: 'Global coordination zone — shared resources, cross-region governance',
    syncPriority: 'global',
    governanceThreshold: 0.75,
  },
};

// ─── Cross-Region Sync Topology ──────────────────────────────────────

export interface RegionSyncLink {
  from: Region;
  to: Region;
  latencyBudgetMs: number;
  syncMode: 'eventual' | 'strong' | 'causal';
  priority: number;
}

export const SYNC_TOPOLOGY: RegionSyncLink[] = [
  { from: REGIONS.WEST, to: REGIONS.EAST, latencyBudgetMs: 500, syncMode: 'causal', priority: 1 },
  { from: REGIONS.EAST, to: REGIONS.WEST, latencyBudgetMs: 500, syncMode: 'causal', priority: 1 },
  { from: REGIONS.WEST, to: REGIONS.NULL_ISLAND, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.EAST, to: REGIONS.NULL_ISLAND, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.NULL_ISLAND, to: REGIONS.WEST, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.NULL_ISLAND, to: REGIONS.EAST, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
];

// ─── Routing Model ───────────────────────────────────────────────────

export interface TopologyRoute {
  id: string;
  sourceFacilityId: string;
  targetFacilityId: string;
  /** Estimated one-way latency in milliseconds */
  latencyMs: number;
  /** Available bandwidth in Mbps */
  bandwidthMbps: number;
  /** Link type */
  linkType: 'fiber' | 'satellite' | 'microwave' | 'vpn';
  /** Is this link currently active? */
  active: boolean;
  /** Cost metric for shortest-path routing (lower = preferred) */
  cost: number;
}

/** Inter-facility routes — primary links */
export const PRIMARY_ROUTES: TopologyRoute[] = [
  // West intra-region backbone
  { id: 'us-east-to-gulf', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'us-gulf-ops', latencyMs: 25, bandwidthMbps: 1000, linkType: 'fiber', active: true, cost: 10 },
  { id: 'us-east-to-france', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'eu-france-cc', latencyMs: 75, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 20 },
  { id: 'france-to-nordic', sourceFacilityId: 'eu-france-cc', targetFacilityId: 'eu-nordic-pc', latencyMs: 30, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 12 },
  { id: 'france-to-swiss', sourceFacilityId: 'eu-france-cc', targetFacilityId: 'eu-swiss-mrs', latencyMs: 15, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 8 },
  { id: 'france-to-greece', sourceFacilityId: 'eu-france-cc', targetFacilityId: 'eu-greece-mo', latencyMs: 45, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 15 },
  { id: 'us-east-to-canada', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'na-canada-tob', latencyMs: 80, bandwidthMbps: 100, linkType: 'satellite', active: true, cost: 40 },
  { id: 'us-east-to-iceland', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'eu-iceland-ics', latencyMs: 60, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 25 },
  { id: 'us-gulf-to-brazil', sourceFacilityId: 'us-gulf-ops', targetFacilityId: 'sa-brazil-rrp', latencyMs: 120, bandwidthMbps: 50, linkType: 'satellite', active: true, cost: 50 },
  { id: 'us-gulf-to-chile', sourceFacilityId: 'us-gulf-ops', targetFacilityId: 'sa-chile-cms', latencyMs: 110, bandwidthMbps: 50, linkType: 'satellite', active: true, cost: 45 },
  { id: 'us-gulf-to-peru', sourceFacilityId: 'us-gulf-ops', targetFacilityId: 'sa-peru-arc', latencyMs: 90, bandwidthMbps: 50, linkType: 'satellite', active: true, cost: 40 },

  // East intra-region backbone
  { id: 'germany-to-japan', sourceFacilityId: 'eu-germany-epf', targetFacilityId: 'asia-japan-amh', latencyMs: 130, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 30 },
  { id: 'japan-to-singapore', sourceFacilityId: 'asia-japan-amh', targetFacilityId: 'asia-sg-prf', latencyMs: 70, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 18 },
  { id: 'singapore-to-australia', sourceFacilityId: 'asia-sg-prf', targetFacilityId: 'oc-australia-doh', latencyMs: 90, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 25 },
  { id: 'singapore-to-india', sourceFacilityId: 'asia-sg-prf', targetFacilityId: 'asia-india-rpc', latencyMs: 55, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 18 },
  { id: 'germany-to-norway', sourceFacilityId: 'eu-germany-epf', targetFacilityId: 'eu-norway-arf', latencyMs: 100, bandwidthMbps: 100, linkType: 'satellite', active: true, cost: 35 },
  { id: 'germany-to-morocco', sourceFacilityId: 'eu-germany-epf', targetFacilityId: 'af-morocco-sms', latencyMs: 60, bandwidthMbps: 100, linkType: 'fiber', active: true, cost: 22 },
  { id: 'singapore-to-kenya', sourceFacilityId: 'asia-sg-prf', targetFacilityId: 'af-kenya-gmh', latencyMs: 140, bandwidthMbps: 50, linkType: 'satellite', active: true, cost: 50 },
  { id: 'australia-to-nz', sourceFacilityId: 'oc-australia-doh', targetFacilityId: 'oc-nz-adc', latencyMs: 30, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 12 },
  { id: 'japan-to-mongolia', sourceFacilityId: 'asia-japan-amh', targetFacilityId: 'asia-mongolia-spu', latencyMs: 85, bandwidthMbps: 50, linkType: 'satellite', active: true, cost: 35 },

  // Cross-region links (West ↔ East) — via NULL_ISLAND
  { id: 'us-east-to-global', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'global-imh', latencyMs: 100, bandwidthMbps: 1000, linkType: 'fiber', active: true, cost: 5 },
  { id: 'france-to-global', sourceFacilityId: 'eu-france-cc', targetFacilityId: 'global-imh', latencyMs: 90, bandwidthMbps: 1000, linkType: 'fiber', active: true, cost: 5 },
  { id: 'germany-to-global', sourceFacilityId: 'eu-germany-epf', targetFacilityId: 'global-gcc', latencyMs: 95, bandwidthMbps: 1000, linkType: 'fiber', active: true, cost: 5 },
  { id: 'japan-to-global', sourceFacilityId: 'asia-japan-amh', targetFacilityId: 'global-gcc', latencyMs: 120, bandwidthMbps: 500, linkType: 'fiber', active: true, cost: 8 },
  { id: 'global-imh-to-gcc', sourceFacilityId: 'global-imh', targetFacilityId: 'global-gcc', latencyMs: 5, bandwidthMbps: 10000, linkType: 'fiber', active: true, cost: 1 },

  // Direct cross-region peering (backup)
  { id: 'france-to-germany-direct', sourceFacilityId: 'eu-france-cc', targetFacilityId: 'eu-germany-epf', latencyMs: 20, bandwidthMbps: 1000, linkType: 'fiber', active: true, cost: 8 },
  { id: 'us-east-to-japan-direct', sourceFacilityId: 'us-east-cpp', targetFacilityId: 'asia-japan-amh', latencyMs: 160, bandwidthMbps: 200, linkType: 'fiber', active: true, cost: 40 },
];

// ─── Failover Paths ──────────────────────────────────────────────────

export interface FailoverPath {
  id: string;
  description: string;
  /** Primary facility that might fail */
  primaryFacilityId: string;
  /** Ordered list of failover targets (first available wins) */
  failoverTargets: string[];
  /** Max acceptable failover latency increase (ms) */
  maxLatencyPenaltyMs: number;
  /** Automatic failover, or requires manual intervention? */
  mode: 'automatic' | 'manual' | 'semi-automatic';
  /** How long to wait before triggering failover (ms) */
  detectionTimeMs: number;
  /** Minimum time before failing back to primary (ms) */
  cooldownMs: number;
}

export const FAILOVER_PATHS: FailoverPath[] = [
  // West region failovers
  {
    id: 'fo-us-east',
    description: 'US East CPP primary failover',
    primaryFacilityId: 'us-east-cpp',
    failoverTargets: ['us-gulf-ops', 'eu-france-cc', 'global-imh'],
    maxLatencyPenaltyMs: 100,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },
  {
    id: 'fo-us-gulf',
    description: 'Gulf Coast Operations failover',
    primaryFacilityId: 'us-gulf-ops',
    failoverTargets: ['us-east-cpp', 'eu-france-cc', 'global-imh'],
    maxLatencyPenaltyMs: 100,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },
  {
    id: 'fo-eu-france',
    description: 'European Control Center failover',
    primaryFacilityId: 'eu-france-cc',
    failoverTargets: ['eu-nordic-pc', 'eu-swiss-mrs', 'us-east-cpp'],
    maxLatencyPenaltyMs: 80,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },

  // East region failovers
  {
    id: 'fo-germany',
    description: 'Eastern Production Facility failover',
    primaryFacilityId: 'eu-germany-epf',
    failoverTargets: ['eu-france-cc', 'asia-japan-amh', 'global-gcc'],
    maxLatencyPenaltyMs: 150,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },
  {
    id: 'fo-japan',
    description: 'Asia Manufacturing Hub failover',
    primaryFacilityId: 'asia-japan-amh',
    failoverTargets: ['asia-sg-prf', 'eu-germany-epf', 'global-gcc'],
    maxLatencyPenaltyMs: 120,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },
  {
    id: 'fo-singapore',
    description: 'Pacific Rim Facility failover',
    primaryFacilityId: 'asia-sg-prf',
    failoverTargets: ['asia-japan-amh', 'oc-australia-doh', 'global-gcc'],
    maxLatencyPenaltyMs: 100,
    mode: 'automatic',
    detectionTimeMs: 5000,
    cooldownMs: 300000,
  },

  // NULL_ISLAND failovers (global coordination)
  {
    id: 'fo-global-imh',
    description: 'International Management Hub failover',
    primaryFacilityId: 'global-imh',
    failoverTargets: ['global-gcc', 'us-east-cpp', 'eu-france-cc'],
    maxLatencyPenaltyMs: 200,
    mode: 'semi-automatic',
    detectionTimeMs: 10000,
    cooldownMs: 600000,
  },
  {
    id: 'fo-global-gcc',
    description: 'Global Coordination Center failover',
    primaryFacilityId: 'global-gcc',
    failoverTargets: ['global-imh', 'eu-germany-epf', 'asia-japan-amh'],
    maxLatencyPenaltyMs: 200,
    mode: 'semi-automatic',
    detectionTimeMs: 10000,
    cooldownMs: 600000,
  },
];

// ─── Latency Model ───────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng points */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Speed-of-light latency model factors */
const LATENCY_MODEL = {
  /** Speed of light in fiber (roughly 2/3 c) in km/ms */
  fiberSpeedKmPerMs: 200,
  /** Overhead multiplier for routing, switching, queuing */
  routingOverhead: 1.4,
  /** Additional per-hop latency (ms) */
  perHopLatencyMs: 2,
  /** Satellite one-way base latency (GEO orbit ~35,786 km up + down) */
  satelliteBaseMs: 270,
  /** Satellite jitter range (ms) */
  satelliteJitterMs: 30,
  /** Microwave relay latency per km (faster than fiber, less overhead) */
  microwaveSpeedKmPerMs: 280,
} as const;

/** Estimate one-way latency between two geographic points */
export function estimateLatencyMs(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  linkType: 'fiber' | 'satellite' | 'microwave' | 'vpn' = 'fiber'
): number {
  const distKm = haversineKm(lat1, lng1, lat2, lng2);

  switch (linkType) {
    case 'fiber': {
      const propagation = distKm / LATENCY_MODEL.fiberSpeedKmPerMs;
      const hops = Math.ceil(distKm / 1000); // Approximate one hop per 1000 km
      return Math.round(propagation * LATENCY_MODEL.routingOverhead + hops * LATENCY_MODEL.perHopLatencyMs);
    }
    case 'satellite': {
      // Deterministic jitter based on route coordinates to avoid non-determinism in Dijkstra
      const coordHash = Math.abs(Math.sin(lat1 * 12.9898 + lng1 * 78.233 + lat2 * 37.719 + lng2 * 43.758) * 43758.5453) % 1;
      return Math.round(LATENCY_MODEL.satelliteBaseMs + (coordHash * LATENCY_MODEL.satelliteJitterMs));
    }
    case 'microwave': {
      const propagation = distKm / LATENCY_MODEL.microwaveSpeedKmPerMs;
      return Math.round(propagation * 1.1); // Minimal overhead
    }
    case 'vpn': {
      // VPN = fiber + encryption overhead
      const propagation = distKm / LATENCY_MODEL.fiberSpeedKmPerMs;
      const hops = Math.ceil(distKm / 1000);
      return Math.round(propagation * LATENCY_MODEL.routingOverhead * 1.15 + hops * LATENCY_MODEL.perHopLatencyMs + 5);
    }
  }
}

/** Estimate latency between two facilities by ID */
export function estimateFacilityLatencyMs(fromId: string, toId: string): number {
  const from = REGIONAL_FACILITIES.find(f => f.id === fromId);
  const to = REGIONAL_FACILITIES.find(f => f.id === toId);
  if (!from || !to) return Infinity;

  // Check for a direct route first
  const directRoute = PRIMARY_ROUTES.find(r =>
    r.active && ((r.sourceFacilityId === fromId && r.targetFacilityId === toId) ||
                 (r.sourceFacilityId === toId && r.targetFacilityId === fromId)));

  if (directRoute) return directRoute.latencyMs;

  // Fall back to geographic estimate
  return estimateLatencyMs(from.lat, from.lng, to.lat, to.lng);
}

// ─── Topology Graph & Routing ────────────────────────────────────────

/** Adjacency list representation of the topology graph */
type AdjacencyList = Map<string, Array<{ target: string; cost: number; latencyMs: number; route: TopologyRoute }>>;

/** Build adjacency list from route definitions (bidirectional) */
function buildAdjacencyList(routes: TopologyRoute[]): AdjacencyList {
  const adj: AdjacencyList = new Map();

  for (const route of routes) {
    if (!route.active) continue;

    if (!adj.has(route.sourceFacilityId)) adj.set(route.sourceFacilityId, []);
    if (!adj.has(route.targetFacilityId)) adj.set(route.targetFacilityId, []);

    adj.get(route.sourceFacilityId)!.push({ target: route.targetFacilityId, cost: route.cost, latencyMs: route.latencyMs, route });
    adj.get(route.targetFacilityId)!.push({ target: route.sourceFacilityId, cost: route.cost, latencyMs: route.latencyMs, route });
  }

  return adj;
}

/** Dijkstra shortest path between two facilities */
export function findShortestPath(fromId: string, toId: string, routes: TopologyRoute[] = PRIMARY_ROUTES): {
  path: string[];
  totalCost: number;
  totalLatencyMs: number;
} | null {
  const adj = buildAdjacencyList(routes);
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const latency = new Map<string, number>();
  const visited = new Set<string>();

  // Initialize
  for (const facility of REGIONAL_FACILITIES) {
    dist.set(facility.id, Infinity);
    latency.set(facility.id, Infinity);
  }
  dist.set(fromId, 0);
  latency.set(fromId, 0);

  while (true) {
    // Find unvisited node with minimum distance
    let minDist = Infinity;
    let current = '';
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < minDist) {
        minDist = d;
        current = node;
      }
    }

    if (!current || current === toId) break;
    visited.add(current);

    const neighbors = adj.get(current) ?? [];
    for (const { target, cost, latencyMs: edgeLatency } of neighbors) {
      if (visited.has(target)) continue;
      const newDist = (dist.get(current) ?? Infinity) + cost;
      if (newDist < (dist.get(target) ?? Infinity)) {
        dist.set(target, newDist);
        latency.set(target, (latency.get(current) ?? 0) + edgeLatency);
        prev.set(target, current);
      }
    }
  }

  if (!prev.has(toId) && fromId !== toId) return null;

  // Reconstruct path
  const path: string[] = [];
  let node = toId;
  while (node) {
    path.unshift(node);
    node = prev.get(node) ?? '';
    if (node === fromId) { path.unshift(fromId); break; }
  }

  return {
    path,
    totalCost: dist.get(toId) ?? Infinity,
    totalLatencyMs: latency.get(toId) ?? Infinity,
  };
}

/** Find K shortest paths (Yen's algorithm simplified — for failover alternatives) */
export function findKShortestPaths(fromId: string, toId: string, k: number = 3): Array<{
  path: string[];
  totalCost: number;
  totalLatencyMs: number;
}> {
  const results: Array<{ path: string[]; totalCost: number; totalLatencyMs: number }> = [];

  // First shortest path
  const first = findShortestPath(fromId, toId);
  if (!first) return results;
  results.push(first);

  // Find alternate paths by removing edges from previous paths
  for (let i = 1; i < k; i++) {
    const prevPath = results[i - 1].path;
    let bestAlternate: { path: string[]; totalCost: number; totalLatencyMs: number } | null = null;

    for (let j = 0; j < prevPath.length - 1; j++) {
      // Create modified route set with one link removed
      const modifiedRoutes = PRIMARY_ROUTES.map(r => {
        if ((r.sourceFacilityId === prevPath[j] && r.targetFacilityId === prevPath[j + 1]) ||
            (r.sourceFacilityId === prevPath[j + 1] && r.targetFacilityId === prevPath[j])) {
          return { ...r, active: false };
        }
        return r;
      });

      const alt = findShortestPath(fromId, toId, modifiedRoutes);
      if (alt && (!bestAlternate || alt.totalCost < bestAlternate.totalCost)) {
        // Check it's actually different from existing results
        const pathStr = alt.path.join('→');
        if (!results.some(r => r.path.join('→') === pathStr)) {
          bestAlternate = alt;
        }
      }
    }

    if (bestAlternate) results.push(bestAlternate);
    else break;
  }

  return results;
}

// ─── Node Placement ──────────────────────────────────────────────────

export interface TopologyNode {
  facilityId: string;
  region: Region;
  role: 'hub' | 'spoke' | 'bridge' | 'coordinator';
  /** Nodes this one directly connects to */
  neighbors: string[];
  /** Is this a region entry point? */
  isGateway: boolean;
  /** Relative importance (used for weighted routing) */
  weight: number;
}

/** Compute node placements from facilities and routes */
export function computeNodePlacements(): TopologyNode[] {
  const adj = buildAdjacencyList(PRIMARY_ROUTES);
  const nodes: TopologyNode[] = [];

  for (const facility of REGIONAL_FACILITIES) {
    const neighbors = (adj.get(facility.id) ?? []).map(n => n.target);
    const connectionCount = neighbors.length;

    // Cross-region links determine gateway status
    const crossRegionLinks = neighbors.filter(nId => {
      const nFacility = REGIONAL_FACILITIES.find(f => f.id === nId);
      return nFacility && nFacility.region !== facility.region;
    });

    let role: TopologyNode['role'];
    if (facility.region === REGIONS.NULL_ISLAND) {
      role = 'coordinator';
    } else if (connectionCount >= 4) {
      role = 'hub';
    } else if (crossRegionLinks.length > 0) {
      role = 'bridge';
    } else {
      role = 'spoke';
    }

    nodes.push({
      facilityId: facility.id,
      region: facility.region,
      role,
      neighbors,
      isGateway: crossRegionLinks.length > 0 || facility.region === REGIONS.NULL_ISLAND,
      weight: facility.tier === 'primary' ? 10 : facility.tier === 'secondary' ? 5 : 1,
    });
  }

  return nodes;
}

// ─── Topology Health ─────────────────────────────────────────────────

export interface TopologyHealthReport {
  timestamp: Date;
  totalFacilities: number;
  facilitiesByRegion: Record<Region, number>;
  totalRoutes: number;
  activeRoutes: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  partitioned: boolean;
  vulnerabilities: string[];
}

/** Analyze topology health */
export function analyzeTopologyHealth(): TopologyHealthReport {
  const facilitiesByRegion: Record<Region, number> = {
    [REGIONS.WEST]: 0,
    [REGIONS.EAST]: 0,
    [REGIONS.NULL_ISLAND]: 0,
  };

  for (const f of REGIONAL_FACILITIES) {
    facilitiesByRegion[f.region]++;
  }

  const activeRoutes = PRIMARY_ROUTES.filter(r => r.active);
  const latencies = activeRoutes.map(r => r.latencyMs);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  // Check for partition — can every region reach every other region?
  const adj = buildAdjacencyList(activeRoutes);
  const visited = new Set<string>();
  const queue: string[] = [REGIONAL_FACILITIES[0]?.id ?? ''];
  if (queue[0]) visited.add(queue[0]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const { target } of adj.get(current) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  const partitioned = visited.size < REGIONAL_FACILITIES.length;

  // Identify vulnerabilities (single points of failure)
  const vulnerabilities: string[] = [];
  for (const route of activeRoutes) {
    // Check if removing this route partitions the graph
    const reduced = activeRoutes.filter(r => r.id !== route.id);
    const reducedAdj = buildAdjacencyList(reduced);
    const reachable = new Set<string>();
    const q2: string[] = [REGIONAL_FACILITIES[0]?.id ?? ''];
    if (q2[0]) reachable.add(q2[0]);
    while (q2.length > 0) {
      const cur = q2.shift()!;
      for (const { target } of reducedAdj.get(cur) ?? []) {
        if (!reachable.has(target)) {
          reachable.add(target);
          q2.push(target);
        }
      }
    }
    if (reachable.size < REGIONAL_FACILITIES.length) {
      vulnerabilities.push(`Route ${route.id} (${route.sourceFacilityId} → ${route.targetFacilityId}) is a bridge — removal partitions network`);
    }
  }

  return {
    timestamp: new Date(),
    totalFacilities: REGIONAL_FACILITIES.length,
    facilitiesByRegion,
    totalRoutes: PRIMARY_ROUTES.length,
    activeRoutes: activeRoutes.length,
    avgLatencyMs: Math.round(avgLatency),
    maxLatencyMs: maxLatency,
    partitioned,
    vulnerabilities,
  };
}

// ─── Simple Helpers (backward compatible) ────────────────────────────

export function getFacilitiesByRegion(region: Region): RegionalFacility[] {
  return REGIONAL_FACILITIES.filter(f => f.region === region);
}

export function getRegionForCoordinates(lat: number, lng: number): Region {
  if (lat === 0 && lng === 0) return REGIONS.NULL_ISLAND;
  if (lng < 30 && lng > -180) return REGIONS.WEST;
  return REGIONS.EAST;
}

export function getSyncConfig(from: Region, to: Region): RegionSyncLink | undefined {
  return SYNC_TOPOLOGY.find(link => link.from === from && link.to === to);
}

export function getFacilityById(id: string): RegionalFacility | undefined {
  return REGIONAL_FACILITIES.find(f => f.id === id);
}

export function getFailoverPath(facilityId: string): FailoverPath | undefined {
  return FAILOVER_PATHS.find(fp => fp.primaryFacilityId === facilityId);
}

export function getPrimaryFacilities(region: Region): RegionalFacility[] {
  return REGIONAL_FACILITIES.filter(f => f.region === region && f.tier === 'primary');
}

export function getRoutesBetweenRegions(from: Region, to: Region): TopologyRoute[] {
  return PRIMARY_ROUTES.filter(r => {
    const fromFacility = REGIONAL_FACILITIES.find(f => f.id === r.sourceFacilityId);
    const toFacility = REGIONAL_FACILITIES.find(f => f.id === r.targetFacilityId);
    return fromFacility && toFacility && fromFacility.region === from && toFacility.region === to;
  });
}
