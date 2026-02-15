/**
 * Federation Manager — ADR-0014 [14.3]
 *
 * Site registry, heartbeat protocol, cross-site tag resolution,
 * and federated queries across 0xSCADA instances.
 */

import { EventEmitter } from 'events';
import type {
  FederationSite,
  FederationConfig,
  FederatedTagRef,
  FederatedQuery,
  FederatedQueryResult,
  FederationMetrics,
  SyncMessage,
} from '../../shared/types/federation';

export class FederationManager extends EventEmitter {
  private config: FederationConfig;
  private sites: Map<string, FederationSite> = new Map();
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private pendingQueries: Map<string, { resolve: (r: FederatedQueryResult[]) => void; results: FederatedQueryResult[]; expected: number; timer: ReturnType<typeof setTimeout> }> = new Map();
  private queriesForwarded = 0;
  private syncOperations = 0;

  constructor(config: Partial<FederationConfig> = {}) {
    super();
    this.config = {
      siteId: config.siteId ?? `site-${Date.now()}`,
      siteName: config.siteName ?? 'Primary',
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 90000,
      maxPeerSites: config.maxPeerSites ?? 50,
      enableAutoDiscovery: config.enableAutoDiscovery ?? true,
      tlsMutualAuth: config.tlsMutualAuth ?? true,
      syncIntervalMs: config.syncIntervalMs ?? 60000,
    };
  }

  registerSite(site: FederationSite): void {
    if (this.sites.size >= this.config.maxPeerSites) {
      throw new Error(`Maximum peer sites (${this.config.maxPeerSites}) reached`);
    }
    this.sites.set(site.siteId, site);
    this.startHeartbeat(site.siteId);
    this.emit('site-registered', site);
  }

  unregisterSite(siteId: string): void {
    this.sites.delete(siteId);
    const timer = this.heartbeatTimers.get(siteId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(siteId);
    }
    this.emit('site-unregistered', siteId);
  }

  getSite(siteId: string): FederationSite | undefined {
    return this.sites.get(siteId);
  }

  getAllSites(): FederationSite[] {
    return Array.from(this.sites.values());
  }

  parseTagRef(canonical: string): FederatedTagRef | null {
    const match = canonical.match(/^([^:]+):(.+)\/([^/]+)$/);
    if (!match) return null;
    return {
      siteId: match[1],
      area: match[2],
      tagName: match[3],
      canonical,
    };
  }

  resolveTag(canonical: string): { site: FederationSite; tagRef: FederatedTagRef } | null {
    const ref = this.parseTagRef(canonical);
    if (!ref) return null;

    const site = this.sites.get(ref.siteId);
    if (!site || site.status === 'offline') return null;

    return { site, tagRef: ref };
  }

  async query(query: FederatedQuery): Promise<FederatedQueryResult[]> {
    const targetSites = query.targetSites === 'all'
      ? Array.from(this.sites.keys())
      : query.targetSites;

    this.queriesForwarded += targetSites.length;

    return new Promise((resolve) => {
      const results: FederatedQueryResult[] = [];
      const expected = targetSites.length;

      if (expected === 0) {
        resolve([]);
        return;
      }

      const timer = setTimeout(() => {
        // Return whatever we have on timeout
        this.pendingQueries.delete(query.queryId);
        resolve(results);
      }, query.timeout);

      this.pendingQueries.set(query.queryId, { resolve, results, expected, timer });

      for (const siteId of targetSites) {
        const site = this.sites.get(siteId);
        if (!site || site.status === 'offline') {
          this.receiveQueryResult({
            queryId: query.queryId,
            siteId,
            status: 'error',
            error: site ? 'Site offline' : 'Site not found',
            latencyMs: 0,
          });
        } else {
          // In production, this would send over the network
          this.emit('query-forward', { query, site });
        }
      }
    });
  }

  receiveQueryResult(result: FederatedQueryResult): void {
    const pending = this.pendingQueries.get(result.queryId);
    if (!pending) return;

    pending.results.push(result);
    if (pending.results.length >= pending.expected) {
      clearTimeout(pending.timer);
      this.pendingQueries.delete(result.queryId);
      pending.resolve(pending.results);
    }
  }

  handleSyncMessage(message: SyncMessage): void {
    this.syncOperations++;

    switch (message.type) {
      case 'heartbeat': {
        const site = this.sites.get(message.fromSite);
        if (site) {
          site.lastHeartbeat = Date.now();
          site.status = 'online';
        }
        break;
      }
      case 'state-sync':
        this.emit('state-sync', message);
        break;
      case 'query':
        this.emit('incoming-query', message);
        break;
      case 'query-result':
        this.receiveQueryResult(message.payload as FederatedQueryResult);
        break;
      case 'crdt-op':
        this.emit('crdt-operation', message);
        break;
    }
  }

  getMetrics(): FederationMetrics {
    const sites = Array.from(this.sites.values());
    const onlineSites = sites.filter((s) => s.status === 'online');

    return {
      connectedSites: onlineSites.length,
      totalFederatedTags: 0, // populated by integration
      queriesForwarded: this.queriesForwarded,
      syncOperations: this.syncOperations,
      avgCrossSiteLatencyMs: 0,
      lastSyncTime: Math.max(...sites.map((s) => s.lastHeartbeat), 0),
    };
  }

  shutdown(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();
    for (const pending of this.pendingQueries.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingQueries.clear();
  }

  private startHeartbeat(siteId: string): void {
    const timer = setInterval(() => {
      const site = this.sites.get(siteId);
      if (!site) return;

      const timeSince = Date.now() - site.lastHeartbeat;
      if (timeSince > this.config.heartbeatTimeoutMs) {
        site.status = 'offline';
        this.emit('site-offline', siteId);
      } else if (timeSince > this.config.heartbeatTimeoutMs * 0.7) {
        site.status = 'degraded';
        this.emit('site-degraded', siteId);
      }
    }, this.config.heartbeatIntervalMs);

    this.heartbeatTimers.set(siteId, timer);
  }
}
