/**
 * Regional Topology Model
 * 
 * Extracted from SIN's East-West-NULL_ISLAND regional topology.
 * Defines geographic regions for SCADA facility organization,
 * cross-region synchronization, and governance boundaries.
 */

// Region definitions from SIN
export const REGIONS = {
  EAST: 'east',
  WEST: 'west',
  NULL_ISLAND: 'null_island',
} as const;

export type Region = typeof REGIONS[keyof typeof REGIONS];

// Facility with region assignment
export interface RegionalFacility {
  name: string;
  country: string;
  lat: number;
  lng: number;
  region: Region;
}

// Full facility list from SIN's shared schema
export const REGIONAL_FACILITIES: RegionalFacility[] = [
  // WEST REGION - Americas and Western Europe
  { name: 'Central Processing Plant', country: 'United States', lat: 40.7128, lng: -74.0060, region: REGIONS.WEST },
  { name: 'Gulf Coast Operations', country: 'United States', lat: 29.7604, lng: -95.3698, region: REGIONS.WEST },
  { name: 'European Control Center', country: 'France', lat: 48.8566, lng: 2.3522, region: REGIONS.WEST },
  { name: 'Nordic Processing Center', country: 'Sweden', lat: 59.3293, lng: 18.0686, region: REGIONS.WEST },
  { name: 'Mountain Research Station', country: 'Switzerland', lat: 46.6863, lng: 7.8632, region: REGIONS.WEST },
  { name: 'Coastal Monitoring Station', country: 'Chile', lat: -53.1638, lng: -70.9171, region: REGIONS.WEST },
  { name: 'Island Control Station', country: 'Iceland', lat: 65.6835, lng: -18.0878, region: REGIONS.WEST },
  { name: 'Rainforest Research Post', country: 'Brazil', lat: -3.7436, lng: -73.2516, region: REGIONS.WEST },
  { name: 'Tundra Operations Base', country: 'Canada', lat: 68.3607, lng: -133.7230, region: REGIONS.WEST },
  { name: 'Mediterranean Outpost', country: 'Greece', lat: 36.4072, lng: 25.4567, region: REGIONS.WEST },
  { name: 'Andean Research Center', country: 'Peru', lat: -13.1631, lng: -72.5450, region: REGIONS.WEST },

  // EAST REGION - Asia, Eastern Europe, Africa, Oceania
  { name: 'Eastern Production Facility', country: 'Germany', lat: 52.5200, lng: 13.4050, region: REGIONS.EAST },
  { name: 'Asia Manufacturing Hub', country: 'Japan', lat: 35.6762, lng: 139.6503, region: REGIONS.EAST },
  { name: 'Pacific Rim Facility', country: 'Singapore', lat: 1.3521, lng: 103.8198, region: REGIONS.EAST },
  { name: 'Desert Operations Hub', country: 'Australia', lat: -23.6980, lng: 133.8807, region: REGIONS.EAST },
  { name: 'Arctic Research Facility', country: 'Norway', lat: 78.2232, lng: 15.6267, region: REGIONS.EAST },
  { name: 'Rural Processing Center', country: 'India', lat: 34.1526, lng: 77.5771, region: REGIONS.EAST },
  { name: 'Grasslands Monitoring Hub', country: 'Kenya', lat: 0.5142, lng: 35.2728, region: REGIONS.EAST },
  { name: 'Alpine Data Center', country: 'New Zealand', lat: -45.0312, lng: 168.6626, region: REGIONS.EAST },
  { name: 'Sahara Monitoring Station', country: 'Morocco', lat: 31.5085, lng: -5.1294, region: REGIONS.EAST },
  { name: 'Steppe Processing Unit', country: 'Mongolia', lat: 47.9200, lng: 106.9177, region: REGIONS.EAST },

  // NULL ISLAND - Global/shared resources
  { name: 'International Management Hub', country: 'International Waters', lat: 0, lng: 0, region: REGIONS.NULL_ISLAND },
  { name: 'Global Coordination Center', country: 'International', lat: 0, lng: 0, region: REGIONS.NULL_ISLAND },
];

// Region metadata for topology decisions
export interface RegionConfig {
  id: Region;
  name: string;
  description: string;
  syncPriority: 'primary' | 'secondary' | 'global';
  governanceThreshold: number; // consensus % needed for region-wide changes
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

// Cross-region sync topology
export interface RegionSyncLink {
  from: Region;
  to: Region;
  latencyBudgetMs: number;
  syncMode: 'eventual' | 'strong' | 'causal';
  priority: number; // lower = higher priority
}

export const SYNC_TOPOLOGY: RegionSyncLink[] = [
  { from: REGIONS.WEST, to: REGIONS.EAST, latencyBudgetMs: 500, syncMode: 'causal', priority: 1 },
  { from: REGIONS.EAST, to: REGIONS.WEST, latencyBudgetMs: 500, syncMode: 'causal', priority: 1 },
  { from: REGIONS.WEST, to: REGIONS.NULL_ISLAND, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.EAST, to: REGIONS.NULL_ISLAND, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.NULL_ISLAND, to: REGIONS.WEST, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
  { from: REGIONS.NULL_ISLAND, to: REGIONS.EAST, latencyBudgetMs: 200, syncMode: 'strong', priority: 0 },
];

// Helpers
export function getFacilitiesByRegion(region: Region): RegionalFacility[] {
  return REGIONAL_FACILITIES.filter(f => f.region === region);
}

export function getRegionForCoordinates(lat: number, lng: number): Region {
  if (lat === 0 && lng === 0) return REGIONS.NULL_ISLAND;
  // Rough East-West split: West = Americas + Western Europe (lng < 30)
  // This matches SIN's assignment pattern
  if (lng < 30 && lng > -180) return REGIONS.WEST;
  return REGIONS.EAST;
}

export function getSyncConfig(from: Region, to: Region): RegionSyncLink | undefined {
  return SYNC_TOPOLOGY.find(link => link.from === from && link.to === to);
}
