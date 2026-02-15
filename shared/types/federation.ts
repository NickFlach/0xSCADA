/**
 * Multi-Site Federation Types — ADR-0014
 */

export interface FederationSite {
  siteId: string;
  name: string;
  endpoint: string;
  publicKey: string;
  status: 'online' | 'degraded' | 'offline' | 'unknown';
  lastHeartbeat: number;
  version: string;
  capabilities: string[];
  tagNamespace: string;
  metadata: Record<string, string>;
}

export interface FederationConfig {
  siteId: string;
  siteName: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxPeerSites: number;
  enableAutoDiscovery: boolean;
  tlsMutualAuth: boolean;
  syncIntervalMs: number;
}

export interface FederatedTagRef {
  siteId: string;
  area: string;
  tagName: string;
  /** Canonical form: siteId:area/tagName */
  canonical: string;
}

export interface FederatedQuery {
  queryId: string;
  originSite: string;
  targetSites: string[] | 'all';
  query: {
    type: 'tag-read' | 'alarm-list' | 'historian-query' | 'report';
    params: Record<string, unknown>;
  };
  timeout: number;
  timestamp: number;
}

export interface FederatedQueryResult {
  queryId: string;
  siteId: string;
  status: 'success' | 'error' | 'timeout';
  data?: unknown;
  error?: string;
  latencyMs: number;
}

export interface CRDTOperation {
  type: 'lww-register' | 'g-counter' | 'or-set-add' | 'or-set-remove';
  key: string;
  value: unknown;
  timestamp: number;
  siteId: string;
  vectorClock: Record<string, number>;
}

export interface SyncMessage {
  type: 'heartbeat' | 'state-sync' | 'query' | 'query-result' | 'crdt-op';
  fromSite: string;
  toSite: string;
  payload: unknown;
  signature: string;
  timestamp: number;
}

export interface FederationMetrics {
  connectedSites: number;
  totalFederatedTags: number;
  queriesForwarded: number;
  syncOperations: number;
  avgCrossSiteLatencyMs: number;
  lastSyncTime: number;
}
